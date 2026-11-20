import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
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

/** OpenAI's own key, when Codex signs in with one rather than a ChatGPT plan. */
function codexAuth() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(openai_api_key|codex_api_key)$/i.test(k)))
}

/** Headless Claude Code. One process per run, so every run starts with a clean context. */
export class ClaudeCli implements AgentRunner {
  async run(o: AgentRun) {
    const { cwd, prompt, signal, onActivity, onText, peer, chat } = o
    const args = claudeArgs(o, carried())
    // A board run's folder is yap's own and may not exist yet: it is where the run stands, nothing is read there.
    if (o.only) mkdirSync(cwd, { recursive: true })

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
            if (block.type === 'text') (text = block.text), onText?.(block.text)
            if (block.type !== 'tool_use') continue
            if (block.name === 'StructuredOutput') data = block.input
            else onActivity?.(activity(block.name, block.input ?? {}, chat ? Infinity : 140)) // a chat roots paths first, then cuts
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

/** The `claude` command line for a run. Pure, so the check can read it. */
export function claudeArgs({ readOnly, only, schema, peer, chat }: AgentRun, settings: Record<string, unknown> = {}) {
  const args = ['claude', '-p', '--output-format', 'stream-json', '--verbose']
  // No human is there to answer a prompt: anything that would ask is denied.
  args.push('--permission-prompts', 'none', '--strict-mcp-config')
  // A chat keeps its session so the next message resumes it; every other run starts clean and leaves nothing.
  if (chat) args.push(chat.resume ? '--resume' : '--session-id', chat.session, '--append-system-prompt', chat.system)
  else args.push('--no-session-persistence')
  if (only) {
    // No built-in tool, only the server's. dontAsk refuses whatever is not allowed, and no settings file is read: a
    // user's defaultMode bypassPermissions or allow rules would otherwise win. Their sign-in settings come back in.
    args.push('--tools', '', '--mcp-config', JSON.stringify({ mcpServers: { [only.name]: { command: only.command, args: only.args } } }))
    args.push('--allowedTools', `mcp__${only.name}`, '--permission-mode', 'dontAsk', '--setting-sources', '')
    if (Object.keys(settings).length) args.push('--settings', JSON.stringify(settings))
  } else if (readOnly) args.push('--tools', 'Read,Grep,Glob')
  else args.push('--permission-mode', 'auto')
  if (schema) args.push('--json-schema', JSON.stringify(schema))
  if (peer) args.push('--session-id', peer)
  return args
}

/**
 * What of the user's Claude Code settings a run that reads none keeps: everything but what could widen it. How they
 * sign in (apiKeyHelper, Bedrock's awsAuthRefresh, forceLoginMethod, a gateway's env), their model, stay; their
 * permissions, hooks and MCP servers do not.
 */
export function carriedFrom(s: Record<string, unknown>) {
  const WIDEN = ['permissions', 'hooks', 'enableAllProjectMcpServers', 'enabledMcpjsonServers', 'disabledMcpjsonServers', 'mcpServers', 'statusLine', 'enabledPlugins', 'extraKnownMarketplaces']
  return Object.fromEntries(Object.entries(s).filter(([k]) => !WIDEN.includes(k)))
}
function carried() {
  try {
    const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
    return carriedFrom(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')))
  } catch {
    return {}
  }
}

/**
 * Claude's own credentials, if it signs in with one. They reach the shell commands it runs too: Claude Code's
 * CLAUDE_CODE_SUBPROCESS_ENV_SCRUB would keep them out, but in 2.1.310 it also makes auto mode deny every write.
 */
function auth() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(anthropic_\w+|claude_code_oauth_token)$/i.test(k)))
}

function activity(tool: string, input: Record<string, unknown>, max = 140) {
  const detail = input.command ?? input.file_path ?? input.pattern ?? input.description ?? ''
  return `${tool} ${String(detail).replace(/\s+/g, ' ')}`.trim().slice(0, max)
}
