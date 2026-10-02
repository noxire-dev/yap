import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { AgentRunner, Project, Store, Ticket, Workspace } from './ports'

/** Review rounds a ticket gets before it lands in front of a human. */
export const ROUNDS = 4
const DIFF_CAP = 150_000

interface Check {
  criterion: string
  pass: boolean
  reason: string
}

const VERDICT = {
  type: 'object',
  properties: {
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        properties: { criterion: { type: 'string' }, pass: { type: 'boolean' }, reason: { type: 'string' } },
        required: ['criterion', 'pass', 'reason'],
      },
    },
  },
  required: ['criteria'],
}

const PLAN = {
  type: 'object',
  properties: {
    tickets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          body: { type: 'string' },
          criteria: { type: 'array', items: { type: 'string' } },
          deps: { type: 'array', items: { type: 'integer' } },
        },
        required: ['title', 'body', 'criteria', 'deps'],
      },
    },
  },
  required: ['tickets'],
}

const tail = (s: string, n = 2000) => (s.length > n ? '…' + s.slice(-n) : s)
const list = (items: string[]) => items.map((c, i) => `${i + 1}. ${c}`).join('\n')

function workPrompt(t: Ticket, round: number, conflicts: boolean) {
  return `You are an engineer on an autonomous crew, working alone in a git worktree on your own branch.
Nobody is watching this session and nobody can answer questions. Make reasonable calls and finish the ticket.

# Ticket t${t.id}: ${t.title}
${t.body}

# Acceptance criteria
A reviewer who has not seen your reasoning will check the diff against each of these:
${list(t.criteria)}

# Rules
- Work only in this directory. Do not switch branches, push, or touch other worktrees.
- Whatever you leave in the tree is committed for you when you stop.
- Run the project's own tests or checks for what you touched before you finish.
- Stay inside the ticket. No drive-by refactors.
- Finish with a short summary of what you changed.
${
  round > 1
    ? `
# Round ${round}: your previous attempt was sent back
${t.findings.map(f => `- ${f}`).join('\n')}

The earlier work is already on this branch. Fix the findings; do not start over.
`
    : ''
}${
    conflicts
      ? `
The base branch was merged into this branch and left conflicts. Resolve every conflict marker first.
`
      : ''
  }`
}

function reviewPrompt(t: Ticket, diff: string) {
  return `You are reviewing a change you did not write. You have no context beyond this message.
Judge what the code does, not what the author meant.

# Ticket t${t.id}: ${t.title}
${t.body}

# Acceptance criteria
${list(t.criteria)}

# Diff against the base branch
\`\`\`diff
${diff.length > DIFF_CAP ? diff.slice(0, DIFF_CAP) + '\n[diff truncated: read the files for the rest]' : diff}
\`\`\`

The working directory is the author's branch. Read files where the diff is not enough.

Answer every criterion, in the order given, with pass or fail and a one or two sentence reason that cites file:line.
Fail a criterion you cannot verify from the code. If the change breaks existing behaviour or goes beyond the ticket,
fail the criterion it touches most closely and say why.`
}

function planPrompt(goal: string) {
  return `Break this goal into tickets for an autonomous engineering crew working in this repository. Read the code first.

# Goal
${goal}

# Rules
- A ticket is one reviewable change that leaves the repo working once it and its deps are merged.
- 1 to 8 tickets. Fewer is better: a small goal is one ticket.
- title: imperative, under 70 characters.
- body: what to change and where, with file paths. The engineer has no other context.
- criteria: 2 to 5 statements a reviewer can verify by reading the diff. Concrete and checkable, never "works well".
- deps: zero-based indexes of earlier tickets that must merge first. Only when the ticket truly builds on the other;
  independent tickets run in parallel.`
}

function receipt(t: Ticket, checks: Check[] | null) {
  return [
    `t${t.id}: ${t.title}`,
    '',
    `Ticket: ${t.id}`,
    `Rounds: ${t.round}`,
    `Reviewed-by: ${checks ? 'kumi reviewer (fresh context, not the author)' : 'human override'}`,
    ...(checks ?? []).map(c => `Criterion: [pass] ${c.criterion}`),
  ].join('\n')
}

export class Crew {
  private live = new Map<number, { abort: AbortController; activity: string; done: Promise<void> }>()
  private gates = new Map<number, Promise<unknown>>()

  constructor(
    private store: Store,
    private ws: Workspace,
    private agent: AgentRunner,
    private home: string,
    private changed: () => void = () => {},
  ) {}

  /** What each running ticket's agent is doing right now. */
  activity() {
    return Object.fromEntries([...this.live].map(([id, l]) => [id, l.activity]))
  }

  /** Whatever a dead process left mid-flight goes back on the board. Branches survive. */
  recover() {
    for (const t of this.store.tickets())
      if (['working', 'review', 'gate'].includes(t.status))
        this.store.patchTicket(t.id, { status: 'todo', round: Math.max(0, t.round - 1), tries: t.tries + 1 })
    for (const g of this.store.goals())
      if (g.status === 'planning') this.store.patchGoal(g.id, { status: 'failed', note: 'interrupted' })
    this.kick()
  }

