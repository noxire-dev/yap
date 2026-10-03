#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { build, home, url } from './env'
import { type Client, type State, Tui, reader, sheet, status, useColor } from './tui'

const USAGE = `kumi                 open the board (starts the daemon if it isn't running)
kumi status          every project's rail
kumi show <ticket>   one ticket: criteria, verdicts, what was done, journal
kumi goal <text>     plan tickets for this repo from a sentence (--rinai files it as an issue too)
kumi take <issue>    plan tickets from an issue on this repo's Rinai board
kumi go              start this repo's drafted tickets
kumi init            make this directory a git repo so the crew can work in it
kumi herdr <board|new|go> [popup|tab]   what the Herdr plugin's actions run
kumi sessions        the Claude Code sessions the hooks have seen, and what each is doing
kumi start | stop    the daemon in the background; stop kills running agents and requeues their tickets
kumi serve           the daemon in the foreground`

class HttpClient implements Client {
  async get<T>(path: string) {
    return this.read(await fetch(url + path)) as Promise<T>
  }

  async send(method: 'POST' | 'PATCH', path: string, body: object = {}) {
    return this.read(await fetch(url + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  }

  private async read(res: Response) {
    const data: any = await res.json()
    if (!res.ok) throw new Error(data?.error ?? res.statusText)
    return data
  }

  watch(ping: () => void, down: (isDown: boolean) => void) {
    void (async () => {
      for (;;) {
        try {
          const res = await fetch(`${url}/api/stream`)
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
  fetch(`${url}/api/state`, { signal: AbortSignal.timeout(500) }).then(
    r => (r.ok ? (r.json() as Promise<State>) : null),
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
  } else if (cmd === 'herdr') {
    await herdr(rest[0], rest[1] === 'tab' ? 'tab' : 'popup')
  } else if (cmd === 'init') {
    console.log(`${(await here(true)).name} is ready for the crew`)
  } else if (cmd === 'stop') {
    console.log((await running()) ? (await api.send('POST', '/api/stop'), 'stopped') : 'not running')
  } else console.log(USAGE)
} catch (e: any) {
  console.error(`kumi: ${e?.message ?? e}`)
  process.exit(1)
}
