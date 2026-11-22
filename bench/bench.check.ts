// The bench's scoring rules, run: what goes into a row and what the report says from it.
import assert from 'node:assert/strict'
import { dropTests, INIT, initCheck, linesAdded, median, plugins, report, tally, testFuncs, type Row } from './run'

assert.equal(median([3, 1, 2]), 2)
assert.equal(median([4, 1, 2, 3]), 2.5)
assert.ok(Number.isNaN(median([])))

// The agents' own test files go; the hidden tests are applied over the code alone.
const patch = 'diff --git a/mux.go b/mux.go\n+code\ndiff --git a/mux_test.go b/mux_test.go\n+test\ndiff --git a/testdata/x b/testdata/x\n+keep\n'
assert.equal(dropTests(patch), 'diff --git a/mux.go b/mux.go\n+code\ndiff --git a/testdata/x b/testdata/x\n+keep\n')
assert.deepEqual(testFuncs('+func TestA(t *testing.T) {}\n+func TestB_c(t) {}\n+func TestA(t) {}\n+func helper() {}'), ['TestA', 'TestB_c'])

// Cost and tokens add up over every agent; destructive git, stale edits, asks and failed ends are counted.
const bash = (command: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } })
const t = tally([
  { type: 'bench_argv' },
  { type: 'system', subtype: 'init', apiKeySource: 'none' },
  bash('git stash'),
  bash('git stash list'),
  bash('git checkout -- mux.go'),
  bash('git checkout -b feature'),
  bash('git reset --hard HEAD'),
  bash("yap say --question '@user' which one?"),
  { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'File has been modified since read, either by the user or by a linter.' }] } },
  { type: 'result', subtype: 'success', total_cost_usd: 1.25, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 } },
  { type: 'bench_argv' },
  { type: 'result', subtype: 'error_max_turns', is_error: true, total_cost_usd: 0.75, usage: { input_tokens: 1 }, result: '' },
])
assert.equal(t.agents, 2)
assert.equal(t.cost, 2)
assert.deepEqual([t.input, t.output, t.cache_read, t.cache_creation], [11, 20, 30, 40])
assert.equal(t.destructive, 3, 'stash, checkout --, reset --hard; not stash list or checkout -b')
assert.equal(t.stale, 1)
assert.equal(t.asked, 1)
assert.equal(t.failed.length, 1)
assert.deepEqual([...t.sources], ['none'])
assert.equal(t.limited, false)
assert.equal(tally([{ type: 'result', is_error: true, result: "You've hit your usage limit · resets 3am" }]).limited, true)

// One process can end several turns (a subagent's notice wakes it): each result carries the running total, so
// only an agent's last one counts, and its modelUsage (subagents included) gives the tokens.
const turns = tally([
  { type: 'bench_argv' },
  { type: 'result', subtype: 'success', total_cost_usd: 0.5, usage: { input_tokens: 5 } },
  { type: 'result', subtype: 'success', total_cost_usd: 0.53, usage: { input_tokens: 1 }, modelUsage: { 'claude-sonnet-5-5': { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 } } },
  { type: 'bench_argv' },
  { type: 'result', subtype: 'error_during_execution', is_error: true, total_cost_usd: 0.1, usage: { input_tokens: 7 } },
  { type: 'result', subtype: 'success', total_cost_usd: 0.2, usage: { input_tokens: 9 } },
])
assert.equal(Math.round(turns.cost * 100), 73)
assert.deepEqual([turns.input, turns.output, turns.cache_read, turns.cache_creation], [10, 2, 3, 4])
assert.equal(turns.failed.length, 0, 'an agent that went on to succeed did not fail')

