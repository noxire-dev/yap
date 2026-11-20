import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { childEnv } from './env'
import type { Agent, AgentRun, AgentRunner } from './ports'

/** The runner for the run's `agent`: a background session runs on whichever plan the user has. */
export class Agents implements AgentRunner {
  constructor(private by: Record<Agent, AgentRunner>) {}
  run(o: AgentRun) {
    return this.by[o.agent ?? 'claude'].run(o)
  }
}

/**
 * Headless Codex, for a peer only: `codex exec` in the workspace sandbox, never asking. Its hooks (yap setup)
 * report under the peer's id through YAP_SESSION, the way a Claude peer's do under --session-id.
 */
export class CodexCli implements AgentRunner {
  async run({ cwd, prompt, signal, peer }: AgentRun) {
    const dir = mkdtempSync(join(tmpdir(), 'yap-codex-'))
    const last = join(dir, 'last.txt')
    try {
      const yap = Object.fromEntries(['YAP_HOME', 'YAP_PORT'].filter(k => process.env[k]).map(k => [k, process.env[k]!]))
      const args = ['codex', 'exec', '-s', 'workspace-write', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '-o', last, '-']
      const p = Bun.spawn(args, { cwd, stdin: 'pipe', stdout: 'ignore', stderr: 'pipe', signal, windowsHide: true, env: { ...childEnv(), ...codexAuth(), ...yap, ...(peer ? { YAP_SESSION: peer } : {}) } })
      p.stdin.write(prompt)
      p.stdin.end()
      const stderr = new Response(p.stderr).text()
      await p.exited
      let text = ''
      try {
        text = readFileSync(last, 'utf8').trim()
      } catch {}
      const ok = p.exitCode === 0
      // Its stderr is mostly warnings and MCP chatter; Codex's own failure is the `ERROR: ` line.
      const lines = (await stderr).trim().split(/\r?\n/)
      if (!text) text = [...new Set(lines.filter(l => l.startsWith('ERROR: ')))].join('\n') || lines.slice(-3).join('\n') || `codex exited ${p.exitCode}`
      return { ok, text }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/**
 * Claude Code in a live herdr-core terminal (the Herdr app's `hc`), not `-p`: the person can watch it, type into it,
 * take it over, and answer whatever it asks (a folder it isn't trusted in, a permission). Its task goes in through a
 * file, its answer comes back as its last message in the session's transcript. A finished run's terminal is closed;
 * a failed one stays for the person to look at.
 */
export class LiveClaude implements AgentRunner {
  constructor(
    private hc: string,
    private transcripts = join(homedir(), '.claude', 'projects'),
  ) {}

  private async call(args: string[], signal?: AbortSignal) {
    const p = Bun.spawn([this.hc, ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', windowsHide: true, signal })
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
    if ((await p.exited) !== 0) throw new Error(`hc ${args[0]}: ${err.trim() || out.trim()}`)
    return out.trim() ? JSON.parse(out) : {}
  }

  /** The session's last words: its final assistant message, from Claude Code's transcript. */
  private answer(id: string) {
    for (const d of readdirSync(this.transcripts)) {
      let lines: string[]
      try {
        lines = readFileSync(join(this.transcripts, d, `${id}.jsonl`), 'utf8').trim().split('\n')
      } catch {
        continue
      }
      for (const l of lines.reverse()) {
        const m = JSON.parse(l)
        if (m.type !== 'assistant') continue
        const text = (m.message?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')
        if (text) return text
      }
    }
    return ''
  }

  async run({ cwd, prompt, readOnly, schema, signal, onActivity, peer }: AgentRun) {
    const id = peer ?? randomUUID()
    const name = `crew-${id.slice(0, 8)}`
    const dir = mkdtempSync(join(tmpdir(), 'yap-live-'))
    const task = join(dir, 'task.md')
    writeFileSync(task, schema ? `${prompt}\n\nEnd your turn with only a JSON object matching this schema, nothing before or after it:\n${JSON.stringify(schema)}\n` : prompt)
    // The prompt first: --tools and --add-dir take every value after them.
    const claude = ['claude', `Your task is in ${task}. Read it and do it.`, '--session-id', id, '--add-dir', dir, ...(readOnly ? ['--tools', 'Read,Grep,Glob'] : ['--permission-mode', 'auto'])]
    const t = await this.call(['run', '--bg', '--json', '--no-parent', '--name', name, '--cwd', cwd, '--label', 'yap.crew=1', '--', ...claude])
    const kill = () => this.call(['kill', t.address]).catch(() => {})
    signal?.addEventListener('abort', kill, { once: true })
    try {
      // Until it is done, or idle with something said: right after launch an agent is idle with nothing yet.
      const started = Date.now()
      for (let asked = ''; ; ) {
        if (signal?.aborted) return { ok: false, text: 'stopped' }
        await this.call(['wait', t.address, '--json', '--timeout', '60'], signal).catch(() => {})
        const g = await this.call(['get', t.address, '--json'])
        if (g.state !== 'live') break
        const s = typeof g.status === 'string' ? g.status : g.status?.state
        if (s === 'done' || (s === 'idle' && this.answer(id))) break
        // Idle and silent this long: the task never reached it.
        if (s === 'idle' && Date.now() - started > 120_000) return { ok: false, text: `${name} sat idle without starting; its terminal ${t.address} is left open` }
        if (s === 'blocked' && g.status?.msg !== asked) onActivity?.(`${name} waits on you: ${(asked = g.status?.msg ?? 'a question')}`)
        if (s === 'blocked' || s === 'idle') await Bun.sleep(3000)
      }
      const text = this.answer(id)
      if (!text) return { ok: false, text: `${name} ended without an answer; its terminal ${t.address} is left open` }
      let data: unknown
      if (schema)
        try {
          data = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
        } catch {}
      await kill()
      return { ok: true, text, data }
    } finally {
      signal?.removeEventListener('abort', kill)
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** OpenAI's own key, when Codex signs in with one rather than a ChatGPT plan. */
function codexAuth() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(openai_api_key|codex_api_key)$/i.test(k)))
}

/** Headless Claude Code. One process per run, so every run starts with a clean context. */
export class ClaudeCli implements AgentRunner {
  async run({ cwd, prompt, readOnly, schema, signal, onActivity, peer }: AgentRun) {
    const args = ['claude', '-p', '--output-format', 'stream-json', '--verbose']
    // No human is there to answer a prompt: anything that would ask is denied.
    args.push('--permission-prompts', 'none', '--strict-mcp-config', '--no-session-persistence')
    if (readOnly) args.push('--tools', 'Read,Grep,Glob')
    else args.push('--permission-mode', 'auto')
    if (schema) args.push('--json-schema', JSON.stringify(schema))
    if (peer) args.push('--session-id', peer)

    // YAP_AGENT keeps the crew out of the session registry: its hooks see it and stay quiet. A peer's hooks report,
    // so they need to find this daemon.
    const yap = peer ? Object.fromEntries(['YAP_HOME', 'YAP_PORT'].filter(k => process.env[k]).map(k => [k, process.env[k]!])) : { YAP_AGENT: '1' }
    const p = Bun.spawn(args, { cwd, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', signal, windowsHide: true, env: { ...childEnv(), ...auth(), ...yap } })
    p.stdin.write(prompt)
    p.stdin.end()
    const stderr = new Response(p.stderr).text()

    let ok = false
    let text = ''
    let data: unknown
    let buf = ''
    const decoder = new TextDecoder()
    for await (const chunk of p.stdout) {
      buf += decoder.decode(chunk, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop()!
      for (const line of lines) {
        let msg: any
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.type === 'assistant') {
          for (const block of msg.message?.content ?? []) {
            if (block.type === 'text') text = block.text
            if (block.type !== 'tool_use') continue
            if (block.name === 'StructuredOutput') data = block.input
            else onActivity?.(activity(block.name, block.input ?? {}))
          }
        } else if (msg.type === 'result') {
          ok = !msg.is_error
          if (typeof msg.result === 'string' && msg.result) text = msg.result
          data = msg.structured_output ?? data
        }
      }
    }
    await p.exited
    if (!ok && !text) text = (await stderr).trim() || `claude exited ${p.exitCode}`
    return { ok, text, data }
  }
}

/**
 * Claude's own credentials, if it signs in with one. They reach the shell commands it runs too: Claude Code's
 * CLAUDE_CODE_SUBPROCESS_ENV_SCRUB would keep them out, but in 2.1.310 it also makes auto mode deny every write.
 */
function auth() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(anthropic_\w+|claude_code_oauth_token)$/i.test(k)))
}

function activity(tool: string, input: Record<string, unknown>) {
  const detail = input.command ?? input.file_path ?? input.pattern ?? input.description ?? ''
  return `${tool} ${String(detail).replace(/\s+/g, ' ')}`.trim().slice(0, 140)
}
