import { DurableObject } from 'cloudflare:workers'

/**
 * YAP's remote bridge (docs/yap.md, "Remote"). A machine running the yap daemon dials out to this relay and holds
 * one WebSocket open; a web client that holds a token for that machine calls YAP verbs over HTTP, and the relay
 * passes each call down the socket and the answer back. One Durable Object per machine. The relay keeps no
 * project, session or message: only hashes of the machine's secret, its pairing code and the tokens it issued.
 *
 *   POST   /pair                      the daemon asks for a machine id, a secret and a pairing code
 *   POST   /claim     {device, code}  a web client trades the code for a token, once, within ten minutes
 *   GET    /connect                   the daemon's WebSocket, with its secret
 *   POST   /d/<device>/<verb>         a web client's call, with its token
 *   DELETE /d/<device>                the daemon unpairs, with its secret: every token dies with it
 *   GET    /                          what this is: { protocol, version }
 *
 * Any origin may call it: auth is a bearer token, never a cookie, so a page can only use a token it was given.
 */

interface Env {
  DEVICE: DurableObjectNamespace<Device>
}

const PAIRING = 10 * 60_000
/** Wrong codes before the code is burned and the machine has to pair again. */
const TRIES = 5
/** How long a web call waits for the machine to answer. */
const WAIT = 25_000

const random = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, '0')).join('')
const hash = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('')
const bearer = (req: Request) => req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
const fail = (status: number, error: string) => Response.json({ error }, { status })
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS', 'access-control-max-age': '86400' }

export class Device extends DurableObject<Env> {
  /** Calls waiting for the machine's answer. In memory: a call in flight keeps this object awake. */
  private waiting = new Map<string, (answer: { status: number; body: unknown }) => void>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)')
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS token (hash TEXT PRIMARY KEY, at INTEGER)')
    })
  }

  private get(k: string) {
    return this.ctx.storage.sql.exec<{ v: string }>('SELECT v FROM kv WHERE k = ?', k).toArray()[0]?.v ?? ''
  }

  private set(k: string, v: string) {
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', k, v)
  }

  async pair(secret: string, code: string) {
    if (this.get('secret')) throw new Error('taken')
    this.set('secret', await hash(secret))
    this.set('code', await hash(code))
    this.set('expires', String(Date.now() + PAIRING))
    this.set('tries', '0')
  }

  /** The code works once, and only within TRIES guesses. */
  async claim(code: string) {
    if (!this.get('code')) return null
    const ok = this.get('code') === (await hash(code)) && Date.now() < Number(this.get('expires'))
    if (!ok) {
      const tries = Number(this.get('tries')) + 1
      this.set('tries', String(tries))
      if (tries >= TRIES) this.set('code', '')
      return null
    }
    this.set('code', '')
    const token = random(32)
    this.ctx.storage.sql.exec('INSERT INTO token (hash, at) VALUES (?, ?)', await hash(token), Date.now())
    return token
  }

  async fetch(req: Request) {
    const url = new URL(req.url)
    const secret = this.get('secret')
    if (!secret) return fail(404, 'no such device')

    if (url.pathname === '/connect') {
      if ((await hash(bearer(req))) !== secret) return fail(401, 'wrong secret')
      // One machine, one socket: a reconnect replaces the old one.
      for (const ws of this.ctx.getWebSockets()) ws.close(1000, 'replaced')
      const [client, server] = Object.values(new WebSocketPair())
      this.ctx.acceptWebSocket(server)
      return new Response(null, { status: 101, webSocket: client })
    }

    if (req.method === 'DELETE') {
      if ((await hash(bearer(req))) !== secret) return fail(401, 'wrong secret')
      for (const ws of this.ctx.getWebSockets()) ws.close(1000, 'unpaired')
      this.ctx.storage.sql.exec('DELETE FROM kv')
      this.ctx.storage.sql.exec('DELETE FROM token')
      return Response.json({})
    }

    const t = await hash(bearer(req))
    if (!this.ctx.storage.sql.exec('SELECT 1 FROM token WHERE hash = ?', t).toArray().length) return fail(401, 'not paired with this device')
    const ws = this.ctx.getWebSockets()[0]
    if (!ws) return fail(503, 'the machine is offline')
    const verb = url.pathname.split('/').pop()!
    const body = await req.json().catch(() => ({}))
    const id = random(8)
    const answer = await new Promise<{ status: number; body: unknown }>(resolve => {
      const timer = setTimeout(() => (this.waiting.delete(id), resolve({ status: 504, body: { error: 'the machine did not answer' } })), WAIT)
      this.waiting.set(id, a => (clearTimeout(timer), resolve(a)))
      ws.send(JSON.stringify({ id, verb, body }))
    })
    return Response.json(answer.body, { status: answer.status })
  }

  async webSocketMessage(_: WebSocket, message: string | ArrayBuffer) {
    let m: { id?: string; answer?: unknown; error?: string; status?: number }
    try {
      m = JSON.parse(String(message))
    } catch {
      return
    }
    const done = m.id ? this.waiting.get(m.id) : undefined
    if (!done) return
    this.waiting.delete(m.id!)
    done(m.error ? { status: m.status ?? 400, body: { error: m.error } } : { status: 200, body: m.answer ?? {} })
  }
}

export default {
  async fetch(req: Request, env: Env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
    const res = await route(req, env)
    // A WebSocket upgrade goes back as it is; everything else carries CORS.
    if (res.status === 101) return res
    const out = new Response(res.body, res)
    for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v)
    return out
  },
}

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url)
  const parts = url.pathname.split('/').filter(Boolean)

  // ponytail: anyone can pair a new device; rate-limit /pair if it is ever abused.
  if (req.method === 'POST' && url.pathname === '/pair') {
    const device = random(8)
    const secret = random(32)
    const code = random(4)
    await env.DEVICE.getByName(device).pair(secret, code)
    return Response.json({ device, secret, code })
  }

  if (req.method === 'POST' && url.pathname === '/claim') {
    const b = (await req.json().catch(() => ({}))) as { device?: string; code?: string }
    if (!/^[0-9a-f]{16}$/.test(b.device ?? '')) return fail(400, 'no such device')
    const token = await env.DEVICE.getByName(b.device!).claim(String(b.code ?? ''))
    return token ? Response.json({ token }) : fail(403, 'wrong or expired code')
  }

  if (url.pathname === '/connect') {
    if (req.headers.get('upgrade') !== 'websocket') return fail(426, 'a WebSocket, please')
    const device = url.searchParams.get('device') ?? ''
    if (!/^[0-9a-f]{16}$/.test(device)) return fail(400, 'no such device')
    return env.DEVICE.getByName(device).fetch(req)
  }

  if (parts[0] === 'd' && /^[0-9a-f]{16}$/.test(parts[1] ?? '') && ((req.method === 'POST' && parts.length === 3) || (req.method === 'DELETE' && parts.length === 2)))
    return env.DEVICE.getByName(parts[1]).fetch(req)

  if (req.method === 'GET' && url.pathname === '/') return Response.json({ protocol: 'yap', version: 0 })

  return fail(404, 'not found')
}