// Clean agents: each agent's init line lists exactly its lane's plugins (INIT): nothing in A2, yap in D2, yap for D3's
// commander and ponytail and yap for its workers. Claude Code's built-ins don't count, and an agent that never logged
// an init line fails the check.
const builtin = { name: 'cc-plugin-telemetry', source: 'cc-plugin-telemetry@builtin' }
const init = (...ps: object[]) => ({ type: 'system', subtype: 'init', plugins: [...ps, builtin] })
const yapP = { name: 'yap', source: 'yap@inline' }
const found = plugins([{ type: 'bench_argv' }, init(yapP), { type: 'bench_argv' }, init(), { type: 'bench_argv' }, init({ name: 'ponytail', source: 'ponytail@ponytail' })])
assert.deepEqual(found, [['yap'], [], ['ponytail']])
assert.equal(initCheck([['yap'], ['yap']], INIT.D2), '')
assert.equal(initCheck([[], []], INIT.A2), '')
assert.match(initCheck([['yap'], []], INIT.D2), /agent 2 loaded \[\], want \[yap\]/)
assert.match(initCheck([['yap']], INIT.A2), /agent 1 loaded \[yap\], want \[\]/)
assert.match(initCheck(plugins([{ type: 'bench_argv' }, init(), { type: 'bench_argv' }]), INIT.A2), /agent 2 logged no init line/)
assert.match(initCheck([], INIT.A2), /no agent ran/)
assert.equal(initCheck([['yap'], ['ponytail', 'yap'], ['ponytail', 'yap']], INIT.D3), '', "D3: the commander yap alone, each worker ponytail and yap")
assert.match(initCheck([['yap'], ['yap'], ['ponytail', 'yap']], INIT.D3), /agent 2 loaded \[yap\], want \[ponytail,yap\]/, 'a D3 worker without ponytail fails')
assert.match(initCheck([['ponytail', 'yap'], ['ponytail', 'yap']], INIT.D3), /agent 1 loaded \[ponytail, yap\], want \[yap\]/, 'a D3 commander with ponytail fails')

// Lines added: a patch's + lines, not its +++ headers or - lines.
assert.equal(linesAdded('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n-old\n+new\n+more\n ctx\n'), 2)

