#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { build, home, url } from './env'
import { type Client, type State, Tui, reader, sheet, status, useColor } from './tui'

const USAGE = `kumi                 open the board (starts the daemon if it isn't running)
kumi status          every project's rail
kumi show <ticket>   one ticket: criteria, verdicts, what was done, journal
kumi goal <text>     plan tickets for this repo from a sentence (--rinai files it as an issue too)
kumi take <issue>    plan tickets from an issue on this repo's Rinai board
kumi go              start this repo's drafted tickets
kumi init            make this directory a git repo so the crew can work in it
kumi forget [name]   take this repo's project (or the named one) off the board
kumi herdr <board|new|go> [popup|tab]   what the Herdr plugin's actions run
kumi hooks [--install]  the Claude Code hooks for parallel sessions; --install puts them in ~/.claude/settings.json
kumi sessions        the Claude Code sessions the hooks have seen, and what each is doing
kumi say [@id] <text>  message the other Claude Code sessions in this repo, or one of them
kumi note <text>     pin a note on this repo's board for every session, now and later; -d <id> takes one down
kumi notes           this repo's board
kumi start | stop    the daemon in the background; stop kills running agents and requeues their tickets
kumi serve           the daemon in the foreground`

// Written by the daemon on its first start; read on every call, so a fresh daemon's token is picked up.
const auth = (): Record<string, string> => {
  try {
    return { 'x-kumi-token': readFileSync(join(home, 'token'), 'utf8').trim() }
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
      throw new Error(res.status === 403 ? 'the daemon refused the request: ~/.kumi/token is missing or stale' : `something that isn't kumi answers on ${url}; set KUMI_PORT`)
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
      // 403 is a kumi daemon whose token this client can't read; anything else on the port isn't kumi.
      if (r.status === 403) throw new Error('the daemon refused the request: ~/.kumi/token is missing or stale')
      throw new Error(`something that isn't kumi answers on ${url}; set KUMI_PORT`)
    },
    () => null,
  )

async function daemon() {
  const s = await running()
  if (s) {
    // A daemon from before the last code change keeps serving until nothing is mid-flight.
    if (s.build === build || Object.keys(s.activity).length) return
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
 * The repo kumi is about. Inside a Herdr plugin pane or action the process starts in the plugin's own
 * directory, so the focused pane's directory comes from Herdr instead.
 */
function target() {
  if (process.env.KUMI_CWD) return process.env.KUMI_CWD
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
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('the board needs a terminal. Try `kumi status`.')

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
      open: process.env.KUMI_OPEN === 'new' ? 'new' : undefined,
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
      return void toast('kumi', goals.size ? `started ${p.name}'s drafts` : `nothing drafted on ${p.name}`)
    }
    if (what !== 'board' && what !== 'new') throw new Error('kumi herdr <board|new|go> [popup|tab]')
    await daemon()
    const args = ['plugin', 'pane', 'open', '--plugin', 'kumi', '--entrypoint', 'board', '--placement', placement, '--env', `KUMI_CWD=${cwd}`, '--focus']
    if (what === 'new') args.push('--env', 'KUMI_OPEN=new')
    const r = Bun.spawnSync([bin, ...args], { windowsHide: true })
    if (r.exitCode !== 0) throw new Error(r.stderr.toString().trim() || `herdr exited ${r.exitCode}`)
  } catch (e: any) {
    // An action has no terminal to print to; a toast is the only place an error can be seen.
    toast('kumi', String(e?.message ?? e))
    throw e
  }
}

// The project for the current directory, for the one-shot commands agents and scripts use.
async function here(init = false) {
  await daemon()
  return api.send('POST', '/api/projects', { path: target(), init }) as Promise<{ id: number; name: string; tracker: string | null }>
}

/**
 * The Claude Code hooks that report every session to the daemon. A bare curl, so a hook costs milliseconds and
 * says nothing when the daemon is down; crew agents (KUMI_AGENT) stay out. Messages land on edits, shell
 * commands and prompts, not on reads, which keeps the per-call cost off the busiest tools.
 */
