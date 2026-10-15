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

  async wake(id: string, text: string) {
    const list = await this.run('agent', 'list')
    if (!list) return false
    const a = JSON.parse(list).result?.agents?.find((a: any) => a.agent_session?.value === id)
    // A focused pane has the user at it, maybe mid-sentence: a prompt would land in what they are typing.
    if (!a || a.focused || !['idle', 'done'].includes(a.agent_status)) return false
    return (await this.run('agent', 'prompt', a.pane_id, text)) !== null
  }
}
