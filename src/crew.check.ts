// bun src/crew.check.ts — the loop against fakes: no model, no network, and git only for the merge check.
import { Database } from 'bun:sqlite'
import assert from 'node:assert/strict'
import { YapLocal, YapError as LocalError, wakePrompt } from '../sdk/local'
import { Yap, YapError } from '../sdk/remote'
import { Bridge, remote } from './bridge'
import { Chats, rooted } from './chat'
import { Crew, ROUNDS } from './crew'
import { MAIL_MS, threadChips } from './kodrChips'
import { childEnv } from './env'
import type { AgentRunner, Tracker, Workspace } from './ports'
import { Sessions, gitRisk, norm, patchFiles } from './sessions'
import { resolve } from 'node:path'
import { SqliteStore } from './store'
import { LocalWorkspace } from './workspace'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { events, local } from './wire'
import { rpc } from './mcp'

const ok = { ok: true, log: '' }
const TWO = { tickets: [{ title: 'first', body: '', criteria: ['a', 'b'], deps: [] }, { title: 'second', body: '', criteria: ['a', 'b'], deps: [0] }] }

function rig(reviews: boolean[], o: { gateOk?: boolean; plan?: object; hang?: boolean; report?: string; diff?: string; landed?: string; baseBroken?: boolean } = {}) {
  let atBase = false
  const store = new SqliteStore(new Database(':memory:'))
  const merged: string[] = []
  const squashed: string[] = []
  // What `git status` would list, for shell-edit tracking.
  const dirty: { path: string; mtime: number }[] = []
  const ws: Workspace = {
    root: async dir => dir,
    // `/wt` is a second worktree of `/repo`.
    where: async dir => (dir.startsWith('/elsewhere') ? { top: '/elsewhere', common: '/elsewhere/.git' } : { top: dir.startsWith('/wt') ? '/wt' : '/repo', common: '/repo/.git' }),
    changed: async () => dirty,
    snapshot: async () => null,
    conflicts: async () => [],
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
    // The gate tree sits on the merged result after a squash, and on the bare base once reset to it.
    discard: async (_d, to) => void (to === 'main' && (atBase = true)),
    squash: async (_r, _s, _b, pick, message) => {
      atBase = false
      squashed.push(pick)
      merged.push(message)
      return { ...ok, sha: 'abc123' }
    },
    exec: async () => {
      const ok = atBase ? !o.baseBroken : (o.gateOk ?? true)
      return { ok, log: ok ? '' : atBase ? 'base is red' : '1 test failed' }
    },
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
    comment: async (_r, n, text) => void told.push(`comment ${n} ${text.split('\n')[0]}`, ...(text.includes('The crew did') ? ['the reporter summary leaked'] : [])),
  }
  const crew = new Crew(store, ws, agent, tracker, '/tmp/yap')
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
  assert.match(merged[0], /Rounds: 2\nReviewed-by: yap reviewer/)
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
  assert.match(t.note, /still failing after 4 rounds: `bun test` failed on the merged result/)
}

