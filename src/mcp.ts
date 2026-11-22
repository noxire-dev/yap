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
    description: 'The other agent sessions working in this repo: their names, working trees, the files each edited, worktrees whose work would conflict with theirs if merged, and the questions and blockers nobody has answered yet.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'yap_say',
    description:
      'Message another agent session in this repo (`to`: its name or id, without @) or all of them, or the person with `to` "user" (it waits in their inbox, on the web too). `repo` reaches another repo\'s sessions instead, by its directory\'s name. An idle session wakes to read it. `kind` "question" or "blocker" keeps it on your list until someone replies with `re` set to its id; answer one sent to you the same way.',
    inputSchema: { type: 'object', properties: { text: s, to: s, kind: { type: 'string', enum: ['question', 'blocker'] }, re: s, repo: s }, required: ['text'] },
  },
  {
    name: 'yap_doing',
    description: 'Say what you are working on, one line in your own words, when you start a task and when it changes. Other sessions see it next to your name, and the user sees it too. Empty text clears it.',
    inputSchema: { type: 'object', properties: { text: s }, required: ['text'] },
  },
  {
    name: 'yap_board',
    description: "The repo's board: notes every session sees, newest first.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'yap_note',
    description: "Pin a note on the repo's board for every session, now and later: a decision, a warning, who owns what. `replaces`: the id of a note this one supersedes, taken down in the same step.",
    inputSchema: { type: 'object', properties: { text: s, replaces: { type: 'number' } }, required: ['text'] },
  },
  {
    name: 'yap_claim',
    description:
      'Before a task that touches several files in one directory, claim it (a file or directory, relative to the repo root), so other sessions are warned before they edit there. Says who holds it when another session already claimed an overlapping path. Lasts 20 minutes past your last edit under it. Pass release with the claim id when you are done, or "all" for every one of yours.',
    inputSchema: { type: 'object', properties: { path: s, why: s, release: s } },
  },
  {
    name: 'yap_spawn',
    description:
      'Start a background agent session in this repo on a task: Claude Code, or Codex with agent "codex". It is a peer you can message; its last word comes back to you as a message. `skills` (Claude Code only) makes it lean: none of the user\'s plugins or skills, only yap and these, each an installed plugin\'s name (ponytail) or a skill in ~/.claude/skills (frontend-craft).',
    inputSchema: { type: 'object', properties: { task: s, agent: { type: 'string', enum: ['claude', 'codex'] }, skills: { type: 'array', items: s } }, required: ['task'] },
  },
]

/** YAP's text names the `yap` commands; run from an agent's shell without YAP_SESSION, they'd speak as nobody. */
const tools = (text: string) =>
  text
    .replace(/`yap say --re (\S+) <text>`/g, 'yap_say with re "$1"')
    .replace(/`yap say '?@<session>'? <text>`( or `yap say <text>` for all of them)?/g, 'yap_say')
    .replace(/`yap say '?@[^`]*`/g, 'yap_say')
    .replace(/`yap note <text>`/g, 'yap_note')
    .replace(/`yap say --question '?@user'? <text>`/g, 'yap_say to "user" with kind "question"')
    .replace(/`yap doing <text>`/g, 'yap_doing')
    .replace(/`yap claim <path> <why>`/g, 'yap_claim')
    .replace(/`yap release <id>`/g, 'yap_claim with release')
    .replace(/, and take a note down with `yap note -d <id>` once it no longer holds/g, '')

const say = (a: Answer) => tools([a.deny && `Don't run it. ${a.deny}`, a.context].filter(Boolean).join('\n\n')) || 'nothing from yap: go ahead'

