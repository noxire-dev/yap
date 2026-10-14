// bun src/crew.check.ts — the loop against fakes: no git, no model, no network.
import { Database } from 'bun:sqlite'
import assert from 'node:assert/strict'
import { Crew, ROUNDS } from './crew'
import type { AgentRunner, Tracker, Workspace } from './ports'
import { Sessions, gitRisk } from './sessions'
import { resolve } from 'node:path'
import { SqliteStore } from './store'

const ok = { ok: true, log: '' }
const norm = (p: string) => (process.platform === 'win32' ? resolve(p).replace(/\\/g, '/').toLowerCase() : resolve(p))
const TWO = { tickets: [{ title: 'first', body: '', criteria: ['a', 'b'], deps: [] }, { title: 'second', body: '', criteria: ['a', 'b'], deps: [0] }] }

function rig(reviews: boolean[], o: { gateOk?: boolean; plan?: object; hang?: boolean; report?: string; diff?: string; landed?: string } = {}) {
  const store = new SqliteStore(new Database(':memory:'))
  const merged: string[] = []
  const squashed: string[] = []
  // What `git status` would list, for shell-edit tracking.
  const dirty: { path: string; mtime: number }[] = []
  const ws: Workspace = {
    root: async dir => dir,
    // `/wt` is a second worktree of `/repo`.
    where: async dir => ({ top: dir.startsWith('/wt') ? '/wt' : '/repo', common: '/repo/.git' }),
    changed: async () => dirty,
    init: async () => {},
    branch: async () => 'main',
    slug: async () => 'acme/toy',
    gateHint: () => '',
    worktree: async () => {},
    mergeBase: async () => true,
    commitAll: async () => ok,
    diff: async () => o.diff ?? 'diff --git a/x b/x',
    head: async () => 'reviewed1',
    landed: async () => o.landed ?? null,
    discard: async () => {},
    squash: async (_r, _s, _b, pick, message) => {
      squashed.push(pick)
      merged.push(message)
      return { ...ok, sha: 'abc123' }
    },
    exec: async () => ({ ok: o.gateOk ?? true, log: o.gateOk === false ? '1 test failed' : '' }),
    advance: async () => ok,
    cleanup: async () => {},
  }
  const prompts: string[] = []
  const agent: AgentRunner = {
    async run({ prompt, schema, signal }) {
      prompts.push(prompt)
      if (prompt.startsWith('Break this goal')) return { ok: true, text: '', data: o.plan ?? TWO }
      if (prompt.startsWith('You are reporting')) return { ok: true, text: 'The crew did the thing in x.' }
      if (!schema && o.hang) {
        // The first author run never answers until it is killed.
        o.hang = false
        await new Promise(r => signal!.addEventListener('abort', r))
        return { ok: false, text: 'killed' }
      }
      if (!schema) return { ok: true, text: o.report ?? 'did the thing' }
      const pass = reviews.shift() ?? false
      const again = prompt.includes('the previous round failed on these')
      return {
        ok: true,
        text: '',
        data: {
          previous: again ? [{ finding: 'b', evidence: 'slug.ts:2 unchanged', addressed: pass }] : [],
          criteria: [{ criterion: 'a', reason: 'fine', pass: true }, { criterion: 'b', reason: 'no cap', pass }],
          nits: ['rename x'],
        },
      }
    },
  }
  const told: string[] = []
  const tracker: Tracker = {
    cards: async () => [{ number: 7, title: 'from the board', column: 'todo', priority: 'normal', cycle: true }],
    brief: async (_r, n) => `# issue ${n}\nthe brief`,
    file: async (_r, title) => (told.push(`file ${title}`), { number: 9, title, column: 'todo', priority: 'normal', cycle: false }),
    claim: async (_r, n) => void told.push(`claim ${n}`),
    move: async (_r, n, column) => void told.push(`move ${n} ${column}`),
    comment: async (_r, n, text) => void told.push(`comment ${n} ${text.split('\n')[0]}`),
  }
  const crew = new Crew(store, ws, agent, tracker, '/tmp/kumi')
  return { store, crew, merged, squashed, prompts, told, ws, dirty }
}

