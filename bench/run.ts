// The bench: CooperBench task pairs (go-chi) through five ways of running agents, scored on the merged result.
// Spec: docs/bench/brief.md. Run `bun bench/run.ts --tasks 1 --repeats 1` for the dry run; `--gold` checks the
// scorer against the dataset's own patches; `--report <json>` rewrites the report from a results file.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const CACHE = join(ROOT, 'bench', '.cache')
const DATA = join(CACHE, 'CooperBench', 'dataset', 'go_chi_task')
const CHI = join(CACHE, 'chi')
const SHIM = join(CACHE, 'bin')
const RESULTS = join(ROOT, 'bench', 'results')
const SHARED_PORT = 4170

export const SETUPS = ['A', 'B', 'C', 'D', 'E'] as const
export type Setup = (typeof SETUPS)[number]
export const NAMES: Record<Setup, string> = {
  A: 'subagents (one session, Task tool)',
  B: 'bare parallel (two sessions, no yap)',
  C: 'yap peers (two sessions with yap)',
  D: 'commander (yap spawn, workers share a tree)',
  E: 'crew (yap goal + yap go, test gate)',
}

// The go-chi pairs of CooperBench's lite and core subsets: the language this machine runs without Docker.
const BASE: Record<string, string> = { '26': '9436cc85db0d35be06e66b91b4f74bbc0295b07b', '27': '9436cc85db0d35be06e66b91b4f74bbc0295b07b', '56': '7f280968675bcc9f310008fc6b8abff0b923734c' }
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
  wall_s: number
  collisions: number
  collisions_detail: { merge_conflict_files: number; destructive_git: number; stale_edits: number }
  interventions: number
  interventions_detail: string[]
  agents: number
  api_key_sources: string[]
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

