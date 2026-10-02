import type { AgentRun, AgentRunner } from './ports'

/** Headless Claude Code. One process per run, so every run starts with a clean context. */
export class ClaudeCli implements AgentRunner {
  async run({ cwd, prompt, readOnly, schema, signal, onActivity }: AgentRun) {
    const args = ['claude', '-p', '--output-format', 'stream-json', '--verbose']
    // No human is there to answer a prompt: anything that would ask is denied.
    args.push('--permission-prompts', 'none', '--strict-mcp-config', '--no-session-persistence')
    if (readOnly) args.push('--tools', 'Read,Grep,Glob')
    else args.push('--permission-mode', 'auto')
    if (schema) args.push('--json-schema', JSON.stringify(schema))

    const p = Bun.spawn(args, { cwd, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', signal })
    p.stdin.write(prompt)
    p.stdin.end()
    const stderr = new Response(p.stderr).text()

    let ok = false
    let text = ''
    let data: unknown
    let buf = ''
    const decoder = new TextDecoder()
    for await (const chunk of p.stdout) {
      buf += decoder.decode(chunk, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop()!
      for (const line of lines) {
        let msg: any
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.type === 'assistant') {
          for (const block of msg.message?.content ?? []) {
            if (block.type === 'text') text = block.text
            if (block.type !== 'tool_use') continue
            if (block.name === 'StructuredOutput') data = block.input
            else onActivity?.(activity(block.name, block.input ?? {}))
          }
        } else if (msg.type === 'result') {
          ok = !msg.is_error
          if (typeof msg.result === 'string' && msg.result) text = msg.result
          data = msg.structured_output ?? data
        }
      }
    }
    await p.exited
    if (!ok && !text) text = (await stderr).trim() || `claude exited ${p.exitCode}`
    return { ok, text, data }
  }
}

function activity(tool: string, input: Record<string, unknown>) {
  const detail = input.command ?? input.file_path ?? input.pattern ?? input.description ?? ''
  return `${tool} ${String(detail).replace(/\s+/g, ' ')}`.trim().slice(0, 140)
}
