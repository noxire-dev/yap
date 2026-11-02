/**
 * A YAP client for the web side of the relay: one file, no dependencies, runs in a browser, a Worker, Bun or
 * Node 18+. The wire is in docs/yap.md, "Remote".
 *
 *   const yap = await Yap.claim('https://yap-relay.example.workers.dev', '<device>.<code>')
 *   localStorage.yap = JSON.stringify(yap)          // { relay, device, token }: keep it, the code works once
 *   const { id } = await yap.spawn('app', 'add a retry to fetchUser')
 *   const done = await yap.wait(id)
 *   console.log(done.ok, done.result)
 *
 *   const again = Yap.from(JSON.parse(localStorage.yap))
 */

export interface Hello {
  protocol: 'yap'
  version: number
  verbs: string[]
}

export interface Project {
  name: string
  base: string
}

export interface Session {
  project: string
  /** First 8 characters of its id; `say` takes this or its name. */
  id: string
  /** From the first file it edited, `''` until then. */
  name: string
  /** Last heard from, ms since the epoch. */
  at: number
  /** Files it edited, relative to its working tree. */
  files: string[]
}

export interface Spawn {
  project: string
  id: string
  name: string
  task: string
  /** The session that asked, or `''` for the user. */
  from: string
  started: number
  /** Set once it ended. */
  done?: number
  ok?: boolean
  /** Its final message. */
  result?: string
}

export interface Note {
  id: number
  ts: number
  author: string
  text: string
}

/** A refusal from the relay or the machine. `status`: 400 bad call, 401 bad token, 429 too many running, 503 machine offline, 504 no answer. */
export class YapError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'YapError'
  }
}

/** Any fetch: the global one, a test double, a Worker service binding. */
type Fetch = (url: string, init: RequestInit) => Promise<Response>

export class Yap {
  constructor(
    readonly relay: string,
    readonly device: string,
    readonly token: string,
    private fetcher: Fetch = (url, init) => fetch(url, init),
  ) {
    this.relay = relay.replace(/\/$/, '')
  }

  /** Trade the pairing string `yap pair` printed (`<device>.<code>`) for a client. Works once. */
  static async claim(relay: string, pairing: string, fetcher: Fetch = (url, init) => fetch(url, init)) {
    const [device, code] = pairing.trim().split('.')
    const { token } = await call<{ token: string }>(fetcher, `${relay.replace(/\/$/, '')}/claim`, { device, code })
    return new Yap(relay, device, token, fetcher)
  }

  /** A client from what `JSON.stringify(yap)` kept. */
  static from(saved: { relay: string; device: string; token: string }, fetcher?: Fetch) {
    return new Yap(saved.relay, saved.device, saved.token, fetcher)
  }

  toJSON() {
    return { relay: this.relay, device: this.device, token: this.token }
  }

  private verb<T>(name: string, body: object = {}) {
    return call<T>(this.fetcher, `${this.relay}/d/${this.device}/${name}`, body, this.token)
  }

  /** The protocol version the machine speaks, and the verbs it takes. */
  hello() {
    return this.verb<Hello>('hello')
  }

  /** The repos the user registered with yap. Every other call names one of these. */
  projects() {
    return this.verb<Project[]>('projects')
  }

  /** Live agent sessions in those projects. */
  sessions() {
    return this.verb<Session[]>('sessions')
  }

  /** Background sessions started since the daemon did, newest first. */
  spawns() {
    return this.verb<Spawn[]>('spawns')
  }

  notes(project: string) {
    return this.verb<Note[]>('notes', { project })
  }

  /** Pin a note on the project's board; every session there hears of it. */
  note(project: string, text: string) {
    return this.verb<Note>('note', { project, text })
  }

  /** Message one session (`to`: its name or id, a prefix will do) or all of them in the project. */
  say(project: string, text: string, to?: string) {
    return this.verb<{ to: string[]; woke: string[] }>('say', { project, text, to })
  }

  /** Start a background agent session in the project on `task`. It runs on the user's machine. */
  spawn(project: string, task: string) {
    return this.verb<{ id: string }>('spawn', { project, text: task })
  }

  /** Poll until the spawned session ends, and return how it did. Rides out the machine dropping off for a while. */
  async wait(id: string, { every = 3000, timeout = 30 * 60_000 } = {}) {
    const until = Date.now() + timeout
    for (;;) {
      const s = await this.verb<Spawn[]>('spawns', { id }).then(
        ([s]) => s ?? Promise.reject(new YapError(400, `no spawn ${id} on this machine`)),
        e => (e instanceof YapError && (e.status === 503 || e.status === 504) ? null : Promise.reject(e)),
      )
      if (s?.done) return s
      if (Date.now() > until) throw new YapError(504, `spawn ${id} still running after ${timeout} ms`)
      await new Promise(r => setTimeout(r, every))
    }
  }
}

async function call<T>(fetcher: Fetch, url: string, body: object, token?: string): Promise<T> {
  const res = await fetcher(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
  const data: any = await res.json().catch(() => ({}))
  if (!res.ok) throw new YapError(res.status, data?.error ?? `${res.status} ${res.statusText}`)
  return data as T
}
