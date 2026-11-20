#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SETTINGS, type Settings, build, dir, home, settings, url, version } from './env'
import { STALE, ago } from './sessions'
import { type Client, type State, Tui, reader, sheet, status, useColor } from './tui'

const USAGE = `yap                 open the board (starts the daemon if it isn't running)
yap status          every project's rail
yap show <ticket>   one ticket: criteria, verdicts, what was done, journal
yap goal <text>     plan tickets for this repo from a sentence (--rinai files it as an issue too)
yap take <issue>    plan tickets from an issue on this repo's Rinai board
yap go              start this repo's drafted tickets
yap init            make this directory a git repo so the crew can work in it
yap gate [<cmd>]    the command run on every merged result before the base moves; '' turns it off
yap forget [name]   take this repo's project (or the named one) off the board
yap herdr <board|new|go> [popup|tab]   what the Herdr plugin's actions run
yap setup           connect this machine's agents: the plugin in Claude Code, yap's tools in Codex and Cursor
yap hooks           how to get the Claude Code hooks (the plugin), and takes out ones an older yap installed
yap sessions        the Claude Code sessions the hooks have seen, and what each is doing
yap say [--question|--blocker] [--re <id>] [@id] <text>
                    message the other sessions in this repo, or one of them; a question or blocker
                    stays on your list until a reply with --re <its id>
yap spawn [--codex] <text>  start a background Claude Code (or Codex) session here on that task; its last word comes back to you
yap spawns           the background sessions yap started, and how each ended
yap mcp             yap as an MCP server on stdio, for agents without hooks (Codex, Cursor, Zed)
yap config [<key> [<value>]]  yap's settings: spawns, how many background sessions run at once (3)
yap pair <relay>     pair this machine with a YAP relay, so a web client can reach it; prints the pairing code
yap unpair           forget the pairing, here and on the relay: every web client's token stops working
yap bridge           whether this machine is paired, and connected
yap note <text>     pin a note on this repo's board for every session, now and later; -d <id> takes one down
yap notes           this repo's board
yap claim <path> <why>   tell the other sessions you're working under that file or directory; they're warned before editing there
yap release <id>    end a claim early
yap claims          this repo's live claims, every worktree
yap start | stop    the daemon in the background; stop kills running agents and requeues their tickets
yap serve           the daemon in the foreground`

/** The session a command speaks as: the harness's YAP_SESSION, else Claude Code's or Codex's own id; none is the user. */
const me = process.env.YAP_SESSION || process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_THREAD_ID

// Written by the daemon on its first start; read on every call, so a fresh daemon's token is picked up.
const auth = (): Record<string, string> => {
  try {
    return { 'x-yap-token': readFileSync(join(home, 'token'), 'utf8').trim() }
  } catch {
    return {}
  }
}

class HttpClient implements Client {
  async get<T>(path: string) {
    return this.read(await fetch(url + path, { headers: auth() })) as Promise<T>
  }

  async send(method: 'POST' | 'PATCH' | 'DELETE', path: string, body: object = {}) {
    return this.read(await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...auth() }, body: JSON.stringify(body) }))
  }

  private async read(res: Response) {
    const data: any = await res.json().catch(() => {
      throw new Error(res.status === 403 ? 'the daemon refused the request: ~/.yap/token is missing or stale' : `something that isn't yap answers on ${url}; set YAP_PORT`)
    })
    if (!res.ok) throw new Error(data?.error ?? res.statusText)
    return data
  }

  watch(ping: () => void, down: (isDown: boolean) => void) {
    void (async () => {
      for (;;) {
        try {
          const res = await fetch(`${url}/api/stream`, { headers: auth() })
          down(false)
          for await (const _ of res.body!) ping()
        } catch {
          down(true)
          await Bun.sleep(1000)
        }
      }
    })()
  }
}

const api = new HttpClient()
const running = () =>
  fetch(`${url}/api/state`, { signal: AbortSignal.timeout(500), headers: auth() }).then(
    async r => {
      if (r.ok) return r.json().catch(() => null) as Promise<State | null>
      // 403 is a yap daemon whose token this client can't read; anything else on the port isn't yap.
      if (r.status === 403) throw new Error('the daemon refused the request: ~/.yap/token is missing or stale')
      throw new Error(`something that isn't yap answers on ${url}; set YAP_PORT`)
    },
    () => null,
  )

