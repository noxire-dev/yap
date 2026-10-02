import type { Event, Goal, Project, Ticket } from './ports'

export interface State {
  projects: Project[]
  goals: Goal[]
  tickets: Ticket[]
  /** Ticket id to the one line its agent is on right now. */
  activity: Record<string, string>
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
  /** Open text in the user's editor. Null if they left it unchanged. */
  edit(text: string): string | null
  quit(): void
}

let color = true
export const useColor = (on: boolean) => void (color = on)
const sgr = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s)
const dim = sgr('2')
const bold = sgr('1')
const red = sgr('31')
const green = sgr('32')
const yellow = sgr('33')
const current = sgr('1;4')

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

const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const PHASE: Record<string, string> = { working: 'working', review: 'in review', gate: 'at the gate' }

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
    const doing = s.activity[t.id] ? dim(` · ${s.activity[t.id]}`) : ''
    put(t, [
      head(t, dim('├─╮'), dim(`round ${t.round || 1}`)),
      clip(`${pipe} ${yellow(SPIN[o.tick % SPIN.length])} ${PHASE[t.status]} ${dim(ago(t.updated, o.now))}${doing}`, w),
      pipe,
    ])
  }

  const goal = s.goals.filter(g => g.project_id === p.id).at(-1)
  if (goal?.status === 'planning') lines.push(clip(` ${dim('┆')} ${yellow(SPIN[o.tick % SPIN.length])} planning ${dim(`· ${goal.text}`)}`, w), pipe)
  if (goal?.status === 'failed') lines.push(clip(` ${dim('┆')} ${red('✗')} planning failed ${dim(`· ${first(goal.note)}`)}`, w), pipe)

  for (const t of by('todo')) {
    const waits = t.deps.filter(d => !done.has(d))
    put(t, [head(t, dim('┆  '), dim(waits.length ? `waits for ${waits.map(d => `t${d}`).join(', ')}` : p.running ? 'queued' : 'paused'))])
  }
  if (by('todo').length) lines.push(pipe)

  for (const g of s.goals.filter(g => g.project_id === p.id)) {
    const drafts = by('draft').filter(t => t.goal_id === g.id)
    if (!drafts.length) continue
    lines.push(row(` ${dim('┆')} ${bold('goal')} ${g.text}`, `${plural(drafts.length, 'draft')} · ${bold('s')} starts them `, w))
    for (const t of drafts) {
      const after = t.deps.length ? dim(`after ${t.deps.map(d => `t${d}`).join(', ')}`) : dim('draft')
      put(t, [head(t, dim('┆  '), after)])
    }
    lines.push(pipe)
  }

  const merged = by('merged').sort((a, b) => b.updated - a.updated)
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
    default:
      return ''
  }
}

