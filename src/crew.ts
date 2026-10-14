import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { AgentRunner, Goal, Project, Store, Ticket, Tracker, Workspace } from './ports'

/** Review rounds a ticket gets before it lands in front of a human. */
export const ROUNDS = 4
const DIFF_CAP = 150_000
/** Files that configure Claude Code itself, for the reviewer and every later session. */
const AGENT_CONFIG = /^diff --git a\/(\S*?(?:\.claude\/\S+|CLAUDE\.md|AGENTS\.md|\.mcp\.json)) /m

interface Check {
  criterion: string
  pass: boolean
  reason: string
}

// Reason before verdict in every row: the model commits to evidence before it commits to a word.
const VERDICT = {
  type: 'object',
  properties: {
    previous: {
      type: 'array',
      items: {
        type: 'object',
        properties: { finding: { type: 'string' }, evidence: { type: 'string' }, addressed: { type: 'boolean' } },
        required: ['finding', 'evidence', 'addressed'],
      },
    },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        properties: { criterion: { type: 'string' }, reason: { type: 'string' }, pass: { type: 'boolean' } },
        required: ['criterion', 'reason', 'pass'],
      },
    },
    nits: { type: 'array', items: { type: 'string' } },
  },
  required: ['previous', 'criteria', 'nits'],
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
const first = (s: string) => s.trim().split(/\r?\n/)[0].slice(0, 200)
const list = (items: string[]) => items.map((c, i) => `${i + 1}. ${c}`).join('\n')
const fence = (diff: string, cap: number, note: string) =>
  '```diff\n' + (diff.length > cap ? diff.slice(0, cap) + `\n[${note}]` : diff) + '\n```'

/** An author report that opens `Status: BLOCKED`: the author stopped on purpose and a human has to look. */
export const blocked = (report: string) => /^\W*status\W*blocked\b/im.test(report.trim().split(/\r?\n/).slice(0, 3).join('\n'))

