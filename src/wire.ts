import { PROTOCOL, type Sessions, VERBS, type Verb } from './sessions'

/** Everything `/yap/<verb>` takes: the agent's own verbs, then the ones about the repo. */
export const ALL = [...VERBS, 'say', 'note', 'unnote', 'spawn', 'claim', 'release', 'doing', 'hello', 'sessions', 'notes', 'spawns', 'claims', 'inbox']

/** `POST /yap/<verb>` on this machine: a JSON body in, the verb's answer out. Throws on a bad call. */
export function local(sessions: Sessions) {
  return async (verb: string, b: Record<string, unknown>): Promise<unknown> => {
    const str = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : undefined)
    const cwd = String(b.cwd ?? '')
    if (verb === 'say') return sessions.say({ from: str('session'), cwd, text: String(b.text ?? ''), to: str('to'), kind: str('kind'), re: str('re') })
    if (verb === 'note') return sessions.note({ from: str('session'), cwd, text: String(b.text ?? '') })
    if (verb === 'unnote') return sessions.unnote(cwd, Number(b.id)).then(() => ({}))
    if (verb === 'spawn') return sessions.spawn({ from: str('session'), cwd, text: String(b.text ?? ''), agent: str('agent') === 'codex' ? 'codex' : undefined })
    if (verb === 'claim') return sessions.claim({ from: str('session'), cwd, path: String(b.path ?? ''), why: String(b.why ?? '') })
    if (verb === 'release') return sessions.release({ from: str('session'), id: String(b.id ?? '') })
    if (verb === 'doing') return sessions.doing({ from: str('session'), cwd, text: String(b.text ?? '') })
    if (verb === 'inbox') return sessions.inboxIn(cwd, Number(b.since) || 0)
    if (verb === 'claims') return sessions.claims(cwd)
    if (verb === 'hello') return { ...PROTOCOL, verbs: ALL }
    if (verb === 'sessions') return sessions.peers(cwd)
    if (verb === 'notes') return sessions.notes(cwd)
    if (verb === 'spawns') return sessions.spawnsIn(cwd, str('id'), Number(b.since) || 0)
    if (!VERBS.includes(verb as Verb)) throw new Error(`no verb ${verb}; YAP has ${ALL.join(', ')}`)
    return sessions.yap(verb as Verb, {
      session: str('session'),
      cwd,
      path: str('path'),
      command: str('command'),
      prompt: str('prompt'),
      name: str('name'),
      pid: typeof b.pid === 'number' ? b.pid : undefined,
      terminal: str('terminal'),
      continuing: b.continuing === true,
      ack: typeof b.ack === 'number' ? b.ack : undefined,
    })
  }
}

/** `GET /yap/events`: server-sent events from now on, for the repo `cwd` sits in, or every repo without it. */
export async function events(sessions: Sessions, cwd: string | null) {
  const repo = cwd ? await sessions.repoOf(cwd) : null
  let off = () => {}
  return new ReadableStream<string>({
    start(c) {
      c.enqueue(': yap\n\n')
      off = sessions.listen(e => {
        if (!repo || e.repo === repo) c.enqueue(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
      })
    },
    cancel: () => off(),
  })
}
