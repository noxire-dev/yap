/**
 * A YAP client for a harness on this machine: an IDE or agent runner that hosts agent sessions and speaks YAP
 * for them (docs/yap.md, "Bringing your own harness"). One file, no dependencies, Node 18+ or Bun: vendor it.
 *
 *   const yap = await YapLocal.connect()                 // token from ~/.yap/token; starts the daemon if asked
 *   const s = yap.session(threadId, worktree)
 *   show(await s.join('planner'))                        // context for the model, notice for the user
 *   const a = await s.willRun('git checkout main')
 *   if (a.deny) refuse(a.deny)
 *   const stop = yap.watch(worktree, e => { if (e.type === 'message' && idle(e.session)) startTurn(e.session, wakePrompt(e)) })
 */

/** `kind`: a question or blocker stays on the sender's `unanswered` until a reply with `re` (its id, or 8 characters of it). */
export interface Said {
  kind?: 'question' | 'blocker'
  re?: string
}

/** What a verb answers. `{}` is "say nothing". */
export interface Answer {
  /** For the model only: peers, warnings, messages. Put it in front of the next model call. */
  context?: string
  /** One line for the user. */
  notice?: string
  /** willRun only: don't run the command; give the model this reason instead. */
  deny?: string
  /** The messages `context` just delivered, as data, to show. Once unless the session acks (`YapSession.ack`). */
  messages?: Message[]
  /** With `messages`: the highest `seq` among them. */
  seq?: number
}

export interface Message {
  /** Missing from a daemon before acks, like `seq`. */
  id?: string
  /** Only goes up. */
  seq?: number
  kind: 'say' | 'question' | 'blocker' | 'note' | 'spawn' | 'conflict'
  /** The id of the message this answers. */
  re?: string
  /** `session`, `user` (a device paired through the relay) or `local` (unverified: anything on the machine). Missing from a daemon before it. */
  origin?: 'session' | 'user' | 'local'
  /** As the model reads it: `session @auth`, `the user`. */
  from: string
  /** The sending session's id, `''` for the user. */
  sender: string
  text: string
  at: number
  /** spawn: whether it finished or failed. */
  ok?: boolean
}

/** What `watch` hears. `repo` is the repo's main checkout, normalized (forward slashes, lowercase on Windows). */
export type YapEvent =
  | { type: 'join' | 'leave'; repo: string; session: string; name: string }
  | { type: 'edited'; repo: string; session: string; name: string; path: string }
  /** For `session`: wake it if it sits idle (`wakePrompt`), unless it is a `conflict`, which waits for its next turn. */
  | ({ type: 'message'; repo: string; session: string; name: string } & Message)
  | { type: 'note'; repo: string; id: number; author: string; text: string }

export interface Peer {
  id: string
  /** `''` until it names itself or edits a file. */
  name: string
  /** Its working tree. */
  top: string
  repo: string
  started: number
  /** Last heard from. */
  at: number
  /** Files it edited, relative to `top`. */
  files: string[]
  /** Sessions in other worktrees whose working tree would conflict with its own if merged, and in which files. */
  conflicts?: { with: string; files: string[] }[]
  /** Messages it never acked after 3 deliveries. */
  undelivered?: { id: string; from: string; text: string }[]
  /** Questions and blockers it sent that nobody has answered with `re` yet; `to` as names. */
  unanswered?: { id: string; to: string[]; kind: 'question' | 'blocker'; text: string }[]
}

/** A live claim: `path` relative to the holder's working tree `top`; `expires` moves on with the holder's edits under it. */
export interface Claim {
  id: string
  session: string
  name: string
  top: string
  path: string
  why: string
  expires: number
}

export interface Note {
  id: number
  ts: number
  author: string
  text: string
}

export interface Spawn {
  id: string
  name: string
  task: string
  from: string
  started: number
  done?: number
  ok?: boolean
  result?: string
  /** Who ran it; Claude Code when missing. */
  agent?: 'claude' | 'codex'
}

/** A refusal: 400 a bad call, 403 a wrong token, 429 too many spawns running; 0 the daemon is not there. */
export class YapError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'YapError'
  }
}