async function daemon() {
  const s = await running()
  if (s) {
    // Replaced by newer code from the same checkout, or by a newer release from another copy (the Claude Code
    // plugin runs from its own), never by an older one; and only once no ticket or spawn is mid-flight.
    const newer = s.dir === dir ? s.build !== build : Bun.semver.order(version, s.version ?? '0.0.0') > 0
    if (!newer || Object.keys(s.activity).length) return
    if ((await api.get<{ done?: number }[]>('/api/spawns')).some(sp => !sp.done)) return
    await api.send('POST', '/api/stop')
    await Bun.sleep(300)
  }
  mkdirSync(home, { recursive: true })
  const log = openSync(join(home, 'daemon.log'), 'a')
  spawn(process.execPath, [join(import.meta.dir, 'server.ts')], { detached: true, stdio: ['ignore', log, log], windowsHide: true }).unref()
  for (let i = 0; i < 50; i++) {
    if (await running()) return
    await Bun.sleep(100)
  }
  throw new Error(`the daemon did not start. See ${join(home, 'daemon.log')}`)
}

/**
 * The repo yap is about. Inside a Herdr plugin pane or action the process starts in the plugin's own
 * directory, so the focused pane's directory comes from Herdr instead.
 */
function target() {
  if (process.env.YAP_CWD) return process.env.YAP_CWD
  try {
    const c = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON ?? '{}')
    if (c.focused_pane_cwd || c.workspace_cwd) return String(c.focused_pane_cwd || c.workspace_cwd)
  } catch {}
  return process.cwd()
}

const seenFile = join(home, 'seen')
const readSeen = () => {
  try {
    return Number(readFileSync(seenFile, 'utf8')) || 0
  } catch {
    return 0
  }
}

// Alternate screen, hidden cursor, mouse reporting (SGR), bracketed paste.
const SCREEN_ON = '\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?2004h'
const SCREEN_OFF = '\x1b[?2004l\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l'

async function board() {
  await daemon()
  const { stdin, stdout } = process
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('the board needs a terminal. Try `yap status`.')

  const screen = (on: boolean) => {
    stdin.setRawMode(on)
    stdout.write(on ? SCREEN_ON : SCREEN_OFF)
  }

  const tui = new Tui(
    api,
    {
      get columns() {
        return stdout.columns
      },
      get rows() {
        return stdout.rows
      },
      write: s => void stdout.write(s),
    },
    {
      cwd: target(),
      seen: readSeen(),
      open: process.env.YAP_OPEN === 'new' ? 'new' : undefined,
      quit() {
        screen(false)
        writeFileSync(seenFile, String(Date.now()))
        process.exit(0)
      },
    },
  )

  useColor(!process.env.NO_COLOR)
  screen(true)
  const read = reader()
  // One at a time, in order: a key must see the state the key before it left.
  let queue = Promise.resolve()
  stdin.on('data', d => {
    for (const k of read(d.toString())) queue = queue.then(() => tui.key(k))
  })
  stdout.on('resize', () => tui.render())
  await tui.start()
}

/** A Herdr plugin action: open the board on the focused pane's repo, or start its drafts. */
async function herdr(what: string | undefined, placement: 'popup' | 'tab') {
  const bin = process.env.HERDR_BIN_PATH || 'herdr'
  const cwd = target()
  const toast = (title: string, body: string) =>
    spawn(bin, ['notification', 'show', title, '--body', body], { stdio: 'ignore', windowsHide: true })
  try {
    if (what === 'go') {
      const p = await here()
      const s = (await running())!
      const goals = new Set(s.tickets.filter(t => t.project_id === p.id && t.status === 'draft').map(t => t.goal_id))
      for (const g of goals) await api.send('POST', `/api/goals/${g}/start`)
      return void toast('yap', goals.size ? `started ${p.name}'s drafts` : `nothing drafted on ${p.name}`)
    }
    if (what !== 'board' && what !== 'new') throw new Error('yap herdr <board|new|go> [popup|tab]')
    await daemon()
    const args = ['plugin', 'pane', 'open', '--plugin', 'yap', '--entrypoint', 'board', '--placement', placement, '--env', `YAP_CWD=${cwd}`, '--focus']
    if (what === 'new') args.push('--env', 'YAP_OPEN=new')
    const r = Bun.spawnSync([bin, ...args], { windowsHide: true })
    if (r.exitCode !== 0) throw new Error(r.stderr.toString().trim() || `herdr exited ${r.exitCode}`)
  } catch (e: any) {
    // An action has no terminal to print to; a toast is the only place an error can be seen.
    toast('yap', String(e?.message ?? e))
    throw e
  }
}