// A gate that fails on the base by itself goes to a human after one round: no author can fix that.
{
  const { store, crew, prompts } = rig([true], { gateOk: false, baseBroken: true })
  const p = await crew.openProject('.')
  store.patchProject(p.id, { gate: 'bun test' })
  const t = await settled(store, crew.addTicket(p.id, { title: 'x', criteria: ['a', 'b'] }).id)
  assert.deepEqual([t.status, t.round], ['escalated', 1])
  assert.match(t.note, /`bun test` fails on main itself, without t\d+'s change[\s\S]*base is red/)
  assert.equal(prompts.filter(x => x.startsWith('You are the engineer')).length, 1)
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
  assert.deepEqual(told, ['claim 7', 'claim 7', 'comment 7 yap merged this on local main. Pushing closes the issue. The summary is on the yap board.', 'move 7 in-review'])
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
  assert.deepEqual(told, ['file make retries sane', 'claim 9', 'comment 9 yap: t1 "first" needs a human: still failing after 4 rounds. The full story is on the yap board.', 'move 9 blocked'])
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
  assert.match(ctx(await reg.hook('start', { session_id: 'bbbb2222', cwd: '/repo' })), /@auth \(aaaa1111\), active 1m ago: edited src\/auth\.ts$/m)
  assert.match(ctx(await reg.hook('start', { session_id: 'cccc3333', cwd: '/wt' })), /aaaa1111.*in another worktree/)
  const warn = await reg.hook('pre', { session_id: 'bbbb2222', cwd: '/repo', tool_input: { file_path: 'src/auth.ts' } })
  assert.match(ctx(warn), /src\/auth\.ts in this same working tree: session @auth edited it 1m ago/)
  assert.deepEqual(await reg.hook('pre', { session_id: 'bbbb2222', cwd: '/repo', tool_input: { file_path: 'src/auth.ts' } }), {}, 'warned once')
  assert.deepEqual(await reg.hook('pre', { session_id: 'cccc3333', cwd: '/wt', tool_input: { file_path: '/wt/src/auth.ts' } }), {}, 'other worktree')
  assert.match(ctx(await reg.hook('prompt', { session_id: 'aaaa1111', cwd: '/repo', prompt: 'x' })), /bbbb2222[\s\S]*cccc3333/, 'news on the next prompt')
  assert.deepEqual(await reg.hook('prompt', { session_id: 'aaaa1111', cwd: '/repo', prompt: 'y' }), {}, 'nothing moved, nothing said')
  await reg.hook('end', { session_id: 'bbbb2222' })
  assert.deepEqual(reg.list().map(s => s.id).sort(), ['aaaa1111', 'cccc3333'])
}

// spawn: a background session joins as a peer under the id it was given, and its last word goes to whoever asked.
{
  const { store, ws } = rig([])
  const runs: any[] = []
  let finish = (_: string) => {}
  const runner: AgentRunner = { run: o => (runs.push(o), new Promise(r => (finish = text => r({ ok: true, text })))) }
  const woken: string[] = []
  const reg = new Sessions(ws, store, () => 1_000_000, { wake: async s => (woken.push(s.id), true) }, runner)
  await reg.yap('join', { session: 'aaaa1111', cwd: '/repo' })
  const { id } = await reg.spawn({ from: 'aaaa1111', cwd: '/repo', text: 'add a retry to fetchUser' })
  assert.equal(runs[0].peer.slice(0, 8), id)
  assert.match(runs[0].prompt, /^add a retry to fetchUser\n\n.*session @aaaa1111, which asked for it/s)
  await reg.yap('edited', { session: runs[0].peer, cwd: '/repo', path: 'src/fetch.ts' })
  await reg.yap('leave', { session: runs[0].peer })
  finish('Added a retry with backoff to fetchUser.')
  await Bun.sleep(0)
  assert.deepEqual(woken, ['aaaa1111'])
  assert.match((await reg.yap('turn', { session: 'aaaa1111', cwd: '/repo', prompt: 'yap: a message from session @fetch' })).context!, /Session @fetch, which you started, finished: Added a retry/)
  assert.deepEqual(reg.spawns().map(s => [s.id, s.name, s.ok]), [[id, 'fetch', true]])

  // No more than the setting run at once; what ran outlives the daemon, and what was running comes back failed.
  let cap = 1
  const hang: AgentRunner = { run: () => new Promise(() => {}) }
  const next = new Sessions(ws, store, () => 2_000_000, undefined, hang, () => cap)
  assert.deepEqual(next.spawns().map(s => [s.id, s.name, s.ok]), [[id, 'fetch', true]], 'kept across a restart')
  await next.spawn({ cwd: '/repo', text: 'one' })
  await assert.rejects(next.spawn({ cwd: '/repo', text: 'two' }), (e: any) => e.status === 429 && /yap config spawns/.test(e.message))
  cap = 2
  await next.spawn({ cwd: '/repo', text: 'two' })
  const after = new Sessions(ws, store, () => 3_000_000, undefined, hang, () => cap)
  assert.deepEqual(after.spawns().map(s => [s.task, s.ok, s.done]), [['two', false, 3_000_000], ['one', false, 3_000_000], ['add a retry to fetchUser', true, 1_000_000]])
  assert.match(after.spawns()[0].result!, /yap restarted while it ran/)
  await after.spawn({ cwd: '/repo', text: 'three' })
}

// A harness: names its sessions, reads one repo's peers, and hears what happens there as it happens.
{
  const { store, ws } = rig([])
  const reg = new Sessions(ws, store, () => 1_000_000)
  const heard: any[] = []
  const off = reg.listen(e => heard.push(e))
  await reg.yap('join', { session: 'ide-1', cwd: '/repo', name: 'Planner' })
  await reg.yap('join', { session: 'ide-2', cwd: '/wt', name: 'planner' })
  await reg.yap('edited', { session: 'ide-2', cwd: '/wt', path: 'src/x.ts' })
  await reg.yap('join', { session: 'far', cwd: '/elsewhere' })
  await reg.say({ from: 'ide-2', cwd: '/wt', to: 'planner', text: 'x.ts is mine' })
  await reg.note({ cwd: '/repo', text: 'freeze' })
  await reg.yap('leave', { session: 'ide-2' })
  off()
  await reg.yap('leave', { session: 'far' })
  const repo = norm('/repo')
  assert.deepEqual(heard.map(e => [e.type, e.session ?? e.id, e.name ?? e.author, e.path ?? e.text]), [
    ['join', 'ide-1', 'planner', undefined],
    ['join', 'ide-2', 'planner-2', undefined],
    ['edited', 'ide-2', 'planner-2', 'src/x.ts'],
    ['join', 'far', '', undefined],
    ['message', 'ide-1', 'planner', 'x.ts is mine'],
    ['message', 'ide-1', 'planner', 'freeze'],
    ['message', 'ide-2', 'planner-2', 'freeze'],
    ['note', 1, 'an unverified local process', 'freeze'],
    ['leave', 'ide-2', 'planner-2', undefined],
  ])
  assert.equal(heard[4].from, 'session @planner-2')
  assert.equal(heard[4].repo, repo)
  assert.equal(await reg.repoOf('/wt/src'), repo, 'a worktree belongs to its repo')
  assert.deepEqual((await reg.peers('/wt')).map(s => s.name), ['planner'])
  assert.deepEqual((await reg.peers('/elsewhere')).map(s => s.name), [])

  // The answer that delivers messages carries them as data too, for the harness to show.
  const got = await reg.yap('idle', { session: 'ide-1', cwd: '/repo' })
  assert.deepEqual(got.messages!.map(m => [m.kind, m.origin, m.from, m.sender, m.text]), [['say', 'session', 'session @planner-2', 'ide-2', 'x.ts is mine'], ['note', 'local', 'an unverified local process', '', 'freeze']])
  assert.match(got.context!, /From session @planner-2: x\.ts is mine/)
  assert.equal((await reg.yap('idle', { session: 'ide-1', cwd: '/repo' })).messages, undefined, 'once')
  // An inbox saved as plain lines, before messages had a shape, still arrives.
  store.saveSession('old', JSON.stringify({ id: 'old', name: '', top: norm('/repo'), repo: norm('/repo/.git'), started: 1, at: 1_000_000, told: 0, files: [], warned: [], inbox: ['From the user: hi'], shell: 0, cwd: '/repo', news: 1 }))
  const old = await new Sessions(ws, store, () => 1_000_000).yap('idle', { session: 'old', cwd: '/repo' })
  assert.deepEqual([old.messages![0].text, /- From the user: hi/.test(old.context!)], ['From the user: hi', true])
}

// Acks, through the /yap handler: a session that acks keeps a message until it does. Unacked, it comes again with
// the same id once the resend window is past, a daemon restart in between included, three times at most; then
// `sessions` lists it as undelivered. A session that never acks gets each message once.
{
  const { store, ws } = rig([])
  let now = 1_000_000
  const as = (reg: Sessions, session = 'ack-1') => (verb: string, b: object = {}) => local(reg)(verb, { session, cwd: '/repo', ...b }) as Promise<any>
  const reg = new Sessions(ws, store, () => now)
  const verb = as(reg)
  await verb('join', { ack: 0 })
  await reg.say({ cwd: '/repo', to: 'ack-1', text: 'one' })
  await reg.say({ cwd: '/repo', to: 'ack-1', text: 'two' })
  const first = await verb('will-edit', { ack: 0 })
  assert.deepEqual(first.messages.map((m: any) => m.text), ['one', 'two'])
  assert.ok(first.messages[0].seq < first.messages[1].seq && first.seq === first.messages[1].seq, 'in order, seq rising')
  assert.equal((await verb('will-edit', { ack: 0 })).messages, undefined, 'not again while a parallel hook may still be printing it')
  now += 10_000
  const back = new Sessions(ws, store, () => now)
  const again = await as(back)('will-edit', { ack: 0 })
  assert.deepEqual(again.messages.map((m: any) => [m.id, m.seq]), first.messages.map((m: any) => [m.id, m.seq]), 'the restart lost nothing')
  now += 10_000
  assert.equal((await as(back)('turn', { ack: again.seq, prompt: 'go' })).messages, undefined, 'acked: gone')
  await back.say({ cwd: '/repo', to: 'ack-1', text: 'three' })
  const tries = []
  for (let i = 0; i < 4; i++, now += 10_000) tries.push((await as(back)('will-edit', { ack: again.seq })).messages?.length ?? 0)
  assert.deepEqual(tries, [1, 1, 1, 0])
  assert.deepEqual(back.list().find(s => s.id === 'ack-1')!.undelivered.map(m => m.text), ['three'])
  const v0 = as(back, 'v0-1')
  await v0('join')
  await back.say({ cwd: '/repo', to: 'v0-1', text: 'four' })
  assert.deepEqual((await v0('will-edit')).messages.map((m: any) => m.text), ['four'], 'no ack: delivered when sent')
  assert.equal((await v0('will-edit')).messages, undefined, 'once')
}

// Claims, through the /yap handler: an overlapping claim is held in every worktree of the repo, by path components;
// a peer is warned once before editing inside one; the holder's edits renew it; it ends on release, leave or lapse.
{
  const { store, ws } = rig([])
  let now = 1_000_000
  const reg = new Sessions(ws, store, () => now)
  const as = (session: string, cwd = '/repo') => (verb: string, b: object = {}) => local(reg)(verb, { session, cwd, ...b }) as Promise<any>
  const [A, B, C] = [as('aaaa1111'), as('bbbb2222'), as('cccc3333', '/wt')]
  await A('join', { name: 'auth' })
  await B('join', { name: 'api' })
  await C('join', { name: 'wt' })
  assert.equal((await B('will-edit', { path: 'src/auth/token.ts' })).context, undefined, 'nothing claimed yet')
  const { id } = await A('claim', { path: 'src/auth/', why: 'rewriting token refresh' })
  assert.match(id, /^[0-9a-f]{8}$/)
  const held = { held: { session: 'aaaa1111', name: 'auth', path: 'src/auth', why: 'rewriting token refresh' } }
  assert.deepEqual(await B('claim', { path: 'src/auth/token.ts', why: 'x' }), held)
  assert.deepEqual(await C('claim', { path: 'src', why: 'x' }), held, 'another worktree, and a directory above it')
  assert.ok((await B('claim', { path: 'src/author', why: 'names' })).id, 'src/author is not under src/auth')
  await assert.rejects(A('claim', { path: '../elsewhere', why: 'x' }), /inside the working tree/)
  await assert.rejects(local(reg)('claim', { cwd: '/repo', path: 'src', why: 'x' }), /made by a session/)
  const w = await B('will-edit', { path: 'src/auth/token.ts' })
  assert.match(w.context, /src\/auth\/token\.ts is inside another session's claim \(session @auth claimed src\/auth: rewriting token refresh\)/)
  assert.equal(w.notice, 'yap: src/auth/token.ts is inside the claim of @auth')
  assert.equal((await B('will-edit', { path: 'src/auth/other.ts' })).context, undefined, 'once a claim')
  assert.match((await C('will-edit', { path: 'src/auth/x.ts' })).context, /claimed src\/auth in another worktree/)
  assert.equal((await A('will-edit', { path: 'src/auth/token.ts' })).context, undefined, 'not about its own')
  assert.match((await as('dddd4444')('join')).context, /Claimed by another session[\s\S]*- src\/auth, by @auth: rewriting token refresh/)
  // An edit under it renews it; 20 minutes past the last one, it is gone.
  now += 15 * 60_000
  await A('edited', { path: 'src/auth/token.ts' })
  now += 15 * 60_000
  assert.deepEqual((await reg.claims('/wt')).map(c => c.path), ['src/auth'], "renewed; B's lapsed")
  now += 6 * 60_000
  assert.deepEqual(await reg.claims('/repo'), [])
  const two = await A('claim', { path: 'docs', why: 'spec' })
  assert.deepEqual(await A('release', { id: two.id }), {})
  await assert.rejects(B('release', { id: two.id }), /no claim/)
  await A('claim', { path: 'docs', why: 'spec' })
  await A('leave')
  assert.deepEqual(await reg.claims('/repo'), [], 'gone with its session')
}

// The harness client (sdk/local.ts) against the daemon's own /yap handler and event stream.
{
  const { store, ws } = rig([])
  const reg = new Sessions(ws, store, () => 1_000_000)
  const answer = local(reg)
  assert.deepEqual(((await answer('hello', {})) as any).extensions, ['board', 'claims', 'conflicts', 'spawn', 'doing', 'inbox'], 'v1: extensions by short name')
  const fetcher = async (url: string, init: RequestInit) => {
    if (url.includes('/yap/events'))
      return new Response((await events(reg, new URL(url).searchParams.get('cwd'))).pipeThrough(new TextEncoderStream()))
    try {
      return Response.json(await answer(url.split('/yap/')[1], JSON.parse(String(init.body))))
    } catch (e: any) {
      return Response.json({ error: e.message }, { status: e.status ?? 400 })
    }
  }
  const yap = new YapLocal('http://yap.test', 't', fetcher)
  const a = yap.session('k1', '/repo')
  const b = yap.session('k2', '/repo')
  const heard: any[] = []
  let open = () => {}
  const opened = new Promise<void>(r => (open = r))
  const stop = yap.watch('/repo', e => heard.push(e), { onOpen: () => open() })
  await opened
  assert.deepEqual(await a.join('Kodr Planner'), {}, 'alone in the repo: nothing to say')
  await b.join()
  await b.edited('src/a.ts')
  assert.match((await a.willEdit('src/a.ts')).notice!, /src\/a\.ts was just edited by @a/)
  assert.match((await a.willRun('git checkout main')).deny!, /another session is working in this same working tree/)
  await b.say('done with a.ts', 'kodr')
  await Bun.sleep(0)
  const msg = heard.find(e => e.type === 'message')
  assert.deepEqual([msg.session, wakePrompt(msg)], ['k1', 'yap: a message from session @a'])
  assert.deepEqual(await a.idle(true), {}, 'continuing: nothing, the message waits')
  assert.deepEqual((await a.idle()).messages!.map(m => m.text), ['done with a.ts'])
  assert.deepEqual((await yap.sessions('/repo')).map(s => s.name).sort(), ['a', 'kodr-planner'])
  await assert.rejects(yap.call('nope', {}), (e: any) => e instanceof LocalError && e.status === 400 && /no verb nope/.test(e.message))

  // `yap mcp`: a Codex session with no hooks joins as itself and asks yap_check itself.
  const cx = yap.session('mcp-1', '/repo')
  const call = async (name: string, args: object = {}) => ((await rpc(cx, true, { id: 1, method: 'tools/call', params: { name, arguments: args } }, '0')) as any).result
  const init: any = await rpc(cx, true, { id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'codex' } } }, '0')
  assert.match(init.result.instructions, /Call yap_check before editing[\s\S]*@a \(k2\)/)
  assert.doesNotMatch(init.result.instructions, /`yap (say|note)/, 'the tools, not the CLI')
  assert.equal(await rpc(cx, true, { method: 'notifications/initialized' }, '0'), undefined)
  assert.ok(((await rpc(cx, true, { id: 2, method: 'tools/list' }, '0')) as any).result.tools.some((t: any) => t.name === 'yap_check'))
  assert.match((await call('yap_check', { run: 'git stash' })).content[0].text, /^Don't run it\. yap: another session is working/)
  assert.doesNotMatch((await call('yap_check', { run: 'git stash' })).content[0].text, /`yap say/)
  assert.match((await call('yap_check', { edit: 'src/a.ts' })).content[0].text, /Another session is working on src\/a\.ts/)
  await call('yap_check', { edited: ['src/b.ts'] })
  assert.match((await b.willEdit('src/b.ts')).notice!, /by @codex/)
  assert.match((await call('yap_say', { to: '@a', text: 'hi' })).content[0].text, /^sent to @a$/)
  await b.say('b.ts is fine', 'codex')
  assert.match((await call('yap_check')).content[0].text, /b\.ts is fine/)
  assert.match((await call('yap_peers')).content[0].text, /@a in .*edited src\/a\.ts/)
  const claimed = (await call('yap_claim', { path: 'src/c', why: 'moving c' })).content[0].text
  assert.match(claimed, /^claimed as [0-9a-f]{8}/)
  assert.match((await b.claim('src/c/d.ts', 'x') as any).held.name, /^codex$/)
  assert.match((await call('yap_peers')).content[0].text, /yours:\n  claimed src\/c \([0-9a-f]{8}\): moving c/)
  assert.match((await call('yap_claim', { release: claimed.slice(11, 19) })).content[0].text, /^released/)
  assert.equal((await call('nope')).isError, true)

  // The MCP version: a supported one back, never an echo; 2026-07-28 has no handshake, so discover joins.
  const v1: any = await rpc(yap.session('mcp-0', '/repo'), false, { id: 0, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, '0')
  assert.equal(v1.result.protocolVersion, '2025-11-25')
  const zed = yap.session('mcp-2', '/repo')
  const _meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'zed' }, 'io.modelcontextprotocol/clientCapabilities': {} }
  const disc: any = await rpc(zed, true, { id: 0, method: 'server/discover', params: { _meta } }, '0')
  assert.equal(disc.result.resultType, 'complete')
  assert.ok(disc.result.supportedVersions.includes('2026-07-28'))
  assert.match(disc.result.instructions, /Call yap_check/)
  assert.ok((await yap.sessions('/repo')).some(s => s.id === 'mcp-2' && s.name === 'zed'), 'discover joined')
  assert.equal(((await rpc(zed, true, { id: 1, method: 'tools/list', params: { _meta } }, '0')) as any).result.ttlMs > 0, true)
  const bad: any = await rpc(zed, true, { id: 2, method: 'tools/list', params: { _meta: { ..._meta, 'io.modelcontextprotocol/protocolVersion': '2030-01-01' } } }, '0')
  assert.deepEqual([bad.error.code, bad.error.data.requested], [-32022, '2030-01-01'])
  await zed.leave()

  // A question to everyone: one id for every recipient, on the asker's row until a reply with re takes it off.
  const q = await b.say('which branch do we merge into?', undefined, { kind: 'question' })
  assert.deepEqual((await yap.sessions('/repo')).find(s => s.id === 'k2')!.unanswered!.map(u => [u.id, u.kind]), [[q.id, 'question']])
  const asked = (await a.idle()).messages!.find(m => m.kind === 'question')!
  assert.equal(asked.id, q.id)
  const viaMcp = (await call('yap_check')).content[0].text
  assert.match(viaMcp, new RegExp(`Question ${q.id.slice(0, 8)} from session @a: which branch[\\s\\S]*yap_say with re "${q.id.slice(0, 8)}"`))
  assert.match((await call('yap_say', { text: 'main', re: q.id.slice(0, 8) })).content[0].text, /^sent to @a$/, 'a reply goes to the asker')
  const reply = (await b.idle()).messages!.find(m => m.text === 'main')!
  assert.equal(reply.re, q.id)
  assert.deepEqual((await yap.sessions('/repo')).find(s => s.id === 'k2')!.unanswered, [])
  // An re that matches nothing is still delivered.
  await a.say('late answer', 'a', { re: 'deadbeef' })
  assert.equal((await b.idle()).messages!.find(m => m.text === 'late answer')!.re, 'deadbeef')
  // A blocker stays listed until the asker leaves.
  await a.say('I need the db schema first', 'a', { kind: 'blocker' })
  assert.equal((await yap.sessions('/repo')).find(s => s.id === 'k1')!.unanswered!.length, 1)
  assert.match((await call('yap_peers')).content[0].text, /unanswered blocker .* to @a: I need the db schema/)
  await a.leave()
  assert.equal((await yap.sessions('/repo')).find(s => s.id === 'k1'), undefined)
  stop()
}

