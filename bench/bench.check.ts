// The bench's scoring rules, run: what goes into a row and what the report says from it.
import assert from 'node:assert/strict'
import { added, clashes, dropTests, INIT, initCheck, LONG, linesAdded, median, parentContext, plugins, quartiles, report, report4, tally, testFuncs, warningsIn, workerEdits, type Row, type Row4 } from './run'

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

// Lines added: numstat's first column, binary files left out; and a file an agent rewrote from CRLF to LF counts only
// the lines it really added, not every line (v3's first full run counted mux.go +530 for a 24-line change).
assert.equal(linesAdded('3\t1\ta.go\n-\t-\tbin.png\n2\t0\tb.go\n'), 5)
{
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const repo = mkdtempSync(join(tmpdir(), 'lines-'))
  const g = (...a: string[]) => Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a], { cwd: repo })
  g('init', '-q')
  writeFileSync(join(repo, 'mux.go'), Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\r\n') + '\r\n')
  g('add', '-A'), g('commit', '-qm', 'base')
  writeFileSync(join(repo, 'mux.go'), [...Array.from({ length: 50 }, (_, i) => `line ${i}`), 'new 1', 'new 2'].join('\n') + '\n')
  g('add', '-A')
  assert.equal(await added(repo, 'HEAD'), 2)
}

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

// ---------- v4 ----------

// Quartiles interpolate between ranks; one value is all five.
assert.deepEqual(quartiles([4, 1, 3, 2, 5]), { min: 1, p25: 2, med: 3, p75: 4, max: 5 })
assert.deepEqual(quartiles([1, 2, 3, 4]), { min: 1, p25: 1.75, med: 2.5, p75: 3.25, max: 4 })
assert.deepEqual(quartiles([7]), { min: 7, p25: 7, med: 7, p75: 7, max: 7 })

// Peak parent context: the parent's own calls (no parent_tool_use_id), one call once however many messages carry it,
// the call's last usage winning; input + cache read + cache write.
{
  const call = (id: string, input: number, read: number, write: number, parent?: string) => ({ type: 'assistant', ...(parent ? { parent_tool_use_id: parent } : {}), message: { id, usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 999 }, content: [] } })
  const series = parentContext([call('a', 1, 10, 100), call('a', 1, 10, 100), call('s', 5, 50_000, 0, 'tool1'), call('b', 2, 20_000, 300), { type: 'user', message: { content: [] } }, call('c', 3, 30_000, 0)])
  assert.deepEqual(series, [111, 20_302, 30_003], 'a subagent\'s 50k call is not the parent\'s')
  assert.equal(Math.max(...series), 30_003)
}

// The D0 check: zero peer-warning lines in every D0 worker's log, counted per log line; D4's may have any.
{
  const warn = { type: 'system', subtype: 'hook_response', output: '{"additionalContext":"Other agents are working in this repository right now."}' }
  assert.equal(warningsIn([{ type: 'bench_argv' }, warn, { type: 'assistant', message: { content: [] } }, warn]), 2)
  assert.equal(warningsIn([{ type: 'system', subtype: 'hook_response', output: '' }]), 0)
  const { hooksCheck } = await import('./run')
  assert.equal(hooksCheck('D0', [0, 0, 0]), '')
  assert.match(hooksCheck('D0', [0, 2, 1]), /no-hooks check: D0 workers logged 3 peer-warning lines \(0, 2, 1\)/)
  assert.equal(hooksCheck('D4', [3, 1]), '', 'D4 is meant to hear its peers')
}

// Collisions: a file two workers both edited (Edit, MultiEdit, Write; a failed call and the parent's own left out),
// and a clobber when a worker's lines on it are missing from the final tree. A worker that takes its own line out
// again did not get clobbered; a subagent is a worker of its own inside the parent's log.
{
  const use = (id: string, name: string, input: object, parent?: string) => ({ type: 'assistant', ...(parent ? { parent_tool_use_id: parent } : {}), message: { content: [{ type: 'tool_use', id, name, input }] } })
  const failed = (id: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'String to replace not found' }] } })
  const parent = [use('p1', 'Edit', { file_path: 'C:\\run\\repo\\mux.go', old_string: 'x := 1', new_string: 'parentLine()' }), use('s1', 'Edit', { file_path: 'C:/run/repo/tree.go', old_string: 'base line', new_string: 'base line\nsubagentLine()' }, 'task1')]
  const w1 = [use('a', 'Edit', { file_path: 'C:/run/repo/mux.go', old_string: 'func Base() {', new_string: 'func Base() {\n\tworkerOne()\n\tdroppedByOne()' }), use('b', 'Edit', { file_path: 'C:/run/repo/mux.go', old_string: '\tdroppedByOne()', new_string: '' })]
  const w2 = [use('c', 'MultiEdit', { file_path: 'C:/Run/Repo/MUX.go', edits: [{ old_string: 'func Base() {', new_string: 'func Base() {\n\tworkerTwo()' }] }), use('d', 'Write', { file_path: 'C:/run/repo/new.go', content: 'package chi\nfunc New() {}' }), use('e', 'Edit', { file_path: 'C:/run/repo/tree.go', old_string: 'nope', new_string: 'neverLanded()' }), failed('e')]
  const w3 = [use('f', 'Write', { file_path: 'C:/run/repo/new.go', content: 'package chi\nfunc Other() {}' })]
  const edits = workerEdits([parent, w1, w2, w3], p => p.replace(/\\/g, '/').toLowerCase().replace('c:/run/repo/', ''))
  assert.deepEqual([...edits.keys()].sort(), ['0:task1', '1:', '2:', '3:'], 'the parent\'s own edit is not a worker\'s')
  const files: Record<string, string> = { 'mux.go': 'func Base() {\n\tworkerTwo()\n}', 'new.go': 'package chi\nfunc Other() {}', 'tree.go': 'base line\nsubagentLine()' }
  const c = clashes(edits, f => files[f] ?? null)
  assert.deepEqual(c.files, ['mux.go', 'new.go'], 'tree.go: the subagent alone, the other edit failed')
  assert.deepEqual(c.clobbers, [{ file: 'mux.go', worker: '1:', missing: 1 }, { file: 'new.go', worker: '2:', missing: 1 }], 'workerOne() was lost, droppedByOne() was its own; New() was written over')
  assert.deepEqual(clashes(edits, f => (f === 'mux.go' ? 'func Base() {\n\tworkerOne()\n\tworkerTwo()' : files[f])).clobbers.map(x => x.file), ['new.go'], 'both kept: no clobber on mux.go')
}