// The project for the current directory, for the one-shot commands agents and scripts use.
async function here(init = false) {
  await daemon()
  return api.send('POST', '/api/projects', { path: target(), init }) as Promise<{ id: number; name: string; tracker: string | null }>
}

/**
 * `yap setup`: every agent on this machine, connected. Claude Code gets the plugin (hooks, which can stop a
 * command); Codex and Cursor get `yap mcp`. Each runs on its own sign-in and plan; yap never sees either.
 */
function setup() {
  const has = (bin: string) => !!Bun.which(bin)
  const run = (...cmd: string[]) => Bun.spawnSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] })
  const out: string[] = []

  const removed = unhook()
  if (!has('claude')) out.push('Claude Code: not installed. Install it, sign in, then run `yap setup` again.')
  else if (/\byap@yap\b/.test(run('claude', 'plugin', 'list').stdout.toString())) out.push('Claude Code: the yap plugin is already in.')
  else {
    run('claude', 'plugin', 'marketplace', 'add', 'noxire-dev/yap')
    const r = run('claude', 'plugin', 'install', 'yap@yap')
    out.push(r.success ? 'Claude Code: installed the yap plugin. Sessions started from now on use it.' : `Claude Code: installing the plugin failed (${r.stderr.toString().trim() || r.exitCode}). Run \`claude plugin install yap@yap\`.`)
  }
  if (removed) out.push(`Claude Code: took out ${removed} hooks an older yap put in your settings (backup: settings.json.bak-yap).`)

  // Codex's hooks speak Claude Code's format: the same adapter, through `yap hook`, which runs where sh doesn't.
  const codex = join(homedir(), '.codex', 'hooks.json')
  if (!has('codex')) out.push('Codex: not installed.')
  else {
    let cfg: { hooks?: Record<string, unknown[]> } | null = {}
    try {
      if (existsSync(codex)) cfg = JSON.parse(readFileSync(codex, 'utf8'))
    } catch {
      cfg = null
    }
    if (!cfg) out.push(`Codex: ${codex} isn't plain JSON, so it is left alone.`)
    else if (JSON.stringify(cfg).includes('yap hook ')) out.push("Codex: yap's hooks are already in.")
    else {
      const on = (event: string, ev: string, o: object = {}) => ({ ...o, hooks: [{ type: 'command', command: `yap hook ${ev} codex`, timeout: event === 'SessionEnd' ? 3 : 10 }] })
      const ours: Record<string, object> = {
        SessionStart: on('SessionStart', 'start'),
        UserPromptSubmit: on('UserPromptSubmit', 'prompt'),
        Stop: on('Stop', 'stop'),
        PreToolUse: on('PreToolUse', 'pre', { matcher: 'Bash|apply_patch' }),
        PostToolUse: on('PostToolUse', 'post', { matcher: 'Bash|apply_patch' }),
        SessionEnd: on('SessionEnd', 'end'),
      }
      const hooks = { ...cfg.hooks }
      for (const [event, entry] of Object.entries(ours)) hooks[event] = [...(hooks[event] ?? []), entry]
      mkdirSync(join(homedir(), '.codex'), { recursive: true })
      writeFileSync(codex, JSON.stringify({ ...cfg, hooks }, null, 2) + '\n')
      out.push(`Codex: added yap's hooks to ${codex}. Codex runs a hook only once you trust it: open \`codex\`, type /hooks and trust the six yap ones.`)
    }
  }

  const cursor = join(homedir(), '.cursor')
  if (!existsSync(cursor)) out.push('Cursor: not installed.')
  else {
    const file = join(cursor, 'mcp.json')
    let cfg: { mcpServers?: Record<string, unknown> } | null = {}
    try {
      if (existsSync(file)) cfg = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      cfg = null
    }
    if (!cfg) out.push(`Cursor: ${file} isn't plain JSON, so it is left alone. Add "yap": {"command": "yap", "args": ["mcp"]} under mcpServers.`)
    else if (cfg.mcpServers?.yap) out.push('Cursor: yap is already in its MCP servers.')
    else {
      writeFileSync(file, JSON.stringify({ ...cfg, mcpServers: { ...cfg.mcpServers, yap: { command: 'yap', args: ['mcp'] } } }, null, 2) + '\n')
      out.push(`Cursor: added yap to ${file}.`)
    }
  }
  out.push('', "Each agent runs on your own plan: sign in inside it if you haven't (`claude`, `codex login`). yap never sees the sign-in.")
  return out.join('\n')
}

