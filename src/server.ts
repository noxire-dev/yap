import { Database } from 'bun:sqlite'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ClaudeCli } from './agent'
import { Crew } from './crew'
import { build, home, port, settings, url } from './env'
import { Rinai } from './rinai'
import { PROTOCOL, Sessions, VERBS, type Verb } from './sessions'
import { SqliteStore } from './store'
import { Bridge, remote, type Pairing } from './bridge'
import { Dialog } from './dialog'
import { Herdr } from './herdr'
import { LocalWorkspace } from './workspace'

mkdirSync(home, { recursive: true })

const store = new SqliteStore(new Database(join(home, 'yap.db'), { create: true }))
const ws = new LocalWorkspace()

// Server-sent pings: a client refetches state when one lands.
const clients = new Set<ReadableStreamDefaultController>()
const ping = () => {
  for (const c of clients) {
    try {
      c.enqueue('data: x\n\n')
    } catch {
      clients.delete(c)
    }
  }
}
let pending: Timer | undefined
const changed = () => {
  pending ??= setTimeout(() => {
    pending = undefined
    ping()
  }, 150)
}
// Keeps idle streams from being timed out by the client's fetch.
setInterval(ping, 30_000)

const crew = new Crew(store, ws, new ClaudeCli(), new Rinai(), home, changed)
await crew.recover()
const sessions = new Sessions(ws, store, Date.now, new Herdr(), new ClaudeCli(), () => settings().spawns)

// The remote bridge, when `yap pair` left a pairing: one line out to the relay, answering what may be done from
// the web. Reloaded by `yap pair` and `yap unpair`.
const pairingFile = join(home, 'bridge.json')
const answerRemote = remote(sessions, () => store.projects())
let bridge: Bridge | null = null
function rebridge() {
  bridge?.stop()
  bridge = null
  try {
    bridge = new Bridge(JSON.parse(readFileSync(pairingFile, 'utf8')) as Pairing, answerRemote)
  } catch {}
}
rebridge()

// This server runs shell commands, so a web page must not be able to drive it:
// refuse anything not addressed to localhost or sent from another origin.
function foreign(req: Request) {
  const host = req.headers.get('host') ?? ''
  const origin = req.headers.get('origin')
  let from = host
  try {
    from = origin === null ? host : new URL(origin).host
  } catch {
    return true
  }
  return !/^(localhost|127\.0\.0\.1):\d+$/.test(host) || from !== host
}

// A raw local client can send any Host it likes, so the API also wants the token only this user can read.
// Hooks stay open: they only report, and must work from a bare curl.
const tokenFile = join(home, 'token')
if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(24).toString('hex'), { mode: 0o600 })
const token = readFileSync(tokenFile, 'utf8').trim()
const denied = (req: Request) => foreign(req) || req.headers.get('x-yap-token') !== token

type Handler = (req: Request & { params: Record<string, string> }, body: any) => unknown

// `quiet`: called on every tool use, and nothing the board shows changes.
const api = (fn: Handler, quiet = false) => async (req: Request & { params: Record<string, string> }) => {
  if (denied(req)) return new Response('forbidden', { status: 403 })
  try {
    const body = req.method === 'GET' ? {} : await req.json().catch(() => ({}))
    const out = (await fn(req, body)) ?? { ok: true }
    if (req.method !== 'GET' && !quiet) changed()
    return Response.json(out)
  } catch (e: any) {
    return Response.json({ error: String(e?.message ?? e) }, { status: e?.status ?? 400 })
  }
}

const EDITABLE = ['draft', 'todo', 'escalated']

// What would let work merge that nobody checked asks the person at the desktop: the API token is a file any crew
// agent can read, a dialog is not something it can answer. YAP_YOLO=1 trusts whoever holds the token.
const human = process.env.YAP_YOLO === '1' ? { confirm: async () => true } : new Dialog()
async function vouch(question: string) {
  if (!(await human.confirm(`${question}\n\nSay yes only if you asked for this just now. A crew agent can't answer this dialog; it can call yap's API.`)))
    throw new Error('not confirmed on the desktop')
}

