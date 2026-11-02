import { PROTOCOL, type Sessions, VERBS, type Verb } from './sessions'

/** Everything `/yap/<verb>` takes: the agent's own verbs, then the ones about the repo. */
export const ALL = [...VERBS, 'say', 'note', 'unnote', 'spawn', 'hello', 'sessions', 'notes', 'spawns']

/** `POST /yap/<verb>` on this machine: a JSON body in, the verb's answer out. Throws on a bad call. */
export function local(sessions: Sessions) {
  return async (verb: string, b: Record<string, unknown>): Promise<unknown> => {
    const str = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : undefined)
    const cwd = String(b.cwd ?? '')
    if (verb === 'say') return sessions.say({ from: str('session'), cwd, text: String(b.text ?? ''), to: str('to') })
    if (verb === 'note') return sessions.note({ from: str('session'), cwd, text: String(b.text ?? '') })
    if (verb === 'unnote') return sessions.unnote(cwd, Number(b.id)).then(() => ({}))
    if (verb === 'spawn') return sessions.spawn({ from: str('session'), cwd, text: String(b.text ?? '') })
    if (verb === 'hello') return { ...PROTOCOL, verbs: ALL }
    if (verb === 'sessions') return sessions.peers(cwd)
    if (verb === 'notes') return sessions.notes(cwd)
    if (verb === 'spawns') return sessions.spawnsIn(cwd)
    if (!VERBS.includes(verb as Verb)) throw new Error(`no verb ${verb}; YAP has ${ALL.join(', ')}`)
    return sessions.yap(verb as Verb, {
      session: str('session'),
      cwd,
      path: str('path'),
      command: str('command'),
      prompt: str('prompt'),
      name: str('name'),
      continuing: b.continuing === true,
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