/**
 * `yap hook <event> [codex]`: one agent hook, as hooks/yap.sh is for Claude Code, where sh isn't there (Codex on
 * Windows runs hooks through cmd). The event's JSON to the daemon, its answer out. Never fails: a hook must not
 * break the session.
 */
async function hook(event: string, codex: boolean) {
  if (process.env.YAP_AGENT) return
  try {
    const input = await new Response(Bun.stdin.stream()).text()
    if (event === 'start') await daemon()
    const id = (me || (JSON.parse(input).session_id ?? '')).replace(/[^\w-]/g, '')
    const cursor = join(home, 'sessions', `${id}.cursor`)
    let ack = ''
    try {
      ack = readFileSync(cursor, 'utf8').trim()
    } catch {}
    const q = new URLSearchParams({ ...(ack ? { ack } : {}), ...(me ? { session: me } : {}), ...(codex ? { for: 'codex' } : {}), ...(process.env.HC_TERMINAL_ID ? { terminal: process.env.HC_TERMINAL_ID } : {}) })
    const res = await fetch(`${url}/api/hook/${event}?${q}`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth() }, body: input, signal: AbortSignal.timeout(2000) })
    const body = await res.text()
    if (!res.ok) return
    if (body !== '{}') process.stdout.write(body)
    if (!id) return
    if (event === 'end') rmSync(cursor, { force: true })
    const seq = res.headers.get('x-yap-seq')
    if (seq && /^\d+$/.test(seq)) {
      mkdirSync(join(home, 'sessions'), { recursive: true })
      writeFileSync(cursor, seq)
    }
  } catch {}
}

/** Take out the hooks `yap hooks --install` once put in the user's settings: the plugin carries them now. */
function unhook() {
  const file = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json')
  let settings: any
  try {
    settings = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return 0
  }
  let n = 0
  for (const [event, groups] of Object.entries<any[]>(settings.hooks ?? {})) {
    const kept = groups.filter(g => !JSON.stringify(g).includes('/api/hook/'))
    n += groups.length - kept.length
    if (kept.length) settings.hooks[event] = kept
    else delete settings.hooks[event]
  }
  if (n) {
    writeFileSync(`${file}.bak-yap`, readFileSync(file))
    writeFileSync(file, JSON.stringify(settings, null, 2) + '\n')
  }
  return n
}

/** `yap mcp`: stdout carries only JSON-RPC, so anything else goes to stderr. */
async function mcp() {
  const { YapLocal } = await import('../sdk/local')
  const { rpc } = await import('./mcp')
  await daemon()
  const yap = await YapLocal.connect()
  // A session the hooks or a harness already report for (YAP_SESSION) is theirs to join and leave.
  const session = yap.session(me || `mcp-${crypto.randomUUID().slice(0, 8)}`, target())
  const out = (m: unknown) => m && process.stdout.write(JSON.stringify(m) + '\n')
  for await (const line of console) {
    if (!line.trim()) continue
    let m: any
    try {
      m = JSON.parse(line)
    } catch {
      out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'not JSON' } })
      continue
    }
    out(await rpc(session, !me, m, version))
  }
  if (!me) await session.leave().catch(() => {})
}