Bun.serve({
  hostname: '127.0.0.1',
  port,
  // A request can wait on the desktop dialog for two minutes.
  idleTimeout: 150,
  routes: {
    '/api/state': api(() => ({
      build,
      projects: store.projects(),
      goals: store.goals().map(g => ({ ...g, brief: undefined })),
      tickets: store.tickets(),
      activity: crew.activity(),
    })),

    '/api/events': api(req => {
      const q = new URL(req.url).searchParams
      const num = (k: string) => (q.has(k) ? Number(q.get(k)) : undefined)
      return store.events({ ticket_id: num('ticket'), project_id: num('project'), limit: num('limit') })
    }),

    '/api/stream': (req, server) => {
      if (denied(req)) return new Response('forbidden', { status: 403 })
      server.timeout(req, 0)
      let me: ReadableStreamDefaultController
      const body = new ReadableStream({
        start(c) {
          clients.add((me = c))
          c.enqueue('data: x\n\n')
        },
        cancel() {
          clients.delete(me)
        },
      })
      return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
    },

    // Agents die with the daemon; recover() puts their tickets back on the board at next start.
    '/api/stop': {
      POST: api(() => {
        setTimeout(() => process.exit(0), 50)
      }),
    },

    // Claude Code hooks from every session on this machine. Never fails: a hook must not break the session. The
    // token too: a hook's answer carries other sessions' prompts and messages, and a post can speak as any session.
    '/api/hook/:event': {
      POST: async req => {
        // Empty: hooks installed before the token carry no -f, and a body would land in their session as text.
        if (denied(req)) return new Response(null, { status: 403 })
        try {
          return Response.json(await sessions.hook(req.params.event, await req.json()))
        } catch {
          return Response.json({})
        }
      },
    },
    // YAP (docs/yap.md): the same as the hooks, in plain verbs and answers, for any agent.
    '/yap': api(() => ({ ...PROTOCOL, verbs: [...VERBS, 'say', 'note', 'unnote', 'spawn'] })),
    '/yap/:verb': {
      POST: api((req, b) => {
        const verb = req.params.verb
        const str = (k: string) => (typeof b[k] === 'string' ? b[k] : undefined)
        const cwd = String(b.cwd ?? '')
        if (verb === 'say') return sessions.say({ from: str('session'), cwd, text: String(b.text ?? ''), to: str('to') })
        if (verb === 'note') return sessions.note({ from: str('session'), cwd, text: String(b.text ?? '') })
        if (verb === 'unnote') return sessions.unnote(cwd, Number(b.id)).then(() => ({}))
        if (verb === 'spawn') return sessions.spawn({ from: str('session'), cwd, text: String(b.text ?? '') })
        if (!VERBS.includes(verb as Verb)) throw new Error(`no verb ${verb}; YAP has ${[...VERBS, 'say', 'note', 'unnote', 'spawn'].join(', ')}`)
        return sessions.yap(verb as Verb, { session: str('session'), cwd, path: str('path'), command: str('command'), prompt: str('prompt') })
      }, true),
    },
    '/api/sessions': api(() => sessions.list()),
    '/api/spawns': api(() => sessions.spawns()),
    '/api/bridge': {
      GET: api(() => (bridge ? { relay: bridge.pairing.relay, device: bridge.pairing.device, connected: bridge.connected } : {})),
      POST: api(() => rebridge()),
    },
    '/api/notes': {
      GET: api(req => sessions.notes(new URL(req.url).searchParams.get('cwd') ?? '')),
      POST: api((_, b) => sessions.note({ from: b.from || undefined, cwd: String(b.cwd ?? ''), text: String(b.text ?? '') })),
    },
    '/api/notes/:id': { DELETE: api((req, b) => sessions.unnote(String(b.cwd ?? ''), Number(req.params.id))) },
    '/api/say': { POST: api((_, b) => sessions.say({ from: b.from || undefined, cwd: String(b.cwd ?? ''), text: String(b.text ?? ''), to: b.to || undefined })) },

    // Opening is idempotent: the project for the repo that path sits in, new or not.
    '/api/projects': { POST: api((_, b) => crew.openProject(String(b.path ?? ''), b.init === true)) },
    '/api/projects/forget': {
      POST: api(async (_, b) => {
        await vouch(`Take ${b.name || b.path} off yap's board, with its goals, tickets and history?`)
        return crew.forgetProject(String(b.name ?? ''), String(b.path ?? ''))
      }),
    },

    '/api/projects/:id': {
      PATCH: api(async (req, b) => {
        const patch: Record<string, unknown> = {}
        const p = store.projects().find(p => p.id === Number(req.params.id))
        if (typeof b.gate === 'string' && p && b.gate.trim() !== p.gate) {
          await vouch(b.gate.trim() ? `Change ${p.name}'s gate to: ${b.gate.trim()}` : `Turn off ${p.name}'s gate? Merged work would no longer be run before the base moves.`)
          patch.gate = b.gate.trim()
        }
        if (Number.isInteger(b.workers) && b.workers > 0) patch.workers = b.workers
        if (typeof b.running === 'boolean') patch.running = b.running
        store.patchProject(Number(req.params.id), patch)
        crew.kick()
      }),
    },

    '/api/projects/:id/cards': api(req => crew.cards(Number(req.params.id))),

    // A goal is typed (`text`, and `file` to put it on the tracker too) or taken from the tracker (`issue`).
    '/api/goals': {
      POST: api((_, b) =>
        Number.isInteger(b.issue)
          ? crew.take(Number(b.project_id), b.issue, String(b.title ?? ''))
          : crew.compose(Number(b.project_id), String(b.text ?? ''), b.file === true),
      ),
    },
    '/api/goals/:id/start': { POST: api(req => crew.startGoal(Number(req.params.id))) },

    '/api/tickets/:id': {
      PATCH: api(async (req, b) => {
        const id = Number(req.params.id)
        const t = store.tickets().find(t => t.id === id)
        if (!t || !EDITABLE.includes(t.status)) throw new Error('only draft, todo and escalated tickets can be edited')
        // An escalated ticket failed review: changing what it is judged against is a way past the reviewer.
        const criteria = Array.isArray(b.criteria) ? b.criteria.map((c: string) => String(c).trim()).filter(Boolean) : t.criteria
        if (t.status === 'escalated' && ((typeof b.body === 'string' && b.body !== t.body) || String(criteria) !== String(t.criteria)))
          await vouch(`Change what t${t.id} "${t.title}" is reviewed against, after it failed review?`)
        const patch: Record<string, unknown> = {}
        if (typeof b.title === 'string' && b.title.trim()) patch.title = b.title.trim()
        if (typeof b.body === 'string') patch.body = b.body
        if (Array.isArray(b.criteria) && b.criteria.some((c: string) => c.trim()))
          patch.criteria = b.criteria.map((c: string) => c.trim()).filter(Boolean)
        store.patchTicket(id, patch)
      }),
    },

    '/api/tickets/:id/diff': api(async req => {
      const id = Number(req.params.id)
      const t = store.tickets().find(t => t.id === id)
      const p = store.projects().find(p => p.id === t?.project_id)
      if (!t || !p) throw new Error('no such ticket')
      return { diff: t.sha ? await ws.diff(p.path, `${t.sha}^`, t.sha) : await ws.diff(p.path, p.base, `yap/t${id}`) }
    }),

    '/api/tickets/:id/:action': {
      POST: api(async (req, b) => {
        const action = req.params.action
        if (!['start', 'retry', 'approve', 'restart', 'drop'].includes(action)) throw new Error('unknown action')
        const t = store.tickets().find(t => t.id === Number(req.params.id))
        if (action === 'approve' && t) await vouch(`Send t${t.id} "${t.title}" to the gate without the reviewer's approval?`)
        return crew.act(Number(req.params.id), action as 'start', String(b.note ?? ''))
      }),
    },
  },
  fetch: () => new Response('not found', { status: 404 }),
})

console.log(`yap daemon on ${url}, state in ${home}`)
