/**
 * The board chat's hands: an MCP server over `gh rinai`, pinned to one board, with no shell anywhere.
 *
 * Claude Code's Bash permissions cannot confine a chat to `gh rinai`: it runs commands it judges read-only (`cat`,
 * a `; whoami` after an allowed one) whatever the allow list says, and a board chat that can read files can post
 * them in a comment. So a board chat gets no built-in tools at all, only these, and each one runs `gh rinai -R
 * <board> <verb>` as an argument list: a card's text is data, never a command.
 */
import type { Readable } from 'node:stream'

/** Runs `gh` with these arguments. The concrete one spawns it; a check passes a fake. */
export type Gh = (args: string[]) => Promise<{ ok: boolean; out: string }>

const n = { type: 'integer', minimum: 1, description: 'the task number' }
const COLUMNS = ['future', 'todo', 'ongoing', 'in-review', 'blocked', 'done']
const LEVELS = ['urgent', 'high', 'normal', 'low']
const HEALTH = ['on-track', 'at-risk', 'off-track']
const obj = (properties: Record<string, object> = {}, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })

export const BOARD_TOOLS = [
  { name: 'board', description: 'The whole board as markdown: every column, each card with its facts.', inputSchema: obj() },
  {
    name: 'search',
    description: "The board's cards as JSON, filtered.",
    inputSchema: obj({
      column: { enum: COLUMNS },
      assignee: { type: 'string', description: '@me or a login' },
      priority: { enum: LEVELS },
      label: { type: 'string' },
      text: { type: 'string', description: 'in the title' },
      waiting: { type: 'boolean', description: 'only what waits on the user' },
    }),
  },
  { name: 'brief', description: 'One task in full, as markdown: body, comments, linked PRs, subtasks.', inputSchema: obj({ n }, ['n']) },
  { name: 'goals', description: 'The goals: open-ended work with updates and a health.', inputSchema: obj() },
  { name: 'pulse', description: 'Goal updates on this board, newest first, as JSON.', inputSchema: obj() },
  { name: 'cycle', description: 'What the board is doing now, in order, as JSON.', inputSchema: obj() },
  { name: 'move', description: 'Move a task to a column.', inputSchema: obj({ n, column: { enum: COLUMNS } }, ['n', 'column']) },
  { name: 'priority', description: "Set a task's priority.", inputSchema: obj({ n, level: { enum: LEVELS } }, ['n', 'level']) },
  { name: 'claim', description: 'Move a task to Ongoing and assign the user.', inputSchema: obj({ n }, ['n']) },
  { name: 'cycle_add', description: 'Put tasks in the cycle.', inputSchema: obj({ numbers: { type: 'array', items: n, minItems: 1 } }, ['numbers']) },
  { name: 'cycle_remove', description: 'Take tasks out of the cycle.', inputSchema: obj({ numbers: { type: 'array', items: n, minItems: 1 } }, ['numbers']) },
  { name: 'cycle_order', description: "Set the cycle's order, most important first.", inputSchema: obj({ numbers: { type: 'array', items: n, minItems: 1 } }, ['numbers']) },
  {
    name: 'file',
    description: 'File a new task.',
    inputSchema: obj({ title: { type: 'string' }, body: { type: 'string' }, column: { enum: COLUMNS }, priority: { enum: LEVELS }, parent: n }, ['title']),
  },
  { name: 'comment', description: 'Comment on a task, as plain text.', inputSchema: obj({ n, text: { type: 'string' } }, ['n', 'text']) },
  { name: 'update', description: "Post an update on a goal and set its health.", inputSchema: obj({ n, health: { enum: HEALTH }, text: { type: 'string' } }, ['n', 'health', 'text']) },
  { name: 'goal', description: 'Make a task a goal.', inputSchema: obj({ n }, ['n']) },
  { name: 'ungoal', description: 'Make a goal a task again.', inputSchema: obj({ n }, ['n']) },
]

const num = (v: unknown) => {
  if (!Number.isInteger(v) || (v as number) < 1) throw new Error('a task number is a positive whole number')
  return String(v)
}
const one = (v: unknown, of: string[]) => {
  if (typeof v !== 'string' || !of.includes(v)) throw new Error(`expected one of ${of.join(', ')}`)
  return v
}
/** Free text, as one argument. "-" alone would make gh rinai read stdin, and a leading dash reads as a flag. */
const words = (v: unknown, what: string) => {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!s) throw new Error(`${what} is empty`)
  return s.startsWith('-') ? ` ${s}` : s
}
const nums = (v: unknown) => {
  if (!Array.isArray(v) || !v.length) throw new Error('give at least one task number')
  return v.map(num)
}