// Codex's hooks: the same adapter. apply_patch names its files in the patch, and Stop carries on with a block.
{
  const { store, ws } = rig([])
  const reg = new Sessions(ws, store, () => 1_000_000)
  const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: src/new.ts\n+z\n*** End Patch'
  assert.deepEqual(patchFiles(patch), ['src/a.ts', 'src/new.ts'])
  await reg.hook('post', { session_id: 'claude-1', cwd: '/repo', tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } })
  const pre: any = await reg.hook('pre', { session_id: 'codex-1', cwd: '/repo', tool_name: 'apply_patch', tool_input: { command: patch }, codex: true })
  assert.match(pre.hookSpecificOutput.additionalContext, /Another session is working on src\/a\.ts/)
  await reg.hook('post', { session_id: 'codex-1', cwd: '/repo', tool_name: 'apply_patch', tool_input: { command: patch }, codex: true })
  assert.match(((await reg.hook('pre', { session_id: 'claude-1', cwd: '/repo', tool_name: 'Edit', tool_input: { file_path: 'src/new.ts' } })) as any).systemMessage, /src\/new\.ts was just edited by @a-2/)
  const deny: any = await reg.hook('pre', { session_id: 'codex-1', cwd: '/repo', tool_name: 'Bash', tool_input: { command: 'git stash' }, codex: true })
  assert.equal(deny.hookSpecificOutput.permissionDecision, 'deny')
  await reg.say({ from: 'claude-1', cwd: '/repo', text: 'leave a.ts to me', to: 'a-2' })
  assert.deepEqual(Object.keys(await reg.hook('stop', { session_id: 'codex-1', cwd: '/repo', codex: true })).sort(), ['decision', 'reason', 'systemMessage'])

  // A spawn runs on the agent asked for.
  const runs: any[] = []
  const spawner = new Sessions(ws, store, () => 1_000_000, undefined, { run: async o => (runs.push(o), { ok: true, text: 'done' }) })
  await local(spawner)('spawn', { cwd: '/repo', text: 'tidy', agent: 'codex' })
  await Bun.sleep(0)
  assert.equal(runs[0].agent, 'codex')
  assert.equal(spawner.spawns()[0].agent, 'codex')
}