/** One ticket in full: the latest verdict per criterion, its journal, then what it asked for. */
function sheet(t: Ticket, events: Event[], w: number) {
  const out: string[] = []
  const say = (text: string, indent: number, style = (s: string) => s) => wrap(text, w - indent - 1).forEach(l => out.push(' '.repeat(indent) + style(l)))
  const verdict = events.find(e => e.kind === 'verdict' && (e.data.criteria as any[])?.length)?.data as any

  if (t.status === 'escalated') {
    out.push(` ${red('Needs you')}`)
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
  out.push('', ` ${bold('Journal')}`)
  for (const e of [...events].reverse()) out.push(clip(` ${dim(clock(e.ts))}  ${e.kind.padEnd(8)} ${told(e)}`, w))
  out.push('', ` ${bold('Ticket')}`)
  say(t.body || '(no description)', 1, t.body ? undefined : dim)
  return out
}

const TEMPLATE = `# title


# body


# criteria (one per line; a reviewer checks the diff against each)

`

const toFile = (t: Ticket) => `# title\n${t.title}\n\n# body\n${t.body}\n\n# criteria (one per line; a reviewer checks the diff against each)\n${t.criteria.join('\n')}\n`

function fromFile(text: string) {
  const parts: Record<string, string[]> = { title: [], body: [], criteria: [] }
  let cur = ''
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^# (title|body|criteria)\b/)
    if (m) cur = m[1]
    else if (cur) parts[cur].push(line)
  }
  return {
    title: parts.title.join(' ').trim(),
    body: parts.body.join('\n').trim(),
    criteria: parts.criteria.map(c => c.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').trim()).filter(Boolean),
  }
}

/** Plain printout of every project's rail, for `kumi status`. */
export function status(s: State, w: number, seen: number) {
  if (!s.projects.length) return 'no projects yet. run `kumi` in a repo to add one.'
  const now = Date.now()
  return s.projects
    .map(p => [`${bold(p.name)} ${dim(p.running ? '' : '(paused)')}`, ...rail(s, p, w, { sel: null, seen, tick: 0, now }).lines].join('\n'))
    .join('\n\n')
}

const HINTS: Record<Ticket['status'], string> = {
  draft: 's start goal  e edit  x drop',
  todo: 'e edit  x drop',
  working: 'x drop',
  review: 'x drop',
  gate: '',
  merged: '',
  escalated: 'r retry  a approve anyway  e edit  x drop',
  dropped: '',
}

export class Tui {
  private s: State = { projects: [], goals: [], tickets: [], activity: {} }
  private pid: number | null = null
  private sel: number | null = null
  private order: number[] = []
  private view: 'rail' | 'ticket' | 'diff' = 'rail'
  private events: Event[] = []
  private diff: string[] = []
  private top = 0
  private prompt: { label: string; value: string; yn: boolean; done: (v: string | null) => void } | null = null
  private toast = ''
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
    this.api.watch(
      () => void this.refresh(),
      down => {
        this.down = down
        this.render()
      },
    )
    setInterval(() => {
      this.tick++
      this.render()
    }, 1000)
    await this.refresh()
  }

  private get project() {
    return this.s.projects.find(p => p.id === this.pid) ?? this.s.projects[0]
  }

  private get ticket() {
    return this.s.tickets.find(t => t.id === this.sel)
  }

  private async refresh() {
    if (this.loading) return void (this.stale = true)
    this.loading = true
    try {
      this.s = await this.api.get<State>('/api/state')
      if (this.view === 'ticket' && this.sel) this.events = await this.api.get(`/api/events?ticket=${this.sel}`)
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

  render() {
    const w = this.term.columns
    const h = this.term.rows
    const room = h - 3
    const p = this.project
    let body: string[]

    if (!p) {
      body = ['', ' No projects yet.', '', ` Press ${bold('A')} to add a git repo. The crew works in worktrees outside it and only ever`, ' fast-forwards its base branch.']
    } else if (this.view === 'rail') {
      const opts = { seen: this.host.seen, tick: this.tick, now: Date.now() }
      let r = rail(this.s, p, w, { ...opts, sel: this.sel })
      if (this.sel === null || !r.order.includes(this.sel)) {
        this.sel = r.order[0] ?? null
        r = rail(this.s, p, w, { ...opts, sel: this.sel })
      }
      this.order = r.order
      const [from, to] = r.span.get(this.sel ?? -1) ?? [0, 0]
      if (from < this.top) this.top = from
      if (to > this.top + room) this.top = to - room
      this.top = Math.max(0, Math.min(this.top, r.lines.length - 1))
      body = r.order.length || this.s.goals.some(g => g.project_id === p.id)
        ? r.lines.slice(this.top, this.top + room)
        : ['', ` Nothing on the rail. Press ${bold('g')} and describe a goal, or ${bold('n')} to write one ticket.`, '', ...r.lines]
    } else {
      const t = this.ticket
      const all = this.view === 'diff' ? this.diff : t ? sheet(t, this.events, w) : []
      this.top = Math.max(0, Math.min(this.top, all.length - room + 2))
      const title = t ? row(` ${dim(`t${t.id}`)} ${bold(t.title)}`, `${t.status === 'escalated' ? red('needs you') : dim(t.status)}${t.round ? dim(` · round ${t.round}`) : ''} `, w) : ''
      body = [title, '', ...all.slice(this.top, this.top + room - 2)]
    }

    const lines = [this.header(w), dim('─'.repeat(w)), ...body.slice(0, room)]
    while (lines.length < h - 1) lines.push('')
    lines.push(this.footer(w))
    this.term.write('\x1b[H' + lines.map(l => clip(l, w) + '\x1b[K').join('\n') + '\x1b[J')
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
        ? `${p.running ? dim('running') : yellow('paused')}${dim(` · ${plural(p.workers, 'worker')} · gate: ${p.gate || 'none'}`)}`
        : ''
    return row(` ${bold('kumi')}  ${tabs.join('  ')}`, `${right} `, w)
  }

  private footer(w: number) {
    if (this.prompt) return ` ${bold(this.prompt.label)}${this.prompt.yn ? ' (y/n)' : ':'} ${this.prompt.value}█`
    if (this.view === 'diff') return row(dim(' j/k scroll'), dim('esc back '), w)
    const t = this.ticket
    const left = this.toast || (t ? `${this.view === 'rail' ? '↵ open  ' : ''}d diff  ${HINTS[t.status]}` : '')
    const right = this.view === 'rail' ? 'g goal  n ticket  p pause  c config  A add repo  tab project  q quit ' : 'esc back '
    return row(` ${left}`, dim(right), w)
  }

  private ask(label: string, value = '', yn = false) {
    return new Promise<string | null>(done => {
      this.prompt = { label, value, yn, done }
      this.render()
    })
  }

  private confirm = async (label: string) => (await this.ask(label, '', true)) === 'y'

  async key(k: string) {
    const q = this.prompt
    if (q) {
      const close = (v: string | null) => {
        this.prompt = null
        q.done(v)
      }
      if (q.yn) close(k.toLowerCase() === 'y' ? 'y' : null)
      else if (k === '\r' || k === '\n') close(q.value.trim())
      else if (k === '\x1b' || k === '\x03') close(null)
      else if (k === '\x7f' || k === '\b') q.value = [...q.value].slice(0, -1).join('')
      else if (!k.startsWith('\x1b')) q.value += k.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f]/g, '')
      return this.render()
    }
    this.toast = ''
    try {
      await this.press(k)
    } catch (e: any) {
      this.toast = red(String(e?.message ?? e))
    }
    this.render()
  }

  private async press(k: string) {
    const down = k === 'j' || k === '\x1b[B'
    const up = k === 'k' || k === '\x1b[A'
    if (k === '\x03' || (k === 'q' && this.view === 'rail')) return this.host.quit()

    if (this.view !== 'rail') {
      if (k === '\x1b' || k === 'q' || k === '\x7f') {
        this.view = this.view === 'diff' ? 'ticket' : 'rail'
        this.top = 0
        return
      }
      if (down || up) return void (this.top += down ? 1 : -1)
      if (k === ' ' || k === '\x1b[6~') return void (this.top += this.term.rows - 6)
      if (k === 'b' || k === '\x1b[5~') return void (this.top -= this.term.rows - 6)
      if (this.view === 'diff') return
    } else {
      if (down || up) {
        const i = this.order.indexOf(this.sel ?? -1) + (down ? 1 : -1)
        this.sel = this.order[Math.max(0, Math.min(i, this.order.length - 1))] ?? null
        return
      }
      if (k === '\t' || k === '\x1b[Z') {
        const ps = this.s.projects
        const i = ps.findIndex(p => p.id === this.project?.id) + (k === '\t' ? 1 : -1)
        this.pid = ps[(i + ps.length) % ps.length]?.id ?? null
        this.sel = null
        this.top = 0
        return
      }
      if (k === 'A') return this.addProject()
      const p = this.project
      if (!p) return
      if (k === 'g') {
        const text = await this.ask('goal')
        if (!text) return
        await this.api.send('POST', '/api/goals', { project_id: p.id, text })
        return
      }
      if (k === 'n') {
        const text = this.host.edit(TEMPLATE)
        if (text) this.sel = (await this.api.send('POST', '/api/tickets', { project_id: p.id, ...fromFile(text) })).id
        return
      }
      if (k === 'p') return this.api.send('PATCH', `/api/projects/${p.id}`, { running: !p.running })
      if (k === 'c') {
        const gate = await this.ask('gate command run on the merged result', p.gate)
        if (gate === null) return
        const workers = Number(await this.ask('agents working at once', String(p.workers)))
        return this.api.send('PATCH', `/api/projects/${p.id}`, { gate, workers })
      }
    }

    const t = this.ticket
    if (!t) return
    const on = (...st: Ticket['status'][]) => st.includes(t.status)
    if (k === '\r' && this.view === 'rail') {
      this.events = await this.api.get(`/api/events?ticket=${t.id}`)
      this.view = 'ticket'
      this.top = 0
    } else if (k === 'd') {
      const { diff } = await this.api.get<{ diff: string }>(`/api/tickets/${t.id}/diff`)
      this.diff = diff ? diff.split('\n').map(l => (l.startsWith('+') ? green(l) : l.startsWith('-') ? red(l) : l.startsWith('@@') ? dim(l) : l)) : [dim(' no diff yet')]
      this.view = 'diff'
      this.top = 0
    } else if (k === 's' && on('draft')) {
      await this.api.send('POST', t.goal_id ? `/api/goals/${t.goal_id}/start` : `/api/tickets/${t.id}/start`)
    } else if (k === 'r' && on('escalated')) {
      const note = await this.ask(`note for the author of t${t.id}, optional`)
      if (note !== null) await this.api.send('POST', `/api/tickets/${t.id}/retry`, { note })
    } else if (k === 'a' && on('escalated')) {
      if (await this.confirm(`send t${t.id} to the gate without the reviewer's approval?`)) await this.api.send('POST', `/api/tickets/${t.id}/approve`)
    } else if (k === 'x' && !on('merged', 'dropped', 'gate')) {
      if (await this.confirm(`drop t${t.id} and delete its branch?`)) {
        await this.api.send('POST', `/api/tickets/${t.id}/drop`)
        this.view = 'rail'
      }
    } else if (k === 'e' && on('draft', 'todo', 'escalated')) {
      const text = this.host.edit(toFile(t))
      if (text) await this.api.send('PATCH', `/api/tickets/${t.id}`, fromFile(text))
    }
  }

  private async addProject() {
    const path = await this.ask('path to a git repo', this.host.cwd)
    if (!path) return
    const gate = await this.ask('gate command run on the merged result, e.g. bun test (empty for none)')
    if (gate === null) return
    this.pid = (await this.api.send('POST', '/api/projects', { path, gate })).id
    this.sel = null
  }
}
