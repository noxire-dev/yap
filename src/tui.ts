import type { Card, Event, Goal, Project, Ticket } from './ports'

export interface State {
  /** Fingerprint of the daemon's source. */
  build: number
  projects: Project[]
  goals: Goal[]
  tickets: Ticket[]
  /** Ticket id to the one line its agent is on right now. */
  activity: Record<string, { line: string; at: number }>
}

/** The daemon, as the TUI sees it. */
export interface Client {
  get<T = any>(path: string): Promise<T>
  send(method: 'POST' | 'PATCH', path: string, body?: object): Promise<any>
  /** `ping` on every state change; `down` when the daemon stops or starts answering. */
  watch(ping: () => void, down: (isDown: boolean) => void): void
}

export interface Term {
  columns: number
  rows: number
  write(s: string): void
}

export interface Host {
  cwd: string
  /** When the previous session ended; merges after it are marked new. */
  seen: number
  quit(): void
}

// ── text ────────────────────────────────────────────────────────────────────

let color = true
export const useColor = (on: boolean) => void (color = on)
const sgr = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s)
const dim = sgr('2')
const bold = sgr('1')
const red = sgr('31')
const green = sgr('32')
const yellow = sgr('33')
const current = sgr('1;4')
const inverse = sgr('7')

const width = (s: string) => Bun.stringWidth(s)

