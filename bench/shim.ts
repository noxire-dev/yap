// `claude` for a bench run, compiled to claude.exe and put first on PATH: every Claude Code process in a run goes
// through it, the ones yap's daemon starts too. It runs the real claude with the same arguments, on the plan (any
// API key is taken out of its environment), on the bench's model, and copies its stdout line by line into
// $BENCH_LOG_DIR, which is where the run's cost, tokens and tool calls are read from. With no user settings, and
// with --plugin-dir $BENCH_PLUGIN_DIR when that is set.
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const real = process.env.BENCH_REAL_CLAUDE
if (!real) {
  console.error('bench shim: BENCH_REAL_CLAUDE is not set')
  process.exit(127)
}
const args = process.argv.slice(2)
const model = process.env.BENCH_MODEL
if (model && args.includes('-p') && !args.includes('--model')) args.unshift('--model', model)
// Clean agents (docs/bench/brief-v2.md): none of the user's settings or plugins, and yap only where the setup uses
// it, from this repo. The runner reads each agent's init line to check it.
if (args.includes('-p') && !args.includes('--setting-sources')) args.unshift('--setting-sources', '')
const plugin = process.env.BENCH_PLUGIN_DIR
if (plugin && args.includes('-p') && !args.includes('--plugin-dir')) args.unshift('--plugin-dir', plugin)
const env = { ...process.env }
delete env.ANTHROPIC_API_KEY
delete env.ANTHROPIC_AUTH_TOKEN

const dir = process.env.BENCH_LOG_DIR
const file = dir && args.includes('-p') ? join(dir, `${Date.now()}-${process.pid}.jsonl`) : ''
if (file) mkdirSync(dir!, { recursive: true }), appendFileSync(file, JSON.stringify({ type: 'bench_argv', argv: args, cwd: process.cwd() }) + '\n')

const p = Bun.spawn([real, ...args], { stdin: 'inherit', stdout: 'pipe', stderr: 'inherit', env, windowsHide: true })
for await (const chunk of p.stdout) {
  process.stdout.write(chunk)
  if (file) appendFileSync(file, chunk)
}
process.exit(await p.exited)