/** The prompt that wakes an idle session for a message: its `turn` answer then carries the message. */
export const wakePrompt = (e: { from: string }) => `yap: a message from ${e.from}`

type Fetch = (url: string, init: RequestInit) => Promise<Response>

export class YapLocal {
  constructor(
    readonly url: string,
    private token: string,
    private fetcher: Fetch = (url, init) => fetch(url, init),
  ) {}

  /**
   * The daemon on this machine, as `yap` set it up: `YAP_HOME` (~/.yap) holds the token, `YAP_PORT` (4170) the
   * port. `start`: how to start the daemon when it isn't running (say, run `yap start`); it is called once.
   */
  static async connect(o: { start?: () => Promise<unknown>; fetcher?: Fetch } = {}) {
    const { readFileSync } = await import('node:fs')
    const { homedir } = await import('node:os')
    const { join } = await import('node:path')
    const home = process.env.YAP_HOME ?? join(homedir(), '.yap')
    const url = `http://127.0.0.1:${process.env.YAP_PORT ?? 4170}`
    const token = () => readFileSync(join(home, 'token'), 'utf8').trim()
    let yap: YapLocal | undefined
    try {
      yap = new YapLocal(url, token(), o.fetcher)
      await yap.hello()
      return yap
    } catch (e) {
      if (!o.start) throw e
    }
    await o.start()
    // A first start writes the token.
    yap = new YapLocal(url, token(), o.fetcher)
    await yap.hello()
    return yap
  }

  /** One agent conversation. `id` is stable for it (a thread id); `cwd` is where it works. */
  session(id: string, cwd: string) {
    return new YapSession(this, id, cwd)
  }

