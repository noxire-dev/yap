// The bench: CooperBench task pairs (go-chi) through three ways of running agents, scored on the merged result.
// Spec: docs/bench/brief.md, v2 changes in docs/bench/brief-v2.md, v3's in docs/bench/brief-v3.md. Run `bun bench/run.ts --tasks 1 --repeats 1`
// for the dry run; `--gold` checks the scorer against the dataset's own patches; `--report <json>` rewrites the
// report from a results file.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { phaseSplit, setups as timing } from './trace'

const ROOT = resolve(import.meta.dir, '..')
const CACHE = join(ROOT, 'bench', '.cache')
const DATA = join(CACHE, 'CooperBench', 'dataset', 'go_chi_task')
const CHI = join(CACHE, 'chi')
const SHIM = join(CACHE, 'bin')
const RESULTS = join(ROOT, 'bench', 'results')
const SHARED_PORT = 4170
// v1 holds 4200 + slot, v2 4300 + slot; v3's daemons are 4400 + slot and nothing else.
const PORT_BASE = 4400

export const SETUPS = ['A2', 'D2', 'D3'] as const
export type Setup = (typeof SETUPS)[number]
export const NAMES: Record<Setup, string> = {
  A2: 'subagents, trusting (Task tool, features as files)',
  D2: 'commander on Haiku, pointing (yap spawn)',
  D3: 'D2 with lean ponytail workers (yap spawn --skills ponytail)',
}
/** The setups whose agents load yap (from this repo, through --plugin-dir). */
export const WITH_YAP: Record<Setup, boolean> = { A2: false, D2: true, D3: true }
/** What each agent's init line must list: the first agent of a run (the parent, the commander), then every other. */
export const INIT: Record<Setup, { lead: string; rest: string }> = {
  A2: { lead: '', rest: '' },
  D2: { lead: 'yap', rest: 'yap' },
  D3: { lead: 'yap', rest: 'ponytail,yap' },
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

// ---------- pure parts (bench/bench.check.ts) ----------

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

/** A fresh checkout of the task's base commit on branch main, with no remote to fetch answers from. */
async function checkout(task: string, dir: string) {
  await must(sh(['git', 'clone', '-q', '--no-checkout', CHI, dir], ROOT), 'clone')
  await must(git(dir, 'checkout', '-q', '-b', 'main', BASE[task]), 'checkout base')
  await must(git(dir, 'remote', 'remove', 'origin'), 'remove origin')
}

/** Everything in `dir`'s tree against `base`, untracked files included. */
async function patchOf(dir: string, base: string) {
  await must(git(dir, 'add', '-A'), 'add')
  return must(git(dir, 'diff', '--cached', '--binary', base), 'diff')
}

/** Both features' hidden tests on a fresh base checkout with `patch` applied. */
export async function score(task: string, pair: [number, number], patch: string, dir: string) {
  const res: boolean[] = []
  const notes: string[] = []
  for (const f of pair) {
    const d = join(dir, `score-${f}`)
    await checkout(task, d)
    const mine = dropTests(patch)
    let ok = true
    if (mine.trim()) {
      writeFileSync(join(dir, 'final.patch'), mine)
      ok = (await git(d, 'apply', '--ignore-whitespace', join(dir, 'final.patch'))).ok
      if (!ok) notes.push(`feature ${f}: the final patch does not apply`)
    }
    const tests = join(DATA, `task${task}`, `feature${f}`, 'tests.patch')
    if (ok) ok = (await git(d, 'apply', '--ignore-whitespace', tests)).ok || (await git(d, 'apply', '--3way', tests)).ok
    if (ok) {
      const run = await sh(['go', 'test', '-run', testFuncs(readFileSync(tests, 'utf8')).join('|'), './...'], d, { timeout: 600_000 })
      ok = run.ok
      if (!ok) notes.push(`feature ${f}: ${(run.out + run.err).split('\n').filter(l => /FAIL|error|undefined/.test(l)).slice(0, 3).join(' | ')}`)
    }
    res.push(ok)
    rmSync(d, { recursive: true, force: true })
  }
  return { f1: res[0], f2: res[1], notes }
}

interface Ctx {
  dir: string
  repo: string
  task: string
  pair: [number, number]
  env: Record<string, string>
  deadline: number
  logFile: string
  notes: string[]
  merge_conflict_files: number
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

async function api<T>(c: Ctx, path: string): Promise<T> {
  const token = readFileSync(join(c.env.YAP_HOME, 'token'), 'utf8').trim()
  const r = await fetch(`http://127.0.0.1:${c.env.YAP_PORT}${path}`, { headers: { 'x-yap-token': token } })
  if (!r.ok) throw new Error(`${path}: ${r.status}`)
  return r.json() as Promise<T>
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

/** The pair's features as files outside the repo (`<run dir>/features/1.md`, `2.md`), so nothing of them lands in the patch. */
function featureFiles(c: Ctx) {
  mkdirSync(join(c.dir, 'features'), { recursive: true })
  return c.pair.map((f, i) => {
    const p = join(c.dir, 'features', `${i + 1}.md`)
    writeFileSync(p, feature(c.task, f) + '\n')
    return p.replace(/\\/g, '/')
  })
}

// A2 and D2/D3 share the trust rule: the workers run the tests and report, the lead re-runs and fixes nothing unless
// one reported a failure.
const TRUST = "The workers run the tests: each must run `go test ./...` before it finishes and end with whether the tests passed. Do not re-run the tests yourself and do not review or fix their work, unless a worker reported a failing test or an unfinished feature: only then fix that, and run `go test ./...` once after your fix. Nobody will answer questions: make the calls yourself."

/** D2 and D3: a commander on Haiku that points each worker at its feature's file. */
async function commander(c: Ctx, spawn: string) {
  const [f1, f2] = featureFiles(c)
  await agent(
    c,
    c.repo,
    `This repository needs two features, written up in \`${f1}\` and \`${f2}\`. Do not read them. Start one background worker per feature with \`${spawn} <task>\`, the task one line: "Implement the feature in <its path>. Another worker builds another feature in this same working tree at the same time. Run \`go test ./...\` before you finish and end with whether the tests passed." Each worker's last word comes back to you on its own when it ends, so do not poll. Wait for both. ${TRUST}`,
    true,
    COMMANDER,
  )
  // The commander may end before its workers do: the run is over when every spawn is.
  let spawns: { done?: number; ok?: boolean; result?: string }[] = []
  while (Date.now() < c.deadline) {
    spawns = await api(c, '/api/spawns')
    if (spawns.every(s => s.done)) break
    await wait(10_000)
  }
  if (!spawns.length) c.notes.push('the commander started no workers')
  for (const s of spawns) if (!s.done) c.notes.push('out of time: a worker was still running at the run deadline')
  else if (!s.ok) c.notes.push(`a worker failed: ${String(s.result ?? '').slice(0, 120)}`)
  return patchOf(c.repo, BASE[c.task])
}

/** Each setup leaves the patch the run produced, against the base commit. */
const RUN: Record<Setup, (c: Ctx) => Promise<string>> = {
  async A2(c) {
    const [f1, f2] = featureFiles(c)
    await agent(
      c,
      c.repo,
      `This repository needs two features, written up in \`${f1}\` and \`${f2}\`. Do not read them. Give each to its own subagent with the Task tool, both at once, telling each in one line to implement the feature in its file's path, that another subagent builds another feature in this same working tree at the same time, and to run \`go test ./...\` before it finishes and end with whether the tests passed. ${TRUST.replaceAll('worker', 'subagent')}`,
      false,
    )
    return patchOf(c.repo, BASE[c.task])
  },
  D2: c => commander(c, 'yap spawn'),
  D3: c => commander(c, 'yap spawn --skills ponytail'),
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
  if (port < PORT_BASE || port >= PORT_BASE + 100) throw new Error(`refusing port ${port}: v3's daemons are on ${PORT_BASE}-${PORT_BASE + 99}`)
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

async function one(o: { task: string; pair: [number, number]; repeat: number; setup: Setup; slot: number; date: string; tag: string; logFile: string; model: string; minutes: number; retry?: boolean }): Promise<Row> {
  const run = `${o.task}-${o.pair.join('_')}-r${o.repeat}-${o.setup}`
  const dir = runDir(o.tag, run, !!o.retry)
  const home = join(dir, 'yap')
  const port = PORT_BASE + o.slot
  const env = runEnv(home, port, join(dir, 'logs'), o.model, WITH_YAP[o.setup])
  const c: Ctx = { dir, repo: join(dir, 'repo'), task: o.task, pair: o.pair, env, deadline: Date.now() + o.minutes * 60_000, logFile: o.logFile, notes: [], merge_conflict_files: 0 }
  const row: Row = {
    date: o.date, run, task: o.task, pair: o.pair, repeat: o.repeat, setup: o.setup, pass: false, f1: false, f2: false,
    total_cost_usd: 0, tokens: 0, tokens_detail: { input: 0, output: 0, cache_read: 0, cache_creation: 0 }, lines_added: 0, wall_s: 0,
    collisions: 0, collisions_detail: { merge_conflict_files: 0, destructive_git: 0, stale_edits: 0 }, interventions: 0, interventions_detail: [],
    agents: 0, api_key_sources: [], plugins: [], daemon: { home, port },
  }
  let patch = ''
  const t0 = Date.now()
  try {
    await checkout(o.task, c.repo)
    log(o.logFile, `${run}: start, setup ${o.setup} (${NAMES[o.setup]}), throwaway daemon YAP_HOME=${home} YAP_PORT=${port}`)
    await must(sh(['bun', join(ROOT, 'src', 'cli.ts'), 'start'], dir, { env, timeout: 60_000 }), 'starting the throwaway daemon')
    patch = await RUN[o.setup](c)
  } catch (e: any) {
    row.error = String(e?.message ?? e)
    log(o.logFile, `${run}: could not run: ${row.error}`)
  } finally {
    row.wall_s = Math.round((Date.now() - t0) / 1000)
    await sh(['bun', join(ROOT, 'src', 'cli.ts'), 'stop'], dir, { env, timeout: 60_000 }).catch(() => {})
  }
  const lines = existsSync(join(dir, 'logs'))
    ? readdirSync(join(dir, 'logs')).sort().flatMap(f => readFileSync(join(dir, 'logs', f), 'utf8').split('\n').flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } }))
    : []
  const t = tally(lines)
  Object.assign(row, {
    total_cost_usd: Math.round(t.cost * 10000) / 10000,
    tokens: t.input + t.output + t.cache_read + t.cache_creation,
    tokens_detail: { input: t.input, output: t.output, cache_read: t.cache_read, cache_creation: t.cache_creation },
    lines_added: patch.trim() ? await added(c.repo, BASE[o.task]) : 0,
    agents: t.agents,
    api_key_sources: [...t.sources],
    limited: t.limited || undefined,
  })
  const found = plugins(lines)
  row.plugins = found.map(p => p ?? [])
  const init = initCheck(found, INIT[o.setup])
  if (init && !t.limited) row.error = row.error ? `${row.error}; ${init}` : init
  log(o.logFile, `${run}: ${init || `init check ok: ${found.length} agents, ${found.map((p, i) => `agent ${i + 1} [${p!.join(', ')}]`).join(', ')}`}`)
  row.collisions_detail = { merge_conflict_files: c.merge_conflict_files, destructive_git: t.destructive, stale_edits: t.stale }
  row.collisions = c.merge_conflict_files + t.destructive + t.stale
  row.interventions_detail = [...c.notes.filter(n => !n.startsWith('merge conflict')), ...t.failed, ...Array(t.asked).fill('an agent asked a person')]
  row.interventions = row.interventions_detail.length
  // A run whose agents were not the clean ones the setup names fails: its result says nothing about the setup.
  if (!row.error && patch.trim()) {
    const s = await score(o.task, o.pair, patch, dir)
    Object.assign(row, { f1: s.f1, f2: s.f2, pass: s.f1 && s.f2 })
    for (const n of s.notes) log(o.logFile, `${run}: ${n}`)
  }
  if (row.api_key_sources.some(s => s !== 'none')) log(o.logFile, `${run}: WARNING an agent signed in with ${row.api_key_sources.join(', ')}, not the plan`)
  log(o.logFile, `${run}: ${row.pass ? 'PASS' : 'FAIL'} f1=${row.f1} f2=${row.f2} cost=${usd(row.total_cost_usd)} tokens=${row.tokens} wall=${row.wall_s}s collisions=${row.collisions} interventions=${row.interventions} agents=${row.agents}${row.limited ? ' LIMITED' : ''}${c.notes.length ? ` notes: ${c.notes.join('; ')}` : ''}`)
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

/** The report with everything it reads beside the rows: the timing and phase splits, and v2's rows to compare with. */
function written(rows: Row[], tag: string) {
  const v2 = join(RESULTS, '2026-11-21-v2.json')
  return report(rows, tag, trace(timing, tag), { phases: trace(phaseSplit, tag), v2: existsSync(v2) ? JSON.parse(readFileSync(v2, 'utf8')) : undefined })
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
    const rows: Row[] = JSON.parse(readFileSync(file, 'utf8'))
    const tag = file.split(/[\\/]/).at(-1)!.replace(/\.json$/, '')
    writeFileSync(file.replace(/\.json$/, '.md'), written(rows, tag) + '\n')
    return console.log(`wrote ${file.replace(/\.json$/, '.md')}`)
  }
  await prepare()
  if (argv.includes('--gold')) {
    // The scorer against the dataset itself: the base fails each pair, the combined gold patch passes it.
    let bad = 0
    for (const [task, f1, f2] of PAIRS) {
      const dir = join(tmpdir(), 'yapbench', 'gold', `${task}-${f1}_${f2}`)
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      const gold = await score(task, [f1, f2], readFileSync(join(DATA, `task${task}`, 'combined.patch'), 'utf8'), dir)
      const none = await score(task, [f1, f2], '', dir)
      const ok = gold.f1 && gold.f2 && !none.f1 && !none.f2
      if (!ok) bad++
      console.log(`${task}[${f1},${f2}] gold f1=${gold.f1} f2=${gold.f2} | base f1=${none.f1} f2=${none.f2} ${ok ? 'ok' : `WRONG ${gold.notes.join('; ')}`}`)
    }
    process.exit(bad ? 1 : 0)
  }
  const tasks = Number(opt('--tasks', '6'))
  const repeats = Number(opt('--repeats', '3'))
  const setups = opt('--setups', SETUPS.join(',')).split(',') as Setup[]
  const parallel = Number(opt('--parallel', '3'))
  const minutes = Number(opt('--minutes', '45'))
  const model = opt('--model', 'claude-sonnet-5-5')
  // v3's own names: results, logs and run directories never meet v1's (<date>), v2's (<date>-v2) or each other's.
  const tag = `${date}-v3${tasks === 1 && repeats === 1 ? '-dry' : ''}`
  const out = join(RESULTS, `${tag}.json`)
  const logFile = join(RESULTS, `${tag}.log`)
  const rows: Row[] = existsSync(out) && argv.includes('--resume') ? JSON.parse(readFileSync(out, 'utf8')) : []
  const before = await weekly()
  log(logFile, `bench ${tag}: ${tasks} pairs × ${repeats} repeats × setups ${setups.join('')}, model ${model}, ${parallel} at a time, ${minutes} min a run; daemons on ${PORT_BASE}+slot, shared daemon port ${SHARED_PORT} is never used; run dirs ${join(tmpdir(), 'yapbench', tag)}; plan weekly usage ${before ?? '?'}%`)
  // Interleaved so time-of-day and plan throttling fall on every setup alike.
  const queue = PAIRS.slice(0, tasks).flatMap(([task, f1, f2]) => Array.from({ length: repeats }, (_, r) => setups.map(setup => ({ task, pair: [f1, f2] as [number, number], repeat: r + 1, setup })))).flat()
  const todo = queue.filter(q => !rows.some(r => r.task === q.task && r.pair.join() === q.pair.join() && r.repeat === q.repeat && r.setup === q.setup && !r.limited))
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
}

if (import.meta.main) await main()