  async addProject(input: string, gate = '', workers = 2) {
    const path = resolve(input.trim().replace(/^["']|["']$/g, '').replace(/^~(?=[\\/]|$)/, homedir()))
    if (this.store.projects().some(p => p.path === path)) throw new Error('that repo is already a project')
    const base = await this.ws.branch(path)
    if (!base) throw new Error(`${path} is not a git repo on a branch`)
    return this.store.addProject({ name: basename(path), path, base, gate, workers, running: true })
  }

  addTicket(project_id: number, d: { title: string; body?: string; criteria?: string[]; deps?: number[] }, goal_id: number | null = null) {
    const criteria = (d.criteria ?? []).map(c => c.trim()).filter(Boolean)
    if (!d.title?.trim()) throw new Error('a ticket needs a title')
    const t = this.store.addTicket({
      project_id: this.project(project_id).id,
      goal_id,
      title: d.title.trim(),
      body: d.body ?? '',
      criteria: criteria.length ? criteria : ['The change does what the ticket describes and nothing else.'],
      deps: d.deps ?? [],
      status: goal_id ? 'draft' : 'todo',
      round: 0,
      tries: ROUNDS,
      findings: [],
      note: '',
      override: false,
      sha: null,
    })
    this.kick()
    return t
  }

  /** Turn a goal into draft tickets. Returns at once; the planner runs behind it. */
  plan(project_id: number, text: string) {
    const p = this.project(project_id)
    const goal = this.store.addGoal({ project_id, text: text.trim(), status: 'planning', note: '' })
    this.changed()
    void this.agent
      .run({ cwd: p.path, prompt: planPrompt(goal.text), readOnly: true, schema: PLAN })
      .then(r => {
        const drafts: any[] = r.data?.tickets ?? []
        if (!r.ok || !drafts.length) throw new Error(tail(r.text, 500) || 'planner returned no tickets')
        const ids: number[] = []
        for (const d of drafts) {
          const deps = (d.deps ?? []).filter((i: number) => i >= 0 && i < ids.length).map((i: number) => ids[i])
          ids.push(this.addTicket(project_id, { ...d, deps }, goal.id).id)
        }
        this.store.patchGoal(goal.id, { status: 'ready' })
        this.store.log(project_id, null, 'plan', { goal: goal.text, tickets: ids })
      })
      .catch(e => this.store.patchGoal(goal.id, { status: 'failed', note: String(e?.message ?? e) }))
      .finally(this.changed)
    return goal
  }

  startGoal(goal_id: number) {
    for (const t of this.store.tickets())
      if (t.goal_id === goal_id && t.status === 'draft') this.store.patchTicket(t.id, { status: 'todo' })
    this.kick()
  }

  async act(id: number, action: 'start' | 'retry' | 'approve' | 'drop', note = '') {
    const t = this.ticket(id)
    const p = this.project(t.project_id)
    const from = (...ok: Ticket['status'][]) => {
      if (!ok.includes(t.status)) throw new Error(`can't ${action} a ticket that is ${t.status}`)
    }
    if (action === 'start') {
      from('draft')
      this.store.patchTicket(id, { status: 'todo' })
    } else if (action === 'retry') {
      from('escalated')
      const findings = note ? [...t.findings, `From the human: ${note}`] : t.findings
      this.store.patchTicket(id, { status: 'todo', tries: ROUNDS, findings })
    } else if (action === 'approve') {
      from('escalated')
      this.store.patchTicket(id, { status: 'todo', tries: ROUNDS, override: true })
    } else {
      if (t.status === 'merged') throw new Error('already merged')
      const run = this.live.get(id)
      run?.abort.abort()
      this.store.patchTicket(id, { status: 'dropped' })
      await run?.done
      await this.ws.cleanup(p.path, this.dir(p, id), this.branchOf(id))
    }
    this.store.log(p.id, id, 'human', { action, note })
    this.kick()
  }

  /** Hand every free worker slot a ticket whose deps are done. */
  kick() {
    const tickets = this.store.tickets()
    const done = new Set(tickets.filter(t => t.status === 'merged' || t.status === 'dropped').map(t => t.id))
    for (const p of this.store.projects()) {
      if (!p.running) continue
      const mine = tickets.filter(t => t.project_id === p.id)
      let free = p.workers - mine.filter(t => this.live.has(t.id)).length
      for (const t of mine) {
        if (free <= 0) break
        if (t.status !== 'todo' || this.live.has(t.id) || !t.deps.every(d => done.has(d))) continue
        free--
        this.start(p, t.id)
      }
    }
    this.changed()
  }

  private start(p: Project, id: number) {
    const abort = new AbortController()
    const done = this.run(p, id, abort.signal)
      .catch(e => {
        if (abort.signal.aborted) return
        const why = String(e?.message ?? e)
        this.store.patchTicket(id, { status: 'escalated', override: false, note: why })
        this.store.log(p.id, id, 'escalate', { why })
      })
      .finally(() => {
        this.live.delete(id)
        this.kick()
      })
    this.live.set(id, { abort, activity: '', done })
  }

  private async run(p: Project, id: number, signal: AbortSignal) {
    const dir = this.dir(p, id)
    const branch = this.branchOf(id)
    const set = (patch: Partial<Ticket>) => {
      this.store.patchTicket(id, patch)
      this.changed()
    }
    const log = (kind: Parameters<Store['log']>[2], data: Record<string, unknown>) => this.store.log(p.id, id, kind, data)
    const onActivity = (line: string) => {
      const l = this.live.get(id)
      if (l) l.activity = line
      this.changed()
    }
    const send = (round: number, note: string) => {
      log('verdict', { round, approved: false, criteria: [], note })
      set({ findings: [note] })
    }

    await this.ws.worktree(p.path, dir, branch, p.base)

    for (;;) {
      let t = this.ticket(id)
      let checks: Check[] | null = null

      if (!t.override) {
        if (t.tries <= 0) {
          const why = `still failing after ${t.round} rounds`
          log('escalate', { why, findings: t.findings })
          return set({ status: 'escalated', note: why })
        }
        const round = t.round + 1
        log('claim', { round })
        set({ status: 'working', round, tries: t.tries - 1 })
        t = this.ticket(id)

        const clean = await this.ws.mergeBase(dir, p.base)
        const work = await this.agent.run({ cwd: dir, prompt: workPrompt(t, round, !clean), signal, onActivity })
        if (signal.aborted) return
        if (!work.ok) throw new Error(`author run failed: ${tail(work.text, 500)}`)

        const commit = await this.ws.commitAll(dir, `t${id}: ${t.title} (round ${round})`)
        if (!commit.ok) {
          send(round, `the commit was rejected:\n${tail(commit.log)}`)
          continue
        }
        const diff = await this.ws.diff(p.path, p.base, branch)
        if (!diff) {
          send(round, 'no changes were produced on the branch')
          continue
        }
        log('submit', { round, summary: tail(work.text, 800) })
        set({ status: 'review' })
        onActivity('')

        const review = await this.agent.run({
          cwd: dir,
          prompt: reviewPrompt(t, diff),
          readOnly: true,
          schema: VERDICT,
          signal,
          onActivity,
        })
        if (signal.aborted) return
        await this.ws.discard(dir)
        const got: any[] = Array.isArray(review.data?.criteria) ? review.data.criteria : []
        if (got.length < t.criteria.length) throw new Error(`reviewer returned no verdict: ${tail(review.text, 500)}`)
        // Pair by position and take approval from the rows, never from the reviewer's say-so.
        checks = t.criteria.map((criterion, i) => ({ criterion, pass: got[i].pass === true, reason: String(got[i].reason ?? '') }))
        const approved = checks.every(c => c.pass)
        log('verdict', { round, approved, criteria: checks })
        if (!approved) {
          set({ findings: checks.filter(c => !c.pass).map(c => `${c.criterion}: ${c.reason}`) })
          continue
        }
      }

      set({ status: 'gate' })
      onActivity(p.gate)
      const gate = await this.locked(p.id, async (): Promise<{ log: string; sha?: string; human?: boolean }> => {
        const merged = await this.ws.squash(p.path, this.dir(p, 'gate'), p.base, branch, receipt(t, checks))
        if (!merged.sha) return { log: merged.log }
        if (p.gate) {
          const ran = await this.ws.exec(this.dir(p, 'gate'), p.gate)
          if (!ran.ok) return { log: `\`${p.gate}\` failed on the merged result:\n${tail(ran.log, 3000)}` }
        }
        const moved = await this.ws.advance(p.path, p.base, merged.sha)
        return moved.ok ? { sha: merged.sha, log: '' } : { log: `could not fast-forward ${p.base}:\n${moved.log}`, human: true }
      })

      if (gate.sha) {
        log('merge', { sha: gate.sha, rounds: t.round })
        set({ status: 'merged', sha: gate.sha, findings: [] })
        return this.ws.cleanup(p.path, dir, branch)
      }
      log('gate', { ok: false, log: gate.log })
      if (gate.human) {
        log('escalate', { why: gate.log })
        return set({ status: 'escalated', override: false, note: gate.log })
      }
      set({ findings: [gate.log], override: false })
    }
  }

  /** One gate at a time per project: the base branch only moves in a straight line. */
  private locked<T>(project_id: number, fn: () => Promise<T>): Promise<T> {
    const next = (this.gates.get(project_id) ?? Promise.resolve()).then(fn, fn)
    this.gates.set(project_id, next.catch(() => {}))
    return next
  }

  private dir = (p: Project, leaf: number | 'gate') => join(this.home, 'wt', `p${p.id}`, leaf === 'gate' ? 'gate' : `t${leaf}`)
  private branchOf = (id: number) => `kumi/t${id}`

  private project(id: number) {
    const p = this.store.projects().find(p => p.id === id)
    if (!p) throw new Error(`no project ${id}`)
    return p
  }

  private ticket(id: number) {
    const t = this.store.tickets().find(t => t.id === id)
    if (!t) throw new Error(`no ticket ${id}`)
    return t
  }
}