  /** POST /yap/<verb>. Every method here comes down to this. */
  async call<T>(verb: string, body: object): Promise<T> {
    let res: Response
    try {
      res = await this.fetcher(`${this.url}/yap/${verb}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-yap-token': this.token },
        body: JSON.stringify(body),
      })
    } catch (e) {
      throw new YapError(0, `the yap daemon is not running at ${this.url}: ${(e as Error).message}`)
    }
    const data: any = await res.json().catch(() => ({}))
    if (!res.ok) throw new YapError(res.status, data?.error ?? (res.status === 403 ? 'wrong token' : `${res.status}`))
    return data as T
  }

  hello() {
    return this.call<{ protocol: 'yap'; version: number; verbs: string[]; extensions?: string[] }>('hello', {})
  }

  /** Live sessions in the repo `cwd` sits in, this harness's and everyone else's. */
  sessions(cwd: string) {
    return this.call<Peer[]>('sessions', { cwd })
  }

  /** The repo's board, newest first. */
  notes(cwd: string) {
    return this.call<Note[]>('notes', { cwd })
  }

  /** Background sessions started in the repo, newest first. */
  spawns(cwd: string) {
    return this.call<Spawn[]>('spawns', { cwd })
  }

  /** The user's message to one session (`to`: a name or id prefix) or all of them in the repo. */
  say(cwd: string, text: string, to?: string, o: Said = {}) {
    return this.call<{ id: string; to: string[]; woke: string[] }>('say', { cwd, text, to, ...o })
  }

  /** The user's note on the repo's board. */
  note(cwd: string, text: string) {
    return this.call<Note>('note', { cwd, text })
  }

  unnote(cwd: string, id: number) {
    return this.call<{}>('unnote', { cwd, id })
  }

  /** The live claims in the repo, every worktree. */
  claims(cwd: string) {
    return this.call<Claim[]>('claims', { cwd })
  }

  /**
   * Hear what happens in the repo `cwd` sits in (every repo without it), from now on. Comes back by itself
   * when the daemon restarts; read `sessions` after `onOpen` for who was already there. Returns the way to stop.
   */
  watch(cwd: string | undefined, on: (e: YapEvent) => void, o: { onOpen?: () => void; retry?: number } = {}) {
    const stop = new AbortController()
    const url = `${this.url}/yap/events${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`
    void (async () => {
      while (!stop.signal.aborted) {
        try {
          const res = await this.fetcher(url, { headers: { 'x-yap-token': this.token }, signal: stop.signal })
          if (!res.ok || !res.body) throw new Error(String(res.status))
          o.onOpen?.()
          const text = new TextDecoder()
          let buf = ''
          for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            buf += text.decode(chunk, { stream: true })
            let end: number
            while ((end = buf.indexOf('\n\n')) >= 0) {
              const data = buf.slice(0, end).split('\n').find(l => l.startsWith('data: '))
              buf = buf.slice(end + 2)
              if (data) on(JSON.parse(data.slice(6)))
            }
          }
        } catch {}
        if (!stop.signal.aborted) await new Promise(r => setTimeout(r, o.retry ?? 2000))
      }
    })()
    return () => stop.abort()
  }
}

/**
 * One session's side of YAP. Call each verb at its moment in the agent's loop; put `context` in front of the
 * model, show `notice` to the user, and honour `deny`.
 */
export class YapSession {
  constructor(
    readonly yap: YapLocal,
    readonly id: string,
    public cwd: string,
  ) {}

  /**
   * Set it to an answer's `seq` once that answer's context reached the model; every verb sends it. Once set, a
   * message whose answer got lost comes again, up to 3 times with the same `id`; drop ids you already showed.
   * Unset, each message is delivered once.
   */
  ack?: number

  private verb(verb: string, body: object = {}) {
    return this.yap.call<Answer>(verb, { session: this.id, cwd: this.cwd, ack: this.ack, ...body })
  }

  /**
   * The conversation starts. `name`: what the harness calls it (`planner`); otherwise named from its first edit.
   * `pid`: a process that lives exactly as long as the session; when it dies without `leave`, the session goes.
   */
  join(name?: string, pid?: number) {
    return this.verb('join', { name, pid })
  }

  /** The user sent `prompt`. Tells it what peers did since it last heard; nothing when nothing moved. */
  turn(prompt: string) {
    return this.verb('turn', { prompt })
  }

  /** Before a file write. Warns when a peer in the same tree just edited it. */
  willEdit(path: string) {
    return this.verb('will-edit', { path })
  }

  /** After a file write. The first one names the session. */
  edited(path: string) {
    return this.verb('edited', { path })
  }

  /** Before a shell command. `deny` when it would move or sweep up a peer's work in the same tree. */
  willRun(command: string) {
    return this.verb('will-run', { command })
  }

  /** After a shell command: files it changed count as this session's. */
  ran(command: string) {
    return this.verb('ran', { command })
  }

  /**
   * Before the turn ends: messages that came in while it worked. If `context` comes back, let the model carry on
   * with it, then call again with `continuing` (which answers nothing), so two sessions can't keep each other going.
   */
  idle(continuing = false) {
    return this.verb('idle', { continuing })
  }

  /** The conversation ends. */
  leave() {
    return this.verb('leave')
  }

  /** Message one peer (`to`: a name or id prefix) or every session in the repo, as this session. */
  say(text: string, to?: string, o: Said = {}) {
    return this.yap.call<{ id: string; to: string[]; woke: string[] }>('say', { session: this.id, cwd: this.cwd, text, to, ...o })
  }

  /** Pin a note on the repo's board, as this session. */
  note(text: string) {
    return this.yap.call<Note>('note', { session: this.id, cwd: this.cwd, text })
  }

  /**
   * Claim a file or directory before working under it, so peers in any worktree are warned before they edit there.
   * `held` when a peer's live claim overlaps it. It lasts 20 minutes past this session's last edit under it.
   */
  claim(path: string, why: string) {
    return this.yap.call<{ id: string } | { held: { session: string; name: string; path: string; why: string } }>('claim', { session: this.id, cwd: this.cwd, path, why })
  }

  release(id: string) {
    return this.yap.call<{}>('release', { session: this.id, cwd: this.cwd, id })
  }

  /** Start a background Claude Code (or `codex`) session on `task`; its last word comes back to this one as a message. */
  spawn(task: string, agent?: 'claude' | 'codex') {
    return this.yap.call<{ id: string }>('spawn', { session: this.id, cwd: this.cwd, text: task, agent })
  }
}
