// Where a bench run's time went. Reads the per-agent logs the shim writes (stream-json, one file per claude
// process, named <start ms>-<pid>.jsonl) and splits each agent's wall-clock into start-up, model time and tool time,
// with subagents as lanes of their own. Nothing here runs an agent.
//
//   bun bench/trace.ts <run dir | run id>          the run's lanes, slowest tools, and gaps where nobody worked
//   bun bench/trace.ts <run> --html out.html       the same as a timeline
//   bun bench/trace.ts --setups [<date>]           median split per setup across every run of a date
//   bun bench/trace.ts --archive [<dir>]           copy every run's logs out before the runner reuses its directory
//
// A run id is a directory name under %TEMP%/yapbench/<date>/, like 26-1_2-r1-D.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

type Seg = { kind: 'start' | 'model' | 'tool'; from: number; to: number; label?: string }
type Lane = { name: string; segs: Seg[]; start: number; end: number; cost: number; turns: number }
type Trace = { run: string; t0: number; t1: number; lanes: Lane[] }

const ROOT = join(tmpdir(), 'yapbench')

/** One claude process's log into lanes: the agent itself, then one per subagent it ran. */
function lanes(file: string, n: number): Lane[] {
  const started = Number(basename(file).split('-')[0])
  const byLane = new Map<string, { segs: Seg[]; last: number; pending: Map<string, { at: number; label: string }> }>()
  let cost = 0, turns = 0, cwd = '', end = started
  const lane = (id: string) => {
    let l = byLane.get(id)
    if (!l) byLane.set(id, (l = { segs: [], last: NaN, pending: new Map() }))
    return l
  }
  const main = lane('')
  main.last = started
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    let m: any
    try { m = JSON.parse(line) } catch { continue }
    if (m.type === 'bench_argv') cwd = basename(m.cwd ?? '')
    if (m.type === 'result') (cost = m.total_cost_usd ?? 0), (turns = m.num_turns ?? 0)
    const at = m.timestamp ? Date.parse(m.timestamp) : NaN
    if (Number.isNaN(at)) continue
    end = Math.max(end, at)
    const l = lane(m.parent_tool_use_id ?? '')
    if (Number.isNaN(l.last)) l.last = at
    if (m.type === 'assistant') {
      // The model's turn ran from the last thing it was waiting on to this message; one turn can arrive as several
      // messages (thinking, text, a tool call), so extend the previous model segment rather than start a new one.
      const prev = l.segs.at(-1)
      if (prev?.kind === 'model' && prev.to >= l.last) prev.to = at
      else l.segs.push({ kind: l === main && !main.segs.length ? 'start' : 'model', from: l.last, to: at })
      l.last = at
      for (const c of m.message?.content ?? []) if (c.type === 'tool_use') l.pending.set(c.id, { at, label: toolLabel(c) })
    } else if (m.type === 'user') {
      for (const c of m.message?.content ?? []) {
        const p = c.type === 'tool_result' && l.pending.get(c.tool_use_id)
        if (!p) continue
        l.segs.push({ kind: 'tool', from: p.at, to: at, label: p.label })
        l.pending.delete(c.tool_use_id)
      }
      l.last = at
    }
  }
  const out: Lane[] = []
  for (const [id, l] of byLane) {
    if (!l.segs.length) continue
    const name = id ? `  subagent ${id.slice(-6)}` : `agent ${n} (${cwd || '?'})`
    out.push({ name, segs: l.segs, start: id ? l.segs[0].from : started, end: id ? l.segs.at(-1)!.to : end, cost: id ? 0 : cost, turns: id ? 0 : turns })
  }
  return out
}

function toolLabel(c: any): string {
  const i = c.input ?? {}
  const what = i.file_path ? basename(i.file_path) : i.command ? String(i.command).split('\n')[0] : i.description ?? i.pattern ?? ''
  return `${c.name} ${String(what).replace(/^cd \S+ && /, '').slice(0, 60)}`.trim()
}

