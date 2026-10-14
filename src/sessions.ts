import { dirname, relative, resolve } from 'node:path'
import type { Store, Workspace } from './ports'

/** A session silent this long has gone away without saying so. */
const LIVE = 2 * 60 * 60_000
/** An edit this recent is worth a warning to whoever touches the same file next. */
const RECENT = 30 * 60_000
/** Notes shown to a session; the rest stay on the board for `kumi notes`. */
const BOARD = 10

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
  /** Messages from other sessions or the user, delivered on its next hook call. */
  inbox: string[]
  /** When its running shell command started, to tell which files the command changed. */
  shell: number
}

/** Git commands that move or discard the shared working tree under whoever else is editing it. */
const CLOBBER = /\bgit\s+(checkout|switch|stash|clean|rebase|restore|pull|merge|reset\s+(?:\S+\s+)*--hard)\b/

/** What Claude Code sends a hook on stdin; only the fields used here. */
export interface HookInput {
  session_id?: string
  cwd?: string
  prompt?: string
  tool_name?: string
  tool_input?: { file_path?: string; notebook_path?: string; command?: string }
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
      s = { id, top, repo, intent: '', started: now, at: now, told: 0, files: new Map(), warned: new Map(), inbox: [], shell: 0 }
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
    const board = this.store.notes(s.repo).slice(0, BOARD).map(n => `- #${n.id} ${ago(n.ts, this.now())}, ${n.author}: ${n.text.slice(0, 300)}`)
    s.told = this.now()
    if (!lines.length && !board.length) return ''
    return [
      ...(lines.length
        ? [`Other agents are working in this repository right now. Don't redo their work, and re-read any file they touched before you edit it:`, ...lines]
        : []),
      ...(board.length ? [`This repository's kumi board, what sessions and the user left for whoever works here next:`, ...board] : []),
      `You are session ${s.id.slice(0, 8)}. Message the others with \`kumi say @<session> <text>\` or \`kumi say <text>\` for all of them. Leave something on the board for later sessions (a claim on an area, a decision, a warning, a handoff) with \`kumi note <text>\`, and take a note down with \`kumi note -d <id>\` once it no longer holds.`,
    ].join('\n')
  }

  /** Pin a note on the board of the repo `cwd` sits in. Live sessions there hear about it on their next hook call. */
  async note(m: { from?: string; cwd: string; text: string }) {
    const text = m.text.trim()
    if (!text) throw new Error('say what the note is')
    const s = m.from ? await this.touch({ session_id: m.from, cwd: m.cwd }) : null
    const repo = s?.repo ?? (await this.root(m.cwd)).repo
    const n = this.store.addNote({ repo, ts: this.now(), author: this.label(s), text })
    for (const o of this.all.values()) if (o.repo === repo && o.id !== s?.id) o.inbox.push(`New note on the board, #${n.id} from ${n.author}: ${text}`)
    return n
  }

  async notes(cwd: string) {
    return this.store.notes((await this.root(cwd)).repo)
  }

  async unnote(cwd: string, id: number) {
    if (!this.store.removeNote((await this.root(cwd)).repo, id)) throw new Error(`no note #${id} on this repo's board`)
  }

  /** Who a message is from, as the recipient reads it. */
  private label(s: Session | null) {
    return s ? `session ${s.id.slice(0, 8)}${s.intent ? ` ("${s.intent}")` : ''}` : 'the user'
  }

  /**
   * Leave a message for the other sessions in the sender's repo, or the one whose id starts with `to`. A
   * sender outside Claude Code (no `from`) is the user. Delivered on each recipient's next hook call.
   */
  async say(m: { from?: string; cwd: string; text: string; to?: string }) {
    const text = m.text.trim()
    if (!text) throw new Error('say something')
    const s = m.from ? await this.touch({ session_id: m.from, cwd: m.cwd }) : null
    const repo = s?.repo ?? (await this.root(m.cwd)).repo
    const to = m.to?.replace(/^@/, '').toLowerCase()
    const now = this.now()
    const them = [...this.all.values()].filter(o => o.repo === repo && o.id !== s?.id && now - o.at <= LIVE && (!to || o.id.startsWith(to)))
    if (!them.length) throw new Error(to ? `no live session ${to} in this repo` : 'nobody else is working in this repo')
    for (const o of them) o.inbox.push(`From ${this.label(s)}: ${text}`)
    return them.map(o => o.id.slice(0, 8))
  }

  /** Everything waiting for `s`, emptied. */
  private drain(s: Session) {
    if (!s.inbox.length) return ''
    const lines = s.inbox.splice(0)
    return `Messages for you through kumi:\n${lines.map(l => `- ${l}`).join('\n')}\nAnswer a session with \`kumi say @<session> <text>\` if it needs one; tell the user about anything that changes your plan.`
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
    const both = (...parts: string[]) => parts.filter(Boolean).join('\n\n')

    if (event === 'start') return say('SessionStart', both(this.overview(s), this.drain(s)))

    if (event === 'prompt') {
      s.intent = String(input.prompt ?? '').trim().split(/\r?\n/)[0].slice(0, 100)
      // Only when something moved since this session last heard, so a quiet repo costs no context.
      const moved = this.others(s).some(o => o.at > s.told) || (this.crew(s).length > 0 && s.told === 0)
      return say('UserPromptSubmit', both(moved ? this.overview(s) : '', this.drain(s)))
    }

    const command = input.tool_input?.command
    if (input.tool_name === 'Bash' && typeof command === 'string') {
      if (event === 'post') {
        // A shell command edits too (sed, codegen, a formatter): what it touched counts as this session's.
        for (const f of await this.ws.changed(s.top)) if (f.mtime >= s.shell - 1000) s.files.set(norm(f.path), this.now())
        return {}
      }
      if (event !== 'pre') return {}
      s.shell = this.now()
      const mail = this.drain(s)
      const busy = this.others(s).filter(o => o.top === s.top && this.now() - o.at < RECENT && o.files.size)
      if (!CLOBBER.test(command) || !busy.length) return say('PreToolUse', mail, mail ? { systemMessage: 'kumi: a message arrived' } : {})
      const who = busy.map(o => `${this.label(o)}, editing ${[...o.files.keys()].slice(-3).map(f => relative(s.top, f).replace(/\\/g, '/')).join(', ')}`)
      return {
        systemMessage: `kumi: held back a git command that would move the tree under ${busy.map(o => o.id.slice(0, 8)).join(', ')}`,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `kumi: another session is working in this same working tree right now (${who.join('; ')}). This git command can switch, rewrite or discard the files under it. Don't run it. Ask that session first with \`kumi say @<session> <text>\`, use a separate worktree, or ask the user to run it if they asked for it.`,
          ...(mail ? { additionalContext: mail } : {}),
        },
      }
    }

    const path = input.tool_input?.file_path ?? input.tool_input?.notebook_path
    if (event === 'post') {
      if (path) s.files.set(norm(resolve(input.cwd ?? '', path)), this.now())
      return {}
    }
    if (event !== 'pre') return {}
    const mail = this.drain(s)
    const notice = mail ? { systemMessage: 'kumi: a message arrived' } : {}
    if (!path) return say('PreToolUse', mail, notice)

    const file = norm(resolve(input.cwd ?? '', path))
    const hits = this.others(s)
      .filter(o => o.top === s.top)
      .map(o => ({ o, at: o.files.get(file) ?? 0 }))
      .filter(h => this.now() - h.at < RECENT && h.at > (s.warned.get(file) ?? 0))
    if (!hits.length) return say('PreToolUse', mail, notice)
    s.warned.set(file, Math.max(...hits.map(h => h.at)))
    // As the session spelled it: `file` is lowercased on Windows.
    const name = relative(input.cwd ?? '', resolve(input.cwd ?? '', path)).replace(/\\/g, '/')
    const who = hits.map(h => `${this.label(h.o)} edited it ${ago(h.at, this.now())}`)
    return say(
      'PreToolUse',
      both(
        `Another session is working on ${name} in this same working tree: ${who.join('; ')}. Re-read the file before you edit it, keep their change intact, and if your task overlaps theirs, tell them with \`kumi say @<session> <text>\` and tell the user instead of redoing it.`,
        mail,
      ),
      { systemMessage: `kumi: ${name} was just edited by ${hits.map(h => h.o.id.slice(0, 8)).join(', ')}` },
    )
  }
}