function workPrompt(t: Ticket, round: number, conflicts: boolean) {
  return `You are the engineer on ticket t${t.id}, working alone in a git worktree on your own branch. Nobody is
watching and nobody can answer a question, so when the ticket leaves a call open, make it, write it down as a
ruling, and keep going. A reviewer who never sees your reasoning will check the diff against each criterion
below, and anything it cannot verify fails.

# Ticket t${t.id}: ${t.title}
${t.body}

# Acceptance criteria
${list(t.criteria)}
${
  round > 1
    ? `
# Round ${round}: the last attempt was sent back
${t.findings.map(f => `- ${f}`).join('\n')}

That work is already on this branch. Fix these; do not start over. A finding about evidence ("could not
verify") is fixed by producing the evidence: a test that exercises the behaviour, or output the reviewer can
reproduce.
`
    : ''
}${
    conflicts
      ? `
The base branch was merged into this branch and left conflicts. Resolve every conflict marker first.
`
      : ''
  }
# How to work
- Read the code the ticket names before you change it, and follow the conventions already there.
- Leave the tree as the ticket and nothing else: no scratch scripts, no notes or docs about the change, no new
  dependencies, no reformatting of lines you did not need to touch, no edits to existing tests unless the ticket
  asks. A bug you notice outside the ticket goes in your report, not in the diff.
- Verify by running, not by reading: the command the ticket names, or the project's tests for what you touched.
  If you are about to write "should work" or "probably", run the check instead.
- If the same check has failed three times, stop editing. List the possible causes, test the likeliest with a
  focused check, then change code. If that fails too, report BLOCKED with what you tried.
- Stay in this directory. Never switch branches, push, or touch another worktree. Whatever is in the tree when
  you stop is committed for you.

Stop and report BLOCKED only when the next step is outside this worktree (a push, a publish, a credential, a
service you cannot reach), destructive or irreversible, or the ticket is wrong enough that every path is a guess,
such as a criterion that contradicts the code it names. Anything else, decide.

# Your report
End with this report and nothing after it:

Status: DONE | DONE_WITH_CONCERNS | BLOCKED
Verified: each command you ran to check the work, with its result (pass/fail counts or exit code)
Changed: each file, with one line on what changed in it
Rulings: each call the ticket did not make, as "what — why — what it costs if wrong", or "none"
Noticed: anything outside the ticket worth a look, or "nothing"`
}

function reviewPrompt(t: Ticket, diff: string, round: number, report: string) {
  return `You are reviewing a change you did not write, with no context beyond this message. Judge what the code
does, not what anyone says it does. Pass a criterion only on evidence: the diff, files you read, or output you
produced yourself. A commit message, a comment, a function name, or the author's report claiming the behaviour is
not evidence. A test that passes without the change, or asserts nothing, is not evidence either.

# Ticket t${t.id}: ${t.title}
${t.body}

# Acceptance criteria
${list(t.criteria)}
${
  round > 1 && t.findings.length
    ? `
# Round ${round}: the previous round failed on these
${t.findings.map(f => `- ${f}`).join('\n')}

For each, say whether it is addressed, with the file:line or command that shows it. Attempted is not addressed:
the specific gap must be gone.
`
    : ''
}
# Diff against the base branch
${fence(diff, DIFF_CAP, 'diff truncated: read the files for the rest')}

# The author's report (claims to check, not evidence)
${report || '(none)'}

# How to judge
The working directory is the author's branch, checked out. Read files where the diff is not enough. Where a
criterion is about behaviour, run the focused test or command that shows it. Your edits are thrown away.

- A criterion fails when the behaviour it names is missing, wrong, or you could not make it happen. Uncertain is
  a fail: say what you ran or read and what was missing, so the next round can supply it.
- A criterion about a test passes only if that test would fail without the change. Read the assertion; run it
  against the base branch if in doubt.
- Every hunk traces to a criterion. A hunk that does not (an unrelated fix, a rename, a stray file, a new
  dependency, an edit to an existing test the ticket did not ask for) fails the nearest criterion and names it.
- Style, naming, coverage you would like more of, and pre-existing problems the diff did not introduce are not
  fails. Put them in nits; they do not block.
- A fail reason is written for the engineer who fixes it: the file:line or command and its output, the input
  that shows the gap, and what would make it pass.

Answer every criterion in the order given: the reason first, then pass or fail.`
}

function planPrompt(goal: string, brief: string) {
  return `Break this goal into tickets for an autonomous engineering crew working in this repository. Read the
code before you write a ticket. Each ticket goes to an engineer who has the repo, sees nothing but that ticket,
and cannot ask anyone anything. A reviewer then checks the engineer's diff against the ticket's criteria.

# Goal
${goal}
${brief ? `\n# The issue this came from\n${brief}\n` : ''}
# A ticket
- One reviewable change that leaves the repo working once it and its deps are merged. Fewer is better: a small
  goal is one ticket, and 8 is the most.
- title: imperative, under 70 characters.
- body, in this order:
  1. The problem, with an input or example that shows it where there is one.
  2. The files to change, by exact path.
  3. Any name, signature, error message or flag this ticket must produce or use, so tickets that run in
     parallel agree without talking.
  4. Out of scope: what the engineer must not touch.
  5. Verify: the command that proves it, and what its output looks like when it passes.
  6. Assumptions: every call you made where the goal was silent. Nobody can be asked, so decide and say so.
- criteria: 2 to 5 lines. Each is one observable behaviour with its input and expected result, checkable from the
  diff or by running something. Any function, message, flag or path a criterion names also appears in the body.
  If a criterion asks for a test, say which regression the test must catch. Never "works", "handles edge cases",
  "is tested", or "is clean".
- deps: zero-based indexes of earlier tickets that must merge first, only when this ticket builds on that one's
  code. Independent tickets run in parallel.

# Example
title: Collapse dash runs in slugify
body:
  slugify('a  b') returns 'a--b'; runs of separators should become one dash.
  Files: slug.ts, slug.test.ts.
  Keep the export \`slugify(input: string): string\` unchanged.
  Out of scope: accent handling, length limits.
  Verify: \`bun test slug.test.ts\` passes, including a new 'collapses dash runs' test.
  Assumptions: leading and trailing dashes are trimmed too, since a slug never starts with one.
criteria:
  - slugify('a  b') and slugify('a--b') both return 'a-b'
  - slugify('  Hello World!  ') returns 'hello-world'
  - slug.test.ts has a 'collapses dash runs' test that fails on the current slugify

Before you return, read each ticket as that engineer. If they would have to guess what done means, fix the
ticket.`
}

function digestPrompt(goal: Goal, done: { t: Ticket; diff: string }[]) {
  return `You are reporting to the person who asked an autonomous crew for this. They were not watching and will
read this once, later. Say only what you can point to in a diff or a report below.

# What they asked for
${goal.text}

${done
  .map(
    ({ t, diff }) => `# t${t.id}: ${t.title} (${t.sha?.slice(0, 7)}, ${t.round} round${t.round === 1 ? '' : 's'}${
      t.override ? ', merged by human override without reviewer approval' : ''
    })
