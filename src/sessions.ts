import { dirname, relative, resolve } from 'node:path'
import type { Store, Workspace } from './ports'

/** A session silent this long has gone away without saying so. */
const LIVE = 2 * 60 * 60_000
/** An edit this recent is worth a warning to whoever touches the same file next. */
const RECENT = 30 * 60_000

const norm = (p: string) => {
  const r = resolve(p).replace(/\\/g, '/')
  return process.platform === 'win32' ? r.toLowerCase() : r
}

interface Session {
  id: string
  /** Working tree the session edits in. */
  top: string
  /** The repo it belongs to: worktrees of one repo share it. */
  repo: string
  intent: string
  started: number
  at: number
  /** When this session was last told about the others. */
  told: number
  /** File (normalized) to when this session last edited it. */
  files: Map<string, number>
  /** File to the other session's edit time it was already warned about. */
  warned: Map<string, number>
}

/** What Claude Code sends a hook on stdin; only the fields used here. */
export interface HookInput {
  session_id?: string
  cwd?: string
  prompt?: string
  tool_input?: { file_path?: string; notebook_path?: string }
}

function ago(ts: number, now: number) {
  const m = Math.max(0, Math.round((now - ts) / 60_000))
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`
}

/**
 * The connective tissue between Claude Code sessions on this machine. Every hook call reports in; a session
 * learns who else is in its repo, what they are doing, and when it is about to edit a file someone else just did.
 */
export class Sessions {
  private all = new Map<string, Session>()
  private roots = new Map<string, { top: string; repo: string }>()

  constructor(
    private ws: Workspace,
    private store: Store,
    private now = Date.now,
  ) {}

  private async root(cwd: string) {
    let r = this.roots.get(cwd)
    if (!r) {
      const w = await this.ws.where(cwd)
      r = w ? { top: norm(w.top), repo: norm(w.common) } : { top: norm(cwd), repo: norm(cwd) }
      this.roots.set(cwd, r)
    }
    return r
  }

  private async touch(input: HookInput) {
    const now = this.now()
    for (const [id, s] of this.all) if (now - s.at > LIVE) this.all.delete(id)
    const id = String(input.session_id ?? '')
    if (!id || !input.cwd) return null
    let s = this.all.get(id)
    if (!s) {
      const { top, repo } = await this.root(input.cwd)
      s = { id, top, repo, intent: '', started: now, at: now, told: 0, files: new Map(), warned: new Map() }
      this.all.set(id, s)
    }
    s.at = now
    return s
  }

  private others(s: Session) {
    return [...this.all.values()].filter(o => o.id !== s.id && o.repo === s.repo)
  }

  private line(o: Session, from: Session) {
    const now = this.now()
    const files = [...o.files.keys()].map(f => relative(o.top, f).replace(/\\/g, '/'))
    const edited = files.length ? ` · edited ${files.slice(-4).join(', ')}${files.length > 4 ? ` and ${files.length - 4} more` : ''}` : ''
    const where = o.top === from.top ? '' : ' · in another worktree'
    return `- session ${o.id.slice(0, 8)}, active ${ago(o.at, now)}: ${o.intent ? `"${o.intent}"` : 'no prompt yet'}${edited}${where}`
  }

  /** kumi's own crew on the same repo: running tickets, each in its own worktree. */
  private crew(s: Session) {
    const main = s.repo.endsWith('/.git') ? dirname(s.repo) : s.repo
    const p = this.store.projects().find(p => norm(p.path) === main)
    if (!p) return []
    return this.store
      .tickets()
      .filter(t => t.project_id === p.id && ['todo', 'working', 'review', 'gate'].includes(t.status))
      .map(t => `- kumi crew: t${t.id} "${t.title}" (${t.status === 'todo' ? 'queued' : t.status}, merges into ${p.base} when approved)`)
  }

  private overview(s: Session) {
    const lines = [...this.others(s).map(o => this.line(o, s)), ...this.crew(s)]
    s.told = this.now()
    if (!lines.length) return ''
    return `Other agents are working in this repository right now. Don't redo their work, and re-read any file they touched before you edit it:\n${lines.join('\n')}`
  }

  /** Live sessions, for `kumi sessions`. */
  list() {
    const now = this.now()
    return [...this.all.values()]
      .filter(s => now - s.at <= LIVE)
      .map(s => ({ id: s.id, top: s.top, intent: s.intent, started: s.started, at: s.at, files: [...s.files.keys()] }))
  }

  /** One hook call. Returns what Claude Code should get back; `{}` means say nothing. */
  async hook(event: string, input: HookInput): Promise<object> {
    if (event === 'end') {
      this.all.delete(String(input.session_id ?? ''))
      return {}
    }
    const s = await this.touch(input)
    if (!s) return {}
    const say = (name: string, text: string, extra: object = {}) =>
      text ? { ...extra, hookSpecificOutput: { hookEventName: name, additionalContext: text } } : {}

    if (event === 'start') return say('SessionStart', this.overview(s))

    if (event === 'prompt') {
      s.intent = String(input.prompt ?? '').trim().split(/\r?\n/)[0].slice(0, 100)
      // Only when something moved since this session last heard, so a quiet repo costs no context.
      const moved = this.others(s).some(o => o.at > s.told) || (this.crew(s).length > 0 && s.told === 0)
      return moved ? say('UserPromptSubmit', this.overview(s)) : {}
    }

    const path = input.tool_input?.file_path ?? input.tool_input?.notebook_path
    if (!path) return {}
    const file = norm(resolve(input.cwd ?? '', path))

    if (event === 'post') {
      s.files.set(file, this.now())
      return {}
    }

    if (event === 'pre') {
      const hits = this.others(s)
        .filter(o => o.top === s.top)
        .map(o => ({ o, at: o.files.get(file) ?? 0 }))
        .filter(h => this.now() - h.at < RECENT && h.at > (s.warned.get(file) ?? 0))
      if (!hits.length) return {}
      s.warned.set(file, Math.max(...hits.map(h => h.at)))
      // As the session spelled it: `file` is lowercased on Windows.
      const name = relative(input.cwd ?? '', resolve(input.cwd ?? '', path)).replace(/\\/g, '/')
      const who = hits.map(h => `session ${h.o.id.slice(0, 8)} (${h.o.intent ? `"${h.o.intent}"` : 'no prompt yet'}) edited it ${ago(h.at, this.now())}`)
      return say(
        'PreToolUse',
        `Another session is working on ${name} in this same working tree: ${who.join('; ')}. Re-read the file before you edit it, keep their change intact, and if your task overlaps theirs, say so to the user instead of redoing it.`,
        { systemMessage: `kumi: ${name} was just edited by ${hits.map(h => h.o.id.slice(0, 8)).join(', ')}` },
      )
    }
    return {}
  }
}
