import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ClaudeCli } from './agent'
import { Crew } from './crew'
import { home, port, url } from './env'
import { SqliteStore } from './store'
import { LocalWorkspace } from './workspace'

mkdirSync(home, { recursive: true })

const store = new SqliteStore(new Database(join(home, 'kumi.db'), { create: true }))
const ws = new LocalWorkspace()

// Server-sent pings: the UI refetches state when one lands.
const clients = new Set<ReadableStreamDefaultController>()
let pending: Timer | undefined
const changed = () => {
  pending ??= setTimeout(() => {
    pending = undefined
    for (const c of clients) {
      try {
        c.enqueue('data: x\n\n')
      } catch {
        clients.delete(c)
      }
    }
  }, 150)
}

const crew = new Crew(store, ws, new ClaudeCli(), home, changed)
crew.recover()

// This server runs shell commands, so a web page must not be able to drive it:
// refuse anything not addressed to localhost or sent from another origin.
function foreign(req: Request) {
  const host = req.headers.get('host') ?? ''
  const origin = req.headers.get('origin')
  return !/^(localhost|127\.0\.0\.1):\d+$/.test(host) || (origin !== null && new URL(origin).host !== host)
}

type Handler = (req: Request & { params: Record<string, string> }, body: any) => unknown

const api = (fn: Handler) => async (req: Request & { params: Record<string, string> }) => {
  if (foreign(req)) return new Response('forbidden', { status: 403 })
  try {
    const body = req.method === 'GET' ? {} : await req.json().catch(() => ({}))
    return Response.json((await fn(req, body)) ?? { ok: true })
  } catch (e: any) {
    return Response.json({ error: String(e?.message ?? e) }, { status: 400 })
  }
}

const EDITABLE = ['draft', 'todo', 'escalated']

Bun.serve({
  hostname: '127.0.0.1',
  port,
  routes: {
    '/api/state': api(() => ({
      projects: store.projects(),
      goals: store.goals(),
      tickets: store.tickets(),
      activity: crew.activity(),
    })),

    '/api/events': api(req => {
      const q = new URL(req.url).searchParams
      const num = (k: string) => (q.has(k) ? Number(q.get(k)) : undefined)
      return store.events({ ticket_id: num('ticket'), project_id: num('project'), limit: num('limit') })
    }),

    '/api/stream': (req, server) => {
      if (foreign(req)) return new Response('forbidden', { status: 403 })
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

    '/api/projects': { POST: api((_, b) => crew.addProject(String(b.path ?? ''), b.gate, b.workers)) },

    '/api/projects/:id': {
      PATCH: api((req, b) => {
        const patch: Record<string, unknown> = {}
        if (typeof b.gate === 'string') patch.gate = b.gate
        if (Number.isInteger(b.workers) && b.workers > 0) patch.workers = b.workers
        if (typeof b.running === 'boolean') patch.running = b.running
        store.patchProject(Number(req.params.id), patch)
        crew.kick()
      }),
    },

    '/api/goals': { POST: api((_, b) => crew.plan(Number(b.project_id), String(b.text ?? ''))) },
    '/api/goals/:id/start': { POST: api(req => crew.startGoal(Number(req.params.id))) },

    '/api/tickets': { POST: api((_, b) => crew.addTicket(Number(b.project_id), b)) },

    '/api/tickets/:id': {
      PATCH: api((req, b) => {
        const id = Number(req.params.id)
        const t = store.tickets().find(t => t.id === id)
        if (!t || !EDITABLE.includes(t.status)) throw new Error('only draft, todo and escalated tickets can be edited')
        const patch: Record<string, unknown> = {}
        if (typeof b.title === 'string' && b.title.trim()) patch.title = b.title.trim()
        if (typeof b.body === 'string') patch.body = b.body
        if (Array.isArray(b.criteria) && b.criteria.some((c: string) => c.trim()))
          patch.criteria = b.criteria.map((c: string) => c.trim()).filter(Boolean)
        store.patchTicket(id, patch)
        changed()
      }),
    },

    '/api/tickets/:id/diff': api(async req => {
      const id = Number(req.params.id)
      const t = store.tickets().find(t => t.id === id)
      const p = store.projects().find(p => p.id === t?.project_id)
      if (!t || !p) throw new Error('no such ticket')
      return { diff: t.sha ? await ws.diff(p.path, `${t.sha}^`, t.sha) : await ws.diff(p.path, p.base, `kumi/t${id}`) }
    }),

    '/api/tickets/:id/:action': {
      POST: api((req, b) => {
        const action = req.params.action
        if (action !== 'start' && action !== 'retry' && action !== 'approve' && action !== 'drop') throw new Error('unknown action')
        return crew.act(Number(req.params.id), action, String(b.note ?? ''))
      }),
    },
  },
  fetch: () => new Response('not found', { status: 404 }),
})

console.log(`kumi daemon on ${url}, state in ${home}`)