Author's report:
${t.summary || '(none)'}

${fence(diff, 40_000, 'truncated')}
`,
  )
  .join('\n')}
# Write, in this order
1. One or two sentences on what is now true that was not before.
2. What changed, by file path, one line each.
3. Every ruling the authors recorded, with what it costs if wrong. Skip this part if there were none.
4. What was verified (commands and counts from the reports) and what was not.
5. Anything noticed and left alone, or worth a look before pushing.

Plain language, short lines. Do not open with "Summary", do not praise the work, and do not end with an offer
or a question.`
}

function receipt(t: Ticket, checks: Check[] | null, ref: string) {
  return [
    `t${t.id}: ${t.title}`,
    '',
    ...(ref ? [ref, ''] : []),
    `Ticket: ${t.id}`,
    `Rounds: ${t.round}`,
    `Reviewed-by: ${checks ? 'kumi reviewer (fresh context, not the author)' : 'human override'}`,
    ...(checks ?? []).map(c => `Criterion: [pass] ${c.criterion}`),
  ].join('\n')
}

export class Crew {
  private live = new Map<number, { abort: AbortController; activity: string; at: number; done: Promise<void> }>()
  private gates = new Map<number, Promise<unknown>>()

  constructor(
    private store: Store,
    private ws: Workspace,
    private agent: AgentRunner,
    private tracker: Tracker,
    private home: string,
    private changed: () => void = () => {},
  ) {}

  /** What each running ticket's agent is doing right now, and when it last did anything. */
  activity() {
    return Object.fromEntries([...this.live].map(([id, l]) => [id, { line: l.activity, at: l.at }]))
  }

  /** Whatever a dead process left mid-flight goes back on the board. Branches survive. */
  async recover() {
    for (const t of this.store.tickets()) {
      if (!['working', 'review', 'gate'].includes(t.status)) continue
      const p = this.project(t.project_id)
      // The daemon died after the base moved but before the ticket said so: the receipt on the base proves it.
      const sha = t.status === 'gate' ? await this.ws.landed(p.path, p.base, t.id) : null
      if (sha) {
        this.store.patchTicket(t.id, { status: 'merged', sha, findings: [] })
        this.store.log(p.id, t.id, 'merge', { sha, rounds: t.round, recovered: true })
        void this.ws.cleanup(p.path, this.dir(p, t.id), this.branchOf(t.id))
      } else this.store.patchTicket(t.id, { status: 'todo', round: Math.max(0, t.round - 1), tries: Math.min(ROUNDS, t.tries + 1) })
    }
    for (const g of this.store.goals())
      if (g.status === 'planning') this.store.patchGoal(g.id, { status: 'failed', note: 'interrupted' })
    // Projects added before the tracker existed.
    for (const p of this.store.projects())
      if (p.tracker === undefined)
        void this.ws.slug(p.path).then(tracker => {
          this.store.patchProject(p.id, { tracker, hint: this.ws.gateHint(p.path) })
          this.changed()
        })
    this.kick()
  }

