// bun src/crew.check.ts — the loop against fakes: no git, no model.
import { Database } from 'bun:sqlite'
import assert from 'node:assert/strict'
import { Crew, ROUNDS } from './crew'
import type { AgentRunner, Workspace } from './ports'
import { SqliteStore } from './store'

const ok = { ok: true, log: '' }

function rig(reviews: boolean[], gateOk = true) {
  const store = new SqliteStore(new Database(':memory:'))
  const merged: string[] = []
  const ws: Workspace = {
    branch: async () => 'main',
    worktree: async () => {},
    mergeBase: async () => true,
    commitAll: async () => ok,
    diff: async () => 'diff --git a/x b/x',
    discard: async () => {},
    squash: async (_r, _s, _b, _br, message) => {
      merged.push(message)
      return { ...ok, sha: 'abc123' }
    },
    exec: async () => ({ ok: gateOk, log: gateOk ? '' : '1 test failed' }),
    advance: async () => ok,
    cleanup: async () => {},
  }
  const prompts: string[] = []
  const agent: AgentRunner = {
    async run({ prompt, schema }) {
      prompts.push(prompt)
      if (!schema) return { ok: true, text: 'did the thing' }
      const pass = reviews.shift() ?? false
      return { ok: true, text: '', data: { criteria: [{ criterion: 'a', pass: true, reason: 'fine' }, { criterion: 'b', pass, reason: 'no cap' }] } }
    },
  }
  const crew = new Crew(store, ws, agent, '/tmp/kumi')
  return { store, crew, merged, prompts }
}

async function settle(store: SqliteStore, id: number) {
  for (let i = 0; i < 200; i++) {
    const t = store.tickets().find(t => t.id === id)!
    if (t.status === 'merged' || t.status === 'escalated') return t
    await Bun.sleep(5)
  }
  throw new Error('ticket never settled')
}

// Sent back once, then approved: merges on round 2 with the receipt in the commit.
{
  const { store, crew, merged, prompts } = rig([false, true])
  const p = await crew.addProject('.', 'bun test')
  const t = await settle(store, crew.addTicket(p.id, { title: 'cap retries', criteria: ['a', 'b'] }).id)
  assert.equal(t.status, 'merged')
  assert.equal(t.round, 2)
  assert.match(merged[0], /Rounds: 2\nReviewed-by: kumi reviewer/)
  assert.match(prompts[2], /Round 2[\s\S]*b: no cap/, 'findings reach the author')
  assert.deepEqual(store.events({ ticket_id: t.id }).map(e => e.kind).reverse(), ['claim', 'submit', 'verdict', 'claim', 'submit', 'verdict', 'merge'])
}

// Never approved: escalates after ROUNDS, nothing merges, and a human override goes straight to the gate.
{
  const { store, crew, merged } = rig([])
  const p = await crew.addProject('.')
  const id = crew.addTicket(p.id, { title: 'x', criteria: ['a', 'b'] }).id
  const t = await settle(store, id)
  assert.equal(t.status, 'escalated')
  assert.equal(t.round, ROUNDS)
  assert.equal(merged.length, 0)
  await crew.act(id, 'approve')
  assert.equal((await settle(store, id)).status, 'merged')
  assert.match(merged[0], /Reviewed-by: human override/)
}

// Approved but the gate fails on the merged result: main never moves, the log goes back to the author.
{
  const { store, crew } = rig([true, true, true, true], false)
  const p = await crew.addProject('.', 'bun test')
  const t = await settle(store, crew.addTicket(p.id, { title: 'x', criteria: ['a', 'b'] }).id)
  assert.equal(t.status, 'escalated')
  assert.equal(t.sha, null)
  assert.match(t.findings[0], /1 test failed/)
}

// A dependent ticket waits for its dep.
{
  const { store, crew } = rig([true, true])
  const p = await crew.addProject('.')
  store.patchProject(p.id, { running: false })
  const a = crew.addTicket(p.id, { title: 'a', criteria: ['a', 'b'] }).id
  const b = crew.addTicket(p.id, { title: 'b', criteria: ['a', 'b'], deps: [a] }).id
  store.patchProject(p.id, { workers: 2, running: true })
  crew.kick()
  assert.equal(store.tickets().find(t => t.id === b)!.status, 'todo')
  await settle(store, a)
  assert.equal((await settle(store, b)).status, 'merged')
}

console.log('crew ok')
