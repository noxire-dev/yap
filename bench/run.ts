// The bench: CooperBench go-chi tasks through three ways of running agents, scored per feature on the final tree.
// Spec: docs/bench/brief.md, then brief-v2.md, brief-v3.md and brief-v4.md (long tasks, what this runs now). The dry
// run: `bun bench/run.ts --tasks L8 --repeats 1 --setups A4,D4,D0`; the full run: `--repeats 3`. `--gold` writes the
// ceiling, what the union of each task's gold patches passes; `--report <json>` rewrites the report from a results file.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { phaseSplit, setups as timing } from './trace'

const ROOT = resolve(import.meta.dir, '..')
const CACHE = join(ROOT, 'bench', '.cache')
const DATA = join(CACHE, 'CooperBench', 'dataset', 'go_chi_task')
const CHI = join(CACHE, 'chi')
const SHIM = join(CACHE, 'bin')
const RESULTS = join(ROOT, 'bench', 'results')
const SHARED_PORT = 4170
// v1 holds 4200 + slot, v2 4300 + slot, v3 4400 + slot; v4's daemons are 4500 + slot and nothing else.
const PORT_BASE = 4500

/** v3's setups: their rows are still reported (`report`). */
export const SETUPS = ['A2', 'D2', 'D3'] as const
/** v4's setups (docs/bench/brief-v4.md): what the runner runs now. */
export const SETUPS4 = ['A4', 'D4', 'D0'] as const
export type Setup = (typeof SETUPS)[number] | (typeof SETUPS4)[number]
export const NAMES: Record<Setup, string> = {
  A2: 'subagents, trusting (Task tool, features as files)',
  D2: 'commander on Haiku, pointing (yap spawn)',
  D3: 'D2 with lean ponytail workers (yap spawn --skills ponytail)',
  A4: 'subagents, one per feature, all at once',
  D4: 'commander on Haiku, one yap spawn per feature, all at once',
  D0: 'D4 with the workers\' yap hooks off',
}
/** The setups whose agents load yap (from this repo, through --plugin-dir). D0's workers load it too; its hooks send nothing. */
export const WITH_YAP: Record<Setup, boolean> = { A2: false, D2: true, D3: true, A4: false, D4: true, D0: true }
/** What each agent's init line must list: the first agent of a run (the parent, the commander), then every other. */
export const INIT: Record<Setup, { lead: string; rest: string }> = {
  A2: { lead: '', rest: '' },
  D2: { lead: 'yap', rest: 'yap' },
  D3: { lead: 'yap', rest: 'ponytail,yap' },
  A4: { lead: '', rest: '' },
  D4: { lead: 'yap', rest: 'yap' },
  D0: { lead: 'yap', rest: 'yap' },
}
/** The commander's own model in D2 and D3; every other agent runs on the bench's model. */
const COMMANDER = 'claude-haiku-5-5'

// The go-chi pairs of CooperBench's lite and core subsets: the language this machine runs without Docker.
export const BASE: Record<string, string> = { '26': '9436cc85db0d35be06e66b91b4f74bbc0295b07b', '27': '9436cc85db0d35be06e66b91b4f74bbc0295b07b', '56': '7f280968675bcc9f310008fc6b8abff0b923734c' }
export const PAIRS: [task: string, f1: number, f2: number][] = [
  ['26', 1, 2],
  ['56', 1, 5],
  ['27', 2, 4],
  ['26', 2, 4],
  ['56', 2, 3],
  ['27', 3, 4],
]

/** v4's long tasks: every feature of the go-chi tasks on one base commit, given at once. */
export const LONG: Record<string, { base: string; features: [task: string, f: number][] }> = {
  L8: { base: BASE['26'], features: [...[1, 2, 3, 4].map(f => ['26', f] as [string, number]), ...[1, 2, 3, 4].map(f => ['27', f] as [string, number])] },
  L5: { base: BASE['56'], features: [1, 2, 3, 4, 5].map(f => ['56', f] as [string, number]) },
}
export const fname = ([task, f]: [string, number]) => `${task}.${f}`

export interface Row {
  date: string
  run: string
  task: string
  pair: [number, number]
  repeat: number
  setup: Setup
  pass: boolean
  f1: boolean
  f2: boolean
  total_cost_usd: number
  tokens: number
  tokens_detail: { input: number; output: number; cache_read: number; cache_creation: number }
  /** Lines the run's patch adds, the agents' own tests included. */
  lines_added: number
  wall_s: number
  collisions: number
  collisions_detail: { merge_conflict_files: number; destructive_git: number; stale_edits: number }
  interventions: number
  interventions_detail: string[]
  agents: number
  api_key_sources: string[]
  /** Each agent's plugins from its init line, Claude Code's own (`@builtin`) left out. */
  plugins: string[][]
  daemon: { home: string; port: number }
  limited?: boolean
  error?: string
}

/** A v4 run: a long task, scored per feature. */
export interface Row4 {
  date: string
  run: string
  long: string
  /** The task's features as `<task>.<feature>`, in the order `per` scores them. */
  features: string[]
  repeat: number
  setup: Setup
  per: boolean[]
  passed: number
  /** Every feature passed. */
  pass: boolean
  total_cost_usd: number
  tokens: number
  tokens_detail: { input: number; output: number; cache_read: number; cache_creation: number }
  lines_added: number
  wall_s: number
  /** The largest context (input + cache read + cache write) of any one parent model call. */
  peak_context: number
  /** The parent's context per model call, in order. */
  context_series: number[]
  /** `Other agents are working` lines in each worker's log (the spawned sessions; A4's subagents have none). */
  warnings: number[]
  /** Files two or more workers edited, and each worker's lines on them missing from the final tree. */
  collision_files: string[]
  clobbers: { file: string; worker: string; missing: number }[]
  collisions_detail: { destructive_git: number; stale_edits: number }
  interventions: number
  interventions_detail: string[]
  agents: number
  api_key_sources: string[]
  plugins: string[][]
  daemon: { home: string; port: number }
  limited?: boolean
  error?: string
}

// ---------- pure parts (bench/bench.check.ts) ----------

/** Min, quartiles and max, interpolated between ranks. */
export function quartiles(xs: number[]) {
  if (!xs.length) return { min: NaN, p25: NaN, med: NaN, p75: NaN, max: NaN }
  const s = [...xs].sort((a, b) => a - b)
  const q = (p: number) => {
    const i = (s.length - 1) * p, lo = Math.floor(i)
    return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo)
  }
  return { min: s[0], p25: q(0.25), med: q(0.5), p75: q(0.75), max: s.at(-1)! }
}

/**
 * The parent's context per model call: its main lane (no parent_tool_use_id), one call counted once however many
 * messages it arrives as (by message id), as input + cache read + cache write.
 */
export function parentContext(lines: unknown[]) {
  const calls = new Map<string, number>()
  for (const m of lines as any[]) {
    const u = m?.type === 'assistant' && !m.parent_tool_use_id && m.message?.usage
    if (u) calls.set(m.message.id ?? `#${calls.size}`, (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0))
  }
  return [...calls.values()]
}

/** How many of a log's lines carry yap's peer warning: zero for every D0 worker, some for D4's. */
export const warningsIn = (lines: unknown[]) => lines.filter(m => JSON.stringify(m).includes('Other agents are working')).length

/**
 * D0 is D4 with the workers' hooks off: a D0 worker that logged a peer warning means they were on, and the run says
 * nothing about D0. The problem, or '' when it holds; other setups always hold.
 */
export function hooksCheck(setup: Setup, warnings: number[]) {
  const n = warnings.reduce((a, w) => a + w, 0)
  return setup === 'D0' && n ? `no-hooks check: D0 workers logged ${n} peer-warning lines (${warnings.join(', ')})` : ''
}

type Edit = { file: string; added: string[]; removed: string[]; whole: boolean }
// Lines short enough to recur anywhere (a brace, `return`) say nothing about whose hunk survived.
const meaningful = (s: string) => s.split('\n').map(l => l.trim()).filter(l => l.length >= 4)
const minus = (a: string[], b: string[]) => { const x = new Set(b); return a.filter(l => !x.has(l)) }

