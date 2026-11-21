// The bench's scoring rules, run: what goes into a row and what the report says from it.
import assert from 'node:assert/strict'
import { dropTests, median, report, tally, testFuncs, type Row } from './run'

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

// The report names, for each setup, the columns it lost on and why its runs failed; a setup with no runs says so.
const row = (setup: Row['setup'], pass: boolean, cost: number, extra: Partial<Row> = {}): Row => ({
  date: 'd', run: `${setup}${cost}`, task: '26', pair: [1, 2], repeat: 1, setup, pass, f1: pass, f2: pass, total_cost_usd: cost, tokens: 100,
  tokens_detail: { input: 0, output: 0, cache_read: 0, cache_creation: 0 }, wall_s: 600, collisions: 0,
  collisions_detail: { merge_conflict_files: 0, destructive_git: 0, stale_edits: 0 }, interventions: 0, interventions_detail: [],
  agents: 1, api_key_sources: ['none'], daemon: { home: 'h', port: 4200 }, ...extra,
})
const md = report(
  [row('A', true, 1), row('A', true, 2), row('B', false, 1, { collisions: 1, collisions_detail: { merge_conflict_files: 1, destructive_git: 0, stale_edits: 0 } }), row('C', false, 3, { error: 'boom' })],
  'd',
)
assert.match(md, /\| A: .* \| 2 \| 100% \| \$1\.50 \|/)
assert.match(md, /\*\*A\*\* .*lost on cost \(\$1\.50 median against B's \$1\.00\)/)
assert.match(md, /\*\*B\*\* .*lost on pass rate \(0% against A's 100%\).*collisions.*1 on a merge conflict/)
assert.match(md, /\*\*C\*\* .*1 that could not run \(boom\)/)
assert.match(md, /\*\*D\*\* .*has no runs/)

console.log('bench ok')