// The report names, for each setup, the columns it lost on and why its runs failed; a setup with no runs says so.
const row = (setup: Row['setup'], pass: boolean, cost: number, extra: Partial<Row> = {}): Row => ({
  date: 'd', run: `${setup}${cost}`, task: '26', pair: [1, 2], repeat: 1, setup, pass, f1: pass, f2: pass, total_cost_usd: cost, tokens: 100,
  tokens_detail: { input: 0, output: 0, cache_read: 0, cache_creation: 0 }, lines_added: 10, wall_s: 600, collisions: 0,
  collisions_detail: { merge_conflict_files: 0, destructive_git: 0, stale_edits: 0 }, interventions: 0, interventions_detail: [],
  agents: 1, api_key_sources: ['none'], plugins: [[]], daemon: { home: 'h', port: 4400 }, ...extra,
})
const md = report(
  [row('A2', true, 1), row('A2', true, 2), row('D2', false, 1, { collisions: 1, collisions_detail: { merge_conflict_files: 1, destructive_git: 0, stale_edits: 0 } }), row('D3', false, 3, { error: 'boom' })],
  'd',
)
assert.match(md, /\| A2: .* \| 2 \| 100% \| \$1\.50 \| 100 \| 600s \| 10 \|/, 'the median row, lines added included')
assert.match(md, /\*\*A2\*\* .*lost on cost \(\$1\.50 median against D2's \$1\.00\)/)
assert.match(md, /\*\*D2\*\* .*lost on pass rate \(0% against A2's 100%\).*collisions.*1 on a merge conflict/)
assert.match(md, /\*\*D3\*\* .*1 that could not run \(boom\)/)
assert.match(report([row('A2', true, 1)], 'd'), /\*\*D3\*\* .*has no runs/)
assert.doesNotMatch(md, /\*\*[A-D]\*\* /, 'v3 has none of v2\'s setups')
assert.doesNotMatch(md, /Where the time went/, 'no split given, no timing section')
assert.doesNotMatch(md, /## Against v2|## Plan, work, tail/, 'no v2 rows or phases given, no sections for them')
assert.match(report([row('A2', true, 1)], 'd-v3', 'setup  runs  wall\nA2  1  60.0'), /## Where the time went[\s\S]*trace\.ts --setups d-v3[\s\S]*A2 {2}1 {2}60\.0/)
assert.match(report([row('A2', true, 1)], 'd-v3', '', { phases: 'setup  plan\nA2  12.0' }), /## Plan, work, tail[\s\S]*trace\.ts --phases d-v3[\s\S]*A2 {2}12\.0/)

// Against v2: v2's A and D next to v3's setups, then each change as a row of differences.
const v2 = [row('A2', true, 1, { wall_s: 100 }), row('A2', false, 1, { wall_s: 120 })].map(r => ({ ...r, setup: 'A' })).concat([{ ...row('D2', true, 0.5, { wall_s: 80 }), setup: 'D' }])
const vs = report([row('A2', true, 0.75, { wall_s: 90 }), row('D2', true, 0.25, { wall_s: 60 }), row('D3', false, 0.25, { wall_s: 70, lines_added: 5 })], 'd', '', { v2 })
assert.match(vs, /\| v2 A \| 2 \| 50% \| \$1\.00 \| 100 \| 110s \|/)
assert.match(vs, /\| v2 D \| 1 \| 100% \| \$0\.50 \| 100 \| 80s \|/)
assert.match(vs, /\| A2 − v2 A \| \| \+50 pts \| -\$0\.25 \| ±0 \| -20s \|/)
assert.match(vs, /\| D3 − D2 \| \| -100 pts \| ±\$0\.00 \| ±0 \| \+10s \|/)
// What ponytail changed: D3 against D2 on pass rate, lines added and time.
assert.match(vs, /## What ponytail changed[\s\S]*Pass rate 0% against 100% \(-100 pts.*lines added 5 against 10 \(-50%\), wall-clock 70s against 60s \(\+17%\)/)

console.log('bench ok')

// A parent that ends its turn to wait on a background subagent is idle until the notification, not thinking.
{
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { lanes } = await import('./trace')
  const t0 = Date.parse('2026-11-21T10:00:00Z'), at = (s: number) => new Date(t0 + s * 1000).toISOString()
  const f = join(mkdtempSync(join(tmpdir(), 'trace-')), `${t0}-1.jsonl`)
  const log = [
    { type: 'assistant', timestamp: at(2), message: { content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: {} }] } },
    { type: 'user', timestamp: at(3), message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } },
    { type: 'assistant', timestamp: at(4), message: { content: [{ type: 'text', text: 'waiting' }] } },
    { type: 'assistant', timestamp: at(60), parent_tool_use_id: 't1', message: { content: [{ type: 'text', text: 'done' }] } },
    { type: 'system', subtype: 'task_notification' },
    { type: 'assistant', timestamp: at(65), message: { content: [{ type: 'text', text: 'read it' }] } },
  ]
  writeFileSync(f, log.map(m => JSON.stringify(m)).join('\n'))
  const main = lanes(f, 1)[0]
  const model = main.segs.filter(s => s.kind !== 'tool').reduce((a, s) => a + s.to - s.from, 0) / 1000
  assert.equal(model, 2 + 1 + 5, 'the 56 s waiting on the subagent is not model time')

  // Tokens read per lane: one model call logged as several messages (same id) counts once; a subagent's are its own.
  const g = join(mkdtempSync(join(tmpdir(), 'trace-')), `${t0}-2.jsonl`)
  const u = (id: string, n: number, parent?: string) => ({ type: 'assistant', timestamp: at(n), ...(parent ? { parent_tool_use_id: parent } : {}), message: { id, usage: { input_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 100 }, content: [{ type: 'text', text: '.' }] } })
  writeFileSync(g, [u('m1', 1), u('m1', 2), u('m2', 3), u('s1', 4, 't9'), u('s2', 5, 't9')].map(m => JSON.stringify(m)).join('\n'))
  assert.deepEqual(lanes(g, 1).map(l => l.read), [222, 222])

  // Phases: the parent is the first lane, every other a worker. Plan to the first worker's start, work to the last
  // one's end, tail to the run's end; the parent's turns and tokens read apart from the workers'.
  const { phases } = await import('./trace')
  const lane = (start: number, end: number, read: number, calls = 0) => ({ name: '', segs: [], start, end, cost: 0, turns: 0, read, calls })
  assert.deepEqual(phases({ run: 'r', t0: 0, t1: 100_000, lanes: [lane(0, 100_000, 50, 3), lane(10_000, 60_000, 100), lane(20_000, 80_000, 200)] }), { plan: 10_000, work: 70_000, tail: 20_000, turns: 3, parentRead: 50, workersRead: 300 })
  assert.deepEqual(phases({ run: 'r', t0: 0, t1: 30_000, lanes: [lane(0, 30_000, 5, 1)] }), { plan: 30_000, work: 0, tail: 0, turns: 1, parentRead: 5, workersRead: 0 }, 'no worker: all plan')
}