async function tool(me: YapSession, name: string, a: Record<string, any>): Promise<string> {
  const yap = me.yap
  if (name === 'yap_check') {
    for (const f of a.edited ?? []) await me.edited(String(f))
    return say(a.run ? await me.willRun(String(a.run)) : await me.willEdit(a.edit ? String(a.edit) : ''))
  }
  if (name === 'yap_peers') {
    const all = await yap.sessions(me.cwd)
    const peers = all.filter(p => p.id !== me.id)
    const claims = await yap.claims(me.cwd)
    const open = (p: (typeof all)[number]) => [
      ...claims.filter(c => c.session === p.id).map(c => `  claimed ${c.path} (${c.id}): ${c.why}`),
      ...(p.unanswered ?? []).map(q => `  unanswered ${q.kind} ${q.id.slice(0, 8)} to ${q.to.join(', ')}: ${q.text}`),
    ]
    const line = (p: (typeof peers)[number]) =>
      [
        `@${p.name || p.id.slice(0, 8)} in ${p.top}${p.files.length ? `, edited ${p.files.slice(-5).join(', ')}` : ''}`,
        ...(p.conflicts ?? []).map(c => `  would conflict with @${c.with} if merged, in ${c.files.join(', ')}`),
        ...open(p),
      ].join('\n')
    const mine = open(all.find(p => p.id === me.id) ?? ({} as (typeof all)[number]))
    return [peers.length ? peers.map(line).join('\n') : 'no other session in this repo', mine.length && `yours:\n${mine.join('\n')}`].filter(Boolean).join('\n')
  }
  if (name === 'yap_say') {
    const kind = a.kind === 'question' || a.kind === 'blocker' ? a.kind : undefined
    const r = await me.say(String(a.text ?? ''), a.to ? String(a.to).replace(/^@/, '') : undefined, { kind, re: a.re ? String(a.re) : undefined, repo: a.repo ? String(a.repo) : undefined })
    const sent = `sent to ${r.to.join(', ')}${r.woke.length ? `; ${r.woke.join(', ')} woke to read it` : ''}`
    return kind ? `${sent}. Your ${kind} is ${r.id.slice(0, 8)}; it stays on your list until a reply with that re.` : sent
  }
  if (name === 'yap_claim') {
    if (a.release === 'all') return `released ${(await me.release('all')).released} claims`
    if (a.release) return (await me.release(String(a.release)), `released ${a.release}`)
    const r = await me.claim(String(a.path ?? ''), String(a.why ?? ''))
    return 'held' in r ? `already claimed: ${r.held.path} by @${r.held.name}, ${r.held.why}. Ask them with yap_say before working there.` : `claimed as ${r.id}; release it with yap_claim release "${r.id}" when done`
  }
  if (name === 'yap_board') {
    const ns = await yap.notes(me.cwd)
    return ns.length ? ns.map(n => `#${n.id} ${n.author}: ${n.text}`).join('\n') : 'the board is empty'
  }
  if (name === 'yap_doing') return (await me.doing(String(a.text ?? '')), a.text ? 'the others see it next to your name' : 'cleared')
  if (name === 'yap_note') return `pinned #${(await me.note(String(a.text ?? ''), a.replaces == null ? undefined : Number(a.replaces))).id}`
  if (name === 'yap_spawn') return `started @${(await me.spawn(String(a.task ?? ''), a.agent === 'codex' ? 'codex' : undefined, Array.isArray(a.skills) ? a.skills.map(String) : undefined)).id}; its last word comes back to you through yap_check`
  throw new Error(`no tool ${name}`)
}

/** 2026-07-28 has no handshake: each request names its version in `_meta`. The rest negotiate in `initialize`. */
const MODERN = '2026-07-28'
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const SUPPORTED = [MODERN, ...LEGACY]
const META = 'io.modelcontextprotocol/'

const GUIDE =
  'Other agent sessions may be working in this repo, some in this same working tree. Call yap_check before editing a file or running a git command that switches, resets, stashes or commits, and between steps; do what it says. Message a peer with yap_say.'

/** The join, once per session, on its first request. */
const joins = new WeakMap<YapSession, Promise<Answer>>()

/**
 * One JSON-RPC message in, its reply out (none for a notification). `owned`: this server is the session's only
 * YAP voice, so it joins on its first request, named for the client; a session hooks already report for doesn't.
 */
export async function rpc(me: YapSession, owned: boolean, m: { id?: unknown; method?: string; params?: any }, version: string) {
  if (m.id === undefined) return
  const meta = m.params?._meta ?? {}
  const asked = meta[`${META}protocolVersion`]
  if (asked !== undefined && !SUPPORTED.includes(asked))
    return { jsonrpc: '2.0', id: m.id, error: { code: -32022, message: 'Unsupported protocol version', data: { supported: SUPPORTED, requested: asked } } }
  // A 2026-07-28 result says it is complete and who answered.
  const modern = asked === MODERN
  const ok = (result: Record<string, unknown>) => ({
    jsonrpc: '2.0',
    id: m.id,
    result: modern ? { resultType: 'complete', ...result, _meta: { [`${META}serverInfo`]: { name: 'yap', version } } } : result,
  })

  if (owned && !joins.has(me)) {
    // Codex calls itself `codex-mcp-client`, and kills this process rather than close it: the pid says leave.
    const client = m.method === 'initialize' ? m.params?.clientInfo : meta[`${META}clientInfo`]
    const name = String(client?.name ?? 'mcp').replace(/[-_ ]?mcp[-_ ]?client$/i, '') || 'mcp'
    joins.set(me, me.join(name, process.pid).catch(() => ({}) as Answer))
  }
  const instructions = async () => [GUIDE, tools((await joins.get(me))?.context ?? '')].filter(Boolean).join('\n\n')

  if (m.method === 'initialize') {
    const v = m.params?.protocolVersion
    return ok({ protocolVersion: LEGACY.includes(v) ? v : LEGACY[0], capabilities: { tools: {} }, serverInfo: { name: 'yap', version }, instructions: await instructions() })
  }
  if (m.method === 'server/discover')
    return ok({ supportedVersions: SUPPORTED, capabilities: { tools: {} }, instructions: await instructions(), _meta: { [`${META}serverInfo`]: { name: 'yap', version } } })
  if (m.method === 'ping') return ok({})
  if (m.method === 'tools/list') return ok({ tools: TOOLS, ...(modern ? { ttlMs: 3_600_000, cacheScope: 'public' } : {}) })
  if (m.method === 'tools/call') {
    try {
      return ok({ content: [{ type: 'text', text: await tool(me, m.params?.name, m.params?.arguments ?? {}) }] })
    } catch (e: any) {
      return ok({ content: [{ type: 'text', text: `yap: ${e?.message ?? e}` }], isError: true })
    }
  }
  return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `no method ${m.method}` } }
}