async function until<T>(get: () => T | undefined | false) {
  for (let i = 0; i < 400; i++) {
    const v = get()
    if (v) return v
    await Bun.sleep(5)
  }
  throw new Error('never settled')
}
const settled = (store: SqliteStore, id: number) => until(() => store.tickets().find(t => t.id === id && (t.status === 'merged' || t.status === 'escalated')))

// Sent back once, then approved: merges on round 2 with the receipt in the commit.
{
  const { store, crew, merged, prompts } = rig([false, true])
  const p = await crew.openProject('.')
  assert.equal((await crew.openProject('.')).id, p.id, 'opening the same repo twice is one project')
  store.patchProject(p.id, { gate: 'bun test' })
  const t = await settled(store, crew.addTicket(p.id, { title: 'cap retries', criteria: ['a', 'b'] }).id)
  assert.equal(t.status, 'merged')
  assert.equal(t.round, 2)
  assert.match(merged[0], /Rounds: 2\nReviewed-by: kumi reviewer/)
  assert.match(prompts[2], /Round 2[\s\S]*b: no cap/, 'findings reach the author')
  assert.match(prompts[3], /previous round failed on these[\s\S]*b: no cap/, 'and the next reviewer')
  assert.match(prompts[3], /author's report \(claims to check, not evidence\)\ndid the thing/)
  assert.deepEqual(store.events({ ticket_id: t.id }).find(e => e.kind === 'verdict')!.data.nits, ['rename x'])
  assert.deepEqual(store.events({ ticket_id: t.id }).map(e => e.kind).reverse(), ['claim', 'submit', 'verdict', 'claim', 'submit', 'verdict', 'merge'])
}

// Never approved: escalates after ROUNDS, nothing merges, and a human override goes straight to the gate.
{
  const { store, crew, merged } = rig([])
  const p = await crew.openProject('.')
  const id = crew.addTicket(p.id, { title: 'x', criteria: ['a', 'b'] }).id
  const t = await settled(store, id)
  assert.equal(t.status, 'escalated')
  assert.equal(t.round, ROUNDS)
  assert.equal(merged.length, 0)
  assert.ok(t.findings.some(f => f.startsWith('Still open from round 3: b')), 'an unaddressed finding is carried')
  await crew.act(id, 'approve')
  assert.equal((await settled(store, id)).status, 'merged')
  assert.match(merged[0], /Reviewed-by: human override/)
}

// Approved but the gate fails on the merged result: main never moves, the log goes back to the author.
{
  const { store, crew } = rig([true, true, true, true], { gateOk: false })
  const p = await crew.openProject('.')
  store.patchProject(p.id, { gate: 'bun test' })
  const t = await settled(store, crew.addTicket(p.id, { title: 'x', criteria: ['a', 'b'] }).id)
  assert.equal(t.status, 'escalated')
  assert.equal(t.sha, null)
  assert.match(t.findings[0], /1 test failed/)
}

// A stalled author is restarted by hand: same round again, no try spent, and it merges.
{
  const { store, crew } = rig([true], { hang: true })
  const p = await crew.openProject('.')
  const id = crew.addTicket(p.id, { title: 'x', criteria: ['a', 'b'] }).id
  await until(() => store.tickets()[0].status === 'working')
  await crew.act(id, 'restart')
  const t = await settled(store, id)
  assert.equal(t.status, 'merged')
  assert.equal(t.round, 1)
  assert.deepEqual(store.events({ ticket_id: id }).map(e => e.kind).reverse(), ['claim', 'human', 'claim', 'submit', 'verdict', 'merge'])
}

// An issue taken from the tracker: planned from its brief into drafts that wait, the second ticket waits for
// the first, the board hears about it, and only the last merge closes the issue.
{
  const { store, crew, merged, prompts, told } = rig([true, true])
  const p = await crew.openProject('.')
  assert.equal((await crew.cards(p.id))[0].onRail, false)
  await crew.take(p.id, 7, 'from the board')
  const goal = await until(() => store.goals().find(g => g.status === 'ready'))
  assert.match(prompts[0], /the brief/)
  assert.equal((await crew.cards(p.id))[0].onRail, true)
  await assert.rejects(crew.take(p.id, 7, 'again'), /already on the rail/)
  const [a, b] = store.tickets()
  assert.deepEqual([a.status, b.status, b.deps], ['draft', 'draft', [a.id]])
  crew.startGoal(goal.id)
  await settled(store, a.id)
  await settled(store, b.id)
  assert.match(merged[0], /Refs #7\./)
  assert.match(merged[1], /Fixes #7\./)
  await until(() => told.includes('move 7 in-review'))
  assert.deepEqual(told, ['claim 7', 'claim 7', 'comment 7 kumi merged this on local main. Pushing closes the issue.', 'move 7 in-review'])
  assert.equal(store.goals()[0].summary, 'The crew did the thing in x.', 'the goal carries the reporter\'s summary')
  assert.equal(store.tickets()[0].summary, 'did the thing', 'the ticket carries its author\'s report')
}

// An author that reports BLOCKED goes to a human, not to the reviewer.
{
  const { store, crew, prompts } = rig([], { report: 'Status: BLOCKED\nVerified: nothing; the API needs a key I do not have' })
  const p = await crew.openProject('.')
  const t = await settled(store, crew.addTicket(p.id, { title: 'x', criteria: ['a', 'b'] }).id)
  assert.equal(t.status, 'escalated')
  assert.match(t.note, /needs a decision[\s\S]*needs a key/)
  assert.equal(prompts.length, 1, 'no review ran')
}

// A typed goal filed on the tracker first; a stuck ticket blocks its issue.
{
  const { store, crew, told } = rig([], { plan: { tickets: [TWO.tickets[0]] } })
  const p = await crew.openProject('.')
  const goal = await crew.compose(p.id, 'make retries sane\nmore detail', true)
  assert.equal(goal.issue, 9)
  await until(() => store.goals()[0].status === 'ready')
  crew.startGoal(goal.id)
  await settled(store, store.tickets()[0].id)
  await until(() => told.includes('move 9 blocked'))
  assert.deepEqual(told, ['file make retries sane', 'claim 9', 'comment 9 kumi: t1 "first" needs a human: still failing after 4 rounds. The full story is on the kumi board.', 'move 9 blocked'])
}

// Forgetting a project is refused while a ticket is queued, and takes its goals, tickets and journal with it.
{
  const { store, crew } = rig([])
  const p = await crew.openProject('.')
  store.patchProject(p.id, { running: false })
  crew.addTicket(p.id, { title: 'busy' })
  await assert.rejects(crew.forgetProject(p.name, ''), /1 ticket queued or running/)
  for (const t of store.tickets()) store.patchTicket(t.id, { status: 'dropped' })
  store.log(p.id, null, 'human', {})
  await crew.forgetProject('', '.')
  assert.deepEqual([store.projects(), store.tickets(), store.events({})], [[], [], []])
  await assert.rejects(crew.forgetProject('nope', ''), /no project nope/)
}

// Sessions: each one hears about the others in its repo, and is warned once before touching a file another
// session in the same working tree just edited. A worktree of the same repo is visible but never warned.
{
  const { store, ws } = rig([])
  let now = 1_000_000
  const reg = new Sessions(ws, store, () => now)
  const ctx = (r: any) => r.hookSpecificOutput?.additionalContext ?? ''
  assert.deepEqual(await reg.hook('start', { session_id: 'aaaa1111', cwd: '/repo' }), {}, 'alone: nothing to say')
  await reg.hook('prompt', { session_id: 'aaaa1111', cwd: '/repo', prompt: 'fix the login redirect\nmore' })
  await reg.hook('post', { session_id: 'aaaa1111', cwd: '/repo', tool_input: { file_path: '/repo/src/auth.ts' } })
  now += 60_000
  assert.match(ctx(await reg.hook('start', { session_id: 'bbbb2222', cwd: '/repo' })), /aaaa1111.*"fix the login redirect".*src\/auth\.ts/)
  assert.match(ctx(await reg.hook('start', { session_id: 'cccc3333', cwd: '/wt' })), /aaaa1111.*in another worktree/)
  const warn = await reg.hook('pre', { session_id: 'bbbb2222', cwd: '/repo', tool_input: { file_path: 'src/auth.ts' } })
  assert.match(ctx(warn), /src\/auth\.ts in this same working tree: session aaaa1111 \("fix the login redirect"\) edited it 1m ago/)
  assert.deepEqual(await reg.hook('pre', { session_id: 'bbbb2222', cwd: '/repo', tool_input: { file_path: 'src/auth.ts' } }), {}, 'warned once')
  assert.deepEqual(await reg.hook('pre', { session_id: 'cccc3333', cwd: '/wt', tool_input: { file_path: '/wt/src/auth.ts' } }), {}, 'other worktree')
  assert.match(ctx(await reg.hook('prompt', { session_id: 'aaaa1111', cwd: '/repo', prompt: 'x' })), /bbbb2222[\s\S]*cccc3333/, 'news on the next prompt')
  assert.deepEqual(await reg.hook('prompt', { session_id: 'aaaa1111', cwd: '/repo', prompt: 'y' }), {}, 'nothing moved, nothing said')
  await reg.hook('end', { session_id: 'bbbb2222' })
  assert.deepEqual(reg.list().map(s => s.id).sort(), ['aaaa1111', 'cccc3333'])
}

// Sessions talk: a message waits for the recipient's next hook call, a clobbering git command is held back while
// another session edits the same tree, and a shell command's edits count as the session's own.
{
  const { store, ws, dirty } = rig([])
  let now = 1_000_000
  const reg = new Sessions(ws, store, () => now)
  const ctx = (r: any) => r.hookSpecificOutput?.additionalContext ?? ''
  const bash = (id: string, command: string, event = 'pre') => reg.hook(event, { session_id: id, cwd: '/repo', tool_name: 'Bash', tool_input: { command } })
  await reg.hook('prompt', { session_id: 'aaaa1111', cwd: '/repo', prompt: 'fix the login redirect' })
  assert.match(ctx(await reg.hook('start', { session_id: 'bbbb2222', cwd: '/repo' })), /You are session bbbb2222.*kumi say/s)
  assert.deepEqual(await reg.say({ from: 'bbbb2222', cwd: '/repo', to: '@aaaa', text: 'leave auth.ts to me' }), ['aaaa1111'])
  assert.match(ctx(await bash('aaaa1111', 'ls')), /From session bbbb2222: leave auth\.ts to me/)
  assert.deepEqual(await bash('aaaa1111', 'ls'), {}, 'delivered once')
  await assert.rejects(reg.say({ from: 'bbbb2222', cwd: '/repo', to: 'zzzz', text: 'hi' }), /no live session zzzz/)
  await reg.say({ cwd: '/repo', text: 'stop and commit' })
  assert.match(ctx(await reg.hook('prompt', { session_id: 'bbbb2222', cwd: '/repo', prompt: 'go' })), /From the user: stop and commit/)

  // aaaa's shell command rewrites a file: only what changed since the command started is its edit.
  dirty.push({ path: '/repo/old.ts', mtime: now - 60_000 })
  await bash('aaaa1111', "sed -i s/a/b/ src/auth.ts")
  now += 5_000
  dirty.push({ path: '/repo/src/auth.ts', mtime: now })
  await bash('aaaa1111', "sed -i s/a/b/ src/auth.ts", 'post')
  assert.deepEqual(reg.list().find(s => s.id === 'aaaa1111')!.files, [norm('/repo/src/auth.ts')])

  const held: any = await bash('bbbb2222', 'git stash && git checkout main')
  assert.equal(held.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(held.hookSpecificOutput.permissionDecisionReason, /session aaaa1111.*src\/auth\.ts/)
  assert.deepEqual(await bash('bbbb2222', 'git status && git diff'), {}, 'reading git is fine')
  assert.equal(((await bash('aaaa1111', 'git reset --hard')) as any).hookSpecificOutput, undefined, 'bbbb edited nothing')
}

// The board: a note outlives its author and greets the next session, live sessions hear of it at once, and it
// comes down by id.
{
  const { store, ws } = rig([])
  const reg = new Sessions(ws, store, () => 1_000_000)
  const ctx = (r: any) => r.hookSpecificOutput?.additionalContext ?? ''
  await reg.hook('prompt', { session_id: 'aaaa1111', cwd: '/repo', prompt: 'auth refactor' })
  await reg.hook('start', { session_id: 'bbbb2222', cwd: '/repo' })
  const n = await reg.note({ from: 'aaaa1111', cwd: '/repo', text: 'I own src/auth until tonight' })
  assert.match(ctx(await reg.hook('pre', { session_id: 'bbbb2222', cwd: '/repo', tool_name: 'Bash', tool_input: { command: 'ls' } })), /New note on the board, #1 from session aaaa1111 \("auth refactor"\): I own src\/auth/)
  await reg.hook('end', { session_id: 'aaaa1111' })
  assert.match(ctx(await reg.hook('start', { session_id: 'cccc3333', cwd: '/wt' })), /kumi board[\s\S]*#1 just now, session aaaa1111 \("auth refactor"\): I own src\/auth/, 'a worktree shares the board')
  await assert.rejects(reg.unnote('/repo', 99), /no note #99/)
  await reg.unnote('/repo', n.id)
  assert.deepEqual(await reg.notes('/repo'), [])
}

// The gate squashes the commit the reviewer saw, never whatever the branch points at by then.
{
  const { store, crew, squashed } = rig([true], { plan: { tickets: [TWO.tickets[0]] } })
  const p = await crew.openProject('.')
  const g = crew.plan(p.id, 'one')
  await until(() => store.goals()[0].status === 'ready')
  crew.startGoal(g.id)
  assert.equal((await settled(store, store.tickets()[0].id)).status, 'merged')
  assert.deepEqual(squashed, ['reviewed1'])
}

// A diff that touches agent config the ticket never named goes to a human before any reviewer runs in it.
{
  const { store, crew, prompts } = rig([true], { plan: { tickets: [TWO.tickets[0]] }, diff: 'diff --git a/.claude/settings.json b/.claude/settings.json' })
  const p = await crew.openProject('.')
  const g = crew.plan(p.id, 'one')
  await until(() => store.goals()[0].status === 'ready')
  crew.startGoal(g.id)
  const t = await settled(store, store.tickets()[0].id)
  assert.equal(t.status, 'escalated')
  assert.match(t.note, /agent config.*\.claude\/settings\.json/)
  assert.ok(!prompts.some(x => x.startsWith('You are reviewing')), 'no reviewer ran')
}

// A daemon that died after the base moved: the receipt on the base marks the ticket merged on restart.
{
  const { store, crew } = rig([], { landed: 'feed123' })
  const p = await crew.openProject('.')
  store.patchProject(p.id, { running: false })
  const t = crew.addTicket(p.id, { title: 'mid-gate' })
  store.patchTicket(t.id, { status: 'gate', round: 1 })
  await crew.recover()
  assert.deepEqual([store.tickets()[0].status, store.tickets()[0].sha], ['merged', 'feed123'])
}

// The git guard's reading of a command: the forms that slipped past it, and the ones it wrongly blocked.
for (const c of ['git -C . checkout main', 'git -c x=1 switch main', 'git reset --keep HEAD~1', 'git cherry-pick abc', 'git.exe checkout x', 'ls && git stash', 'git restore src/a.ts'])
  assert.equal(gitRisk(c), 'moves', c)
for (const c of ['git add -A && git commit -m x', 'git commit -am x', 'git add .']) assert.equal(gitRisk(c), 'sweeps', c)
for (const c of ['git stash list', 'git merge-base a b', 'git rebase --abort', 'git restore --staged a.ts', 'git checkout-index -a', 'echo "git merge"', 'git add src/a.ts', 'git status'])
  assert.equal(gitRisk(c), null, c)

console.log('crew ok')
