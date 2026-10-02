// bun src/crew.check.ts — the loop against fakes: no git, no model, no network.
import { Database } from 'bun:sqlite'
import assert from 'node:assert/strict'
import { Crew, ROUNDS } from './crew'
import type { AgentRunner, Tracker, Workspace } from './ports'
import { SqliteStore } from './store'

const ok = { ok: true, log: '' }
const TWO = { tickets: [{ title: 'first', body: '', criteria: ['a', 'b'], deps: [] }, { title: 'second', body: '', criteria: ['a', 'b'], deps: [0] }] }

function rig(reviews: boolean[], o: { gateOk?: boolean; plan?: object } = {}) {
  const store = new SqliteStore(new Database(':memory:'))
  const merged: string[] = []
  const ws: Workspace = {
    root: async dir => dir,
    branch: async () => 'main',
    slug: async () => 'acme/toy',
    gateHint: () => '',
    worktree: async () => {},
    mergeBase: async () => true,
    commitAll: async () => ok,
    diff: async () => 'diff --git a/x b/x',
    discard: async () => {},
    squash: async (_r, _s, _b, _br, message) => {
      merged.push(message)
      return { ...ok, sha: 'abc123' }
    },
    exec: async () => ({ ok: o.gateOk ?? true, log: o.gateOk === false ? '1 test failed' : '' }),
    advance: async () => ok,
    cleanup: async () => {},
  }
  const prompts: string[] = []
  const agent: AgentRunner = {
    async run({ prompt, schema }) {
      prompts.push(prompt)
      if (prompt.startsWith('Break this goal')) return { ok: true, text: '', data: o.plan ?? TWO }
      if (!schema) return { ok: true, text: 'did the thing' }
      const pass = reviews.shift() ?? false
      return { ok: true, text: '', data: { criteria: [{ criterion: 'a', pass: true, reason: 'fine' }, { criterion: 'b', pass, reason: 'no cap' }] } }
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
  return { store, crew, merged, prompts, told }
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
  assert.deepEqual(told, ['file make retries sane', 'claim 9', 'comment 9 kumi: t1 "first" needs a human.', 'move 9 blocked'])
}

console.log('crew ok')