// A session that gave a pid leaves when that process dies, even without a leave (Codex kills its MCP server).
{
  const { store, ws } = rig([])
  const dead = new Set<number>()
  const reg = new Sessions(ws, store, () => 1_000_000, undefined, undefined, undefined, pid => !dead.has(pid))
  const left: string[] = []
  reg.listen(e => e.type === 'leave' && left.push(e.session))
  await reg.yap('join', { session: 'mcp-x', cwd: '/repo', name: 'codex', pid: 41 })
  await reg.yap('join', { session: 'hook-y', cwd: '/repo' })
  assert.deepEqual((await reg.peers('/repo')).map(s => s.id).sort(), ['hook-y', 'mcp-x'])
  dead.add(41)
  assert.deepEqual((await reg.peers('/repo')).map(s => s.id), ['hook-y'])
  assert.deepEqual(left, ['mcp-x'])
}

// Chat from the web: a Claude session per thread, resumed every turn. Read-only in the project's own checkout;
// with edits, a worktree and branch of its own. One turn at a time, and Stop ends the one running.
{
  const { store, ws } = rig([])
  const worktrees: string[][] = []
  const cleaned: string[][] = []
  let made: () => void = () => {}
  // The worktree takes as long as the test says: a big repo's checkout outlasts the relay's wait.
  ws.worktree = (repo, dir, branch) => (worktrees.push([repo, dir, branch]), new Promise<void>(r => (made = r)))
  ws.cleanup = async (repo, dir, branch) => void cleaned.push([repo, dir, branch ?? ''])
  const runs: any[] = []
  let finish: (r: { ok: boolean; text: string }) => void = () => {}
  let tick = 0
  // A 'quiet' turn says nothing before it ends.
  const chats = new Chats({ run: o => (runs.push(o), o.prompt !== 'quiet' && (o.onActivity?.(`Read ${o.cwd}\\src\\a.ts`), o.onText?.('it reads a')), new Promise(r => {
    finish = r
    o.signal?.addEventListener('abort', () => r({ ok: false, text: 'killed' }))
  })) }, ws, '/home/.yap', () => ++tick)
  store.addProject({ name: 'app', path: '/repo', base: 'main', gate: '', workers: 1, running: true, tracker: null, hint: '' })
  const answer = remote(new Sessions(ws, store, () => 1), () => store.projects(), chats)
  const last = async (thread: string) => ((await answer('chat.read', { thread })) as any).events.at(-1)
  const started = (n: number) => until(async () => runs.length === n)
  assert.ok(((await answer('hello', {})) as any).extensions.includes('chat'))

  const { thread } = (await answer('chat', { project: 'app', text: 'what does a do?' })) as any
  await started(1)
  assert.equal(runs[0].cwd, '/repo')
  assert.equal(runs[0].readOnly, true, 'no edits unless asked')
  assert.equal(runs[0].chat.resume, false)
  await assert.rejects(answer('chat', { project: 'app', text: 'and b?', thread }), /still answering/)
  finish({ ok: true, text: 'it reads a' })
  await until(async () => !((await answer('chat.read', { thread })) as any).busy)
  const read: any = await answer('chat.read', { thread, after: 1 })
  assert.deepEqual(read.events.map((e: any) => [e.kind, e.text]), [['tool', 'Read src\\a.ts'], ['text', 'it reads a'], ['done', '']], 'what came after the question; paths read from the project root')
  assert.equal(read.events[0].at, ((await answer('chats', {})) as any[])[0].at - 2, 'one clock read per event')

  await answer('chat', { project: 'app', text: 'and b?', thread })
  await started(2)
  assert.equal(runs[1].chat.session, runs[0].chat.session)
  assert.equal(runs[1].chat.resume, true, 'the second turn resumes the same session')
  // A turn that spoke and then failed says it failed, not its last words again.
  finish({ ok: false, text: 'it reads a' })
  await until(async () => (await last(thread))?.kind === 'error')
  assert.equal((await last(thread)).text, 'the turn ended with an error')

  // Stopped before it said a word: the session exists all the same, so the next turn resumes it.
  const quiet: any = await answer('chat', { project: 'app', text: 'quiet' })
  await started(3)
  await answer('chat.stop', { thread: quiet.thread })
  await until(async () => (await last(quiet.thread))?.text === 'stopped')
  await answer('chat', { project: 'app', text: 'again', thread: quiet.thread })
  await started(4)
  assert.equal(runs[3].chat.resume, true, 'a silent first turn still made the session')
  finish({ ok: true, text: '' })

  // An edits thread answers before its worktree exists, and runs once it does.
  const edit: any = await answer('chat', { project: 'app', text: 'fix b', edits: true })
  const dir = join('/home/.yap', 'chats', 'app', edit.thread)
  assert.deepEqual(worktrees, [['/repo', dir, `yap/chat-${edit.thread}`]])
  await Bun.sleep(5)
  assert.equal(runs.length, 4, 'no run before the worktree is there')
  made()
  await started(5)
  assert.equal(runs[4].cwd, dir, 'edits run in the worktree, never the checkout')
  assert.equal(runs[4].readOnly, false)
  assert.deepEqual(((await answer('chats', { project: 'app' })) as any[]).map(c => c.title), ['fix b', 'quiet', 'what does a do?'])
  await assert.rejects(answer('chat', { project: 'nope', text: 'x' }), /no project nope/)

  // Dropping an edits thread stops it and takes its worktree and branch.
  await answer('chat.drop', { thread: edit.thread })
  assert.deepEqual(cleaned, [['/repo', dir, `yap/chat-${edit.thread}`]])
  await assert.rejects(answer('chat.read', { thread: edit.thread }), /no chat/)

  // A removed project's threads are gone from the web.
  store.removeProject(store.projects()[0].id)
  await assert.rejects(answer('chat.read', { thread }), /no project app/)
  assert.deepEqual(await answer('chats', {}), [])
}

