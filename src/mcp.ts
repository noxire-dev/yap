import type { Answer, YapSession } from '../sdk/local'

/**
 * `yap mcp`: YAP as an MCP server (JSON-RPC, one message per line on stdin and stdout), for agents with no hooks
 * (Codex, Cursor, Zed). The model calls `yap_check` itself, so warnings come when it asks and a deny is advice:
 * hooks stay the only way to stop a command before it runs.
 */

const s = { type: 'string' } as const
const TOOLS = [
  {
    name: 'yap_check',
    description:
      'Call before you edit a file another agent may be on, before any git command that switches, resets, stashes or commits, and between steps. It warns when another agent session in this repo just edited the file, says when a git command would wipe or sweep up their work in the same tree (then do not run it), and delivers messages other sessions sent you. Pass the files you changed since your last check in `edited`, so they are warned about yours.',
    inputSchema: { type: 'object', properties: { edit: s, run: s, edited: { type: 'array', items: s } } },
  },
  {
    name: 'yap_peers',
    description: 'The other agent sessions working in this repo: their names, working trees, the files each edited, and worktrees whose work would conflict with theirs if merged.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'yap_say',
    description: 'Message another agent session in this repo (`to`: its name or id, without @) or all of them. An idle one wakes to read it.',
    inputSchema: { type: 'object', properties: { text: s, to: s }, required: ['text'] },
  },
  {
    name: 'yap_board',
    description: "The repo's board: notes every session sees, newest first.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'yap_note',
    description: "Pin a note on the repo's board for every session, now and later: a decision, a warning, who owns what.",
    inputSchema: { type: 'object', properties: { text: s }, required: ['text'] },
  },
  {
    name: 'yap_spawn',
    description: 'Start a background agent session in this repo on a task: Claude Code, or Codex with agent "codex". It is a peer you can message; its last word comes back to you as a message.',
    inputSchema: { type: 'object', properties: { task: s, agent: { type: 'string', enum: ['claude', 'codex'] } }, required: ['task'] },
  },
]

/** YAP's text names the `yap` commands; run from an agent's shell without YAP_SESSION, they'd speak as nobody. */
const tools = (text: string) =>
  text
    .replace(/`yap say @<session> <text>`( or `yap say <text>` for all of them)?/g, 'yap_say')
    .replace(/`yap say @[^`]*`/g, 'yap_say')
    .replace(/`yap note <text>`/g, 'yap_note')
    .replace(/, and take a note down with `yap note -d <id>` once it no longer holds/g, '')

const say = (a: Answer) => tools([a.deny && `Don't run it. ${a.deny}`, a.context].filter(Boolean).join('\n\n')) || 'nothing from yap: go ahead'

async function tool(me: YapSession, name: string, a: Record<string, any>): Promise<string> {
  const yap = me.yap
  if (name === 'yap_check') {
    for (const f of a.edited ?? []) await me.edited(String(f))
    return say(a.run ? await me.willRun(String(a.run)) : await me.willEdit(a.edit ? String(a.edit) : ''))
  }
  if (name === 'yap_peers') {
    const peers = (await yap.sessions(me.cwd)).filter(p => p.id !== me.id)
    const line = (p: (typeof peers)[number]) =>
      [
        `@${p.name || p.id.slice(0, 8)} in ${p.top}${p.files.length ? `, edited ${p.files.slice(-5).join(', ')}` : ''}`,
        ...(p.conflicts ?? []).map(c => `  would conflict with @${c.with} if merged, in ${c.files.join(', ')}`),
      ].join('\n')
    return peers.length ? peers.map(line).join('\n') : 'no other session in this repo'
  }
  if (name === 'yap_say') {
    const r = await me.say(String(a.text ?? ''), a.to ? String(a.to).replace(/^@/, '') : undefined)
    return r.to.length ? `sent to ${r.to.join(', ')}${r.woke.length ? `; ${r.woke.join(', ')} woke to read it` : ''}` : 'nobody to send it to'
  }
  if (name === 'yap_board') {
    const ns = await yap.notes(me.cwd)
    return ns.length ? ns.map(n => `#${n.id} ${n.author}: ${n.text}`).join('\n') : 'the board is empty'
  }
  if (name === 'yap_note') return `pinned #${(await me.note(String(a.text ?? ''))).id}`
  if (name === 'yap_spawn') return `started @${(await me.spawn(String(a.task ?? ''), a.agent === 'codex' ? 'codex' : undefined)).id}; its last word comes back to you through yap_check`
  throw new Error(`no tool ${name}`)
}

/**
 * One JSON-RPC message in, its reply out (none for a notification). `owned`: this server is the session's only
 * YAP voice, so it joins on `initialize`, named for the client; a session hooks already report for doesn't.
 */
export async function rpc(me: YapSession, owned: boolean, m: { id?: unknown; method?: string; params?: any }, version: string) {
  if (m.id === undefined) return
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: m.id, result })
  if (m.method === 'initialize') {
    // Codex calls itself `codex-mcp-client`, and kills this process rather than close it: the pid says leave.
    const name = String(m.params?.clientInfo?.name ?? 'mcp').replace(/[-_ ]?mcp[-_ ]?client$/i, '') || 'mcp'
    const joined = owned ? await me.join(name, process.pid).catch(() => ({}) as Answer) : {}
    return ok({
      protocolVersion: m.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'yap', version },
      instructions: [
        'Other agent sessions may be working in this repo, some in this same working tree. Call yap_check before editing a file or running a git command that switches, resets, stashes or commits, and between steps; do what it says. Message a peer with yap_say.',
        joined.context && tools(joined.context),
      ]
        .filter(Boolean)
        .join('\n\n'),
    })
  }
  if (m.method === 'ping') return ok({})
  if (m.method === 'tools/list') return ok({ tools: TOOLS })
  if (m.method === 'tools/call') {
    try {
      return ok({ content: [{ type: 'text', text: await tool(me, m.params?.name, m.params?.arguments ?? {}) }] })
    } catch (e: any) {
      return ok({ content: [{ type: 'text', text: `yap: ${e?.message ?? e}` }], isError: true })
    }
  }
  return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `no method ${m.method}` } }
}