  /** The project for the repo `input` sits in, added if it is new. `init` makes a repo of a plain directory. */
  async openProject(input: string, init = false) {
    const dir = resolve(input.trim().replace(/^["']|["']$/g, '').replace(/^~(?=[\\/]|$)/, homedir()))
    if (init && !(await this.ws.root(dir))) await this.ws.init(dir)
    const path = await this.ws.root(dir)
    const base = path && (await this.ws.branch(path))
    if (!path || !base) throw new Error(`${dir} is not inside a git repo on a branch`)
    const known = this.store.projects().find(p => p.path === path)
    if (known) return known
    const p = this.store.addProject({
      name: basename(path),
      path,
      base,
      gate: this.ws.gateHint(path),
      workers: 2,
      running: true,
      tracker: await this.ws.slug(path),
      hint: this.ws.gateHint(path),
    })
    this.changed()
    return p
  }

  /**
   * Take a project off the board, by name or by a path inside its repo. Refused while any of its tickets is
   * queued or running. Ticket branches stay in the repo.
   */
  async forgetProject(name: string, input: string) {
    const path = name ? null : await this.ws.root(resolve(input))
    const p = this.store.projects().find(p => (name ? p.name === name : p.path === path))
    if (!p) throw new Error(`no project ${name || input}`)
    const busy = this.store.tickets().filter(t => t.project_id === p.id && ['todo', 'working', 'review', 'gate'].includes(t.status))
    if (busy.length) throw new Error(`${p.name} has ${busy.length} ticket${busy.length === 1 ? '' : 's'} queued or running; drop them first`)
    this.store.removeProject(p.id)
    this.changed()
    return p
  }

  /** The tracker's open cards, each marked if a goal already came from it. */
  async cards(project_id: number) {
    const p = this.project(project_id)
    if (!p.tracker) throw new Error('this repo has no GitHub remote, so there is no board to read')
    const taken = new Set(this.store.goals().filter(g => g.project_id === p.id && g.status !== 'failed').map(g => g.issue))
    return (await this.tracker.cards(p.tracker)).map(c => ({ ...c, onRail: taken.has(c.number) }))
  }

  /** Bring a tracker issue onto the rail: the planner turns its brief into draft tickets. */
  async take(project_id: number, issue: number, title: string) {
    const p = this.project(project_id)
    if (!p.tracker) throw new Error('this repo has no board')
    if (this.store.goals().some(g => g.project_id === p.id && g.issue === issue && g.status !== 'failed'))
      throw new Error(`#${issue} is already on the rail`)
    return this.plan(p.id, `#${issue} ${title}`, issue, await this.tracker.brief(p.tracker, issue))
  }

  /** A goal typed by the human, optionally filed on the tracker first so the board knows about it. */
  async compose(project_id: number, text: string, file: boolean) {
    const p = this.project(project_id)
    if (!text.trim()) throw new Error('say what you want done')
    if (!file) return this.plan(p.id, text)
    if (!p.tracker) throw new Error('this repo has no board to file on')
    const card = await this.tracker.file(p.tracker, text.trim().split(/\r?\n/)[0].slice(0, 120), text.trim())
    this.store.log(p.id, null, 'tracker', { did: 'filed', issue: card.number })
    return this.plan(p.id, text, card.number)
  }

  /** Tell the tracker what became of the issue a ticket came from. Never blocks or fails the crew. */
  private report(p: Project, t: Ticket, what: 'start' | 'stuck', detail = '') {
    const issue = this.store.goals().find(g => g.id === t.goal_id)?.issue
    const repo = p.tracker
    if (!repo || !issue) return
    const say = async () => {
      if (what === 'start') return this.tracker.claim(repo, issue)
      await this.tracker.comment(repo, issue, `kumi: t${t.id} "${t.title}" needs a human.\n\n${detail}`)
      return this.tracker.move(repo, issue, 'blocked')
    }
    say().then(
      () => this.store.log(p.id, t.id, 'tracker', { did: what, issue }),
      e => this.store.log(p.id, t.id, 'tracker', { failed: what, issue, error: String(e?.message ?? e) }),
    )
  }

  /**
   * The last merge of a goal: a reporter reads everything that landed and writes the goal's summary for the
   * human, which also goes to the tracker. Never blocks or fails the crew.
   */
  private async landed(p: Project, t: Ticket) {
    const goal = this.store.goals().find(g => g.id === t.goal_id)
    if (!goal) return
    const mine = this.store.tickets().filter(o => o.goal_id === goal.id && o.status !== 'dropped')
    if (mine.some(o => o.status !== 'merged')) return
    const done = await Promise.all(mine.map(async t => ({ t, diff: await this.ws.diff(p.path, `${t.sha}^`, t.sha!) })))
    const r = await this.agent.run({ cwd: p.path, prompt: digestPrompt(goal, done), readOnly: true }).catch(() => null)
    const summary = (r?.ok && r.text.trim()) || mine.map(o => `- ${o.title}: ${o.summary.split('\n')[0]}`).join('\n')
    this.store.patchGoal(goal.id, { summary })
    this.store.log(p.id, t.id, 'digest', { goal: goal.id, written: !!r?.ok })
    this.changed()
    if (!p.tracker || !goal.issue) return
    const lines = mine.map(o => `- ${o.sha?.slice(0, 7)} ${o.title} (${o.override ? 'human override' : `${o.criteria.length}/${o.criteria.length} criteria`}, round ${o.round})`)
    this.tracker
      .comment(p.tracker, goal.issue, `kumi merged this on local ${p.base}. Pushing closes the issue.\n\n${summary}\n\n${lines.join('\n')}`)
      .then(() => this.tracker.move(p.tracker!, goal.issue!, 'in-review'))
      .then(
        () => this.store.log(p.id, t.id, 'tracker', { did: 'landed', issue: goal.issue }),
        e => this.store.log(p.id, t.id, 'tracker', { failed: 'landed', issue: goal.issue, error: String(e?.message ?? e) }),
      )
  }

  /** `Fixes #n` on the ticket that completes a tracker issue, `Refs #n` on the ones before it. */
  private ref(t: Ticket) {
    const issue = this.store.goals().find(g => g.id === t.goal_id)?.issue
    if (!issue) return ''
    const open = this.store.tickets().some(o => o.goal_id === t.goal_id && o.id !== t.id && o.status !== 'merged' && o.status !== 'dropped')
    return `${open ? 'Refs' : 'Fixes'} #${issue}.`
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
      summary: '',
      note: '',
      override: false,
      sha: null,
    })
    this.kick()
    return t
  }

  /** Turn a goal into draft tickets. Returns at once; the planner runs behind it. */
  plan(project_id: number, text: string, issue: number | null = null, brief = '') {
    const p = this.project(project_id)
    const goal = this.store.addGoal({ project_id, text: text.trim(), status: 'planning', note: '', issue, brief, summary: '' })
    this.changed()
    void this.agent
      .run({ cwd: p.path, prompt: planPrompt(goal.text, brief), readOnly: true, schema: PLAN })
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

  async act(id: number, action: 'start' | 'retry' | 'approve' | 'restart' | 'drop', note = '') {
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
    } else if (action === 'restart') {
      // A stalled agent: kill it and run the same round again, no try spent.
      from('working', 'review')
      const run = this.live.get(id)
      run?.abort.abort()
      await run?.done
      this.store.patchTicket(id, { status: 'todo', round: Math.max(0, t.round - 1), tries: t.tries + 1 })
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
        this.report(p, this.ticket(id), 'stuck', why)
      })
      .finally(() => {
        this.live.delete(id)
        this.kick()
      })
    this.live.set(id, { abort, activity: '', at: Date.now(), done })
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
      if (l) {
        l.activity = line
        l.at = Date.now()
      }
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
      // What the gate squashes: the commit the reviewer saw, or the branch tip on a human override.
      let pick = branch

      if (!t.override) {
        if (t.tries <= 0) {
          const why = `still failing after ${t.round} rounds`
          log('escalate', { why, findings: t.findings })
          this.report(p, t, 'stuck', [why, ...t.findings.map(f => `- ${f}`)].join('\n'))
          return set({ status: 'escalated', note: why })
        }
        const round = t.round + 1
        log('claim', { round })
        if (t.tries === ROUNDS) this.report(p, t, 'start')
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
        const head = await this.ws.head(dir)
        const diff = await this.ws.diff(p.path, p.base, head)
        if (!diff) {
          send(round, 'no changes were produced on the branch')
          continue
        }
        // Agent config in the diff steers the reviewer now and every Claude session in the repo once merged.
        const config = diff.match(AGENT_CONFIG)
        if (config && !`${t.title}\n${t.body}`.includes(config[1]))
          throw new Error(`the change touches agent config the ticket never mentions (${config[1]}); a human should look before a reviewer runs in it`)
        const report = work.text.trim().slice(0, 4000)
        set({ summary: report })
        // The author stopped on purpose: a human decides, the reviewer never sees it.
        if (blocked(report)) throw new Error(`the author stopped and needs a decision:\n${report}`)
        log('submit', { round, summary: first(report) })
        set({ status: 'review' })
        onActivity('')

        const review = await this.agent.run({
          cwd: dir,
          prompt: reviewPrompt(t, diff, round, this.ticket(id).summary),
          schema: VERDICT,
          signal,
          onActivity,
        })
        if (signal.aborted) return
        // Back to exactly what was reviewed: the reviewer's edits and any commit it made are gone.
        await this.ws.discard(dir, head)
        pick = head
        const got: any[] = Array.isArray(review.data?.criteria) ? review.data.criteria : []
        if (got.length < t.criteria.length) throw new Error(`reviewer returned no verdict: ${tail(review.text, 500)}`)
        // Pair by position and take approval from the rows, never from the reviewer's say-so.
        checks = t.criteria.map((criterion, i) => ({ criterion, pass: got[i].pass === true, reason: String(got[i].reason ?? '') }))
        const previous: { finding: string; evidence: string; addressed: boolean }[] = Array.isArray(review.data?.previous) ? review.data.previous : []
        const nits: string[] = Array.isArray(review.data?.nits) ? review.data.nits.map(String) : []
        // A row past the criteria that fails is a finding too, not something to drop for being out of place.
        const extra = got.slice(t.criteria.length).filter(r => r?.pass === false)
        checks.push(...extra.map(r => ({ criterion: String(r.criterion ?? 'extra'), pass: false, reason: String(r.reason ?? '') })))
        const approved = checks.every(c => c.pass)
        log('verdict', { round, approved, criteria: checks, previous, nits })
        if (!approved) {
          // A previous finding still open rides along, so a half-fix cannot drop out of sight between rounds.
          const open = previous.filter(f => f.addressed !== true).map(f => `Still open from round ${round - 1}: ${f.finding} (${f.evidence})`)
          set({ findings: [...checks.filter(c => !c.pass).map(c => `${c.criterion}: ${c.reason}`), ...open] })
          continue
        }
      }

      set({ status: 'gate' })
      onActivity(p.gate)
      const gate = await this.locked(p.id, async (): Promise<{ log: string; sha?: string; human?: boolean }> => {
        const merged = await this.ws.squash(p.path, this.dir(p, 'gate'), p.base, pick, receipt(t, checks, this.ref(t)))
        if (!merged.sha) return { log: merged.log }
        if (p.gate) {
          const ran = await this.ws.exec(this.dir(p, 'gate'), p.gate)
          if (!ran.ok) return { log: `\`${p.gate}\` failed on the merged result:\n${tail(ran.log, 3000)}` }
        }
        // Dropped while the gate ran: the base branch never moves for it.
        if (signal.aborted) return { log: '' }
        const moved = await this.ws.advance(p.path, p.base, merged.sha)
        return moved.ok ? { sha: merged.sha, log: '' } : { log: `could not fast-forward ${p.base}:\n${moved.log}`, human: true }
      })

      if (signal.aborted) return
      if (gate.sha) {
        log('merge', { sha: gate.sha, rounds: t.round })
        set({ status: 'merged', sha: gate.sha, findings: [] })
        void this.landed(p, this.ticket(id))
        return this.ws.cleanup(p.path, dir, branch)
      }
      log('gate', { ok: false, log: gate.log })
      if (gate.human) {
        log('escalate', { why: gate.log })
        this.report(p, t, 'stuck', gate.log)
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