function clip(s: string, w: number) {
  if (width(s) <= w) return s
  let out = ''
  let n = 0
  for (const [ch] of s.matchAll(/\x1b\[[0-9;]*m|./gu)) {
    if (ch.startsWith('\x1b[')) {
      out += ch
      continue
    }
    if (n + width(ch) > w - 1) break
    out += ch
    n += width(ch)
  }
  return out + '…' + (color ? '\x1b[0m' : '')
}

const pad = (s: string, w: number) => {
  const c = clip(s, w)
  return c + ' '.repeat(Math.max(0, w - width(c)))
}

/** `left` and `right` on one line, `left` giving way when they don't both fit. */
function row(left: string, right: string, w: number) {
  const gap = w - width(left) - width(right)
  return gap >= 1 ? left + ' '.repeat(gap) + right : clip(left, Math.max(1, w - width(right) - 1)) + ' ' + right
}

function wrap(text: string, w: number) {
  const out: string[] = []
  for (const para of text.split(/\r?\n/)) {
    let line = ''
    for (const word of para.split(' ')) {
      if (line && width(line) + 1 + width(word) > w) {
        out.push(line)
        line = word
      } else line = line ? `${line} ${word}` : word
    }
    out.push(line)
  }
  return out
}

const first = (s: unknown) => String(s ?? '').trim().split(/\r?\n/)[0]
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function clock(ts: number, now = Date.now()) {
  const d = new Date(ts)
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  return new Date(now).toDateString() === d.toDateString() ? time : `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${time}`
}

function ago(ts: number, now: number) {
  const m = Math.max(0, Math.floor((now - ts) / 60_000))
  return m < 1 ? 'just now' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`
}

// ── input ───────────────────────────────────────────────────────────────────

const SEQ: Record<string, string> = {
  '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left',
  '\x1bOA': 'up', '\x1bOB': 'down', '\x1bOC': 'right', '\x1bOD': 'left',
  '\x1b[H': 'home', '\x1b[F': 'end', '\x1b[1~': 'home', '\x1b[4~': 'end', '\x1bOH': 'home', '\x1bOF': 'end',
  '\x1b[3~': 'delete', '\x1b[5~': 'pgup', '\x1b[6~': 'pgdn', '\x1b[Z': 'shift-tab',
  '\x1b[1;5C': 'ctrl-right', '\x1b[1;5D': 'ctrl-left',
}
const CTRL: Record<string, string> = {
  '\r': 'enter', '\n': 'ctrl-j', '\t': 'tab', '\x7f': 'backspace', '\b': 'backspace', '\x1b': 'esc',
  '\x01': 'ctrl-a', '\x03': 'ctrl-c', '\x04': 'ctrl-d', '\x05': 'ctrl-e', '\x13': 'ctrl-s', '\x15': 'ctrl-u', '\x17': 'ctrl-w',
}

/**
 * Raw terminal bytes to key names. One printable character is itself; everything else is named
 * (`up`, `ctrl-s`, `paste:<text>`, `wheel-up:<x>`, `click:<x>:<y>`). Stateful: a paste can span chunks.
 */
export function reader() {
  let pasting: string | null = null
  return (chunk: string): string[] => {
    const out: string[] = []
    let i = 0
    // A terminal without bracketed paste delivers a paste as one burst of plain text.
    if (pasting === null && chunk.length > 1 && !chunk.includes('\x1b') && /[\r\n]/.test(chunk)) return [`paste:${chunk}`]
    while (i < chunk.length) {
      const rest = chunk.slice(i)
      if (pasting !== null) {
        const end = rest.indexOf('\x1b[201~')
        pasting += end < 0 ? rest : rest.slice(0, end)
        if (end < 0) break
        out.push(`paste:${pasting}`)
        pasting = null
        i += end + 6
        continue
      }
      if (rest.startsWith('\x1b[200~')) {
        pasting = ''
        i += 6
        continue
      }
      const mouse = rest.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/)
      if (mouse) {
        const [all, b, x, y, kind] = mouse
        if (b === '64') out.push(`wheel-up:${x}`)
        else if (b === '65') out.push(`wheel-down:${x}`)
        else if (b === '0' && kind === 'M') out.push(`click:${x}:${y}`)
        i += all.length
        continue
      }
      const seq = rest.match(/^\x1b(?:\[[0-9;]*[A-Za-z~]|O[A-Za-z])/)
      if (seq) {
        if (SEQ[seq[0]]) out.push(SEQ[seq[0]])
        i += seq[0].length
        continue
      }
      if (rest[0] === '\x1b' && rest.length > 1) {
        if (rest[1] === '\r') out.push('alt-enter')
        i += 2
        continue
      }
      const ch = String.fromCodePoint(rest.codePointAt(0)!)
      out.push(CTRL[ch] ?? ch)
      i += ch.length
    }
    return out
  }
}

/** A text field: a string, a cursor, and enough layout to move through wrapped lines. */
class Editor {
  cur: number
  private w = 60
  private top = 0

  constructor(
    public value = '',
    readonly multi = false,
    private placeholder = '',
  ) {
    this.cur = value.length
  }

  /** Visual rows as [start, end) offsets into the value, word-wrapped at `w`. */
  private layout(w: number) {
    const rows: [number, number][] = []
    let start = 0
    for (const line of this.value.split('\n')) {
      const end = start + line.length
      let pos = start
      while (end - pos > w) {
        const space = this.value.lastIndexOf(' ', pos + w)
        if (space <= pos) {
          rows.push([pos, pos + w])
          pos += w
        } else {
          rows.push([pos, space])
          pos = space + 1
        }
      }
      rows.push([pos, end])
      start = end + 1
    }
    return rows
  }

  private rowOf(rows: [number, number][]) {
    let at = 0
    rows.forEach(([a], i) => a <= this.cur && (at = i))
    return at
  }

  private put(text: string) {
    this.value = this.value.slice(0, this.cur) + text + this.value.slice(this.cur)
    this.cur += text.length
  }

  key(k: string) {
    const v = this.value
    const c = this.cur
    const lineStart = v.lastIndexOf('\n', c - 1) + 1
    const cut = (from: number) => {
      this.value = v.slice(0, from) + v.slice(c)
      this.cur = from
    }
    // Never leave the cursor between the halves of a surrogate pair.
    const low = (i: number) => v.charCodeAt(i) >= 0xdc00 && v.charCodeAt(i) <= 0xdfff
    if (k.startsWith('paste:')) {
      const text = k.slice(6).replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(/[\x00-\x09\x0b-\x1f]/g, '')
      return this.put(this.multi ? text : text.replace(/\n+/g, ' '))
    }
    switch (k) {
      case 'newline':
        return void (this.multi && this.put('\n'))
      case 'left':
        return void (this.cur = Math.max(0, c - (low(c - 1) ? 2 : 1)))
      case 'right':
        return void (this.cur = Math.min(v.length, c + (low(c + 1) ? 2 : 1)))
      case 'home':
      case 'ctrl-a':
        return void (this.cur = lineStart)
      case 'end':
      case 'ctrl-e':
        return void (this.cur = v.indexOf('\n', c) < 0 ? v.length : v.indexOf('\n', c))
      case 'ctrl-left':
        return void (this.cur = v.slice(0, c).replace(/\S+\s*$/, '').length)
      case 'ctrl-right':
        return void (this.cur = c + (v.slice(c).match(/^\s*\S+/)?.[0].length ?? 0))
      case 'up':
      case 'down': {
        const rows = this.layout(this.w)
        const at = this.rowOf(rows)
        const to = rows[at + (k === 'up' ? -1 : 1)]
        if (to) this.cur = Math.min(to[0] + (c - rows[at][0]), to[1])
        return
      }
      case 'backspace':
        return void (c && cut(c - (low(c - 1) ? 2 : 1)))
      case 'delete':
        return void (this.value = v.slice(0, c) + v.slice(c + (low(c + 1) ? 2 : 1)))
      case 'ctrl-w':
        return cut(v.slice(0, c).replace(/\S+\s*$/, '').length)
      case 'ctrl-u':
        return cut(lineStart)
    }
    if ([...k].length === 1 && k >= ' ') this.put(k)
  }

  render(w: number, max: number, active: boolean) {
    this.w = w - 1
    if (!this.value) return [active ? inverse(' ') + dim(this.placeholder) : dim(this.placeholder)]
    const rows = this.layout(this.w)
    const at = this.rowOf(rows)
    if (at < this.top) this.top = at
    if (at >= this.top + max) this.top = at - max + 1
    return rows.slice(this.top, this.top + max).map(([a, b], i) => {
      const text = this.value.slice(a, b)
      if (!active || i + this.top !== at) return text
      const col = this.cur - a
      return text.slice(0, col) + inverse(text[col] ?? ' ') + text.slice(col + 1)
    })
  }
}

// ── the rail ────────────────────────────────────────────────────────────────

const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const PHASE: Record<string, string> = { working: 'working', review: 'in review', gate: 'at the gate' }

const goalLabel = (g: Goal) => (g.issue && !g.text.startsWith('#') ? `#${g.issue} ` : '') + first(g.text)

/**
 * The base branch as a line down the screen, newest at the top like `git log --graph`.
 * Above the first merge is everything still on its way in, most urgent first.
 */
export function rail(s: State, p: Project, w: number, o: { sel: number | null; seen: number; tick: number; now: number }) {
  const mine = s.tickets.filter(t => t.project_id === p.id)
  const by = (...st: Ticket['status'][]) => mine.filter(t => st.includes(t.status))
  const done = new Set(by('merged', 'dropped').map(t => t.id))
  const lines: string[] = []
  const span = new Map<number, [number, number]>()
  const order: number[] = []
  const pipe = ` ${dim('│')}`
  const spin = yellow(SPIN[o.tick % SPIN.length])

  const put = (t: Ticket, rows: string[]) => {
    span.set(t.id, [lines.length, lines.length + rows.length])
    order.push(t.id)
    lines.push(...rows)
  }
  const head = (t: Ticket, lead: string, right: string, extra = '') => {
    const on = t.id === o.sel
    return row(`${on ? red('▌') : ' '}${lead} ${dim(`t${t.id}`)} ${on ? bold(t.title) : t.title}${extra}`, `${right} `, w)
  }

  for (const t of by('escalated'))
    put(t, [head(t, dim('├─╮'), red('needs you')), clip(`${pipe} ${red('✗')} ${first(t.note) || 'escalated'}`, w), pipe])

  for (const t of by('working', 'review', 'gate')) {
    const live = s.activity[t.id]
    const quiet = live && o.now - live.at > 5 * 60_000 ? yellow(` · quiet ${ago(live.at, o.now)}`) : ''
    const doing = live?.line ? dim(` · ${live.line}`) : ''
    put(t, [
      head(t, dim('├─╮'), dim(`round ${t.round || 1}`)),
      clip(`${pipe} ${spin} ${PHASE[t.status]} ${dim(ago(t.updated, o.now))}${quiet}${doing}`, w),
      pipe,
    ])
  }

  const goals = s.goals.filter(g => g.project_id === p.id)
  for (const g of goals.filter(g => g.status === 'planning'))
    lines.push(clip(` ${dim('┆')} ${spin} planning ${dim(`· ${goalLabel(g)}`)}`, w), clip(` ${dim('┆   a planner is reading the repo and drafting tickets')}`, w), pipe)
  const last = goals.at(-1)
  if (last?.status === 'failed') lines.push(clip(` ${dim('┆')} ${red('✗')} planning failed ${dim(`· ${first(last.note)}`)}`, w), pipe)

  for (const t of by('todo')) {
    const waits = t.deps.filter(d => !done.has(d))
    put(t, [head(t, dim('┆  '), dim(waits.length ? `waits for ${waits.map(d => `t${d}`).join(', ')}` : p.running ? 'queued' : 'paused'))])
  }
  if (by('todo').length) lines.push(pipe)

  for (const g of goals) {
    const drafts = by('draft').filter(t => t.goal_id === g.id)
    if (!drafts.length) continue
    lines.push(row(` ${dim('┆')} ${bold('goal')} ${goalLabel(g)}`, `${plural(drafts.length, 'draft')} · ${bold('s')} starts them `, w))
    for (const t of drafts) {
      const after = t.deps.length ? dim(`after ${t.deps.map(d => `t${d}`).join(', ')}`) : dim('draft')
      put(t, [head(t, dim('┆  '), after)])
    }
    lines.push(pipe)
  }

  const merged = by('merged').sort((a, b) => b.updated - a.updated)
  const fresh = merged.filter(t => t.updated > o.seen).length
  if (fresh && o.seen) lines.push(clip(` ${dim('●')} ${bold(`${plural(fresh, 'merge')} since you last looked`)} ${dim(`(${clock(o.seen, o.now)})`)}`, w))
  merged.forEach((t, i) => {
    const seal = t.override ? yellow('human override') : `${green('✓')} ${t.criteria.length}/${t.criteria.length}`
    const fresh = t.updated > o.seen ? ` ${red('new')}` : ''
    const right = `${seal} ${dim(`· ${plural(t.round, 'round')} · ${t.sha?.slice(0, 7)}`)}${fresh}`
    put(t, [head(t, `${green('●')} ${dim(clock(t.updated, o.now))}`, right, i === 0 ? dim(` (${p.base})`) : '')])
  })
  if (!merged.length) lines.push(` ${dim(`● ${p.base} · nothing merged yet`)}`)

  return { lines, span, order }
}

function told(e: Event) {
  const d = e.data as any
  switch (e.kind) {
    case 'claim':
      return `round ${d.round}`
    case 'submit':
      return `round ${d.round} · ${first(d.summary)}`
    case 'verdict':
      return d.approved ? green('approved') : d.note ? `sent back · ${first(d.note)}` : `sent back · ${d.criteria.filter((c: any) => !c.pass).length} of ${d.criteria.length} failed`
    case 'gate':
      return red(first(d.log))
    case 'merge':
      return `${String(d.sha).slice(0, 7)} after ${plural(d.rounds, 'round')}`
    case 'escalate':
      return red(first(d.why))
    case 'human':
      return `${d.action}${d.note ? ` · ${d.note}` : ''}`
    case 'digest':
      return d.written ? 'the crew wrote up what it did' : 'no write-up; listed the author reports instead'
    case 'tracker':
      return d.failed ? red(`rinai #${d.issue}: ${d.failed} failed · ${d.error}`) : `rinai #${d.issue} · ${d.did}`
    default:
      return ''
  }
}

function state(t: Ticket) {
  if (t.status === 'escalated') return red('needs you')
  if (PHASE[t.status]) return yellow(PHASE[t.status])
  if (t.status === 'merged') return green('merged')
  return dim(t.status === 'todo' ? 'queued' : t.status)
}

/** One ticket in full: the latest verdict per criterion, what was done, its journal, then what it asked for. */
export function sheet(t: Ticket, events: Event[], goal: Goal | undefined, w: number) {
  const out: string[] = []
  const say = (text: string, indent: number, style = (s: string) => s) => wrap(text, w - indent - 1).forEach(l => out.push(' '.repeat(indent) + style(l)))
  const verdict = events.find(e => e.kind === 'verdict' && (e.data.criteria as any[])?.length)?.data as any

  say(t.title, 1, bold)
  out.push(` ${dim(`t${t.id}`)} ${state(t)}${t.round ? dim(` · round ${t.round}`) : ''}${goal?.issue ? dim(` · rinai #${goal.issue}`) : ''}`, '')

  if (t.status === 'escalated') {
    out.push(` ${red('Why it stopped')}`)
    say(t.note || 'escalated', 3)
    out.push('')
  }
  out.push(` ${bold('Criteria')}${dim(verdict ? `  verdict from round ${verdict.round}` : '  not reviewed yet')}`)
  t.criteria.forEach((c, i) => {
    const v = verdict?.criteria[i]
    const start = out.length
    say(`${i + 1}. ${c}`, 3)
    out[start] = ` ${!v ? dim('·') : v.pass ? green('✓') : red('✗')}${out[start].slice(2)}`
    if (v?.reason) say(v.reason, 6, dim)
  })
  if (t.findings.length && t.status !== 'merged') {
    out.push('', ` ${bold('Sent back with')}`)
    for (const f of t.findings) say(`- ${f}`, 3)
  }
  if (goal?.summary && t.status === 'merged') {
    out.push('', ` ${bold('What the crew did')} ${dim(`for: ${goalLabel(goal)}`)}`)
    say(goal.summary, 3)
  }
  if (t.summary) {
    out.push('', ` ${bold(t.status === 'merged' ? "The author's report" : 'The author says')}`)
    say(t.summary, 3)
  }
  if (events.length) {
    out.push('', ` ${bold('Journal')}`)
    for (const e of [...events].reverse()) out.push(clip(` ${dim(clock(e.ts))}  ${e.kind.padEnd(8)} ${told(e)}`, w))
  }
  out.push('', ` ${bold('Ticket')}`)
  say(t.body || '(no description)', 1, t.body ? undefined : dim)
  return out
}

/** Plain printout of every project's rail, for `kumi status`. */
export function status(s: State, w: number, seen: number) {
  if (!s.projects.length) return 'no projects yet. run `kumi` in a repo to add one.'
  const now = Date.now()
  return s.projects
    .map(p => [`${bold(p.name)} ${dim(p.running ? '' : '(paused)')}`, ...rail(s, p, w, { sel: null, seen, tick: 0, now }).lines].join('\n'))
    .join('\n\n')
}

// ── the board ───────────────────────────────────────────────────────────────

const HINTS: Record<Ticket['status'], string> = {
  draft: 's start  e edit  x drop',
  todo: 'e edit  x drop',
  working: 'R restart the agent  x drop',
  review: 'R restart the agent  x drop',
  gate: '',
  merged: '',
  escalated: 'r retry  a approve anyway  e edit  x drop',
  dropped: '',
}

const HELP = `
 on the rail
   ↑ ↓  j k     move                      n   new work: say what you want done
   ↵            open the ticket           i   take issues from the Rinai board
   d            its diff                  p   pause or resume the crew
   s            start a goal's drafts     c   gate command and agent count
   e            edit a ticket             A   add another repo by path
   r            retry, with a note        tab next project
   a            approve past the reviewer q   quit (the crew keeps working)
   R            restart a stalled agent
   x            drop a ticket

 A ticket moves: draft → queued → working → in review → at the gate → merged.
 It is sent back to its author when a criterion fails, and lands in front of you
 after four rounds. The author never decides whether its own change merges.

 esc closes this`

interface Field {
  label: string
  ed: Editor
  rows: number
}

/** A bordered form at the bottom of the screen. One field submits on enter; several submit on ctrl+s. */
interface Box {
  title: string
  fields: Field[]
  at: number
  toggle?: { label: string; on: boolean }
  done(values: string[], toggle: boolean): Promise<unknown>
}

type Listed = Card & { onRail: boolean }
const SPLIT_AT = 110

export class Tui {
  private s: State = { build: 0, projects: [], goals: [], tickets: [], activity: {} }
  private pid: number | null = null
  private sel: number | null = null
  private order: number[] = []
  private span = new Map<number, [number, number]>()
  private view: 'rail' | 'ticket' | 'diff' = 'rail'
  private events = new Map<number, Event[]>()
  private diff: string[] = []
  private top = 0
  private side = 0
  private box: Box | null = null
  private picker: { cards: Listed[] | null; at: number; filter: string; marked: Set<number> } | null = null
  private confirm: { text: string; done: () => Promise<unknown> } | null = null
  private help = false
  private toast: { text: string; until: number } | null = null
  private down = false
  private tick = 0
  private loading = false
  private stale = false

  constructor(
    private api: Client,
    private term: Term,
    private host: Host,
  ) {}

  async start() {
    // Started inside a repo: that repo is the project, added on the spot if it is new.
    try {
      this.pid = (await this.api.send('POST', '/api/projects', { path: this.host.cwd })).id
    } catch (e: any) {
      if (String(e?.message).includes('not inside a git repo')) this.offerInit(this.host.cwd)
    }
    this.api.watch(
      () => void this.refresh(),
      down => {
        this.down = down
        this.render()
      },
    )
    // The spinner runs while something is; the clock alone redraws once a second.
    setInterval(() => {
      this.tick++
      const p = this.project
      const busy = this.s.tickets.some(t => t.project_id === p?.id && PHASE[t.status]) || this.s.goals.some(g => g.status === 'planning') || (this.picker && !this.picker.cards)
      if (busy || this.tick % 10 === 0) this.render()
    }, 100)
    await this.refresh()
  }

  /** A plain directory: make it a repo, so the crew has a base to branch from. */
  private offerInit(path: string) {
    this.confirm = {
      text: `${path} is not a git repo. Create one there so the crew can work?`,
      done: async () => {
        this.pid = (await this.api.send('POST', '/api/projects', { path, init: true })).id
        this.sel = null
        await this.refresh()
      },
    }
  }

  private get project() {
    return this.s.projects.find(p => p.id === this.pid) ?? this.s.projects[0]
  }

  private get ticket() {
    return this.s.tickets.find(t => t.id === this.sel)
  }

  private get split() {
    return this.term.columns >= SPLIT_AT
  }

  /** Width of the rail: all of it, or what the ticket pane beside it leaves. */
  private get railWidth() {
    const w = this.term.columns
    return this.split ? Math.max(56, w - Math.min(72, Math.floor(w * 0.42)) - 1) : w
  }

  private say(text: string, bad = false) {
    this.toast = { text: bad ? red(text) : text, until: Date.now() + (bad ? 8000 : 4000) }
  }

  private async refresh() {
    if (this.loading) return void (this.stale = true)
    this.loading = true
    try {
      this.s = await this.api.get<State>('/api/state')
      if (this.sel) this.events.set(this.sel, await this.api.get(`/api/events?ticket=${this.sel}`))
    } catch {
      // watch() reports the outage; keep showing the last state.
    }
    this.loading = false
    this.render()
    if (this.stale) {
      this.stale = false
      void this.refresh()
    }
  }

  private select(id: number | null) {
    if (id === this.sel) return
    this.sel = id
    this.side = 0
    if (id && !this.events.has(id))
      void this.api.get(`/api/events?ticket=${id}`).then(e => {
        this.events.set(id, e)
        this.render()
      }, () => {})
  }

  // ── drawing ──

  render() {
    const w = this.term.columns
    const h = this.term.rows
    const room = h - 3
    const p = this.project
    const goalOf = (t: Ticket) => this.s.goals.find(g => g.id === t.goal_id)
    let body: string[]

    if (this.help) body = HELP.split('\n')
    else if (this.picker) body = this.pickerLines(w, room)
    else if (!p) body = ['', ` ${bold('kumi')} runs a crew of coding agents on a git repo.`, '', ` Start it inside a repo, or press ${bold('A')} and give it a path.`]
    else if (this.view === 'rail') {
      const lw = this.railWidth
      const opts = { seen: this.host.seen, tick: this.tick, now: Date.now() }
      let r = rail(this.s, p, lw, { ...opts, sel: this.sel })
      if (this.sel === null || !r.order.includes(this.sel)) {
        this.select(r.order[0] ?? null)
        r = rail(this.s, p, lw, { ...opts, sel: this.sel })
      }
      this.order = r.order
      this.span = r.span
      const [from, to] = r.span.get(this.sel ?? -1) ?? [0, 0]
      if (from < this.top) this.top = from
      if (to > this.top + room) this.top = to - room
      this.top = Math.max(0, Math.min(this.top, r.lines.length - 1))
      const idle = !r.order.length && !this.s.goals.some(g => g.project_id === p.id && g.status === 'planning')
      body = idle ? this.welcome(p) : r.lines.slice(this.top, this.top + room)
      const t = this.ticket
      if (this.split && t && !idle) {
        const rw = w - lw - 1
        const detail = sheet(t, this.events.get(t.id) ?? [], goalOf(t), rw)
        this.side = Math.max(0, Math.min(this.side, detail.length - room))
        body = Array.from({ length: room }, (_, i) => `${pad(body[i] ?? '', lw)}${dim('│')}${detail[this.side + i] ?? ''}`)
      }
    } else {
      const t = this.ticket
      const all = this.view === 'diff' ? this.diff : t ? sheet(t, this.events.get(t.id) ?? [], goalOf(t), Math.min(w, 110)) : []
      this.top = Math.max(0, Math.min(this.top, all.length - room))
      body = all.slice(this.top, this.top + room)
    }

    if (this.box) {
      const b = this.boxLines(w)
      body = [...Array.from({ length: Math.max(0, room - b.length) }, (_, i) => body[i] ?? ''), ...b]
    }
    const lines = [this.header(w), dim('─'.repeat(w)), ...body.slice(0, room)]
    while (lines.length < h - 1) lines.push('')
    lines.push(this.footer(w))
    this.term.write('\x1b[H' + lines.map(l => clip(l, w) + '\x1b[K').join('\n') + '\x1b[J')
  }

  private welcome(p: Project) {
    const out = ['', ` ${bold(p.name)} is ready. Nothing has been asked of it yet.`, '']
    out.push(`   ${bold('n')}   say what you want done. A planner reads the repo and drafts tickets with`, '       acceptance criteria. Nothing runs until you start them.')
    if (p.tracker) out.push(`   ${bold('i')}   take issues from the Rinai board ${dim(`(${p.tracker})`)}`)
    if (!p.gate) {
      out.push(`   ${bold('c')}   set the gate: a command that must pass on the merged result before ${p.base} moves`)
      if (p.hint) out.push(dim(`       suggested: ${p.hint}`))
    }
    out.push('', dim(` The crew works in worktrees outside the repo and only ever fast-forwards ${p.base}.`))
    return out
  }

  private header(w: number) {
    const p = this.project
    const tabs = this.s.projects.map(q => {
      const needs = this.s.tickets.filter(t => t.project_id === q.id && t.status === 'escalated').length
      return (q.id === p?.id ? current(q.name) : dim(q.name)) + (needs ? red(` ${needs}!`) : '')
    })
    const right = this.down
      ? red('daemon unreachable')
      : p
        ? `${p.running ? dim('running') : yellow('paused')}${dim(` · ${plural(p.workers, 'agent')} · `)}${p.gate ? dim(`gate: ${p.gate}`) : yellow('no gate')}${p.tracker ? dim(' · rinai') : ''}`
        : ''
    return row(` ${bold('kumi')}  ${tabs.join('  ')}`, `${right} `, w)
  }

  private footer(w: number) {
    if (this.confirm) return ` ${bold(this.confirm.text)}  ${bold('y')} yes  ${bold('n')} no`
    if (this.toast && Date.now() < this.toast.until) return ` ${this.toast.text}`
    if (this.box || this.picker || this.help) return ''
    if (this.view === 'diff') return row(dim(' ↑↓ scroll  space page'), dim('esc back '), w)
    const t = this.ticket
    const p = this.project
    const left = t ? `${this.view === 'rail' ? '↵ open  ' : ''}d diff  ${HINTS[t.status]}` : ''
    const right = this.view === 'rail' ? `n new${p?.tracker ? '  i rinai' : ''}  ? help ` : 'esc back '
    return row(` ${left}`, dim(right), w)
  }

  private boxLines(w: number) {
    const b = this.box!
    const inner = w - 4
    const many = b.fields.length > 1
    const line = (s: string) => `${dim('│')} ${pad(s, inner)} ${dim('│')}`
    const edge = (l: string, text: string, r: string) => dim(l + '─ ') + text + dim(` ${'─'.repeat(Math.max(0, w - width(text) - 5))}${r}`)
    const out = [edge('╭', bold(b.title), '╮')]
    b.fields.forEach((f, i) => {
      if (many) out.push(line(i === b.at ? bold(f.label) : dim(f.label)))
      const rows = f.ed.render(inner, f.rows, i === b.at)
      for (let r = 0; r < f.rows; r++) out.push(line(rows[r] ?? ''))
      if (many && i < b.fields.length - 1) out.push(line(''))
    })
    const multi = b.fields[b.at].ed.multi
    const hint = many
      ? `tab next field · ctrl+s save · esc cancel`
      : `enter ${b.toggle ? 'plan it' : 'send'}${multi ? ' · ctrl+j new line' : ''}${b.toggle ? ` · tab ${b.toggle.label}: ${b.toggle.on ? 'yes' : 'no'}` : ''} · esc cancel`
    out.push(edge('╰', dim(hint), '╯'))
    return out
  }

  private shown() {
    const k = this.picker!
    const f = k.filter.toLowerCase()
    return (k.cards ?? []).filter(c => !f || c.title.toLowerCase().includes(f) || String(c.number).includes(f))
  }

  private pickerLines(w: number, room: number) {
    const k = this.picker!
    const out = [row(` ${bold('rinai')} ${dim(this.project?.tracker ?? '')}`, dim('type to filter · tab mark · enter take · esc close '), w), ` ${dim('filter')} ${k.filter}${inverse(' ')}`, '']
    if (!k.cards) return [...out, ` ${yellow(SPIN[this.tick % SPIN.length])} reading the board`]
    const cards = this.shown()
    if (!cards.length) return [...out, dim(k.cards.length ? ' nothing matches' : ' no open issues on this board')]
    k.at = Math.max(0, Math.min(k.at, cards.length - 1))
    const from = Math.max(0, Math.min(k.at - room + 5, cards.length - (room - 4)))
    cards.slice(Math.max(0, from), Math.max(0, from) + room - 4).forEach(c => {
      const on = cards[k.at] === c
      const mark = k.marked.has(c.number) ? green('●') : ' '
      const where = c.onRail ? dim('on the rail') : `${c.cycle ? 'cycle · ' : ''}${c.column}${c.priority !== 'normal' ? ` · ${c.priority}` : ''}`
      const title = c.onRail ? dim(c.title) : on ? bold(c.title) : c.title
      out.push(row(`${on ? red('▌') : ' '}${mark} ${dim(`#${c.number}`.padEnd(5))} ${title}`, `${dim(where)} `, w))
    })
    return out
  }

  // ── keys ──

  async key(k: string) {
    try {
      if (this.confirm) {
        const c = this.confirm
        this.confirm = null
        if (k === 'y') await c.done()
      } else if (this.box) await this.boxKey(k)
      else if (this.picker) await this.pickerKey(k)
      else if (this.help) this.help = false
      else {
        this.toast = null
        await this.press(k)
      }
    } catch (e: any) {
      this.say(String(e?.message ?? e), true)
    }
    this.render()
  }

  private async boxKey(k: string) {
    const b = this.box!
    const f = b.fields[b.at]
    const n = b.fields.length
    if (k === 'esc' || k === 'ctrl-c') return void (this.box = null)
    if (k === 'tab' || k === 'shift-tab') {
      if (n === 1) b.toggle && (b.toggle.on = !b.toggle.on)
      else b.at = (b.at + (k === 'tab' ? 1 : n - 1)) % n
      return
    }
    if (k === 'ctrl-s' || (k === 'enter' && (n === 1 || (!f.ed.multi && b.at === n - 1)))) {
      // The box stays open if this throws, so nothing typed is lost to a failed request.
      await b.done(b.fields.map(f => f.ed.value.trim()), b.toggle?.on ?? false)
      this.box = null
      return this.refresh()
    }
    if (k === 'enter' && !f.ed.multi) return void b.at++
    f.ed.key(k === 'enter' || k === 'alt-enter' || k === 'ctrl-j' ? 'newline' : k)
  }

  private async pickerKey(k: string) {
    const p = this.project!
    const pk = this.picker!
    const cards = this.shown()
    const here = cards[pk.at]
    if (k === 'esc' || k === 'ctrl-c') return void (this.picker = null)
    if (k === 'up' || k.startsWith('wheel-up')) return void pk.at--
    if (k === 'down' || k.startsWith('wheel-down')) return void pk.at++
    if (k === 'backspace') return void (pk.filter = pk.filter.slice(0, -1))
    if (k === 'tab' && here && !here.onRail) return void (pk.marked.has(here.number) ? pk.marked.delete(here.number) : pk.marked.add(here.number))
    if (k === 'enter') {
      const take = (pk.cards ?? []).filter(c => (pk.marked.size ? pk.marked.has(c.number) : c === here) && !c.onRail)
      if (!take.length) return
      this.picker = null
      for (const c of take) await this.api.send('POST', '/api/goals', { project_id: p.id, issue: c.number, title: c.title })
      this.say(`took ${take.map(c => `#${c.number}`).join(', ')}. A planner is drafting tickets from ${take.length === 1 ? 'it' : 'them'}.`)
      return this.refresh()
    }
    if ([...k].length === 1 && k >= ' ') {
      pk.filter += k
      pk.at = 0
    }
  }

  private form(title: string, fields: [label: string, value: string, rows?: number, placeholder?: string][], done: Box['done'], toggle?: Box['toggle']) {
    this.box = { title, at: 0, toggle, done, fields: fields.map(([label, value, rows = 1, placeholder = '']) => ({ label, rows, ed: new Editor(value, rows > 1, placeholder) })) }
  }

  private async press(k: string) {
    const down = k === 'j' || k === 'down'
    const up = k === 'k' || k === 'up'
    const page = this.term.rows - 6
    if (k === 'ctrl-c' || (k === 'q' && this.view === 'rail')) return this.host.quit()
    if (k === '?') return void (this.help = true)

    if (this.view !== 'rail') {
      if (k === 'esc' || k === 'q' || k === 'backspace') {
        this.view = this.view === 'diff' && !this.split ? 'ticket' : 'rail'
        this.top = 0
        return
      }
      if (down || up || k.startsWith('wheel')) return void (this.top += down || k.startsWith('wheel-down') ? (down ? 1 : 3) : up ? -1 : -3)
      if (k === ' ' || k === 'pgdn') return void (this.top += page)
      if (k === 'b' || k === 'pgup') return void (this.top -= page)
      if (this.view === 'diff') return
    } else {
      const lw = this.railWidth
      const overSide = this.split && Number(k.split(':')[1]) > lw
      if (k.startsWith('wheel') && overSide) return void (this.side += k.startsWith('wheel-down') ? 3 : -3)
      if (k === 'pgdn' || k === 'pgup') return void (this.side += k === 'pgdn' ? page : -page)
      if (down || up || k.startsWith('wheel')) {
        const i = this.order.indexOf(this.sel ?? -1) + (down || k.startsWith('wheel-down') ? 1 : -1)
        return this.select(this.order[Math.max(0, Math.min(i, this.order.length - 1))] ?? null)
      }
      if (k.startsWith('click:')) {
        const [, x, y] = k.split(':').map(Number)
        const line = this.top + y - 3
        if (x <= lw) for (const [id, [a, b]] of this.span) if (line >= a && line < b) this.select(id)
        return
      }
      if (k === 'tab' || k === 'shift-tab') {
        const ps = this.s.projects
        const i = ps.findIndex(p => p.id === this.project?.id) + (k === 'tab' ? 1 : -1)
        this.pid = ps[(i + ps.length) % ps.length]?.id ?? null
        this.sel = null
        this.top = 0
        return
      }
      if (k === 'A')
        return this.form('add a repo', [['path', this.host.cwd]], async ([path]) => {
          try {
            this.pid = (await this.api.send('POST', '/api/projects', { path })).id
            this.sel = null
          } catch (e: any) {
            if (!String(e?.message).includes('not inside a git repo')) throw e
            this.offerInit(path)
          }
        })
      const p = this.project
      if (!p) return
      if (k === 'n' || k === 'g')
        return this.form(
          `new work for ${p.name}`,
          [['', '', 4, 'What should the crew get done? A sentence or a paragraph.']],
          async ([text], file) => {
            await this.api.send('POST', '/api/goals', { project_id: p.id, text, file })
            this.say(file ? 'filed on rinai. A planner is drafting tickets.' : 'a planner is drafting tickets. They wait for you to start them.')
          },
          p.tracker ? { label: 'file it on rinai too', on: false } : undefined,
        )
      if (k === 'i') {
        if (!p.tracker) return this.say('this repo has no GitHub remote, so there is no Rinai board to read', true)
        this.picker = { cards: null, at: 0, filter: '', marked: new Set() }
        this.render()
        try {
          this.picker.cards = await this.api.get(`/api/projects/${p.id}/cards`)
        } catch (e) {
          this.picker = null
          throw e
        }
        return
      }
      if (k === 'p') {
        await this.api.send('PATCH', `/api/projects/${p.id}`, { running: !p.running })
        return this.refresh()
      }
      if (k === 'c')
        return this.form(
          `${p.name} settings`,
          [
            ['gate: a command that must pass on the merged result (empty for none)', p.gate || p.hint],
            ['agents working at once', String(p.workers)],
          ],
          ([gate, workers]) => this.api.send('PATCH', `/api/projects/${p.id}`, { gate, workers: Number(workers) || p.workers }),
        )
    }

    const t = this.ticket
    if (!t) return
    const on = (...st: Ticket['status'][]) => st.includes(t.status)
    const post = async (path: string, body?: object) => {
      await this.api.send('POST', path, body)
      await this.refresh()
    }
    if (k === 'enter' && this.view === 'rail') {
      this.view = 'ticket'
      this.top = 0
    } else if (k === 'd') {
      const { diff } = await this.api.get<{ diff: string }>(`/api/tickets/${t.id}/diff`)
      this.diff = diff ? diff.split('\n').map(l => (l.startsWith('+') ? green(l) : l.startsWith('-') ? red(l) : l.startsWith('@@') ? dim(l) : l)) : [dim(' no changes on this ticket yet')]
      this.view = 'diff'
      this.top = 0
    } else if (k === 's') {
      // The selected goal's drafts, or every draft in the project when something else is selected.
      const drafts = this.s.tickets.filter(o => o.project_id === t.project_id && o.status === 'draft' && (!on('draft') || o.goal_id === t.goal_id))
      if (!drafts.length) return this.say('nothing to start: no drafts on the rail')
      for (const g of new Set(drafts.map(o => o.goal_id))) await this.api.send('POST', g ? `/api/goals/${g}/start` : `/api/tickets/${drafts[0].id}/start`)
      await this.refresh()
      this.say(`started ${plural(drafts.length, 'ticket')}. You can close kumi; the crew keeps going.`)
    } else if (k === 'R' && on('working', 'review')) {
      this.confirm = { text: `kill t${t.id}'s agent and run this round again?`, done: () => post(`/api/tickets/${t.id}/restart`) }
    } else if (k === 'r' && on('escalated')) {
      this.form(`retry t${t.id}`, [['', '', 3, 'Anything the author should know? Optional.']], ([note]) => post(`/api/tickets/${t.id}/retry`, { note }))
    } else if (k === 'a' && on('escalated')) {
      this.confirm = { text: `send t${t.id} to the gate without the reviewer's approval?`, done: () => post(`/api/tickets/${t.id}/approve`) }
    } else if (k === 'x' && !on('merged', 'dropped', 'gate')) {
      this.confirm = {
        text: `drop t${t.id} and delete its branch?`,
        done: async () => {
          await post(`/api/tickets/${t.id}/drop`)
          this.view = 'rail'
        },
      }
    } else if (k === 'e' && on('draft', 'todo', 'escalated')) {
      this.form(
        `edit t${t.id}`,
        [
          ['title', t.title],
          ['what to do', t.body, 6],
          ['criteria, one per line: the reviewer checks the diff against each', t.criteria.join('\n'), 5],
        ],
        ([title, body, criteria]) => this.api.send('PATCH', `/api/tickets/${t.id}`, { title, body, criteria: criteria.split('\n') }),
      )
    }
  }
}
