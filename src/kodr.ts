// Kodr's side of yap (kodr-plugin.toml). `bun src/kodr.ts` is the service: it wakes an idle Kodr thread when a
// message is queued for it, and publishes what Kodr shows (a status line, and each thread's yap name) in
// KODR_PLUGIN_UI_DIR. `sessions <dir>` prints who is in that repo. Kodr puts a `kodr` that reaches the
// running app first on PATH.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type Peer, wakePrompt, YapLocal } from '../sdk/local'

// Every thread status but a running one: a busy thread hears the message from its next hook instead.
const SETTLED = new Set(['idle', 'completed', 'failed', 'cancelled', 'interrupted'])
const REFRESH_MS = 30_000

async function kodr(args: string[]) {
  const p = Bun.spawn(['kodr', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(p.stdout).text()
  return { ok: (await p.exited) === 0, out }
}

// Under `kodr host` the server's thread list arrives on stdin, one shell item per line, so a
// session's thread is a lookup instead of a `kodr thread show` per session.
const fed = process.env.KODR_EVENTS === 'stdin'
const fedStatus = new Map<string, string>()
let onThreadsChanged = () => {}
if (fed) {
  let pending = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    pending += chunk
    for (let i = pending.indexOf('\n'); i >= 0; i = pending.indexOf('\n')) {
      const item = JSON.parse(pending.slice(0, i))
      pending = pending.slice(i + 1)
      if (item.kind === 'snapshot') {
        fedStatus.clear()
        for (const t of item.snapshot.threads) fedStatus.set(t.id, t.status)
      } else if (item.kind === 'thread.updated' && item.location === 'active') fedStatus.set(item.thread.id, item.thread.status)
      else if (item.kind === 'thread.updated') fedStatus.delete(item.thread.id)
      else if (item.kind === 'thread.removed') fedStatus.delete(item.threadId)
      else continue
      onThreadsChanged()
    }
  })
  // The host closes the feed when it stops; leave with it.
  process.stdin.on('end', () => process.exit(0))
}

/** null when the session is not a Kodr thread: a terminal Claude Code, a Herdr pane, a spawn. */
async function threadStatus(id: string): Promise<string | null> {
  if (fed) return fedStatus.get(id) ?? null
  const r = await kodr(['thread', 'show', id, '--json', '--messages', '0'])
  if (!r.ok) return null
  try {
    return JSON.parse(r.out).thread?.status ?? null
  } catch {
    return null
  }
}

const uiDir = process.env.KODR_PLUGIN_UI_DIR
const publish = (file: string, value: unknown) =>
  uiDir ? Bun.write(join(uiDir, file), JSON.stringify(value)) : Promise.resolve(0)

const start = () => Bun.spawn(['bun', 'src/cli.ts', 'start'], { cwd: `${import.meta.dir}/..` }).exited
const yap = await YapLocal.connect({ start }).catch(async e => {
  await publish('status.json', { text: 'the yap daemon did not start', tone: 'error' })
  throw e
})

const label = (s: Peer) => `@${s.name || s.id.slice(0, 8)}`

if (process.argv[2] === 'sessions') {
  const peers = await yap.sessions(process.argv[3] || process.cwd())
  console.log(
    peers.length
      ? peers
          .map(p => {
            const recent = p.files.slice(-3).map(f => f.split('/').at(-1)).join(', ')
            return `${label(p)}${p.files.length ? `  edited ${p.files.length}: ${recent}` : ''}`
          })
          .join('\n')
      : 'Nobody is in this repo.',
  )
  process.exit(0)
}

// The daemon's own list, every repo at once; the SDK only asks one repo at a time.
const yapHome = process.env.YAP_HOME ?? join(homedir(), '.yap')
const yapUrl = `http://127.0.0.1:${process.env.YAP_PORT ?? 4170}`
async function allSessions(): Promise<Peer[]> {
  const token = readFileSync(join(yapHome, 'token'), 'utf8').trim()
  const r = await fetch(`${yapUrl}/api/sessions`, { headers: { 'x-yap-token': token } })
  if (!r.ok) throw new Error(String(r.status))
  return r.json()
}

const isThread = new Map<string, Promise<boolean>>()
const kodrThread = (id: string) => {
  if (fed) return Promise.resolve(fedStatus.has(id))
  if (!isThread.has(id)) isThread.set(id, threadStatus(id).then(s => s !== null))
  return isThread.get(id)!
}

async function refresh() {
  let sessions: Peer[]
  try {
    sessions = await allSessions()
  } catch {
    await publish('status.json', { text: 'the yap daemon is not answering', tone: 'error' })
    return
  }
  const threads: Record<string, { text: string; tone: string; title: string }[]> = {}
  for (const s of sessions) {
    if (!(await kodrThread(s.id))) continue
    const others = sessions.filter(o => o.repo === s.repo && o.id !== s.id)
    threads[s.id] = [
      {
        // An unnamed session's id means nothing in a chip; say whose it is and who else is here.
        text: `${s.name ? `@${s.name}` : 'yap'}${others.length ? ` +${others.length}` : ''}`,
        tone: others.length ? 'info' : 'neutral',
        title: others.length
          ? `Its yap name. In this repo with ${others.map(label).join(', ')}.`
          : 'Its yap name. Nobody else is in this repo.',
      },
    ]
  }
  const mine = Object.keys(threads).length
  await publish('threads.json', threads)
  await publish('status.json', {
    text: `connected: ${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'}${mine ? `, ${mine} of them Kodr threads` : ''}`,
    tone: 'ok',
  })
}

let refreshTimer: ReturnType<typeof setTimeout> | undefined
const soon = () => {
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(refresh, 500)
}
onThreadsChanged = soon
// Kodr killed outright leaves this running on Windows; leave with it.
const kodrPid = Number(process.env.KODR_PID)
const kodrAlive = () => {
  try {
    process.kill(kodrPid, 0)
    return true
  } catch {
    return false
  }
}
setInterval(() => {
  if (kodrPid && !kodrAlive()) process.exit(0)
  void refresh()
}, REFRESH_MS)
await refresh()

const waking = new Set<string>()
yap.watch(
  undefined,
  async e => {
    if (e.type === 'join' || e.type === 'leave' || e.type === 'edited') return soon()
    if (e.type !== 'message' || waking.has(e.session)) return
    waking.add(e.session)
    try {
      const status = await threadStatus(e.session)
      if (status !== null && SETTLED.has(status)) await kodr(['thread', 'send', e.session, wakePrompt(e)])
    } finally {
      waking.delete(e.session)
    }
  },
  { onOpen: soon },
)