const [cmd, ...rest] = process.argv.slice(2)
const cols = process.stdout.columns || 100
try {
  useColor(!!process.stdout.isTTY && !process.env.NO_COLOR)
  if (!cmd) await board()
  else if (cmd === 'serve') await import('./server')
  else if (cmd === 'start') await daemon()
  else if (cmd === 'status') {
    const s = await running()
    console.log(s ? status(s, cols, readSeen()) : 'the daemon is not running. `yap` starts it.')
  } else if (cmd === 'show') {
    const id = Number(String(rest[0]).replace(/^t/, ''))
    const s = await running()
    const t = s?.tickets.find(t => t.id === id)
    if (!s || !t) throw new Error(`no ticket t${rest[0]}`)
    console.log(sheet(t, await api.get(`/api/events?ticket=${id}`), s.goals.find(g => g.id === t.goal_id), Math.min(cols, 110)).join('\n'))
  } else if (cmd === 'goal') {
    const file = rest.includes('--rinai')
    const text = rest.filter(a => a !== '--rinai').join(' ').trim()
    if (!text) throw new Error('yap goal <what you want done>')
    const p = await here()
    const g = await api.send('POST', '/api/goals', { project_id: p.id, text, file })
    console.log(`goal ${g.id} on ${p.name}${g.issue ? ` (rinai #${g.issue})` : ''}: a planner is drafting tickets. \`yap status\` shows them, \`yap go\` starts them.`)
  } else if (cmd === 'take') {
    const n = Number(String(rest[0]).replace(/^#/, ''))
    const p = await here()
    const card = (await api.get<{ number: number; title: string }[]>(`/api/projects/${p.id}/cards`)).find(c => c.number === n)
    if (!card) throw new Error(`#${rest[0]} is not an open issue on ${p.tracker ?? 'this repo'}`)
    const g = await api.send('POST', '/api/goals', { project_id: p.id, issue: n, title: card.title })
    console.log(`goal ${g.id} on ${p.name} from #${n}: a planner is drafting tickets. \`yap go\` starts them.`)
  } else if (cmd === 'go') {
    const p = await here()
    const s = (await running())!
    const goals = new Set(s.tickets.filter(t => t.project_id === p.id && t.status === 'draft').map(t => t.goal_id))
    for (const g of goals) await api.send('POST', `/api/goals/${g}/start`)
    console.log(goals.size ? `started the drafts of ${goals.size} goal${goals.size === 1 ? '' : 's'} on ${p.name}` : `nothing to start on ${p.name}: no drafts`)
  } else if (cmd === 'sessions') {
    if (!(await running())) throw new Error('the daemon is not running, so no session is being tracked')
    const list = await api.get<{ id: string; name: string; top: string; at: number; files: string[]; undelivered?: { from: string; text: string }[]; unanswered?: { id: string; kind: string; to: string[]; text: string }[] }[]>('/api/sessions')
    const show = (s: (typeof list)[number]) =>
      [
        `${s.id.slice(0, 8)}  ${ago(s.at).padStart(8)}  ${s.name ? `@${s.name}  ` : ''}${s.top}`,
        ...(s.files.length ? [`          edited ${s.files.length}: ${s.files.slice(-3).join(', ')}`] : []),
        ...(s.undelivered ?? []).map(m => `          undelivered, from ${m.from}: ${m.text.split('\n')[0].slice(0, 80)}`),
        ...(s.unanswered ?? []).map(q => `          unanswered ${q.kind} ${q.id.slice(0, 8)} to ${q.to.join(', ')}: ${q.text.split('\n')[0].slice(0, 80)}`),
      ].join('\n')
    console.log(list.length ? list.map(show).join('\n') : 'no sessions')
  } else if (cmd === 'say') {
    let kind: string | undefined
    let re: string | undefined
    for (;;) {
      if (rest[0] === '--question' || rest[0] === '--blocker') kind = rest.shift()!.slice(2)
      else if (rest[0] === '--re') (rest.shift(), (re = rest.shift()))
      else break
    }
    const to = rest[0]?.startsWith('@') ? rest.shift() : undefined
    await daemon()
    const r = await api.send('POST', '/api/say', { from: me, cwd: target(), to, text: rest.join(' '), kind, re })
    if (kind) console.log(`${kind} ${r.id.slice(0, 8)}: a reply with \`--re ${r.id.slice(0, 8)}\` takes it off your list`)
    const asleep = r.to.filter((id: string) => !r.woke.includes(id))
    console.log([r.woke.length && `${r.woke.join(', ')} was idle and is reading it now`, asleep.length && `left for ${asleep.join(', ')}: they read it on their next tool call or prompt`].filter(Boolean).join('; '))
  } else if (cmd === 'claim' || cmd === 'release' || cmd === 'claims') {
    await daemon()
    const cwd = target()
    if (cmd === 'claims') {
      const cs = await api.send('POST', '/yap/claims', { cwd })
      console.log(cs.length ? cs.map((c: any) => `${c.id}  @${c.name}  ${c.path}  for ${Math.max(0, Math.round((c.expires - Date.now()) / 60_000))}m: ${c.why}`).join('\n') : 'no claims')
    } else if (cmd === 'release') {
      await api.send('POST', '/yap/release', { session: me, cwd, id: rest[0] })
      console.log(`released ${rest[0]}`)
    } else {
      const r = await api.send('POST', '/yap/claim', { session: me, cwd, path: rest.shift() ?? '', why: rest.join(' ') })
      console.log(r.held ? `already claimed: ${r.held.path} by @${r.held.name}, ${r.held.why}. Ask them first: yap say @${r.held.name} <text>` : `claimed as ${r.id}: the others are warned before they edit there, for 20 minutes past your last edit under it. \`yap release ${r.id}\` ends it.`)
    }
  } else if (cmd === 'spawn') {
    await daemon()
    // Codex when asked, or when it is the only agent here: the session runs on whichever plan the user has.
    const codex = rest[0] === '--codex' ? !!rest.shift() : !Bun.which('claude') && !!Bun.which('codex')
    const r = await api.send('POST', '/yap/spawn', { session: me, cwd: target(), text: rest.join(' '), agent: codex ? 'codex' : undefined })
    console.log(`started @${r.id} in the background. It is a peer: \`yap say @${r.id}\` reaches it. Its last word comes ${me ? 'to this session when it finishes' : 'back in `yap spawns`'}.`)
  } else if (cmd === 'pair') {
    const relay = String(rest[0] ?? '').replace(/\/$/, '')
    if (!/^https?:\/\//.test(relay)) throw new Error('yap pair <relay url>, like https://relay.example.com')
    const r = await fetch(`${relay}/pair`, { method: 'POST' })
    if (!r.ok) throw new Error(`the relay said ${r.status}`)
    const { device, secret, code } = (await r.json()) as { device: string; secret: string; code: string }
    writeFileSync(join(home, 'bridge.json'), JSON.stringify({ relay, device, secret }), { mode: 0o600 })
    await daemon()
    await api.send('POST', '/api/bridge')
    console.log(`paired with ${relay}. Enter this code where you connect, within ten minutes; it works once:\n\n  ${device}.${code}\n\nWhoever holds it can start agents in your registered projects and message their sessions. \`yap unpair\` takes that back.`)
  } else if (cmd === 'unpair') {
    const file = join(home, 'bridge.json')
    let p: { relay: string; device: string; secret: string } | null = null
    try {
      p = JSON.parse(readFileSync(file, 'utf8'))
    } catch {}
    if (!p) throw new Error('this machine is not paired')
    const r = await fetch(`${p.relay}/d/${p.device}`, { method: 'DELETE', headers: { authorization: `Bearer ${p.secret}` } }).catch(() => null)
    rmSync(file)
    if (await running()) await api.send('POST', '/api/bridge')
    console.log(r?.ok ? `unpaired from ${p.relay}` : `forgot the pairing here; the relay ${r ? `said ${r.status}` : "couldn't be reached"}, so tokens it issued may still be stored there, with nothing to reach`)
  } else if (cmd === 'bridge') {
    if (!(await running())) throw new Error('the daemon is not running')
    const b = await api.get<{ relay?: string; device?: string; connected?: boolean }>('/api/bridge')
    console.log(b.relay ? `paired with ${b.relay} as ${b.device}, ${b.connected ? 'connected' : 'not connected right now'}` : 'not paired. `yap pair <relay>` pairs it')
  } else if (cmd === 'spawns') {
    if (!(await running())) throw new Error('the daemon is not running, so nothing it started is running')
    const list = await api.get<{ id: string; name: string; task: string; started: number; done?: number; ok?: boolean; result?: string }[]>('/api/spawns')
    const show = (s: (typeof list)[number]) =>
      [
        `${s.id}  ${ago(s.started).padStart(8)}  ${s.name ? `@${s.name}  ` : ''}${s.done ? (s.ok ? 'finished' : 'failed') : 'running'}  ${s.task.slice(0, 80)}`,
        ...(s.result ? s.result.split(/\r?\n/).map(l => `          ${l}`) : []),
      ].join('\n')
    console.log(list.length ? list.slice(0, 20).map(show).join('\n') : 'nothing spawned yet')
  } else if (cmd === 'config') {
    const [key, value] = rest
    const now = settings()
    if (!key) console.log(Object.entries(now).map(([k, v]) => `${k} ${v}`).join('\n'))
    else if (!(key in SETTINGS)) throw new Error(`no setting ${key}; there are ${Object.keys(SETTINGS).join(', ')}`)
    else if (value === undefined) console.log(now[key as keyof Settings])
    else {
      const n = Number(value)
      if (!Number.isInteger(n) || n < 1) throw new Error(`${key} takes a whole number, 1 or more`)
      mkdirSync(home, { recursive: true })
      writeFileSync(join(home, 'config.json'), JSON.stringify({ ...now, [key]: n }, null, 2) + '\n')
      console.log(`${key} ${n}`)
    }
  } else if (cmd === 'note' || cmd === 'notes') {
    await daemon()
    const cwd = target()
    if (cmd === 'note' && rest[0] === '-d') {
      await api.send('DELETE', `/api/notes/${Number(String(rest[1]).replace(/^#/, ''))}`, { cwd })
      console.log(`took #${String(rest[1]).replace(/^#/, '')} down`)
    } else if (cmd === 'note') {
      const n = await api.send('POST', '/api/notes', { from: me, cwd, text: rest.join(' ') })
      console.log(`pinned #${n.id}: every session in this repo sees it`)
    } else {
      const ns = await api.get<{ id: number; ts: number; author: string; text: string }[]>(`/api/notes?cwd=${encodeURIComponent(cwd)}`)
      console.log(ns.length ? ns.map(n => `#${n.id}  ${ago(n.ts)}${Date.now() - n.ts > STALE ? ', may be stale' : ''}  ${n.author}\n      ${n.text}`).join('\n') : 'the board is empty')
    }
  } else if (cmd === 'hook') {
    await hook(rest[0] ?? '', rest[1] === 'codex')
  } else if (cmd === 'setup') {
    console.log(setup())
  } else if (cmd === 'mcp') {
    await mcp()
  } else if (cmd === 'hooks') {
    const n = unhook()
    console.log(
      `${n ? `Took yap's old hooks out of your Claude Code settings (${n}). ` : ''}yap's hooks come with its Claude Code plugin:\n  claude plugin marketplace add noxire-dev/yap\n  claude plugin install yap@yap`,
    )
  } else if (cmd === 'herdr') {
    await herdr(rest[0], rest[1] === 'tab' ? 'tab' : 'popup')
  } else if (cmd === 'gate') {
    const p = await here()
    if (rest.length) await api.send('PATCH', `/api/projects/${p.id}`, { gate: rest.join(' ') })
    const now = ((await running())!.projects.find(x => x.id === p.id)!).gate
    console.log(now ? `${p.name}'s gate: ${now}` : `${p.name} has no gate: the reviewer is the only check`)
  } else if (cmd === 'init') {
    console.log(`${(await here(true)).name} is ready for the crew`)
  } else if (cmd === 'forget') {
    await daemon()
    const p = await api.send('POST', '/api/projects/forget', { name: rest[0] ?? '', path: target() })
    console.log(`${p.name} is off the board`)
  } else if (cmd === 'stop') {
    console.log((await running()) ? (await api.send('POST', '/api/stop'), 'stopped') : 'not running')
  } else console.log(USAGE)
} catch (e: any) {
  console.error(`yap: ${e?.message ?? e}`)
  process.exit(1)
}