/** The `gh` arguments for one tool call, pinned to `board`. Throws on anything the tool does not take. */
export function boardArgs(board: string, tool: string, a: Record<string, unknown>): string[] {
  const verb = (...rest: string[]) => ['rinai', '-R', board, ...rest]
  switch (tool) {
    case 'board':
    case 'goals':
    case 'pulse':
    case 'cycle':
      return verb(tool)
    case 'search': {
      const f: string[] = []
      if (a.column !== undefined) f.push('-c', one(a.column, COLUMNS))
      if (a.assignee !== undefined) f.push('-a', words(a.assignee, 'the assignee'))
      if (a.priority !== undefined) f.push('-p', one(a.priority, LEVELS))
      if (a.label !== undefined) f.push('-l', words(a.label, 'the label'))
      if (a.text !== undefined) f.push('-t', words(a.text, 'the text'))
      if (a.waiting === true) f.push('-w')
      return verb('search', ...f)
    }
    case 'brief':
    case 'claim':
    case 'goal':
    case 'ungoal':
      return verb(tool, num(a.n))
    case 'move':
      return verb('move', num(a.n), one(a.column, COLUMNS))
    case 'priority':
      return verb('priority', num(a.n), one(a.level, LEVELS))
    case 'cycle_add':
      return verb('cycle', 'add', ...nums(a.numbers))
    case 'cycle_remove':
      return verb('cycle', 'rm', ...nums(a.numbers))
    case 'cycle_order':
      return verb('cycle', 'order', ...nums(a.numbers))
    case 'file': {
      const f = [words(a.title, 'the title')]
      if (a.body !== undefined) f.push('-b', words(a.body, 'the body'))
      if (a.column !== undefined) f.push('-c', one(a.column, COLUMNS))
      if (a.priority !== undefined) f.push('-p', one(a.priority, LEVELS))
      if (a.parent !== undefined) f.push('-P', num(a.parent))
      return verb('file', ...f)
    }
    case 'comment':
      return verb('comment', num(a.n), words(a.text, 'the comment'))
    case 'update':
      return verb('update', num(a.n), one(a.health, HEALTH), words(a.text, 'the update'))
  }
  throw new Error(`no tool ${tool}`)
}

/** One JSON-RPC message in, its reply out; none for a notification. */
export async function boardRpc(board: string, gh: Gh, m: { id?: unknown; method?: string; params?: any }) {
  if (m.id === undefined) return
  const ok = (result: object) => ({ jsonrpc: '2.0', id: m.id, result })
  if (m.method === 'initialize')
    return ok({ protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'rinai', version: '1' } })
  if (m.method === 'ping') return ok({})
  if (m.method === 'tools/list') return ok({ tools: BOARD_TOOLS })
  if (m.method === 'tools/call') {
    try {
      const r = await gh(boardArgs(board, String(m.params?.name), m.params?.arguments ?? {}))
      return ok({ content: [{ type: 'text', text: r.out || (r.ok ? 'done' : 'gh rinai failed') }], isError: !r.ok })
    } catch (e: any) {
      return ok({ content: [{ type: 'text', text: String(e?.message ?? e) }], isError: true })
    }
  }
  return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `no method ${m.method}` } }
}

/** The real `gh`: an argument list, never a shell; stdin closed so nothing can be read from it. */
export const spawnGh: Gh = async args => {
  const p = Bun.spawn(['gh', ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', windowsHide: true })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  await p.exited
  return { ok: p.exitCode === 0, out: (p.exitCode === 0 ? out : err || out).trim().slice(0, 60_000) }
}

/** Serve the board on stdio: `bun src/board.ts <owner/repo>`. */
export async function serveBoard(board: string, input: AsyncIterable<string> | Readable, gh: Gh = spawnGh) {
  for await (const line of input as AsyncIterable<string>) {
    if (!String(line).trim()) continue
    let m: any
    try {
      m = JSON.parse(String(line))
    } catch {
      continue
    }
    const reply = await boardRpc(board, gh, m)
    if (reply) process.stdout.write(JSON.stringify(reply) + '\n')
  }
}

if (import.meta.main) {
  const board = process.argv[2] ?? ''
  if (!/^[\w.-]+\/[\w.-]+$/.test(board)) throw new Error('bun src/board.ts <owner/repo>')
  await serveBoard(board, console as unknown as AsyncIterable<string>)
}