/**
 * Each worker's successful Edit, MultiEdit and Write calls, by worker: every log after the first is a spawned worker
 * (`<log index>:`), and a subagent is a lane of its log (`<log index>:<tool use id>`). The parent's own are left out.
 * A file is keyed by `norm(path)`. Edits made through Bash (sed, a script) are not seen.
 */
export function workerEdits(logs: unknown[][], norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()) {
  const out = new Map<string, Edit[]>()
  logs.forEach((lines, i) => {
    const failed = new Set<string>()
    for (const m of lines as any[]) if (m?.type === 'user') for (const b of m.message?.content ?? []) if (b?.type === 'tool_result' && b.is_error) failed.add(b.tool_use_id)
    for (const m of lines as any[]) {
      if (m?.type !== 'assistant') continue
      const who = `${i}:${m.parent_tool_use_id ?? ''}`
      if (who === '0:') continue
      for (const b of m.message?.content ?? []) {
        if (b?.type !== 'tool_use' || failed.has(b.id) || !b.input?.file_path) continue
        const file = norm(String(b.input.file_path))
        const pairs: [string, string][] = b.name === 'Edit' ? [[b.input.old_string ?? '', b.input.new_string ?? '']] : b.name === 'MultiEdit' ? (b.input.edits ?? []).map((e: any) => [e.old_string ?? '', e.new_string ?? '']) : b.name === 'Write' ? [['', b.input.content ?? '']] : []
        for (const [o, n] of pairs) {
          const [ol, nl] = [meaningful(o), meaningful(n)]
          const e = { file, added: minus(nl, ol), removed: minus(ol, nl), whole: b.name === 'Write' }
          out.set(who, [...(out.get(who) ?? []), e])
        }
      }
    }
  })
  return out
}

/**
 * Collisions in the shared tree: the files two or more workers edited; and on each, a clobber for every worker whose
 * lines (what it added and did not take out again itself) are missing from the final file. `read` gives a file's final
 * text by its key, or null when it is gone.
 */
export function clashes(edits: Map<string, Edit[]>, read: (file: string) => string | null) {
  const by = new Map<string, Set<string>>()
  for (const [w, es] of edits) for (const e of es) by.set(e.file, (by.get(e.file) ?? new Set()).add(w))
  const files = [...by].filter(([, ws]) => ws.size > 1).map(([f]) => f).sort()
  const clobbers: { file: string; worker: string; missing: number }[] = []
  for (const file of files) {
    const final = new Set(meaningful(read(file) ?? ''))
    for (const w of by.get(file)!) {
      let mine = new Set<string>()
      for (const e of edits.get(w)!.filter(e => e.file === file)) {
        if (e.whole) mine = new Set()
        for (const l of e.removed) mine.delete(l)
        for (const l of e.added) mine.add(l)
      }
      const missing = [...mine].filter(l => !final.has(l)).length
      if (missing) clobbers.push({ file, worker: w, missing })
    }
  }
  return { files, clobbers }
}