// rooted: the project's root off a tool line, however Windows spells it; elsewhere case counts.
assert.equal(rooted('Read c:\\users\\x\\app\\src\\a.ts', 'C:/Users/X/app', true), 'Read src\\a.ts')
assert.equal(rooted('Read /repo/src/a.ts and /repo2/b', '/repo', false), 'Read src/a.ts and /repo2/b')
assert.equal(rooted('Read /Repo/src/a.ts', '/repo', false), 'Read /Repo/src/a.ts')

// The remote bridge: a web call names a registered project, never a path, and sees nothing outside them. The
// line answers what comes down it and comes back after a drop.
{
  const { store, ws } = rig([])
  const runs: any[] = []
  const reg = new Sessions(ws, store, () => 1_000_000, undefined, { run: async o => (runs.push(o), { ok: true, text: 'done' }) })
  store.addProject({ name: 'app', path: '/repo', base: 'main', gate: '', workers: 1, running: true, tracker: null, hint: '' })
  await reg.yap('edited', { session: 'aaaa1111', cwd: '/repo', path: 'src/auth.ts' })
  await reg.yap('edited', { session: 'bbbb2222', cwd: '/elsewhere', path: 'secret.ts' })
  const answer = remote(reg, () => store.projects())
  assert.deepEqual(((await answer('sessions', {})) as any[]).map(s => [s.project, s.name]), [['app', 'auth']], 'no session outside a project')
  await answer('spawn', { project: 'app', text: 'tidy the README' })
  assert.equal(runs[0].cwd, '/repo')
  await assert.rejects(answer('spawn', { project: 'nope', text: 'x', cwd: '/elsewhere' }), /no project nope; .* app/)
  await assert.rejects(answer('join', {}), /no remote verb join/)

  const sent: string[] = []
  const lines: any[] = []
  const later: (() => void)[] = []
  const bridge = new Bridge({ relay: 'https://relay.test', device: 'd1', secret: 's' }, answer, (url, secret) => {
    const l = { url, secret, send: (t: string) => sent.push(t), close() {}, onopen: null, onmessage: null, onclose: null } as any
    lines.push(l)
    return l
  }, fn => later.push(fn))
  assert.equal(lines[0].url, 'wss://relay.test/connect?device=d1')
  lines[0].onopen()
  await lines[0].onmessage({ data: JSON.stringify({ id: 'c1', verb: 'projects' }) })
  await lines[0].onmessage({ data: JSON.stringify({ id: 'c2', verb: 'notes', body: { project: 'nope' } }) })
  assert.deepEqual(sent.map(t => JSON.parse(t)), [{ id: 'c1', answer: [{ name: 'app', base: 'main' }] }, { id: 'c2', error: sent[1] && JSON.parse(sent[1]).error }])
  assert.match(JSON.parse(sent[1]).error, /no project nope/)
  lines[0].onclose()
  assert.equal(bridge.connected, false)
  later[0]()
  assert.equal(lines.length, 2, 'reconnected')
  bridge.stop()
}