const pct = (x: number) => `${Math.round(x * 100)}%`
// Three places and seconds: medians a few cents or seconds apart must not print as a tie that "lost".
const usd = (x: number) => `$${x.toFixed(3)}`
const mins = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`

/** Medians per setup, and for each setup where it lost: the metrics it was not best on, and the pairs it failed. */
export function report(rows: Row[], date: string, raw = `${date}.json`) {
  const by = (s: Setup) => rows.filter(r => r.setup === s)
  const stat = SETUPS.map(s => {
    const rs = by(s)
    return {
      s,
      n: rs.length,
      errors: rs.filter(r => r.error).length,
      pass: rs.length ? rs.filter(r => r.pass).length / rs.length : NaN,
      cost: median(rs.map(r => r.total_cost_usd)),
      tokens: median(rs.map(r => r.tokens)),
      wall: median(rs.map(r => r.wall_s)),
      collisions: median(rs.map(r => r.collisions)),
      interventions: median(rs.map(r => r.interventions)),
    }
  })
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
    `${rows.length} runs: ${[...new Set(rows.map(r => `${r.task}[${r.pair.join(',')}]`))].length} CooperBench go-chi pairs × ${Math.max(...rows.map(r => r.repeat))} repeats × 5 setups, on the user's Claude plan through \`claude -p\`. Pass is both features' hidden tests on the merged tree. Cost is Claude Code's own \`total_cost_usd\` (the API-price equivalent; the plan was billed, not an API key). Harness: \`bench/run.ts\`, spec: \`docs/bench/brief.md\`, raw rows: \`bench/results/${raw}\`.`,
    '',
    '| Setup | Runs | Pass | Median cost | Median tokens | Median wall-clock | Median collisions | Median interventions |',
    '|---|---|---|---|---|---|---|---|',
    ...stat.map(x => `| ${x.s}: ${NAMES[x.s]} | ${x.n}${x.errors ? ` (${x.errors} could not run)` : ''} | ${x.n ? pct(x.pass) : '-'} | ${x.n ? usd(x.cost) : '-'} | ${x.n ? Math.round(x.tokens).toLocaleString('en') : '-'} | ${x.n ? mins(x.wall) : '-'} | ${x.n ? x.collisions : '-'} | ${x.n ? x.interventions : '-'} |`),
    '',
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
    if (x.wall > best.wall) lost.push(`wall-clock (${mins(x.wall)} against ${winner('wall')}'s ${mins(best.wall)})`)
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
const title = (md: string) => (md.match(/Title\**:?\**\s*(.+)/)?.[1] ?? md.split('\n')[0]).replace(/[#*]/g, '').trim()

async function prepare() {
  if (!existsSync(DATA)) await must(sh(['git', 'clone', '--depth', '1', 'https://github.com/cooperbench/CooperBench', join(CACHE, 'CooperBench')], ROOT), 'fetching CooperBench')
  if (!existsSync(CHI)) await must(sh(['git', 'clone', '-q', 'https://github.com/go-chi/chi', CHI], ROOT), 'fetching go-chi')
  if (!existsSync(join(SHIM, 'claude.exe')) && !existsSync(join(SHIM, 'claude')))
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

/** One headless Claude Code, through the shim like every other in the run. */
async function agent(c: Ctx, cwd: string, prompt: string, yap: boolean) {
  const env = { ...c.env, ...(yap ? {} : { YAP_AGENT: '1' }) }
  const args = ['claude', '-p', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none', '--strict-mcp-config', '--no-session-persistence', '--permission-mode', 'auto']
  const p = Bun.spawn(args, { cwd, env, stdin: 'pipe', stdout: 'ignore', stderr: 'pipe', windowsHide: true, timeout: Math.max(1000, c.deadline - Date.now()), killSignal: 'SIGKILL' })
  p.stdin.write(prompt)
  p.stdin.end()
  const err = await new Response(p.stderr).text()
  await p.exited
  if (Date.now() >= c.deadline) c.notes.push('out of time: an agent was stopped at the run deadline')
  else if (p.exitCode !== 0 && err.trim()) c.notes.push(`agent exited ${p.exitCode}: ${err.trim().slice(0, 160)}`)
}

const yapCli = (c: Ctx, cwd: string, ...a: string[]) => sh(['bun', join(ROOT, 'src', 'cli.ts'), ...a], cwd, { env: { ...c.env, YAP_AGENT: '1' }, timeout: 120_000 })
async function api<T>(c: Ctx, path: string): Promise<T> {
  const token = readFileSync(join(c.env.YAP_HOME, 'token'), 'utf8').trim()
  const r = await fetch(`http://127.0.0.1:${c.env.YAP_PORT}${path}`, { headers: { 'x-yap-token': token } })
  if (!r.ok) throw new Error(`${path}: ${r.status}`)
  return r.json() as Promise<T>
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

const RULES = 'Nobody will answer questions: make the calls yourself. Run `go test ./...` before you finish.'
const both = (c: Ctx) => `## Feature 1\n\n${feature(c.task, c.pair[0])}\n\n## Feature 2\n\n${feature(c.task, c.pair[1])}`
const worker = (c: Ctx, i: 0 | 1, yap: boolean) =>
  `Implement the feature below in this repository. Another agent is implementing a different feature at the same time in its own copy of the repository ("${title(feature(c.task, c.pair[1 - i]))}"), and the two copies are merged when you both finish, so keep your change to what your feature needs. ${RULES} Leave your work in the working tree or commit it.` +
  (yap ? ' yap is running: the other agent is a peer you can message with `yap say`, and `yap claim` warns it off the files you edit. Settle with it anything both features touch, since the copies get merged.' : '') +
  `\n\n## Your feature\n\n${feature(c.task, c.pair[i])}`

/** Each setup leaves the patch the run produced, against the base commit. */
const RUN: Record<Setup, (c: Ctx) => Promise<string>> = {
  async A(c) {
    await agent(c, c.repo, `This repository needs the two features below. Give each to its own subagent with the Task tool, both at once, then read what they did and fix anything left. ${RULES}\n\n${both(c)}`, false)
    return patchOf(c.repo, BASE[c.task])
  },
  B: c => apart(c, false),
  C: c => apart(c, true),
  async D(c) {
    await agent(
      c,
      c.repo,
      `This repository needs the two features below. Start one background worker per feature with \`yap spawn <task>\`, giving each the full text of its feature and telling it that another worker builds the other feature in this same working tree at the same time. Then wait until both have finished (\`yap spawns\` shows how each ended), check the result and fix anything left. ${RULES}\n\n${both(c)}`,
      true,
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
  },
  async E(c) {
    await must(yapCli(c, c.repo, 'init'), 'yap init')
    await must(yapCli(c, c.repo, 'gate', 'go test ./...'), 'yap gate')
    const said = await must(yapCli(c, c.repo, 'goal', `Implement the two features below in this repository.\n\n${both(c)}`), 'yap goal')
    const id = Number(said.match(/goal (\d+)/)?.[1])
    if (!id) throw new Error(`yap goal said: ${said.trim()}`)
    type St = { goals: { id: number; status: string; note?: string }[]; tickets: { goal_id: number; status: string; title: string }[] }
    let started = false
    while (Date.now() < c.deadline) {
      const s = await api<St>(c, '/api/state')
      const g = s.goals.find(g => g.id === id)
      if (g?.status === 'failed' || g?.status === 'dropped') {
        c.notes.push(`the goal ${g.status}: ${g.note ?? ''}`)
        break
      }
      const mine = s.tickets.filter(t => t.goal_id === id)
      if (!started && g?.status === 'ready' && mine.some(t => t.status === 'draft')) {
        await must(yapCli(c, c.repo, 'go', String(id)), 'yap go')
        started = true
      } else if (started && mine.every(t => ['merged', 'dropped', 'escalated'].includes(t.status))) {
        for (const t of mine.filter(t => t.status === 'escalated')) c.notes.push(`ticket escalated to a person: ${t.title}`)
        break
      }
      await wait(10_000)
    }
    if (Date.now() >= c.deadline) c.notes.push('out of time: the crew was still working at the run deadline')
    return must(git(c.repo, 'diff', '--binary', BASE[c.task], 'main'), 'diff main')
  },
}

/** B and C: one worktree per agent, both at once, then a plain merge. A conflict fails the run (CooperBench's rule). */
async function apart(c: Ctx, yap: boolean) {
  const trees = [join(c.dir, 'agent1'), join(c.dir, 'agent2')]
  for (const [i, t] of trees.entries()) await must(git(c.repo, 'worktree', 'add', '-q', '-b', `agent${i + 1}`, t, BASE[c.task]), 'worktree add')
  await Promise.all(trees.map((t, i) => agent(c, t, worker(c, i as 0 | 1, yap), yap)))
  for (const t of trees) {
    await must(git(t, 'add', '-A'), 'add')
    await must(git(t, 'commit', '-q', '--allow-empty', '-m', 'agent work'), 'commit')
  }
  await must(git(c.repo, 'merge', '-q', '--ff', 'agent1'), 'merge agent1')
  const m = await git(c.repo, 'merge', '-q', '--no-ff', '--no-edit', 'agent2')
  if (!m.ok) {
    const files = (await git(c.repo, 'diff', '--name-only', '--diff-filter=U')).out.trim().split('\n').filter(Boolean)
    c.merge_conflict_files = files.length || 1
    c.notes.push(`merge conflict in ${files.join(', ') || 'the merge'}`)
    await git(c.repo, 'merge', '--abort')
    return ''
  }
  return must(git(c.repo, 'diff', '--binary', BASE[c.task], 'HEAD'), 'diff merged')
}

const realClaude = () => {
  const own = resolve(SHIM)
  const path = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(p => resolve(p) !== own).join(process.platform === 'win32' ? ';' : ':')
  const r = Bun.which('claude', { PATH: path })
  if (!r) throw new Error('claude is not installed')
  return r
}

/** The environment every agent and daemon of a run gets: no API key, no ids from the session that started the bench. */
function runEnv(home: string, port: number, logs: string, model: string) {
  if (port === SHARED_PORT || resolve(home) === resolve(join(homedir(), '.yap'))) throw new Error('refusing to touch the shared daemon')
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
    YAP_PASS: 'BENCH_REAL_CLAUDE,BENCH_LOG_DIR,BENCH_MODEL',
    // `yap gate` asks for a yes on the desktop; a throwaway daemon must not put dialogs in front of the user.
    YAP_YOLO: '1',
  }
}

async function one(o: { task: string; pair: [number, number]; repeat: number; setup: Setup; slot: number; date: string; logFile: string; model: string; minutes: number }): Promise<Row> {
  const run = `${o.task}-${o.pair.join('_')}-r${o.repeat}-${o.setup}`
  const dir = join(tmpdir(), 'yapbench', o.date, run)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const home = join(dir, 'yap')
  const port = 4200 + o.slot
  const env = runEnv(home, port, join(dir, 'logs'), o.model)
  const c: Ctx = { dir, repo: join(dir, 'repo'), task: o.task, pair: o.pair, env, deadline: Date.now() + o.minutes * 60_000, logFile: o.logFile, notes: [], merge_conflict_files: 0 }
  const row: Row = {
    date: o.date, run, task: o.task, pair: o.pair, repeat: o.repeat, setup: o.setup, pass: false, f1: false, f2: false,
    total_cost_usd: 0, tokens: 0, tokens_detail: { input: 0, output: 0, cache_read: 0, cache_creation: 0 }, wall_s: 0,
    collisions: 0, collisions_detail: { merge_conflict_files: 0, destructive_git: 0, stale_edits: 0 }, interventions: 0, interventions_detail: [],
    agents: 0, api_key_sources: [], daemon: { home, port },
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
    ? readdirSync(join(dir, 'logs')).flatMap(f => readFileSync(join(dir, 'logs', f), 'utf8').split('\n').flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } }))
    : []
  const t = tally(lines)
  Object.assign(row, {
    total_cost_usd: Math.round(t.cost * 10000) / 10000,
    tokens: t.input + t.output + t.cache_read + t.cache_creation,
    tokens_detail: { input: t.input, output: t.output, cache_read: t.cache_read, cache_creation: t.cache_creation },
    agents: t.agents,
    api_key_sources: [...t.sources],
    limited: t.limited || undefined,
  })
  row.collisions_detail = { merge_conflict_files: c.merge_conflict_files, destructive_git: t.destructive, stale_edits: t.stale }
  row.collisions = c.merge_conflict_files + t.destructive + t.stale
  row.interventions_detail = [...c.notes.filter(n => !n.startsWith('merge conflict')), ...t.failed, ...Array(t.asked).fill('an agent asked a person')]
  row.interventions = row.interventions_detail.length
  if (!row.error && patch.trim()) {
    const s = await score(o.task, o.pair, patch, dir)
    Object.assign(row, { f1: s.f1, f2: s.f2, pass: s.f1 && s.f2 })
    for (const n of s.notes) log(o.logFile, `${run}: ${n}`)
  }
  if (row.api_key_sources.some(s => s !== 'none')) log(o.logFile, `${run}: WARNING an agent signed in with ${row.api_key_sources.join(', ')}, not the plan`)
  log(o.logFile, `${run}: ${row.pass ? 'PASS' : 'FAIL'} f1=${row.f1} f2=${row.f2} cost=${usd(row.total_cost_usd)} tokens=${row.tokens} wall=${row.wall_s}s collisions=${row.collisions} interventions=${row.interventions} agents=${row.agents}${row.limited ? ' LIMITED' : ''}${c.notes.length ? ` notes: ${c.notes.join('; ')}` : ''}`)
  return row
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

/** The report next to its results, with the hand-written notes on how the run went (<tag>.notes.md) after it. */
function writeReport(json: string, rows: Row[], date: string) {
  const notes = json.replace(/\.json$/, '.notes.md')
  const extra = existsSync(notes) ? `\n${readFileSync(notes, 'utf8').trim()}\n` : ''
  writeFileSync(json.replace(/\.json$/, '.md'), `${report(rows, date, basename(json))}\n${extra}`)
}

async function main() {
  const argv = process.argv.slice(2)
  const opt = (k: string, d: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d)
  const date = opt('--date', new Date().toISOString().slice(0, 10))
  mkdirSync(RESULTS, { recursive: true })
  if (argv.includes('--report')) {
    const file = opt('--report', '')
    const rows: Row[] = JSON.parse(readFileSync(file, 'utf8'))
    writeReport(file, rows, rows[0]?.date ?? date)
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
  const tag = tasks === 1 && repeats === 1 ? `${date}-dry` : date
  const out = join(RESULTS, `${tag}.json`)
  const logFile = join(RESULTS, `${tag}.log`)
  // The rows a stopped run already wrote are kept; --fresh starts over.
  const rows: Row[] = existsSync(out) && !argv.includes('--fresh') ? JSON.parse(readFileSync(out, 'utf8')) : []
  const before = await weekly()
  log(logFile, `bench ${tag}: ${tasks} pairs × ${repeats} repeats × setups ${setups.join('')}, model ${model}, ${parallel} at a time, ${minutes} min a run; shared daemon port ${SHARED_PORT} is never used; plan weekly usage ${before ?? '?'}%`)
  // Interleaved so time-of-day and plan throttling fall on every setup alike.
  const queue = PAIRS.slice(0, tasks).flatMap(([task, f1, f2]) => Array.from({ length: repeats }, (_, r) => setups.map(setup => ({ task, pair: [f1, f2] as [number, number], repeat: r + 1, setup })))).flat()
  const todo = queue.filter(q => !rows.some(r => r.task === q.task && r.pair.join() === q.pair.join() && r.repeat === q.repeat && r.setup === q.setup && !r.limited))
  const slots = Array.from({ length: parallel }, (_, i) => i)
  await Promise.all(
    slots.map(async slot => {
      for (let q = todo.shift(); q; q = todo.shift()) {
        let row = await one({ ...q, slot, date, logFile, model, minutes })
        // A run the plan's limit cut short says nothing about the setup: wait and run it again.
        for (let tries = 0; row.limited && tries < 12; tries++) {
          log(logFile, `${row.run}: hit the plan's limit, waiting 20 min to run it again`)
          await wait(20 * 60_000)
          row = await one({ ...q, slot, date, logFile, model, minutes })
        }
        const i = rows.findIndex(r => r.run === row.run)
        if (i >= 0) rows.splice(i, 1)
        rows.push(row)
        writeFileSync(out, JSON.stringify(rows, null, 1) + '\n')
      }
    }),
  )
  const after = await weekly()
  writeReport(out, rows, date)
  const cost = rows.reduce((a, r) => a + r.total_cost_usd, 0)
  log(logFile, `bench ${tag}: done, ${rows.length} rows, ${rows.filter(r => r.error).length} could not run, cost ${usd(cost)}, plan weekly usage ${before ?? '?'}% -> ${after ?? '?'}%`)
  log(logFile, `bench ${tag}: wrote ${out} and ${out.replace(/\.json$/, '.md')}`)
}

if (import.meta.main) await main()