function load(run: string): Trace {
  const dir = existsSync(run) ? run : findRun(run)
  const logs = join(dir, 'logs')
  const files = existsSync(logs) ? readdirSync(logs).filter(f => f.endsWith('.jsonl')).sort() : []
  const all = files.flatMap((f, i) => lanes(join(logs, f), i + 1))
  if (!all.length) throw new Error(`no agent logs in ${logs}`)
  return { run: basename(dir), t0: Math.min(...all.map(l => l.start)), t1: Math.max(...all.map(l => l.end)), lanes: all }
}

function findRun(id: string) {
  for (const date of existsSync(ROOT) ? readdirSync(ROOT).sort().reverse() : []) if (existsSync(join(ROOT, date, id))) return join(ROOT, date, id)
  throw new Error(`no run ${id} under ${ROOT}`)
}

const sum = (segs: Seg[], kind: Seg['kind']) => segs.filter(s => s.kind === kind).reduce((a, s) => a + (s.to - s.from), 0)
const sec = (ms: number) => (ms / 1000).toFixed(1).padStart(6)

/** Stretches inside the run where no lane had a segment open: start-up of a spawn, the runner, a daemon. */
function gaps(t: Trace, min = 2000) {
  const segs = t.lanes.flatMap(l => l.segs).sort((a, b) => a.from - b.from)
  const out: { from: number; to: number }[] = []
  let reach = t.t0
  for (const s of segs) {
    if (s.from - reach >= min) out.push({ from: reach, to: s.from })
    reach = Math.max(reach, s.to)
  }
  return out
}

function report(t: Trace) {
  const rows = [`run ${t.run}  wall ${((t.t1 - t.t0) / 1000).toFixed(1)}s  lanes ${t.lanes.length}  cost $${t.lanes.reduce((a, l) => a + l.cost, 0).toFixed(2)}`, '']
  rows.push(`${'lane'.padEnd(34)}  begin    end  start  model  tools  turns   cost`)
  for (const l of t.lanes)
    rows.push(`${l.name.padEnd(34)} ${sec(l.start - t.t0)} ${sec(l.end - t.t0)} ${sec(sum(l.segs, 'start'))} ${sec(sum(l.segs, 'model'))} ${sec(sum(l.segs, 'tool'))}  ${String(l.turns || '').padStart(5)}  ${l.cost ? '$' + l.cost.toFixed(2) : ''}`)
  const slow = t.lanes.flatMap(l => l.segs.filter(s => s.kind === 'tool').map(s => ({ ...s, lane: l.name.trim() }))).sort((a, b) => b.to - b.from - (a.to - a.from)).slice(0, 8)
  rows.push('', 'slowest tool calls')
  for (const s of slow) rows.push(`${sec(s.to - s.from)}s  ${s.lane.padEnd(28)} ${s.label}`)
  const g = gaps(t)
  rows.push('', g.length ? 'gaps where no agent was working (2s or more)' : 'no gaps of 2s or more')
  for (const x of g) rows.push(`${sec(x.to - x.from)}s  at ${((x.from - t.t0) / 1000).toFixed(1)}s`)
  return rows.join('\n')
}