// doing and the user's inbox: a session says what it is on, and peers and the web see it. Its question to the user
// waits in the inbox and on its own row, the web answers it with re, and the asker hears; a spawn the web started
// ends in the inbox. The inbox outlives a restart.
{
  const { store, ws } = rig([])
  let now = 1_000_000
  const reg = new Sessions(ws, store, () => now, undefined, { run: async o => (o.onActivity?.('Read README.md'), o.onActivity?.('Edit README.md'), { ok: true, text: 'tidied' }) })
  store.addProject({ name: 'app', path: '/repo', base: 'main', gate: '', workers: 1, running: true, tracker: null, hint: '' })
  const as = (session: string) => (verb: string, b: object = {}) => local(reg)(verb, { session, cwd: '/repo', ...b }) as Promise<any>
  const [A, B] = [as('aaaa1111'), as('bbbb2222')]
  await A('join', { name: 'auth' })
  await B('join', { name: 'api' })
  now += 1000
  assert.deepEqual(await A('doing', { text: 'rewriting token refresh\nand more' }), {})
  assert.match((await B('turn', { prompt: 'go on' })).context, /- @auth \(aaaa1111\), active just now, doing "rewriting token refresh": no edits yet/)
  assert.equal((await reg.peers('/repo')).find(s => s.name === 'auth')!.doing, 'rewriting token refresh')
  await assert.rejects(local(reg)('doing', { cwd: '/repo', text: 'x' }), /only a session/)

  const q = await A('say', { to: '@user', kind: 'question', text: 'drop the v0 hooks?' })
  assert.deepEqual([q.to, q.woke], [['@user'], []])
  assert.equal((await B('will-edit', { path: 'x.ts' })).messages, undefined, 'not for a peer')
  assert.deepEqual((await reg.peers('/repo')).find(s => s.name === 'auth')!.unanswered!.map(u => u.to), [['the user']])
  const web = remote(reg, () => store.projects())
  const [m, ...none] = (await web('inbox', {})) as any[]
  assert.deepEqual([m.project, m.kind, m.from, m.sender, m.text, none], ['app', 'question', 'session @auth', 'aaaa1111', 'drop the v0 hooks?', []])
  assert.deepEqual(await local(reg)('inbox', { cwd: '/repo', since: 0 }).then((l: any) => l.map((x: any) => x.id)), [q.id])
  assert.deepEqual(await web('inbox', { since: m.seq }), [])
  const auth = ((await web('sessions', {})) as any[]).find(s => s.name === 'auth')
  assert.deepEqual([auth.doing, auth.unanswered], ['rewriting token refresh', [{ id: q.id.slice(0, 8), kind: 'question', text: 'drop the v0 hooks?' }]])

  await web('say', { project: 'app', text: 'yes, drop them', re: q.id.slice(0, 8) })
  assert.match((await A('will-edit', { path: 'y.ts' })).context, new RegExp(`From the user, answering ${q.id.slice(0, 8)}: yes, drop them`))
  assert.equal((await B('will-edit', { path: 'y.ts' })).messages, undefined, 'the answer goes to the asker only')
  assert.deepEqual((await reg.peers('/repo')).find(s => s.name === 'auth')!.unanswered, [])
  await assert.rejects(web('say', { project: 'app', to: 'user', text: 'x' }), /you are the user/)
  assert.match((await as('cccc3333')('join', { name: 'user' })).context, /You are session @user-2\./, '`user` is taken')

  const { id: sp } = (await web('spawn', { project: 'app', text: 'tidy the README' })) as any
  await new Promise(r => setImmediate(r))
  const end = ((await web('inbox', { since: m.seq })) as any[])[0]
  assert.deepEqual([end.kind, end.ok, end.text], ['spawn', true, 'tidied'])
  // Its log: each tool call a line, numbered; the list counts them, one spawn brings the ones after `since`.
  const [listed] = (await web('spawns', {})) as any[]
  assert.deepEqual([listed.steps, 'log' in listed], [2, false])
  const [one] = (await web('spawns', { id: sp, since: 1 })) as any[]
  assert.deepEqual(one.log.map((l: any) => [l.n, l.line]), [[2, 'Edit README.md']])
  assert.deepEqual(((await local(reg)('spawns', { cwd: '/repo', id: sp })) as any[])[0].log.length, 2)
  assert.deepEqual(new Sessions(ws, store, () => now).inbox().map(x => x.kind), ['question', 'spawn'], 'kept across a restart')
}

// The web client: claims once, keeps what it needs as JSON, waits for a spawn, and turns refusals into YapError.
{
  const calls: [string, any, string][] = []
  let polls = 0
  const relay: typeof fetch = (async (url: string, init: any) => {
    const body = JSON.parse(init.body)
    calls.push([url, body, init.headers.authorization ?? ''])
    const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200 })
    if (url.endsWith('/claim')) return ok({ token: 't0k' })
    if (url.endsWith('/spawn')) return ok({ id: 'ab12cd34' })
    if (url.endsWith('/chat')) return ok({ thread: 'th1' })
    if (url.endsWith('/spawns'))
      return ++polls === 1
        ? new Response(JSON.stringify({ error: 'the machine is offline' }), { status: 503 })
        : ok([{ id: body.id, done: polls >= 3 ? 5 : undefined, ok: true, result: 'did it', log: [{ n: 1, line: 'Read a.ts' }, { n: polls, line: `step ${polls}` }].filter(l => l.n > body.since) }])
    return new Response(JSON.stringify({ error: 'no project nope' }), { status: 400 })
  }) as any
  const yap = await Yap.claim('https://relay.test/', 'dev1.c0de', relay)
  assert.deepEqual(calls[0], ['https://relay.test/claim', { device: 'dev1', code: 'c0de' }, ''])
  const again = Yap.from(JSON.parse(JSON.stringify(yap)), relay)
  const { id } = await again.spawn('app', 'tidy')
  assert.deepEqual(calls[1], ['https://relay.test/d/dev1/spawn', { project: 'app', text: 'tidy' }, 'Bearer t0k'])
  const lines: string[] = []
  assert.equal((await again.wait(id, { every: 0, onLine: l => lines.push(l) })).result, 'did it')
  assert.deepEqual(lines, ['Read a.ts', 'step 2', 'step 3'], 'each line once, in order')
  assert.equal(polls, 3, 'rode out a 503')
  await assert.rejects(again.notes('nope'), (e: any) => e instanceof YapError && e.status === 400 && /no project nope/.test(e.message))
  assert.deepEqual(await again.chat('app', 'why?', { edits: true }), { thread: 'th1' })
  assert.deepEqual(calls.at(-1)!.slice(0, 2), ['https://relay.test/d/dev1/chat', { project: 'app', text: 'why?', edits: true }], 'chat goes out as the chat verb')
}

