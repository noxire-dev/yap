import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { GH_ENV } from './board'
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
  async run({ cwd, prompt, signal, peer, only }: AgentRun) {
    // Codex has no way to drop its own tools for an MCP server's alone: a board run here would not be confined.
    if (only) throw new Error('a board chat runs on Claude Code only')
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
    // A run with named skills reads no settings file either: yap and those skills are all it loads.
    const lean = o.skills?.length && !o.only ? skillPlugins(o.skills) : null
    // Only a board run and a lean one read no settings file, so only they need the user's carried in.
    const args = claudeArgs(o, o.only || lean ? carried() : {}, lean ? [YAP_PLUGIN, ...lean.dirs] : [])
    // A board run's folder is yap's own and may not exist yet: it is where the run stands, nothing is read there.
    if (o.only) mkdirSync(cwd, { recursive: true })

    // YAP_AGENT keeps the crew out of the session registry: its hooks see it and stay quiet. A peer's hooks report,
    // so they need to find this daemon.
    const yap = peer ? Object.fromEntries(['YAP_HOME', 'YAP_PORT'].filter(k => process.env[k]).map(k => [k, process.env[k]!])) : { YAP_AGENT: '1' }
    // A board run's server is gh: a gh signed in by environment needs that environment. The run has no shell to read it.
    const gh = o.only ? Object.fromEntries(GH_ENV.filter(k => process.env[k]).map(k => [k, process.env[k]!])) : {}
    const p = Bun.spawn(args, { cwd, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', signal, windowsHide: true, env: { ...childEnv(), ...auth(), ...yap, ...gh } })
    if (lean?.tmp) void p.exited.then(() => rmSync(lean.tmp!, { recursive: true, force: true }))
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
export function claudeArgs({ readOnly, only, schema, peer, chat }: AgentRun, settings: Record<string, unknown> = {}, plugins: string[] = []) {
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
  // A lean run: none of the user's settings, plugins or skills, only these plugin folders (yap's, the skills asked for).
  if (plugins.length && !only) {
    args.push('--setting-sources', '', ...plugins.flatMap(d => ['--plugin-dir', d]))
    if (Object.keys(settings).length) args.push('--settings', JSON.stringify(settings))
  }
  if (schema) args.push('--json-schema', JSON.stringify(schema))
  if (peer) args.push('--session-id', peer)
  return args
}

/** This repo is yap's Claude Code plugin: a lean run loads its hooks from here, as the installed plugin would. */
const YAP_PLUGIN = resolve(import.meta.dir, '..')

/**
 * Where each named skill lives, as folders for --plugin-dir. A name is an installed plugin (`ponytail`, or one of its
 * skills, `ponytail:ponytail-review`, which loads the whole plugin and its hooks), or a skill of the user's own in
 * `~/.claude/skills`, copied into one throwaway plugin (`tmp`, removed when the run ends). Throws on a name that is
 * neither, before anything starts.
 */
export function skillPlugins(names: string[], dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')) {
  let installed: Record<string, { installPath: string }[]> = {}
  try {
    installed = JSON.parse(readFileSync(join(dir, 'plugins', 'installed_plugins.json'), 'utf8')).plugins ?? {}
  } catch {}
  const plugin = (name: string) => Object.entries(installed).find(([k]) => k.split('@')[0] === name)?.[1]?.[0]?.installPath
  const dirs = new Set<string>()
  const own: string[] = []
  for (const name of names) {
    const p = plugin(name.split(':')[0])
    if (p) dirs.add(p)
    else if (!name.includes(':') && existsSync(join(dir, 'skills', name, 'SKILL.md'))) own.push(name)
    else throw new Error(`no plugin or skill named ${name}: an installed plugin (claude plugin list), or a folder in ${join(dir, 'skills')}`)
  }
  if (!own.length) return { dirs: [...dirs] }
  const tmp = mkdtempSync(join(tmpdir(), 'yap-skills-'))
  mkdirSync(join(tmp, '.claude-plugin'))
  writeFileSync(join(tmp, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'skills', version: '0.0.0', description: "the user's skills a yap spawn was asked to load" }))
  for (const name of own) cpSync(join(dir, 'skills', name), join(tmp, 'skills', name), { recursive: true })
  return { dirs: [...dirs, tmp], tmp }
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
