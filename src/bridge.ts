import type { Project } from './ports'
import { PROTOCOL, type Sessions, norm } from './sessions'

/** What `yap pair` got from the relay. */
export interface Pairing {
  relay: string
  device: string
  secret: string
}

/** The socket to the relay. Bun's WebSocket at the edge; a fake in the check. */
export interface Line {
  send(text: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((e: { data: unknown }) => void) | null
  onclose: (() => void) | null
}
export type Dial = (url: string, secret: string) => Line

export const dial: Dial = (url, secret) => new WebSocket(url, { headers: { authorization: `Bearer ${secret}` } } as any) as unknown as Line

/**
 * What a web client may do on this machine, by YAP verb. Every call names a project the user registered, never
 * a path; sessions and spawns outside registered projects are not shown. The user is the sender: whoever holds a
 * token for this machine was given it by the user.
 */
export function remote(sessions: Sessions, projects: () => Project[]) {
  const project = (name: unknown) => {
    const p = projects().find(p => p.name === name)
    if (!p) throw new Error(`no project ${name}; yap's projects here are ${projects().map(p => p.name).join(', ') || 'none'}`)
    return p
  }
  const whose = (path: string) => projects().find(p => norm(path) === norm(p.path))?.name
  const text = (b: any) => String(b.text ?? '')
  const verbs: Record<string, (b: any) => unknown> = {
    hello: () => ({ ...PROTOCOL, verbs: Object.keys(verbs) }),
    projects: () => projects().map(p => ({ name: p.name, base: p.base })),
    sessions: () =>
      sessions
        .list()
        .flatMap(s => (whose(s.repo) ? [{ project: whose(s.repo), id: s.id.slice(0, 8), name: s.name, at: s.at, files: s.files }] : [])),
    spawns: b => sessions.spawns().flatMap(s => (whose(s.cwd) && (!b.id || s.id === b.id) ? [{ ...s, cwd: undefined, project: whose(s.cwd) }] : [])),
    notes: async b => (await sessions.notes(project(b.project).path)).map(({ repo, ...n }) => n),
    note: b => sessions.note({ cwd: project(b.project).path, text: text(b) }),
    say: b => sessions.say({ cwd: project(b.project).path, text: text(b), to: typeof b.to === 'string' ? b.to : undefined }),
    spawn: b => sessions.spawn({ cwd: project(b.project).path, text: text(b) }),
  }
  return async (verb: string, body: unknown) => {
    const fn = verbs[verb]
    if (!fn) throw new Error(`no remote verb ${verb}; there are ${Object.keys(verbs).join(', ')}`)
    return fn(body && typeof body === 'object' ? body : {})
  }
}

/**
 * Holds the line to the relay open and answers what comes down it. Reconnects on its own, backing off to a
 * minute, so a relay deploy or a sleeping laptop costs nothing but the calls made while it was away.
 */
export class Bridge {
  private line: Line | null = null
  private wait = 1000
  private stopped = false
  connected = false

  constructor(
    readonly pairing: Pairing,
    private answer: (verb: string, body: unknown) => Promise<unknown>,
    private open: Dial = dial,
    private later: (fn: () => void, ms: number) => void = (fn, ms) => void setTimeout(fn, ms),
  ) {
    this.connect()
  }

  private connect() {
    if (this.stopped) return
    const url = `${this.pairing.relay.replace(/^http/, 'ws').replace(/\/$/, '')}/connect?device=${this.pairing.device}`
    const line = (this.line = this.open(url, this.pairing.secret))
    line.onopen = () => ((this.connected = true), (this.wait = 1000))
    line.onclose = () => {
      this.connected = false
      if (this.line !== line || this.stopped) return
      this.later(() => this.connect(), this.wait)
      this.wait = Math.min(this.wait * 2, 60_000)
    }
    line.onmessage = async e => {
      let m: { id?: string; verb?: string; body?: unknown }
      try {
        m = JSON.parse(String(e.data))
      } catch {
        return
      }
      if (!m.id || !m.verb) return
      try {
        line.send(JSON.stringify({ id: m.id, answer: (await this.answer(m.verb, m.body)) ?? {} }))
      } catch (err: any) {
        line.send(JSON.stringify({ id: m.id, error: String(err?.message ?? err), status: err?.status }))
      }
    }
  }

  stop() {
    this.stopped = true
    this.line?.close()
  }
}
