// Kodr's side of yap (kodr-plugin.toml). `bun src/kodr.ts` is the wake service; `sessions <dir>` prints who is
// in that repo. Kodr puts a `kodr` that reaches the running app first on PATH.
import { wakePrompt, YapLocal } from '../sdk/local'

// Every thread status but a running one: a busy thread hears the message from its next hook instead.
const SETTLED = new Set(['idle', 'completed', 'failed', 'cancelled', 'interrupted'])

async function kodr(args: string[]) {
  const p = Bun.spawn(['kodr', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(p.stdout).text()
  return { ok: (await p.exited) === 0, out }
}

/** null when the session is not a Kodr thread: a terminal Claude Code, a Herdr pane, a spawn. */
async function threadStatus(id: string): Promise<string | null> {
  const r = await kodr(['thread', 'show', id, '--json', '--messages', '0'])
  if (!r.ok) return null
  try {
    return JSON.parse(r.out).thread?.status ?? null
  } catch {
    return null
  }
}

const start = () => Bun.spawn(['bun', 'src/cli.ts', 'start'], { cwd: `${import.meta.dir}/..` }).exited
const yap = await YapLocal.connect({ start })

if (process.argv[2] === 'sessions') {
  const peers = await yap.sessions(process.argv[3] || process.cwd())
  console.log(
    peers.length
      ? peers
          .map(p => {
            const recent = p.files.slice(-3).map(f => f.split('/').at(-1)).join(', ')
            return `@${p.name || p.id.slice(0, 8)}${p.files.length ? `  edited ${p.files.length}: ${recent}` : ''}`
          })
          .join('\n')
      : 'Nobody is in this repo.',
  )
  process.exit(0)
}

const waking = new Set<string>()
yap.watch(undefined, async e => {
  if (e.type !== 'message' || waking.has(e.session)) return
  waking.add(e.session)
  try {
    const status = await threadStatus(e.session)
    if (status !== null && SETTLED.has(status)) await kodr(['thread', 'send', e.session, wakePrompt(e)])
  } finally {
    waking.delete(e.session)
  }
})
