import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Panes } from './ports'

/** Herdr knows which Claude Code session runs in each pane, and whether it is waiting for input. */
export class Herdr implements Panes {
  constructor(private bin = process.env.HERDR_BIN_PATH || 'herdr') {}

  private async run(...args: string[]) {
    try {
      const p = Bun.spawn([this.bin, ...args], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore', windowsHide: true, timeout: 5000 })
      const out = await new Response(p.stdout).text()
      return (await p.exited) === 0 ? out : null
    } catch {
      return null // no herdr here
    }
  }

  async wake({ id }: { id: string }, text: string) {
    const list = await this.run('agent', 'list')
    if (!list) return false
    const a = JSON.parse(list).result?.agents?.find((a: any) => a.agent_session?.value === id)
    // A focused pane has the user at it, maybe mid-sentence: a prompt would land in what they are typing.
    if (!a || a.focused || !['idle', 'done'].includes(a.agent_status)) return false
    return (await this.run('agent', 'prompt', a.pane_id, text)) !== null
  }
}

/** herdr-core's `hc`: HC_BIN, else on PATH, else where the Herdr app installs it on Windows. */
export const hcBin = () =>
  process.env.HC_BIN || Bun.which('hc') || (process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData/Local'), 'Programs/herdr-core/hc.exe') : 'hc')

/**
 * The Herdr app's herdr-core (`hc`), for a session whose hooks reported its terminal. `hc send` types only
 * into an agent waiting for input, and holds the text while the person has an unfinished draft there (up to a minute).
 */
export class HerdrCore implements Panes {
  constructor(private bin = hcBin()) {}

  async wake({ terminal }: { terminal?: string }, text: string) {
    if (!terminal) return false
    try {
      // Waiting for input is `idle`, or `done` until someone looks at it; `send --if` only knows `idle`, so read the
      // status first. Busy, blocked on a question, or gone: not woken.
      const get = Bun.spawn([this.bin, 'get', terminal, '--json'], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore', windowsHide: true, timeout: 5000 })
      const g = JSON.parse((await new Response(get.stdout).text()) || '{}')
      const status = typeof g.status === 'string' ? g.status : g.status?.state
      if (g.state !== 'live' || !['idle', 'done'].includes(status)) return false
      const p = Bun.spawn([this.bin, 'send', terminal, text], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore', windowsHide: true, timeout: 70_000 })
      // Still running after a few seconds: it is idle and waiting out a draft, so the text will land.
      const code = await Promise.race([p.exited, Bun.sleep(3000).then(() => 0)])
      return code === 0
    } catch {
      return false // no herdr-core here
    }
  }
}

/** Every multiplexer that might hold the session; the first that wakes it wins. */
export class AnyPanes implements Panes {
  constructor(private all: Panes[]) {}
  async wake(s: { id: string; terminal?: string }, text: string) {
    for (const p of this.all) if (await p.wake(s, text)) return true
    return false
  }
}