export const median = (xs: number[]) => {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** A patch without the hunks for test files: the hidden tests are applied on top, as CooperBench does. */
export function dropTests(patch: string) {
  return patch
    .split(/^(?=diff --git )/m)
    .filter(p => !/^diff --git a\/(\S+)/.test(p) || !/(_test\.go|(^|\/)tests?\/)/.test(p.match(/^diff --git a\/(\S+)/)![1]))
    .join('')
}

/** The test functions a tests.patch adds, the way CooperBench's run_tests.sh finds them. */
export const testFuncs = (patch: string) => [...new Set([...patch.matchAll(/func (Test[A-Za-z0-9_]*)/g)].map(m => m[1]))]

const DESTRUCTIVE = /\bgit\s+(stash\b(?!\s+list)|reset\s+--hard|checkout\s+(--\s|\.(\s|$)|-f\b)|restore\b|clean\s+-\w*f)/
const STALE = /modified since (it was )?read|has been modified/i
const LIMIT = /usage limit|rate.?limit|limit (reached|resets)|out of (extra )?usage/i

/** What the agents' streams in a run add up to. `lines` is every JSON line the shim logged. */
export function tally(lines: unknown[]) {
  const t = { cost: 0, input: 0, output: 0, cache_read: 0, cache_creation: 0, agents: 0, destructive: 0, stale: 0, asked: 0, failed: [] as string[], sources: new Set<string>(), limited: false }
  // A process can end several turns, each result a running total: only each agent's last one counts. The shim
  // writes one agent's lines together, after its bench_argv line.
  const last: any[] = []
  for (const m of lines as any[]) {
    if (m?.type === 'bench_argv') t.agents++, last.push(undefined)
    else if (m?.type === 'system' && m.subtype === 'init' && m.apiKeySource) t.sources.add(String(m.apiKeySource))
    else if (m?.type === 'assistant')
      for (const b of m.message?.content ?? []) {
        if (b.type !== 'tool_use') continue
        const cmd = String(b.input?.command ?? '')
        if (b.name === 'Bash' && DESTRUCTIVE.test(cmd)) t.destructive++
        if (b.name === 'AskUserQuestion' || (b.name === 'Bash' && /\byap\s+say\b.*--(question|blocker)/.test(cmd))) t.asked++
      }
    else if (m?.type === 'user')
      for (const b of m.message?.content ?? []) {
        const text = typeof b?.content === 'string' ? b.content : JSON.stringify(b?.content ?? '')
        if (b?.type === 'tool_result' && b.is_error && STALE.test(text)) t.stale++
      }
    else if (m?.type === 'result') {
      if (!last.length) last.push(undefined)
      last[last.length - 1] = m
    }
  }
  for (const m of last) {
    if (!m) continue
    t.cost += Number(m.total_cost_usd ?? 0)
    // modelUsage is the whole process, subagents included; usage alone is the main thread.
    const mu = Object.values(m.modelUsage ?? {}) as any[]
    const u = m.usage ?? {}
    t.input += mu.length ? mu.reduce((a, x) => a + (x.inputTokens ?? 0), 0) : (u.input_tokens ?? 0)
    t.output += mu.length ? mu.reduce((a, x) => a + (x.outputTokens ?? 0), 0) : (u.output_tokens ?? 0)
    t.cache_read += mu.length ? mu.reduce((a, x) => a + (x.cacheReadInputTokens ?? 0), 0) : (u.cache_read_input_tokens ?? 0)
    t.cache_creation += mu.length ? mu.reduce((a, x) => a + (x.cacheCreationInputTokens ?? 0), 0) : (u.cache_creation_input_tokens ?? 0)
    if (m.is_error || (m.subtype && m.subtype !== 'success')) {
      t.failed.push(`agent ended ${m.subtype ?? 'error'}: ${String(m.result ?? '').slice(0, 120)}`)
      if (LIMIT.test(String(m.result ?? ''))) t.limited = true
    }
  }
  return t
}

/**
 * Each agent's plugins, from the init lines it logged: Claude Code's built-in ones (source `…@builtin`) are part of
 * every install, so they are left out. An agent with no init line gets null.
 */
export function plugins(lines: unknown[]) {
  const out: (string[] | null)[] = []
  for (const m of lines as any[]) {
    if (m?.type === 'bench_argv') out.push(null)
    else if (m?.type === 'system' && m.subtype === 'init' && out.length) {
      const mine = (m.plugins ?? []).filter((p: any) => !String(p?.source ?? '').endsWith('@builtin')).map((p: any) => String(p?.name))
      out[out.length - 1] = [...new Set([...(out.at(-1) ?? []), ...mine])].sort()
    }
  }
  return out
}

/**
 * Every agent's init line lists exactly what its lane loads (`INIT`): the first agent `lead`, each later one `rest`.
 * The problem, or '' when it holds.
 */
export function initCheck(found: (string[] | null)[], want: { lead: string; rest: string }) {
  if (!found.length) return 'init check: no agent ran'
  const w = (i: number) => (i ? want.rest : want.lead)
  const bad = found.map((p, i) => (p === null ? `agent ${i + 1} logged no init line` : p.join(',') !== w(i) ? `agent ${i + 1} loaded [${p.join(', ')}], want [${w(i)}]` : '')).filter(Boolean)
  return bad.length ? `init check: ${bad.join('; ')}` : ''
}

/** Lines added, from `git diff --numstat`: the first column summed, binary files (`-`) left out. */
export const linesAdded = (numstat: string) => numstat.split('\n').reduce((a, l) => a + (Number(l.split('\t')[0]) || 0), 0)

/**
 * Lines the staged tree adds against `base`. Agents on Windows rewrite whole files from CRLF to LF and back, which
 * a plain diff counts as every line added (mux.go +530 for a 24-line change), so a CR at a line's end is ignored.
 */
export const added = async (repo: string, base: string) => linesAdded(await must(git(repo, 'diff', '--cached', '--numstat', '--ignore-cr-at-eol', base), 'numstat'))

const pct =(x: number) => `${Math.round(x * 100)}%`
const usd = (x: number) => `$${x.toFixed(2)}`

/** A setup's runs in numbers: pass rate and medians. Rows from an older bench (v2's A and D) work too. */
const stats = (rs: Row[]) => ({
  n: rs.length,
  errors: rs.filter(r => r.error).length,
  pass: rs.length ? rs.filter(r => r.pass).length / rs.length : NaN,
  cost: median(rs.map(r => r.total_cost_usd)),
  tokens: median(rs.map(r => r.tokens)),
  wall: median(rs.map(r => r.wall_s)),
  // v2's rows have no lines_added.
  lines: median(rs.filter(r => r.lines_added !== undefined).map(r => r.lines_added)),
  collisions: median(rs.map(r => r.collisions)),
  interventions: median(rs.map(r => r.interventions)),
})

/**
 * Medians per setup, and for each setup where it lost: the metrics it was not best on, and the pairs it failed.
 * `phases` is the phase split's text, `v2` the rows of the bench before (its A and D get a comparison table).
 */
export function report(rows: Row[], date: string, split = '', more: { phases?: string; v2?: { setup: string }[] } = {}) {
  const by = (s: Setup) => rows.filter(r => r.setup === s)
  const stat = SETUPS.map(s => ({ s, ...stats(by(s)) }))
  const live = stat.filter(x => x.n)
  const best = {
    pass: Math.max(...live.map(x => x.pass)),
    cost: Math.min(...live.map(x => x.cost)),
    tokens: Math.min(...live.map(x => x.tokens)),
    wall: Math.min(...live.map(x => x.wall)),
    collisions: Math.min(...live.map(x => x.collisions)),
    interventions: Math.min(...live.map(x => x.interventions)),
  }
  const winner = (k: keyof typeof best) => live.filter(x => x[k] === best[k]).map(x => x.s).join('/')
  const out = [
    `# Bench results, ${date}`,
    '',
    `${rows.length} runs: ${[...new Set(rows.map(r => `${r.task}[${r.pair.join(',')}]`))].length} CooperBench go-chi pairs × ${Math.max(...rows.map(r => r.repeat))} repeats × ${SETUPS.length} setups, on the user's Claude plan through \`claude -p\`, every agent with no user settings or plugins (\`--setting-sources ''\`), yap only in D2 and D3 (\`--plugin-dir\`), ponytail only in D3's workers (\`yap spawn --skills ponytail\`). Sonnet everywhere but the D2 and D3 commanders (Haiku). Pass is both features' hidden tests on the merged tree. Cost is Claude Code's own \`total_cost_usd\` (the API-price equivalent; the plan was billed, not an API key). Lines is what the patch adds, the agents' own tests included. Harness: \`bench/run.ts\`, spec: \`docs/bench/brief-v3.md\`, raw rows: \`bench/results/${date}.json\`.`,
    '',
    '| Setup | Runs | Pass | Median cost | Median tokens | Median wall-clock | Median lines added | Median collisions | Median interventions |',
    '|---|---|---|---|---|---|---|---|---|',
    ...stat.map(x => `| ${x.s}: ${NAMES[x.s]} | ${x.n}${x.errors ? ` (${x.errors} could not run)` : ''} | ${x.n ? pct(x.pass) : '-'} | ${x.n ? usd(x.cost) : '-'} | ${x.n ? Math.round(x.tokens).toLocaleString('en') : '-'} | ${x.n ? `${Math.round(x.wall)}s` : '-'} | ${x.n ? Math.round(x.lines) : '-'} | ${x.n ? x.collisions : '-'} | ${x.n ? x.interventions : '-'} |`),
    '',
    ...(split ? ['## Where the time went', '', `From \`bun bench/trace.ts --setups ${date}\`, over every agent's log in the run directories.`, '', '```', split.trim(), '```', ''] : []),
    ...(more.phases ? ['## Plan, work, tail', '', `From \`bun bench/trace.ts --phases ${date}\`: plan is the run's start to the first worker's (a subagent, or a spawned session), work the first worker's start to the last one's end, tail the last worker's end to the run's end. Tokens read are input, cache reads and cache writes, summed over each model call; the parent's alone, then the workers'.`, '', '```', more.phases.trim(), '```', ''] : []),
    ...compare(stat, more.v2),
    ...ponytail(stat),
    '## Where each setup lost',
    '',
  ]
  for (const x of stat) {
    if (!x.n) {
      out.push(`**${x.s}** (${NAMES[x.s]}) has no runs.`, '')
      continue
    }
    const lost: string[] = []
    if (x.pass < best.pass) lost.push(`pass rate (${pct(x.pass)} against ${winner('pass')}'s ${pct(best.pass)})`)
    if (x.cost > best.cost) lost.push(`cost (${usd(x.cost)} median against ${winner('cost')}'s ${usd(best.cost)})`)
    if (x.wall > best.wall) lost.push(`wall-clock (${Math.round(x.wall)}s median against ${winner('wall')}'s ${Math.round(best.wall)}s)`)
    if (x.collisions > best.collisions) lost.push(`collisions (${x.collisions} median against ${best.collisions})`)
    if (x.interventions > best.interventions) lost.push(`interventions (${x.interventions} median against ${best.interventions})`)
    const rs = by(x.s)
    const failed = rs.filter(r => !r.pass)
    const pairs = [...new Set(failed.map(r => `${r.task}[${r.pair.join(',')}]`))]
    const why = [
      failed.filter(r => r.collisions_detail.merge_conflict_files).length && `${failed.filter(r => r.collisions_detail.merge_conflict_files).length} on a merge conflict`,
      failed.filter(r => !r.collisions_detail.merge_conflict_files && r.f1 !== r.f2).length && `${failed.filter(r => !r.collisions_detail.merge_conflict_files && r.f1 !== r.f2).length} with one feature passing and the other not`,
      failed.filter(r => !r.collisions_detail.merge_conflict_files && !r.f1 && !r.f2).length && `${failed.filter(r => !r.collisions_detail.merge_conflict_files && !r.f1 && !r.f2).length} with neither feature passing`,
      rs.filter(r => r.error).length && `${rs.filter(r => r.error).length} that could not run (${[...new Set(rs.filter(r => r.error).map(r => r.error!.slice(0, 80)))].join('; ')})`,
    ].filter(Boolean)
    const iv = rs.flatMap(r => r.interventions_detail)
    out.push(
      `**${x.s}** (${NAMES[x.s]}) ${lost.length ? `lost on ${lost.join(', ')}` : 'was best or tied on every column'}. ` +
        (failed.length ? `It failed ${failed.length} of ${rs.length} runs: ${why.join(', ')}; pairs ${pairs.join(', ')}. ` : `It passed all ${rs.length} runs. `) +
        (iv.length ? `A person would have stepped in ${iv.length} times, mostly: ${[...new Set(iv.map(s => s.slice(0, 70)))].slice(0, 3).join('; ')}.` : 'Nobody would have had to step in.'),
      '',
    )
  }
  return out.join('\n')
}

type Stat = ReturnType<typeof stats> & { s: string }
const signed = (x: number, f: (x: number) => string) => (x > 0 ? '+' : x < 0 ? '-' : '±') + f(Math.abs(x))

/** v2's A and D against v3's setups, and what each change bought as a row of differences. */
function compare(stat: Stat[], v2?: { setup: string }[]) {
  if (!v2?.length) return []
  const old = (s: string): Stat => ({ s: `v2 ${s}`, ...stats(v2.filter(r => r.setup === s) as Row[]) })
  const a = old('A'), d = old('D')
  const get = (s: string) => stat.find(x => x.s === s)!
  const line = (x: Stat, name = x.s) => `| ${name} | ${x.n} | ${pct(x.pass)} | ${usd(x.cost)} | ${Math.round(x.tokens).toLocaleString('en')} | ${Math.round(x.wall)}s |`
  const diff = (x: Stat, y: Stat) => `| ${x.s} − ${y.s} | | ${signed(Math.round((x.pass - y.pass) * 100), n => `${n} pts`)} | ${signed(x.cost - y.cost, n => usd(n))} | ${signed(Math.round(x.tokens - y.tokens), n => n.toLocaleString('en'))} | ${signed(Math.round(x.wall - y.wall), n => `${n}s`)} |`
  const rows = [line(a), line(d), ...stat.filter(x => x.n).map(x => line(x))]
  const diffs = [['A2', a], ['D2', d], ['D3', d], ['D3', get('D2')]].filter(([s]) => get(s as string).n).map(([s, y]) => diff(get(s as string), y as Stat))
  return [
    '## Against v2',
    '',
    `v2's A (subagents, the parent told to fix anything left) and D (commander on Sonnet, retyping each feature) from \`bench/results/2026-11-21-v2.json\`, the same six pairs and three repeats; then each change as a difference.`,
    '',
    '| Setup | Runs | Pass | Median cost | Median tokens | Median wall-clock |',
    '|---|---|---|---|---|---|',
    ...rows,
    ...diffs,
    '',
  ]
}

/** What ponytail changed: D3 (lean ponytail workers) against D2 (the same, without it). */
function ponytail(stat: Stat[]) {
  const d2 = stat.find(x => x.s === 'D2'), d3 = stat.find(x => x.s === 'D3')
  if (!d2?.n || !d3?.n) return []
  const pts = Math.round((d3.pass - d2.pass) * 100)
  const rel = (x: number, y: number) => (y ? `${signed(Math.round(((x - y) / y) * 100), n => `${n}%`)}` : '±0%')
  return [
    '## What ponytail changed',
    '',
    `D3 is D2 with each worker started as \`yap spawn --skills ponytail\`. Pass rate ${pct(d3.pass)} against ${pct(d2.pass)} (${signed(pts, n => `${n} pts`)}, over ${d3.n} and ${d2.n} runs, so one run is ${Math.round(100 / d3.n)} pts). Median lines added ${Math.round(d3.lines)} against ${Math.round(d2.lines)} (${rel(d3.lines, d2.lines)}), wall-clock ${Math.round(d3.wall)}s against ${Math.round(d2.wall)}s (${rel(d3.wall, d2.wall)}), cost ${usd(d3.cost)} against ${usd(d2.cost)} (${rel(d3.cost, d2.cost)}), tokens ${rel(d3.tokens, d2.tokens)}.`,
    '',
  ]
}

/**
 * v4's report: per setup and task, the numbers as quartiles; each feature against the ceiling (what the union of the
 * gold patches passes); the parent's context, peak and per call; D4 against D0. `reading` is the hand-written part.
 */
export function report4(rows: Row4[], tag: string, ceiling: Record<string, boolean[]> = {}, more: { phases?: string; reading?: string } = {}) {
  const longs = Object.keys(LONG).filter(l => rows.some(r => r.long === l))
  const k = (n: number) => `${Math.round(n / 1000)}k`
  const s = (n: number) => `${Math.round(n)}s`
  const n0 = (n: number) => String(Math.round(n * 10) / 10)
  const q = (xs: number[], f: (n: number) => string) => {
    if (!xs.length) return '-'
    const x = quartiles(xs)
    return `${f(x.med)} (${f(x.p25)}–${f(x.p75)}; ${f(x.min)}–${f(x.max)})`
  }
  const of = (l: string, set: Setup) => rows.filter(r => r.long === l && r.setup === set)
  const ok = (rs: Row4[]) => rs.filter(r => !r.error)
  const inCeiling = (r: Row4) => r.per.filter((p, i) => p && ceiling[r.long]?.[i]).length
  const runs = (rs: Row4[]) => `${rs.length}${rs.some(r => r.error) ? ` (${rs.filter(r => r.error).length} could not run)` : ''}`
  const out = [
    `# Bench v4 results, ${tag}`,
    '',
    `${rows.length} runs: long tasks ${longs.map(l => `${l} (${LONG[l].features.map(fname).join(', ')})`).join(' and ')}, × ${Math.max(...rows.map(r => r.repeat))} repeats × setups ${SETUPS4.filter(x => rows.some(r => r.setup === x)).map(x => `${x} (${NAMES[x]})`).join(', ')}. On the user's Claude plan through \`claude -p\`, every agent with no user settings or plugins, yap only in D4 and D0 (\`--plugin-dir\`). Sonnet everywhere but the D4 and D0 commanders (Haiku). A feature passes when its hidden tests pass on a fresh base with the run's final patch (its own tests dropped) applied. The ceiling is what the union of the task's gold patches passes the same way (\`--gold\`). Cost is Claude Code's own \`total_cost_usd\`, the API-price equivalent; the plan was billed. Harness: \`bench/run.ts\`, spec: \`docs/bench/brief-v4.md\`, raw rows: \`bench/results/${tag}.json\`.`,
    '',
    '## Runs',
    '',
    'Each cell is median (p25–p75; min–max), over the runs that ran.',
    '',
    '| Setup | Task | Runs | Features passed | Of the ceiling | All passed | Wall-clock | Cost | Peak parent context | Tokens | Lines added |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ]
  for (const l of longs)
    for (const set of SETUPS4) {
      const all = of(l, set), rs = ok(all)
      if (!all.length) continue
      const c = (ceiling[l] ?? []).filter(Boolean).length
      out.push(`| ${set} | ${l} | ${runs(all)} | ${q(rs.map(r => r.passed), n0)} of ${LONG[l].features.length} | ${ceiling[l] ? `${q(rs.map(inCeiling), n0)} of ${c}` : '-'} | ${rs.filter(r => r.pass).length} of ${rs.length} | ${q(rs.map(r => r.wall_s), s)} | ${q(rs.map(r => r.total_cost_usd), usd)} | ${q(rs.map(r => r.peak_context), k)} | ${q(rs.map(r => r.tokens), k)} | ${q(rs.map(r => r.lines_added), n0)} |`)
    }
  out.push('', '## Each feature against the ceiling', '', 'Runs in which the feature\'s hidden tests passed. Ceiling: whether the union of the gold patches passes them.', '')
  out.push(`| Feature | Ceiling | ${SETUPS4.join(' | ')} |`, `|---|---|${SETUPS4.map(() => '---|').join('')}`)
  for (const l of longs)
    LONG[l].features.forEach((f, i) => {
      const cells = SETUPS4.map(set => { const rs = ok(of(l, set)); return rs.length ? `${rs.filter(r => r.per[i]).length}/${rs.length}` : '-' })
      out.push(`| ${l} ${fname(f)} | ${ceiling[l] ? (ceiling[l][i] ? 'passes' : 'fails') : '?'} | ${cells.join(' | ')} |`)
    })
  out.push('', '## Parent context', '', 'The parent is A4\'s session and D4\'s and D0\'s commander. Context is one model call\'s input + cache read + cache write, each call counted once. Growth per piece is (peak − first call) / pieces: what each feature handed out and reported back cost the parent.', '')
  out.push('| Setup | Task | Runs | First call | Peak | Parent calls | Growth per piece |', '|---|---|---|---|---|---|---|')
  for (const l of longs)
    for (const set of SETUPS4) {
      const rs = ok(of(l, set)).filter(r => r.context_series.length)
      if (!rs.length) continue
      out.push(`| ${set} | ${l} | ${rs.length} | ${q(rs.map(r => r.context_series[0]), k)} | ${q(rs.map(r => r.peak_context), k)} | ${q(rs.map(r => r.context_series.length), n0)} | ${q(rs.map(r => (r.peak_context - r.context_series[0]) / LONG[l].features.length), k)} |`)
    }
  out.push('', 'Per call, in thousands of tokens:', '', '```')
  for (const r of [...rows].filter(r => r.context_series.length).sort((a, b) => a.run.localeCompare(b.run))) out.push(`${r.run.padEnd(10)} ${r.context_series.map(x => Math.round(x / 1000)).join(' ')}`)
  out.push('```', '', '## D4 against D0: yap\'s hooks on and off', '', 'D0 is D4 with the workers\' yap hooks sending nothing. Files edited by two workers come from their Edit, MultiEdit and Write calls (edits made through Bash are not seen); a clobber is a worker whose lines on such a file are missing from the final tree. Peer warnings are the `Other agents are working` lines in the workers\' logs.', '')
  out.push('| Setup | Task | Runs | Features passed, total | All passed | Files two workers edited | Runs with a clobber | Clobbered lines | Peer-warning lines |', '|---|---|---|---|---|---|---|---|---|')
  for (const l of longs)
    for (const set of ['D4', 'D0'] as Setup[]) {
      const rs = ok(of(l, set))
      if (!rs.length) continue
      const sum = (f: (r: Row4) => number) => rs.reduce((a, r) => a + f(r), 0)
      out.push(`| ${set} | ${l} | ${rs.length} | ${sum(r => r.passed)} of ${rs.length * LONG[l].features.length} | ${rs.filter(r => r.pass).length} of ${rs.length} | ${q(rs.map(r => r.collision_files.length), n0)} | ${rs.filter(r => r.clobbers.length).length} | ${sum(r => r.clobbers.reduce((a, c) => a + c.missing, 0))} | ${sum(r => r.warnings.reduce((a, w) => a + w, 0))} |`)
    }
  if (more.phases) out.push('', '## Plan, work, tail', '', `From \`bun bench/trace.ts --phases ${tag}\`: plan is the run's start to the first worker's, work the first worker's start to the last one's end, tail the last worker's end to the run's end.`, '', '```', more.phases.trim(), '```')
  const bad = rows.filter(r => r.error)
  if (bad.length) out.push('', '## Runs that could not run', '', ...bad.map(r => `- ${r.run}: ${r.error}`))
  if (more.reading) out.push('', more.reading.trim())
  return out.join('\n')
}

// ---------- the run ----------

const log = (file: string, line: string) => {
  const s = `${new Date().toISOString()} ${line}`
  console.log(s)
  appendFileSync(file, s + '\n')
}

async function sh(cmd: string[], cwd: string, o: { env?: Record<string, string>; input?: string; timeout?: number } = {}) {
  const p = Bun.spawn(cmd, { cwd, env: o.env ?? (process.env as Record<string, string>), stdin: o.input === undefined ? 'ignore' : 'pipe', stdout: 'pipe', stderr: 'pipe', windowsHide: true, timeout: o.timeout })
  if (o.input !== undefined) p.stdin!.write(o.input), p.stdin!.end()
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  await p.exited
  return { ok: p.exitCode === 0, out, err, code: p.exitCode }
}
const git = (cwd: string, ...a: string[]) => sh(['git', '-c', 'user.name=bench', '-c', 'user.email=bench@localhost', '-c', 'core.autocrlf=false', ...a], cwd)
async function must(r: Promise<{ ok: boolean; out: string; err: string }>, what: string) {
  const x = await r
  if (!x.ok) throw new Error(`${what}: ${(x.err || x.out).trim().slice(0, 400)}`)
  return x.out
}

const feature = (task: string, f: number) => readFileSync(join(DATA, `task${task}`, `feature${f}`, 'feature.md'), 'utf8').trim()

async function prepare() {
  if (!existsSync(DATA)) await must(sh(['git', 'clone', '--depth', '1', 'https://github.com/cooperbench/CooperBench', join(CACHE, 'CooperBench')], ROOT), 'fetching CooperBench')
  if (!existsSync(CHI)) await must(sh(['git', 'clone', '-q', 'https://github.com/go-chi/chi', CHI], ROOT), 'fetching go-chi')
  // Built every time: the shim decides each agent's settings and plugins, so a stale one would bench the wrong agents.
  await must(sh(['bun', 'build', '--compile', join(ROOT, 'bench', 'shim.ts'), '--outfile', join(SHIM, process.platform === 'win32' ? 'claude.exe' : 'claude')], ROOT), 'building the claude shim')
}

/** A fresh checkout of a base commit on branch main, with no remote to fetch answers from. */
async function checkout(base: string, dir: string) {
  await must(sh(['git', 'clone', '-q', '--no-checkout', CHI, dir], ROOT), 'clone')
  await must(git(dir, 'checkout', '-q', '-b', 'main', base), 'checkout base')
  await must(git(dir, 'remote', 'remove', 'origin'), 'remove origin')
}

/** Everything in `dir`'s tree against `base`, untracked files included. */
async function patchOf(dir: string, base: string) {
  await must(git(dir, 'add', '-A'), 'add')
  return must(git(dir, 'diff', '--cached', '--binary', base), 'diff')
}

/** Each feature's hidden tests, each on its own fresh checkout of `base` with `patch` applied (its test files dropped). */
export async function scoreEach(base: string, features: [string, number][], patch: string, dir: string) {
  const per: boolean[] = []
  const notes: string[] = []
  for (const [task, f] of features) {
    const d = join(dir, `score-${task}-${f}`)
    await checkout(base, d)
    const mine = dropTests(patch)
    let ok = true
    if (mine.trim()) {
      writeFileSync(join(dir, 'final.patch'), mine)
      ok = (await git(d, 'apply', '--ignore-whitespace', join(dir, 'final.patch'))).ok
      if (!ok) notes.push(`feature ${task}.${f}: the final patch does not apply`)
    }
    const tests = join(DATA, `task${task}`, `feature${f}`, 'tests.patch')
    if (ok) {
      ok = (await git(d, 'apply', '--ignore-whitespace', tests)).ok || (await git(d, 'apply', '--3way', tests)).ok
      if (!ok) notes.push(`feature ${task}.${f}: its tests.patch does not apply`)
    }
    if (ok) {
      const run = await sh(['go', 'test', '-run', testFuncs(readFileSync(tests, 'utf8')).join('|'), './...'], d, { timeout: 600_000 })
      ok = run.ok
      if (!ok) notes.push(`feature ${task}.${f}: ${(run.out + run.err).split('\n').filter(l => /FAIL|error|undefined/.test(l)).slice(0, 3).join(' | ')}`)
    }
    per.push(ok)
    rmSync(d, { recursive: true, force: true })
  }
  return { per, notes }
}

/** v3's pair scoring: both features' hidden tests. */
export async function score(task: string, pair: [number, number], patch: string, dir: string) {
  const { per, notes } = await scoreEach(BASE[task], pair.map(f => [task, f] as [string, number]), patch, dir)
  return { f1: per[0], f2: per[1], notes }
}

/** A long task's gold patches together: each task's combined.patch applied in turn on the base; the tree as one patch. */
async function goldUnion(long: string, dir: string) {
  const { base, features } = LONG[long]
  const repo = join(dir, 'union')
  await checkout(base, repo)
  for (const task of [...new Set(features.map(([t]) => t))]) {
    const p = join(DATA, `task${task}`, 'combined.patch')
    if (!(await git(repo, 'apply', '--ignore-whitespace', p)).ok) await must(git(repo, 'apply', '--3way', p), `task${task}'s gold patch on the union`)
  }
  const patch = await patchOf(repo, base)
  rmSync(repo, { recursive: true, force: true })
  return patch
}

interface Ctx {
  dir: string
  repo: string
  long: string
  base: string
  features: [string, number][]
  env: Record<string, string>
  deadline: number
  logFile: string
  notes: string[]
}

/** One headless Claude Code, through the shim like every other in the run; on `model` if given, else the bench's. */
async function agent(c: Ctx, cwd: string, prompt: string, yap: boolean, model?: string) {
  const env = { ...c.env, ...(yap ? {} : { YAP_AGENT: '1' }) }
  const args = ['claude', '-p', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none', '--strict-mcp-config', '--no-session-persistence', '--permission-mode', 'auto', ...(model ? ['--model', model] : [])]
  const p = Bun.spawn(args, { cwd, env, stdin: 'pipe', stdout: 'ignore', stderr: 'pipe', windowsHide: true, timeout: Math.max(1000, c.deadline - Date.now()), killSignal: 'SIGKILL' })
  p.stdin.write(prompt)
  p.stdin.end()
  const err = await new Response(p.stderr).text()
  await p.exited
  if (Date.now() >= c.deadline) c.notes.push('out of time: an agent was stopped at the run deadline')
  else if (p.exitCode !== 0 && err.trim()) c.notes.push(`agent exited ${p.exitCode}: ${err.trim().slice(0, 160)}`)
}

/** The prompt yap wakes an idle session with when a message is waiting (`WAKE` in src/sessions.ts). */
export const wakeLine = (spawn: { id: string; name?: string }) => `yap: a message from session @${spawn.name || spawn.id.slice(0, 8)}`

/**
 * What the commander is sent next: the wake line for the newest spawn that ended since it was last told, or null
 * when there is nothing new. `told` is how many had ended when it was last woken.
 */
export function nextWake(spawns: { id: string; name?: string; done?: number }[], told: number) {
  const done = spawns.filter(s => s.done).sort((a, b) => a.done! - b.done!)
  return done.length > told ? { line: wakeLine(done.at(-1)!), told: done.length } : null
}

/**
 * D4 and D0's commander, kept open the way a pane keeps a session. A `claude -p` ends when its turn does, so a
 * commander that dispatched and stopped would never read a report (v2 and v3's never did). yap wakes an idle session
 * in a pane by typing its wake line; with no pane, this does: stdin stays open (stream-json), and whenever the
 * commander is idle and a spawn has ended since it was last told, the wake line goes in as its next prompt. Its
 * UserPromptSubmit hook then hands it the reports waiting in its inbox, as in a pane. It ends once every spawn has
 * ended and it went idle after hearing of the last.
 */
async function woken(c: Ctx, prompt: string) {
  const args = ['claude', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none', '--strict-mcp-config', '--no-session-persistence', '--permission-mode', 'auto', '--model', COMMANDER]
  const p = Bun.spawn(args, { cwd: c.repo, env: c.env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', windowsHide: true, timeout: Math.max(1000, c.deadline - Date.now()), killSignal: 'SIGKILL' })
  const send = (text: string) => p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n')
  let idle = false, gone = false
  const read = (async () => {
    let buf = ''
    for await (const chunk of p.stdout) {
      buf += Buffer.from(chunk).toString('utf8')
      const lines = buf.split('\n')
      buf = lines.pop()!
      for (const l of lines) if (l.includes('"type":"result"')) idle = true
    }
    gone = true
  })()
  const err = new Response(p.stderr).text()
  send(prompt)
  let told = 0, wakes = 0
  while (Date.now() < c.deadline && !gone) {
    await wait(3000)
    if (!idle) continue
    const spawns = await api<{ id: string; name?: string; done?: number }[]>(c, '/api/spawns')
    const next = nextWake(spawns, told)
    if (next) {
      idle = false
      told = next.told
      wakes++
      send(next.line)
    } else if (!spawns.length || spawns.every(s => s.done)) break
  }
  p.stdin.end()
  await p.exited
  await read
  log(c.logFile, `${basename(c.dir)}: the commander was woken ${wakes} times`)
  if (Date.now() >= c.deadline) c.notes.push('out of time: the commander was stopped at the run deadline')
  else if (p.exitCode !== 0 && (await err).trim()) c.notes.push(`commander exited ${p.exitCode}: ${(await err).trim().slice(0, 160)}`)
}

async function api<T>(c: Ctx, path: string): Promise<T> {
  const token = readFileSync(join(c.env.YAP_HOME, 'token'), 'utf8').trim()
  const r = await fetch(`http://127.0.0.1:${c.env.YAP_PORT}${path}`, { headers: { 'x-yap-token': token } })
  if (!r.ok) throw new Error(`${path}: ${r.status}`)
  return r.json() as Promise<T>
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

/** The task's features as files outside the repo (`<run dir>/features/1.md`, `2.md`, …), so nothing of them lands in the patch. */
function featureFiles(c: Ctx) {
  mkdirSync(join(c.dir, 'features'), { recursive: true })
  return c.features.map(([task, f], i) => {
    const p = join(c.dir, 'features', `${i + 1}.md`)
    writeFileSync(p, feature(task, f) + '\n')
    return p.replace(/\\/g, '/')
  })
}
const listed = (paths: string[]) => paths.map(p => `\`${p}\``).join(', ')

// A4 and D4/D0 share v3's trust rule: the workers run the tests and report, the lead re-runs and fixes nothing unless
// one reported a failure.
const TRUST = "The workers run the tests: each must run `go test ./...` before it finishes and end with whether the tests passed. Do not re-run the tests yourself and do not review or fix their work, unless a worker reported a failing test or an unfinished feature: only then fix that, and run `go test ./...` once after your fix. Nobody will answer questions: make the calls yourself."

/** D4 and D0: a commander on Haiku that points each worker at its feature's file, all at once. */
async function commander(c: Ctx) {
  const files = featureFiles(c)
  await woken(
    c,
    `This repository needs ${files.length} features, written up in ${listed(files)}. Do not read them. Start one background worker per feature with \`yap spawn <task>\`, all of them now, the task one line: "Implement the feature in <its path>. Other workers build other features in this same working tree at the same time. Run \`go test ./...\` before you finish and end with whether the tests passed." Each worker's last word comes back to you on its own when it ends, so do not poll. Wait for all of them. ${TRUST}`,
  )
  // A commander stopped at the deadline leaves workers running: the run is over when every spawn is.
  let spawns: { done?: number; ok?: boolean; result?: string }[] = []
  while (Date.now() < c.deadline) {
    spawns = await api(c, '/api/spawns')
    if (spawns.every(s => s.done)) break
    await wait(10_000)
  }
  if (!spawns.length) c.notes.push('the commander started no workers')
  for (const s of spawns) if (!s.done) c.notes.push('out of time: a worker was still running at the run deadline')
  else if (!s.ok) c.notes.push(`a worker failed: ${String(s.result ?? '').slice(0, 120)}`)
  return patchOf(c.repo, c.base)
}

/** Each v4 setup leaves the patch the run produced, against the base commit. */
const RUN: Record<(typeof SETUPS4)[number], (c: Ctx) => Promise<string>> = {
  async A4(c) {
    const files = featureFiles(c)
    await agent(
      c,
      c.repo,
      `This repository needs ${files.length} features, written up in ${listed(files)}. Do not read them. Give each to its own subagent with the Task tool, all of them at once, telling each in one line to implement the feature in its file's path, that other subagents build other features in this same working tree at the same time, and to run \`go test ./...\` before it finishes and end with whether the tests passed. ${TRUST.replaceAll('worker', 'subagent')}`,
      false,
    )
    return patchOf(c.repo, c.base)
  },
  D4: commander,
  D0: commander,
}

const realClaude = () => {
  const own = resolve(SHIM)
  const path = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(p => resolve(p) !== own).join(process.platform === 'win32' ? ';' : ':')
  const r = Bun.which('claude', { PATH: path })
  if (!r) throw new Error('claude is not installed')
  return r
}

/** The environment every agent and daemon of a run gets: no API key, no ids from the session that started the bench. */
function runEnv(home: string, port: number, logs: string, model: string, yap: boolean) {
  if (port === SHARED_PORT || resolve(home) === resolve(join(homedir(), '.yap'))) throw new Error('refusing to touch the shared daemon')
  if (port < PORT_BASE || port >= PORT_BASE + 100) throw new Error(`refusing port ${port}: v4's daemons are on ${PORT_BASE}-${PORT_BASE + 99}`)
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !/^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDECODE|CLAUDE_CODE_\w+|YAP_\w+|HC_\w+|HERDR_\w+|KODR_\w+)$/i.test(k)) env[k] = v
  const sep = process.platform === 'win32' ? ';' : ':'
  const pathKey = Object.keys(env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH'
  return {
    ...env,
    [pathKey]: `${SHIM}${sep}${env[pathKey]}`,
    BENCH_REAL_CLAUDE: realClaude(),
    BENCH_LOG_DIR: logs,
    BENCH_MODEL: model,
    YAP_HOME: home,
    YAP_PORT: String(port),
    // The daemon passes these on to the workers it spawns, so they go through the shim like the rest.
    YAP_PASS: 'BENCH_REAL_CLAUDE,BENCH_LOG_DIR,BENCH_MODEL,BENCH_PLUGIN_DIR',
    ...(yap ? { BENCH_PLUGIN_DIR: ROOT } : {}),
  }
}

/**
 * A run's directory, %TEMP%/yapbench/<tag>/<run>. One that holds agent logs is never reused: a run the plan's limit
 * cut short is moved aside to <run>_limited<n> first, and anything else holding logs stops the run.
 */
function runDir(tag: string, run: string, retry: boolean) {
  const dir = join(tmpdir(), 'yapbench', tag, run)
  const logs = join(dir, 'logs')
  if (existsSync(logs) && readdirSync(logs).length) {
    if (!retry) throw new Error(`refusing to reuse ${dir}: it holds an earlier run's logs`)
    let n = 1
    while (existsSync(`${dir}_limited${n}`)) n++
    renameSync(dir, `${dir}_limited${n}`)
  }
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

async function one(o: { long: string; repeat: number; setup: (typeof SETUPS4)[number]; slot: number; date: string; tag: string; logFile: string; model: string; minutes: number; retry?: boolean }): Promise<Row4> {
  const run = `${o.long}-r${o.repeat}-${o.setup}`
  const dir = runDir(o.tag, run, !!o.retry)
  const home = join(dir, 'yap')
  const port = PORT_BASE + o.slot
  const { base, features } = LONG[o.long]
  const env = runEnv(home, port, join(dir, 'logs'), o.model, WITH_YAP[o.setup])
  const c: Ctx = { dir, repo: join(dir, 'repo'), long: o.long, base, features, env, deadline: Date.now() + o.minutes * 60_000, logFile: o.logFile, notes: [] }
  const row: Row4 = {
    date: o.date, run, long: o.long, features: features.map(fname), repeat: o.repeat, setup: o.setup, per: features.map(() => false), passed: 0, pass: false,
    total_cost_usd: 0, tokens: 0, tokens_detail: { input: 0, output: 0, cache_read: 0, cache_creation: 0 }, lines_added: 0, wall_s: 0,
    peak_context: 0, context_series: [], warnings: [], collision_files: [], clobbers: [], collisions_detail: { destructive_git: 0, stale_edits: 0 },
    interventions: 0, interventions_detail: [], agents: 0, api_key_sources: [], plugins: [], daemon: { home, port },
  }
  // Every worker at once: the daemon may run as many spawns as the task has pieces. D0's daemon passes YAP_AGENT on to
  // the workers it starts, so their yap hooks send nothing (hooks/yap.sh); the commander, started by the runner, keeps
  // its own, which is how a worker's last word wakes it.
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'config.json'), JSON.stringify({ spawns: features.length }) + '\n')
  const daemonEnv = o.setup === 'D0' ? { ...env, YAP_AGENT: '1', YAP_PASS: `${env.YAP_PASS},YAP_AGENT` } : env
  let patch = ''
  const t0 = Date.now()
  try {
    await checkout(base, c.repo)
    log(o.logFile, `${run}: start, setup ${o.setup} (${NAMES[o.setup]}), ${features.length} features, throwaway daemon YAP_HOME=${home} YAP_PORT=${port}`)
    await must(sh(['bun', join(ROOT, 'src', 'cli.ts'), 'start'], dir, { env: daemonEnv, timeout: 60_000 }), 'starting the throwaway daemon')
    patch = await RUN[o.setup](c)
  } catch (e: any) {
    row.error = String(e?.message ?? e)
    log(o.logFile, `${run}: could not run: ${row.error}`)
  } finally {
    row.wall_s = Math.round((Date.now() - t0) / 1000)
    await sh(['bun', join(ROOT, 'src', 'cli.ts'), 'stop'], dir, { env, timeout: 60_000 }).catch(() => {})
  }
  const logs = existsSync(join(dir, 'logs'))
    ? readdirSync(join(dir, 'logs')).filter(f => f.endsWith('.jsonl')).sort().map(f => readFileSync(join(dir, 'logs', f), 'utf8').split('\n').flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } }))
    : []
  const lines = logs.flat()
  const t = tally(lines)
  Object.assign(row, {
    total_cost_usd: Math.round(t.cost * 10000) / 10000,
    tokens: t.input + t.output + t.cache_read + t.cache_creation,
    tokens_detail: { input: t.input, output: t.output, cache_read: t.cache_read, cache_creation: t.cache_creation },
    lines_added: patch.trim() ? await added(c.repo, base) : 0,
    agents: t.agents,
    api_key_sources: [...t.sources],
    limited: t.limited || undefined,
  })
  row.context_series = logs.length ? parentContext(logs[0]) : []
  row.peak_context = Math.max(0, ...row.context_series)
  row.warnings = logs.slice(1).map(warningsIn)
  const repoKey = (p: string) => p.replace(/\\/g, '/').toLowerCase()
  const root = repoKey(c.repo) + '/'
  const clash = clashes(workerEdits(logs, p => repoKey(p).replace(root, '')), f => {
    const p = join(c.repo, f)
    return existsSync(p) ? readFileSync(p, 'utf8') : null
  })
  row.collision_files = clash.files
  row.clobbers = clash.clobbers
  const found = plugins(lines)
  row.plugins = found.map(p => p ?? [])
  const init = initCheck(found, INIT[o.setup])
  if (init && !t.limited) row.error = row.error ? `${row.error}; ${init}` : init
  log(o.logFile, `${run}: ${init || `init check ok: ${found.length} agents, ${found.map((p, i) => `agent ${i + 1} [${p!.join(', ')}]`).join(', ')}`}`)
  const warned = row.warnings.reduce((a, w) => a + w, 0)
  const hooks = hooksCheck(o.setup, row.warnings)
  if (hooks && !t.limited) row.error = row.error ? `${row.error}; ${hooks}` : hooks
  if (o.setup !== 'A4') log(o.logFile, `${run}: ${hooks || `hooks check: ${warned} peer-warning lines in ${row.warnings.length} worker logs (${row.warnings.join(', ')})${o.setup === 'D4' && !warned ? ' WARNING: D4 workers heard of no peer' : ''}`}`)
  row.collisions_detail = { destructive_git: t.destructive, stale_edits: t.stale }
  row.interventions_detail = [...c.notes, ...t.failed, ...Array(t.asked).fill('an agent asked a person')]
  row.interventions = row.interventions_detail.length
  // A run whose agents were not the clean ones the setup names fails: its result says nothing about the setup.
  if (!row.error && patch.trim()) {
    const s = await scoreEach(base, features, patch, dir)
    row.per = s.per
    row.passed = s.per.filter(Boolean).length
    row.pass = row.passed === features.length
    for (const n of s.notes) log(o.logFile, `${run}: ${n}`)
  }
  if (row.api_key_sources.some(s => s !== 'none')) log(o.logFile, `${run}: WARNING an agent signed in with ${row.api_key_sources.join(', ')}, not the plan`)
  log(o.logFile, `${run}: ${row.passed}/${features.length} features [${row.per.map(p => (p ? 1 : 0)).join('')}] cost=${usd(row.total_cost_usd)} tokens=${row.tokens} wall=${row.wall_s}s peak-context=${row.peak_context} parent-calls=${row.context_series.length} files-two-edited=${row.collision_files.length} clobbers=${row.clobbers.length} agents=${row.agents}${row.limited ? ' LIMITED' : ''}${row.error ? ` ERROR ${row.error}` : ''}${c.notes.length ? ` notes: ${c.notes.join('; ')}` : ''}`)
  return row
}

/** `bun bench/trace.ts --setups <tag>` and `--phases <tag>`: where each setup's time went, over the run directories' agent logs. */
function trace(f: (tag: string) => string, tag: string) {
  try {
    return f(tag)
  } catch (e: any) {
    return `no timing: ${e?.message ?? e}`
  }
}

/** The ceiling `--gold` wrote for a date: per long task, whether the union of its gold patches passes each feature. */
const goldFile = (date: string) => join(RESULTS, `${date}-v4-gold.json`)

/**
 * The report with everything it reads beside the rows: v3's for v3 rows; for v4's, the ceiling, the phase split and
 * the hand-written reading (`<tag>.reading.md`, kept apart so a rewrite from the rows keeps it).
 */
function written(rows: (Row | Row4)[], tag: string) {
  if (rows.some(r => 'long' in r)) {
    const gold = goldFile(tag.slice(0, 10))
    const reading = join(RESULTS, `${tag}.reading.md`)
    return report4(rows as Row4[], tag, existsSync(gold) ? JSON.parse(readFileSync(gold, 'utf8')) : {}, { phases: trace(phaseSplit, tag), reading: existsSync(reading) ? readFileSync(reading, 'utf8') : undefined })
  }
  const v2 = join(RESULTS, '2026-11-21-v2.json')
  return report(rows as Row[], tag, trace(timing, tag), { phases: trace(phaseSplit, tag), v2: existsSync(v2) ? JSON.parse(readFileSync(v2, 'utf8')) : undefined })
}

/** The plan's weekly usage, as the account reports it: the same number Claude Code's /usage shows. */
export async function weekly(): Promise<number | null> {
  try {
    const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
    const token = JSON.parse(readFileSync(join(dir, '.credentials.json'), 'utf8')).claudeAiOauth.accessToken
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', { headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' } })
    return (await r.json() as any).seven_day?.utilization ?? null
  } catch {
    return null
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const opt = (k: string, d: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d)
  const date = opt('--date', new Date().toISOString().slice(0, 10))
  mkdirSync(RESULTS, { recursive: true })
  if (argv.includes('--report')) {
    const file = opt('--report', '')
    const rows = JSON.parse(readFileSync(file, 'utf8'))
    const tag = file.split(/[\\/]/).at(-1)!.replace(/\.json$/, '')
    writeFileSync(file.replace(/\.json$/, '.md'), written(rows, tag) + '\n')
    return console.log(`wrote ${file.replace(/\.json$/, '.md')}`)
  }
  await prepare()
  const longs = opt('--tasks', 'L8,L5').split(',')
  for (const l of longs) if (!LONG[l]) throw new Error(`no long task ${l}: ${Object.keys(LONG).join(', ')}`)
  if (argv.includes('--gold')) {
    // The ceiling: which features the union of the task's gold patches passes. The scorer is wrong if the bare base
    // passes any of them, or if the union does not apply.
    const ceiling: Record<string, boolean[]> = existsSync(goldFile(date)) ? JSON.parse(readFileSync(goldFile(date), 'utf8')) : {}
    let bad = 0
    for (const l of longs) {
      const dir = join(tmpdir(), 'yapbench', 'gold-v4', l)
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      const union = await goldUnion(l, dir)
      const gold = await scoreEach(LONG[l].base, LONG[l].features, union, dir)
      const none = await scoreEach(LONG[l].base, LONG[l].features, '', dir)
      ceiling[l] = gold.per
      LONG[l].features.forEach((f, i) => {
        if (none.per[i]) bad++
        console.log(`${l} ${fname(f)}: union ${gold.per[i] ? 'passes' : 'FAILS'} | base ${none.per[i] ? 'PASSES (scorer wrong)' : 'fails'}`)
      })
      for (const n of gold.notes) console.log(`${l} union: ${n}`)
      console.log(`${l} ceiling: ${gold.per.filter(Boolean).length} of ${gold.per.length} features`)
    }
    writeFileSync(goldFile(date), JSON.stringify(ceiling) + '\n')
    console.log(`wrote ${goldFile(date)}`)
    process.exit(bad ? 1 : 0)
  }
  const repeats = Number(opt('--repeats', '3'))
  const setups = opt('--setups', SETUPS4.join(',')).split(',') as (typeof SETUPS4)[number][]
  for (const s of setups) if (!SETUPS4.includes(s)) throw new Error(`no v4 setup ${s}: ${SETUPS4.join(', ')}`)
  const parallel = Number(opt('--parallel', '3'))
  const minutes = Number(opt('--minutes', '45'))
  const model = opt('--model', 'claude-sonnet-5-5')
  // v4's own names: results, logs and run directories never meet v1's, v2's, v3's or each other's.
  const tag = `${date}-v4${repeats === 1 ? '-dry' : ''}`
  const out = join(RESULTS, `${tag}.json`)
  const logFile = join(RESULTS, `${tag}.log`)
  const rows: Row4[] = existsSync(out) && argv.includes('--resume') ? JSON.parse(readFileSync(out, 'utf8')) : []
  const before = await weekly()
  log(logFile, `bench ${tag}: tasks ${longs.join(',')} × ${repeats} repeats × setups ${setups.join(',')}, model ${model}, ${parallel} at a time, ${minutes} min a run; daemons on ${PORT_BASE}+slot, shared daemon port ${SHARED_PORT} is never used; run dirs ${join(tmpdir(), 'yapbench', tag)}; plan weekly usage ${before ?? '?'}%`)
  // Interleaved so time-of-day and plan throttling fall on every setup alike.
  const queue = longs.flatMap(long => Array.from({ length: repeats }, (_, r) => setups.map(setup => ({ long, repeat: r + 1, setup })))).flat()
  const todo = queue.filter(q => !rows.some(r => r.long === q.long && r.repeat === q.repeat && r.setup === q.setup && !r.limited))
  const slots = Array.from({ length: parallel }, (_, i) => i)
  await Promise.all(
    slots.map(async slot => {
      for (let q = todo.shift(); q; q = todo.shift()) {
        let row = await one({ ...q, slot, date, tag, logFile, model, minutes, retry: argv.includes('--resume') })
        // A run the plan's limit cut short says nothing about the setup: wait and run it again.
        for (let tries = 0; row.limited && tries < 12; tries++) {
          log(logFile, `${row.run}: hit the plan's limit, waiting 20 min to run it again`)
          await wait(20 * 60_000)
          row = await one({ ...q, slot, date, tag, logFile, model, minutes, retry: true })
        }
        const i = rows.findIndex(r => r.run === row.run)
        if (i >= 0) rows.splice(i, 1)
        rows.push(row)
        writeFileSync(out, JSON.stringify(rows, null, 1) + '\n')
      }
    }),
  )
  const after = await weekly()
  writeFileSync(out.replace(/\.json$/, '.md'), written(rows, tag) + '\n')
  const cost = rows.reduce((a, r) => a + r.total_cost_usd, 0)
  log(logFile, `bench ${tag}: done, ${rows.length} rows, ${rows.filter(r => r.error).length} could not run, cost ${usd(cost)}, plan weekly usage ${before ?? '?'}% -> ${after ?? '?'}%`)
  log(logFile, `bench ${tag}: wrote ${out} and ${out.replace(/\.json$/, '.md')}`)
  process.exit(rows.length === queue.length && !rows.some(r => r.error) ? 0 : 1)
}

if (import.meta.main) await main()