// Per-feature scoring in the report: each feature's passing runs against the ceiling, features passed of the ceiling,
// all-passed runs, quartiles; the parent-context table and per-call series; D4 against D0.
{
  const r4 = (setup: Row4['setup'], repeat: number, per: boolean[], extra: Partial<Row4> = {}): Row4 => ({
    date: 'd', run: `L5-r${repeat}-${setup}`, long: 'L5', features: LONG.L5.features.map(([t, f]) => `${t}.${f}`), repeat, setup, per, passed: per.filter(Boolean).length, pass: per.every(Boolean),
    total_cost_usd: 1, tokens: 1000, tokens_detail: { input: 0, output: 0, cache_read: 0, cache_creation: 0 }, lines_added: 10, wall_s: 100 * repeat,
    peak_context: 30_000, context_series: [10_000, 20_000, 30_000], warnings: [], collision_files: [], clobbers: [], collisions_detail: { destructive_git: 0, stale_edits: 0 },
    interventions: 0, interventions_detail: [], agents: 1, api_key_sources: ['none'], plugins: [[]], daemon: { home: 'h', port: 4500 }, ...extra,
  })
  const T = true, F = false
  const rows = [
    r4('A4', 1, [T, T, T, T, F]), r4('A4', 2, [T, T, T, T, T]), r4('A4', 3, [T, F, T, T, F], { error: 'init check: boom' }),
    r4('D4', 1, [T, T, F, T, F], { warnings: [2, 1], collision_files: ['mux.go'], clobbers: [{ file: 'mux.go', worker: '2:', missing: 3 }] }),
    r4('D0', 1, [F, F, F, F, F], { warnings: [0, 0], collision_files: ['mux.go', 'tree.go'] }),
  ]
  const md = report4(rows, 'd-v4', { L5: [T, T, T, T, F] }, { reading: '## Reading\n\nBy hand.' })
  assert.match(md, /\| A4 \| L5 \| 3 \(1 could not run\) \| 4\.5 \(4\.3–4\.8; 4–5\) of 5 \| 4 \(4–4; 4–4\) of 4 \| 1 of 2 \| 150s \(125s–175s; 100s–200s\) \|/, 'the errored run is counted but not scored')
  assert.match(md, /\| L5 56\.1 \| passes \| 2\/2 \| 1\/1 \| 0\/1 \|/)
  assert.match(md, /\| L5 56\.5 \| fails \| 1\/2 \| 0\/1 \| 0\/1 \|/)
  assert.match(md, /\| A4 \| L5 \| 2 \| 10k .*\| 30k .*\| 3 .*\| 4k /, 'growth per piece: (30k − 10k) / 5')
  assert.match(md, /L5-r1-D4 +10 20 30/)
  assert.match(md, /\| D4 \| L5 \| 1 \| 3 of 5 \| 0 of 1 \| 1 .*\| 1 \| 3 \| 3 \|/)
  assert.match(md, /\| D0 \| L5 \| 1 \| 0 of 5 \| 0 of 1 \| 2 .*\| 0 \| 0 \| 0 \|/)
  assert.match(md, /## Runs that could not run\n\n- L5-r3-A4: init check: boom/)
  assert.match(md, /## Reading\n\nBy hand\.$/)
  assert.doesNotMatch(report4(rows, 'd-v4'), /passes \|/, 'no ceiling given: unknown, not passes')
}
// The commander's wake: yap's own wake line, for the newest spawn that ended since it was last told; nothing new,
// no wake. Several ending while it worked come as one wake: the inbox hands it all of them.
{
  const { nextWake, wakeLine } = await import('./run')
  assert.equal(wakeLine({ id: '0123456789ab' }), 'yap: a message from session @01234567')
  assert.equal(wakeLine({ id: '0123456789ab', name: 'mux' }), 'yap: a message from session @mux')
  const sp = [{ id: 'aaaaaaaaaa' }, { id: 'bbbbbbbbbb', done: 20 }, { id: 'cccccccccc', done: 10 }]
  assert.deepEqual(nextWake(sp, 0), { line: 'yap: a message from session @bbbbbbbb', told: 2 })
  assert.equal(nextWake(sp, 2), null, 'told of both already')
  assert.equal(nextWake([{ id: 'aaaaaaaaaa' }], 0), null, 'none ended yet')
}

// The long tasks: L8 is tasks 26 and 27 on their one base, L5 task 56.
assert.deepEqual(LONG.L8.features.map(([t, f]) => `${t}.${f}`), ['26.1', '26.2', '26.3', '26.4', '27.1', '27.2', '27.3', '27.4'])
assert.equal(LONG.L5.features.length, 5)

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