function html(t: Trace) {
  const W = 1000, H = 26, span = Math.max(1, t.t1 - t.t0), x = (ms: number) => ((ms - t.t0) / span) * W
  const color = { start: '#7C8593', model: '#9391C3', tool: '#5FA37A' }
  const bars = t.lanes.map((l, i) => {
    const y = 30 + i * H
    const segs = l.segs.map(s => `<rect x="${x(s.from).toFixed(1)}" y="${y}" width="${Math.max(1, x(s.to) - x(s.from)).toFixed(1)}" height="${H - 8}" fill="${color[s.kind]}"><title>${s.kind}${s.label ? ': ' + esc(s.label) : ''} (${((s.to - s.from) / 1000).toFixed(1)}s)</title></rect>`).join('')
    return `<text x="-8" y="${y + 13}" text-anchor="end">${esc(l.name.trim())}</text><line x1="${x(l.start)}" x2="${x(l.end)}" y1="${y + 9}" y2="${y + 9}" stroke="#2B3140"/>${segs}`
  }).join('')
  const ticks = Array.from({ length: Math.floor(span / 10000) + 1 }, (_, i) => `<text x="${x(t.t0 + i * 10000)}" y="18" text-anchor="middle">${i * 10}s</text>`).join('')
  const h = 40 + t.lanes.length * H
  return `<!doctype html><meta charset="utf-8"><title>${esc(t.run)}</title><style>body{background:#12151B;color:#E3E7EC;font:13px ui-monospace,monospace;margin:24px}svg text{fill:#9BA5B4;font:11px ui-monospace,monospace}pre{color:#9BA5B4}.k span{display:inline-block;width:10px;height:10px;margin:0 4px 0 14px}</style>
<h1 style="font-size:16px">${esc(t.run)}</h1><div class="k"><span style="background:${color.start}"></span>start-up + first turn<span style="background:${color.model}"></span>model<span style="background:${color.tool}"></span>tool</div>
<svg viewBox="-260 0 ${W + 280} ${h}" width="100%">${ticks}${bars}</svg><pre>${esc(report(t))}</pre>`
}
const esc = (s: string) => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`)

/** Median start-up, model, tool and wall per setup (the letter after the last dash), over every run of a date. */
function setups(date?: string) {
  const d = date ?? (existsSync(ROOT) ? readdirSync(ROOT).sort().at(-1) : undefined)
  if (!d) throw new Error(`no runs under ${ROOT}`)
  const by = new Map<string, number[][]>()
  for (const run of readdirSync(join(ROOT, d))) {
    // A run the plan's limit cut short was moved aside to <run>_limited<n>; its retry is the one that counts.
    if (run.includes('_limited')) continue
    let t: Trace
    try { t = load(join(ROOT, d, run)) } catch { continue }
    const s = run.split('-').at(-1)!
    const all = t.lanes.flatMap(l => l.segs)
    const row = [t.t1 - t.t0, sum(all, 'start'), sum(all, 'model'), sum(all, 'tool'), gaps(t).reduce((a, g) => a + g.to - g.from, 0)]
    by.set(s, [...(by.get(s) ?? []), row])
  }
  const med = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]
  const rows = [`setups on ${d}: medians in seconds; start, model and tools are summed over every lane, so they can exceed wall`, '', 'setup  runs    wall   start   model   tools    gaps']
  for (const [s, rs] of [...by].sort()) rows.push(`${s.padEnd(5)} ${String(rs.length).padStart(5)} ${[0, 1, 2, 3, 4].map(i => sec(med(rs.map(r => r[i]))) + ' ').join('')}`)
  return rows.join('\n')
}

/**
 * The runner deletes a run's directory when the same run id comes round again (a dry run, then the full run), so
 * copy each run's logs out first: to bench/archive/<date>/<run>@<first log ms>/, once per distinct attempt.
 */
function archive(into = join(import.meta.dir, 'archive')) {
  let n = 0
  for (const date of existsSync(ROOT) ? readdirSync(ROOT) : [])
    for (const run of readdirSync(join(ROOT, date))) {
      const logs = join(ROOT, date, run, 'logs')
      const files = existsSync(logs) ? readdirSync(logs).filter(f => f.endsWith('.jsonl')).sort() : []
      if (!files.length) continue
      const dest = join(into, date, `${run}@${files[0].split('-')[0]}`, 'logs')
      mkdirSync(dest, { recursive: true })
      for (const f of files) copyFileSync(join(logs, f), join(dest, f)), n++
    }
  return `copied ${n} logs into ${into}`
}

if (import.meta.main) {
  const a = process.argv.slice(2)
  if (!a.length || a[0] === '--help') {
    console.log('bun bench/trace.ts <run dir | run id> [--html out.html]\nbun bench/trace.ts --setups [<date>]')
    process.exit(a.length ? 0 : 2)
  }
  if (a[0] === '--archive') console.log(archive(a[1]))
  else if (a[0] === '--setups') console.log(setups(a[1]))
  else {
    const t = load(a[0])
    console.log(report(t))
    const i = a.indexOf('--html')
    if (i >= 0) writeFileSync(a[i + 1] ?? `${t.run}.html`, html(t)), console.log(`\ntimeline: ${a[i + 1] ?? `${t.run}.html`}`)
  }
}

export { gaps, lanes, load, setups }
