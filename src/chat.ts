import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { AgentRunner, Project, Workspace } from './ports'

/** One line of a chat, as the web client draws it. `n` counts up per thread, so a client asks for what is after it. */
export interface ChatEvent {
  n: number
  at: number
  kind: 'you' | 'text' | 'tool' | 'done' | 'error'
  text: string
}

interface Thread {
  id: string
  project: string
  cwd: string
  /** Edits allowed: the chat runs in its own worktree on this branch, never in the user's checkout. */
  branch: string | null
  /** Claude Code's own session id: every turn after the first resumes it. */
  session: string
  resumable: boolean
  events: ChatEvent[]
  run: AbortController | null
  at: number
}

const SAYS = (edits: boolean) =>
  `The user is chatting with you from a web page (Rinai's Agents tab) through yap, on their own machine. They see your text and a one-line note per tool call, nothing else, and they answer in the next message. ${
    edits
      ? 'You are in a git worktree of your own on a yap/chat-* branch: edit and commit freely here; the user merges it when they want it. Nothing you do here touches their checkout.'
      : 'You can read and search the project, not change it. If they want changes, say so: they can start a chat with edits allowed.'
  }`

/** A tool line with the project's own root taken off its paths, however the path is spelled. */
export function rooted(line: string, dir: string) {
  for (const d of new Set([dir, dir.replace(/\\/g, '/')])) for (const sep of ['\\', '/']) line = line.split(d + sep).join('')
  return line
}

/**
 * Chats from the web: one Claude Code session per thread, a turn per message. Read-only in the project's own
 * checkout, or with edits in a worktree of its own, so a page never writes where the user is working.
 */
// ponytail: threads live in memory; a daemon restart loses the window onto them (the Claude session and the
// worktree stay on disk). Persist them in the store if that bites.
export class Chats {
  private threads = new Map<string, Thread>()

  constructor(
    private runner: AgentRunner,
    private ws: Workspace,
    private home: string,
    private now: () => number = Date.now,
  ) {}

  private thread(id: string) {
    const t = this.threads.get(id)
    if (!t) throw Object.assign(new Error(`no chat ${id}`), { status: 404 })
    return t
  }

  private push(t: Thread, kind: ChatEvent['kind'], text: string) {
    t.events.push({ n: t.events.length + 1, at: this.now(), kind, text })
    t.at = this.now()
  }

  /** A message: a new thread when none is named. `edits` is the new thread's, and fixed for its life. */
  async say(p: Project, text: string, thread?: string, edits = false) {
    text = text.trim()
    if (!text) throw new Error('say something')
    let t = thread ? this.thread(thread) : undefined
    if (t && t.project !== p.name) throw new Error(`chat ${thread} is in ${t.project}`)
    if (t?.run) throw Object.assign(new Error('still answering: wait, or stop it'), { status: 409 })
    if (!t) {
      const session = randomUUID()
      const id = session.slice(0, 8)
      const branch = edits ? `yap/chat-${id}` : null
      const cwd = branch ? join(this.home, 'chats', p.name, id) : p.path
      if (branch) await this.ws.worktree(p.path, cwd, branch, p.base)
      t = { id, project: p.name, cwd, branch, session, resumable: false, events: [], run: null, at: this.now() }
      this.threads.set(id, t)
    }
    const chat = t
    this.push(chat, 'you', text)
    const run = (chat.run = new AbortController())
    let heard = false
    void this.runner
      .run({
        cwd: chat.cwd,
        prompt: text,
        readOnly: !chat.branch,
        signal: run.signal,
        chat: { session: chat.session, resume: chat.resumable, system: SAYS(!!chat.branch) },
        onText: s => ((heard = true), this.push(chat, 'text', s)),
        // Paths inside the project read from its root: the page has no use for where it sits on this disk.
        onActivity: line => ((heard = true), this.push(chat, 'tool', rooted(line, chat.cwd))),
      })
      .then(
        r => {
          chat.resumable ||= r.ok || heard
          this.push(chat, r.ok ? 'done' : 'error', r.ok ? '' : run.signal.aborted ? 'stopped' : r.text)
        },
        e => this.push(chat, 'error', run.signal.aborted ? 'stopped' : String(e?.message ?? e)),
      )
      .finally(() => (chat.run = null))
    return { thread: chat.id }
  }

  read(id: string, after = 0) {
    const t = this.thread(id)
    return { thread: t.id, project: t.project, branch: t.branch, busy: !!t.run, events: t.events.filter(e => e.n > after) }
  }

  stop(id: string) {
    this.thread(id).run?.abort()
    return {}
  }

  /** Threads, newest first, each named by its first message. */
  list(project?: string) {
    return [...this.threads.values()]
      .filter(t => !project || t.project === project)
      .sort((a, b) => b.at - a.at)
      .map(t => ({ thread: t.id, project: t.project, branch: t.branch, busy: !!t.run, at: t.at, title: (t.events.find(e => e.kind === 'you')?.text ?? '').slice(0, 80) }))
  }
}