function hooks() {
  const post = (ev: string) => `curl -s -m 2 -H content-type:application/json --data-binary @- http://127.0.0.1:\${KUMI_PORT:-4170}/api/hook/${ev} 2>/dev/null || true`
  const run = (ev: string, timeout: number, extra: object = {}) => [
    { ...extra, hooks: [{ type: 'command', command: `[ -n "$KUMI_AGENT" ] || ${ev === 'start' ? `{ kumi start >/dev/null 2>&1; ${post(ev)}; }` : post(ev)}`, timeout, ...(ev === 'post' || ev === 'end' ? { async: true } : {}) }] },
  ]
  const tools = { matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash' }
  return {
    SessionStart: run('start', 15),
    UserPromptSubmit: run('prompt', 5),
    PreToolUse: run('pre', 5, tools),
    PostToolUse: run('post', 5, tools),
    SessionEnd: run('end', 5),
  }
}

/** Merge the hooks into the user's Claude Code settings, replacing kumi's earlier ones. Returns the file. */
function install(block: ReturnType<typeof hooks>) {
  const file = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json')
  let settings: any = {}
  try {
    const text = readFileSync(file, 'utf8')
    settings = JSON.parse(text)
    writeFileSync(`${file}.bak-kumi`, text)
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw new Error(`${file} isn't JSON this can safely rewrite: ${e?.message ?? e}`)
  }
  settings.hooks ??= {}
  const ours = (g: any) => JSON.stringify(g).includes('/api/hook/')
  for (const [event, groups] of Object.entries(block)) settings.hooks[event] = [...(settings.hooks[event] ?? []).filter((g: any) => !ours(g)), ...groups]
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n')
  return file
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
    console.log(s ? status(s, cols, readSeen()) : 'the daemon is not running. `kumi` starts it.')
  } else if (cmd === 'show') {
    const id = Number(String(rest[0]).replace(/^t/, ''))
    const s = await running()
    const t = s?.tickets.find(t => t.id === id)
    if (!s || !t) throw new Error(`no ticket t${rest[0]}`)
    console.log(sheet(t, await api.get(`/api/events?ticket=${id}`), s.goals.find(g => g.id === t.goal_id), Math.min(cols, 110)).join('\n'))
  } else if (cmd === 'goal') {
    const file = rest.includes('--rinai')
    const text = rest.filter(a => a !== '--rinai').join(' ').trim()
    if (!text) throw new Error('kumi goal <what you want done>')
    const p = await here()
    const g = await api.send('POST', '/api/goals', { project_id: p.id, text, file })
    console.log(`goal ${g.id} on ${p.name}${g.issue ? ` (rinai #${g.issue})` : ''}: a planner is drafting tickets. \`kumi status\` shows them, \`kumi go\` starts them.`)
  } else if (cmd === 'take') {
    const n = Number(String(rest[0]).replace(/^#/, ''))
    const p = await here()
    const card = (await api.get<{ number: number; title: string }[]>(`/api/projects/${p.id}/cards`)).find(c => c.number === n)
    if (!card) throw new Error(`#${rest[0]} is not an open issue on ${p.tracker ?? 'this repo'}`)
    const g = await api.send('POST', '/api/goals', { project_id: p.id, issue: n, title: card.title })
    console.log(`goal ${g.id} on ${p.name} from #${n}: a planner is drafting tickets. \`kumi go\` starts them.`)
  } else if (cmd === 'go') {
    const p = await here()
    const s = (await running())!
    const goals = new Set(s.tickets.filter(t => t.project_id === p.id && t.status === 'draft').map(t => t.goal_id))
    for (const g of goals) await api.send('POST', `/api/goals/${g}/start`)
    console.log(goals.size ? `started the drafts of ${goals.size} goal${goals.size === 1 ? '' : 's'} on ${p.name}` : `nothing to start on ${p.name}: no drafts`)
  } else if (cmd === 'sessions') {
    if (!(await running())) throw new Error('the daemon is not running, so no session is being tracked')
    const list = await api.get<{ id: string; top: string; intent: string; at: number; files: string[] }[]>('/api/sessions')
    const ago = (ts: number) => `${Math.round((Date.now() - ts) / 60_000)}m`
    const show = (s: (typeof list)[number]) =>
      [
        `${s.id.slice(0, 8)}  ${ago(s.at).padStart(4)}  ${s.top}`,
        `          ${s.intent || '(no prompt yet)'}`,
        ...(s.files.length ? [`          edited ${s.files.length}: ${s.files.slice(-3).join(', ')}`] : []),
      ].join('\n')
    console.log(list.length ? list.map(show).join('\n') : 'no sessions')
  } else if (cmd === 'say') {
    const to = rest[0]?.startsWith('@') ? rest.shift() : undefined
    await daemon()
    const r = await api.send('POST', '/api/say', { from: process.env.CLAUDE_CODE_SESSION_ID, cwd: target(), to, text: rest.join(' ') })
    console.log(`left for ${r.to.join(', ')}: they read it on their next tool call or prompt`)
  } else if (cmd === 'note' || cmd === 'notes') {
    await daemon()
    const cwd = target()
    if (cmd === 'note' && rest[0] === '-d') {
      await api.send('DELETE', `/api/notes/${Number(String(rest[1]).replace(/^#/, ''))}`, { cwd })
      console.log(`took #${String(rest[1]).replace(/^#/, '')} down`)
    } else if (cmd === 'note') {
      const n = await api.send('POST', '/api/notes', { from: process.env.CLAUDE_CODE_SESSION_ID, cwd, text: rest.join(' ') })
      console.log(`pinned #${n.id}: every session in this repo sees it`)
    } else {
      const ns = await api.get<{ id: number; ts: number; author: string; text: string }[]>(`/api/notes?cwd=${encodeURIComponent(cwd)}`)
      const ago = (ts: number) => `${Math.round((Date.now() - ts) / 60_000)}m`
      console.log(ns.length ? ns.map(n => `#${n.id}  ${ago(n.ts).padStart(5)}  ${n.author}\n      ${n.text}`).join('\n') : 'the board is empty')
    }
  } else if (cmd === 'hooks') {
    const block = hooks()
    if (rest[0] !== '--install') console.log(JSON.stringify({ hooks: block }, null, 2))
    else console.log(`kumi's hooks are in ${install(block)}. Sessions started from now on report to the daemon.`)
  } else if (cmd === 'herdr') {
    await herdr(rest[0], rest[1] === 'tab' ? 'tab' : 'popup')
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
  console.error(`kumi: ${e?.message ?? e}`)
  process.exit(1)
}