// YAP without the hooks: plain verbs, plain answers.
{
  const { store, ws } = rig([])
  const reg = new Sessions(ws, store, () => 1_000_000)
  await reg.yap('edited', { session: 'aaaa1111', cwd: '/repo', path: 'src/auth.ts' })
  await reg.yap('join', { session: 'bbbb2222', cwd: '/repo' })
  const a = await reg.yap('will-edit', { session: 'bbbb2222', cwd: '/repo', path: 'src/auth.ts' })
  assert.equal(a.notice, 'yap: src/auth.ts was just edited by @auth')
  assert.match(a.context!, /session @auth edited it just now/)
  assert.match((await reg.yap('will-run', { session: 'bbbb2222', cwd: '/repo', command: 'git stash' })).deny!, /session @auth, editing src\/auth\.ts/)
  // A message that came in while it worked is read before its turn ends, once a turn.
  await reg.say({ from: 'bbbb2222', cwd: '/repo', to: '@auth', text: 'wait for me' })
  assert.deepEqual(await reg.yap('idle', { session: 'aaaa1111', cwd: '/repo', continuing: true }), {})
  const idle = await reg.hook('stop', { session_id: 'aaaa1111', cwd: '/repo' }) as any
  assert.equal(idle.hookSpecificOutput.hookEventName, 'Stop')
  assert.match(idle.hookSpecificOutput.additionalContext, /From session @bbbb2222: wait for me/)
  assert.deepEqual(await reg.hook('stop', { session_id: 'aaaa1111', cwd: '/repo' }), {}, 'nothing left')
  await reg.yap('leave', { session: 'aaaa1111' })
  assert.deepEqual(await reg.yap('will-run', { session: 'bbbb2222', cwd: '/repo', command: 'git stash' }), {})
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
  await reg.hook('post', { session_id: 'aaaa1111', cwd: '/repo', tool_input: { file_path: 'src/auth.ts' } })
  assert.match(ctx(await reg.hook('start', { session_id: 'bbbb2222', cwd: '/repo' })), /You are session @bbbb2222.*yap say/s)
  assert.deepEqual((({ id, ...r }) => r)(await reg.say({ from: 'bbbb2222', cwd: '/repo', to: '@aaaa', text: 'leave auth.ts to me' })), { to: ['@auth'], woke: [] })
  assert.match(ctx(await bash('aaaa1111', 'ls')), /From session @bbbb2222: leave auth\.ts to me/)
  // Named from the first file it edits, addressed by it; a prompt names nothing, a generic file takes its directory.
  await reg.hook('prompt', { session_id: 'eeee5555', cwd: '/repo', prompt: 'fix the login redirect' })
  assert.equal(reg.list().find(s => s.id === 'eeee5555')!.name, '')
  await reg.hook('post', { session_id: 'eeee5555', cwd: '/repo', tool_input: { file_path: '/repo/src/api/index.ts' } })
  assert.equal(reg.list().find(s => s.id === 'eeee5555')!.name, 'api-index')
  await reg.hook('end', { session_id: 'eeee5555' })
  assert.deepEqual((await reg.say({ from: 'bbbb2222', cwd: '/repo', to: '@au', text: 'ok' })).to, ['@auth'])
  await bash('aaaa1111', 'ls')
  // An edit outside the working tree (a scratchpad) is nobody's conflict.
  await reg.hook('post', { session_id: 'aaaa1111', cwd: '/repo', tool_input: { file_path: '/tmp/scratch/notes.md' } })
  assert.deepEqual(await bash('aaaa1111', 'ls'), {}, 'delivered once')
  await assert.rejects(reg.say({ from: 'bbbb2222', cwd: '/repo', to: 'zzzz', text: 'hi' }), /no live session @zzzz/)
  // A named session in another repo is reachable; everyone still means this repo.
  await reg.hook('start', { session_id: 'ffff6666', cwd: '/other' })
  assert.deepEqual((await reg.say({ from: 'bbbb2222', cwd: '/repo', to: 'ffff', text: 'from kodr' })).to, ['@ffff6666'])
  assert.match(ctx(await reg.hook('prompt', { session_id: 'ffff6666', cwd: '/other', prompt: 'go' })), /from kodr/)
  await reg.hook('end', { session_id: 'ffff6666' })
  await reg.say({ cwd: '/repo', text: 'stop and commit' })
  assert.match(ctx(await reg.hook('prompt', { session_id: 'bbbb2222', cwd: '/repo', prompt: 'go' })), /From an unverified local process: stop and commit\n.*can approve a permission prompt/, 'no session is not the user')

  // aaaa's shell command rewrites a file: only what changed since the command started is its edit.
  dirty.push({ path: '/repo/old.ts', mtime: now - 60_000 })
  await bash('aaaa1111', "sed -i s/a/b/ src/auth.ts")
  now += 5_000
  dirty.push({ path: '/repo/src/auth.ts', mtime: now })
  await bash('aaaa1111', "sed -i s/a/b/ src/auth.ts", 'post')
  assert.deepEqual(reg.list().find(s => s.id === 'aaaa1111')!.files, ['src/auth.ts'])

  const held: any = await bash('bbbb2222', 'git stash && git checkout main')
  assert.equal(held.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(held.hookSpecificOutput.permissionDecisionReason, /session @auth.*src\/auth\.ts/)
  assert.deepEqual(await bash('bbbb2222', 'git status && git diff'), {}, 'reading git is fine')
  assert.equal(((await bash('aaaa1111', 'git reset --hard')) as any).hookSpecificOutput, undefined, 'bbbb edited nothing')
}

// A message wakes a session idle in a pane: the wake prompt is one plain line, the message and the instructions
// come as context, and it doesn't name the session. A daemon restart in between loses nothing.
{
  const { store, ws } = rig([])
  const prompts: string[] = []
  const reg = new Sessions(ws, store, () => 1_000_000, { wake: async (s, text) => (prompts.push(text), s.id === 'aaaa1111') })
  const ctx = (r: any) => r.hookSpecificOutput?.additionalContext ?? ''
  await reg.hook('post', { session_id: 'aaaa1111', cwd: '/repo', tool_input: { file_path: 'src/auth.ts' } })
  await reg.hook('start', { session_id: 'bbbb2222', cwd: '/repo' })
  assert.deepEqual((({ id, ...r }) => r)(await reg.say({ cwd: '/repo', text: 'pull before you push', user: true })), { to: ['@auth', '@bbbb2222'], woke: ['@auth'] })
  assert.equal(prompts[0], 'yap: a message from the user')
  const after = new Sessions(ws, store, () => 1_000_000)
  assert.deepEqual(after.list().map(s => s.id).sort(), ['aaaa1111', 'bbbb2222'], 'the restart kept them')
  assert.match(ctx(await after.hook('prompt', { session_id: 'aaaa1111', cwd: '/repo', prompt: prompts[0] })), /woken by yap[\s\S]*From the user: pull before you push/)
  await after.hook('prompt', { session_id: 'bbbb2222', cwd: '/repo', prompt: prompts[1] })
  assert.equal(after.list().find(s => s.id === 'bbbb2222')!.name, '', "a wake prompt doesn't name a session")
  await after.hook('end', { session_id: 'bbbb2222' })
  assert.deepEqual(new Sessions(ws, store, () => 1_000_000).list().map(s => s.id), ['aaaa1111'], 'an ended session stays gone')
}

// A crew agent or a gate gets the machine's basics, not the ids and tokens of whatever started the daemon.
{
  const env = childEnv({ Path: 'p', USERPROFILE: 'u', CLAUDE_CODE_SESSION_ID: 's', HERDR_SOCKET_PATH: 'h', GH_TOKEN: 't', YAP_PASS: 'database_url', DATABASE_URL: 'd' })
  assert.deepEqual(env, { Path: 'p', USERPROFILE: 'u', DATABASE_URL: 'd' })
}

// The board: a note outlives its author and greets the next session, live sessions hear of it at once, and it
// comes down by id.
{
  const { store, ws } = rig([])
  const reg = new Sessions(ws, store, () => 1_000_000)
  const ctx = (r: any) => r.hookSpecificOutput?.additionalContext ?? ''
  await reg.hook('post', { session_id: 'aaaa1111', cwd: '/repo', tool_input: { file_path: 'src/auth.ts' } })
  await reg.hook('start', { session_id: 'bbbb2222', cwd: '/repo' })
  const n = await reg.note({ from: 'aaaa1111', cwd: '/repo', text: 'I own src/auth until tonight' })
  assert.match(ctx(await reg.hook('pre', { session_id: 'bbbb2222', cwd: '/repo', tool_name: 'Bash', tool_input: { command: 'ls' } })), /New note on the board, #1 from session @auth: I own src\/auth/)
  await reg.hook('end', { session_id: 'aaaa1111' })
  assert.match(ctx(await reg.hook('start', { session_id: 'cccc3333', cwd: '/wt' })), /yap board[\s\S]*#1 just now, session @auth: I own src\/auth/, 'a worktree shares the board')
  await assert.rejects(reg.unnote('/repo', 99), /no note #99/)
  // Four days on, it is marked as maybe no longer true.
  const later = new Sessions(ws, store, () => 1_000_000 + 4 * 24 * 60 * 60_000)
  assert.match(ctx(await later.hook('start', { session_id: 'dddd4444', cwd: '/repo' })), /#1 4d ago, may be stale[\s\S]*over a day old/)
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

// A Kodr thread's chips: a file another session edited in the same tree warns, another worktree's doesn't, and a
// message shows on its recipient until it goes stale.
{
  const peer = (id: string, top: string, files: string[]) => ({ id, name: id, top, repo: 'r', started: 0, at: 0, files })
  const me = peer('me', '/a', ['src/auth.ts', 'x.ts'])
  const all = [me, peer('bob', '/a', ['src/auth.ts']), peer('wt', '/b', ['x.ts'])]
  const msg = { kind: 'say' as const, from: 'session @bob', sender: 'bob', text: 'leave auth to me', at: 0 }
  const chips = threadChips(me, all, msg, 1)
  assert.deepEqual(chips.map(c => [c.text, c.tone]), [['@me +2', 'info'], ['shared: auth.ts', 'warn'], ['msg from @bob', 'info']])
  assert.match(chips[1].title, /src\/auth\.ts \(@bob\)/)
  assert.equal(chips[2].title, 'leave auth to me')
  assert.equal(threadChips(me, all, msg, MAIL_MS).length, 2, 'the message went stale')
  const clashed = threadChips({ ...me, conflicts: [{ with: 'wt', files: ['x.ts'] }] }, all, undefined, 1).at(-1)!
  assert.deepEqual([clashed.text, clashed.tone], ['conflicts with @wt', 'error'])
}

// Two worktrees whose uncommitted work would conflict hear it when a turn ends, from real git, and hear it clear;
// neither real index moves.
{
  const store = new SqliteStore(new Database(':memory:'))
  const ws = new LocalWorkspace()
  const dir = mkdtempSync(join(tmpdir(), 'yap-merge-'))
  const [a, b] = [join(dir, 'a'), join(dir, 'b')]
  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout.toString()
  }
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', a])
  writeFileSync(join(a, 'notes.md'), 'one')
  git(a, 'add', '-A')
  git(a, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base')
  git(a, 'worktree', 'add', '-q', '-b', 'b', b)
  writeFileSync(join(a, 'notes.md'), 'two')
  writeFileSync(join(b, 'notes.md'), 'three')
  writeFileSync(join(b, 'new.md'), 'untracked')
  const status = git(b, 'status', '--porcelain')

  const reg = new Sessions(ws, store, () => 1_000_000)
  const ctx = (r: any) => r.hookSpecificOutput?.additionalContext ?? ''
  await reg.hook('stop', { session_id: 'aaaa1111', cwd: a })
  await reg.hook('stop', { session_id: 'bbbb2222', cwd: b })
  await reg.settled()
  assert.deepEqual(reg.list().find(s => s.id === 'aaaa1111')!.conflicts, [{ with: 'bbbb2222', files: ['notes.md'] }])
  assert.match(ctx(await reg.hook('prompt', { session_id: 'aaaa1111', cwd: a, prompt: 'go' })), /session @bbbb2222's, in another worktree, would conflict if merged, in notes\.md/)
  assert.equal(git(b, 'status', '--porcelain'), status, "the real index didn't move")

  writeFileSync(join(b, 'notes.md'), 'two')
  await reg.hook('stop', { session_id: 'bbbb2222', cwd: b })
  await reg.settled()
  assert.deepEqual(reg.list().find(s => s.id === 'aaaa1111')!.conflicts, [])
  assert.match(ctx(await reg.hook('prompt', { session_id: 'aaaa1111', cwd: a, prompt: 'go' })), /merge cleanly again/)
  rmSync(dir, { recursive: true, force: true })
}

// Git Bash's /c/... is drive C on Windows, not a folder `c` on the current drive.
if (process.platform === 'win32') {
  assert.equal(norm('/c/Users/Me/repo'), 'c:/users/me/repo')
  assert.equal(norm('/c/Users/Me/repo', 'src/a.ts'), norm('C:\\Users\\Me\\repo\\src\\a.ts'))
  assert.equal(norm('/tmp/x'), norm(resolve('/tmp/x')), 'only a one-letter first segment is a drive')
}

console.log('crew ok')
