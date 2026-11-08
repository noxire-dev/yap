// The chips YAP puts on a Kodr thread. Pure, so crew.check.ts can run it without a daemon.
import type { Message, Peer } from '../sdk/local'

export interface Chip {
  text: string
  tone: 'neutral' | 'info' | 'warn'
  title: string
}

/** How long a message stays on its recipient's thread. */
export const MAIL_MS = 10 * 60_000

export const label = (s: Peer) => `@${s.name || s.id.slice(0, 8)}`

export function threadChips(s: Peer, sessions: Peer[], mail: Message | undefined, now: number): Chip[] {
  const others = sessions.filter(o => o.repo === s.repo && o.id !== s.id)
  const chips: Chip[] = [
    {
      // An unnamed session's id means nothing in a chip; say whose it is and who else is here.
      text: `${s.name ? `@${s.name}` : 'yap'}${others.length ? ` +${others.length}` : ''}`,
      tone: others.length ? 'info' : 'neutral',
      title: others.length
        ? `Its yap name. In this repo with ${others.map(label).join(', ')}.`
        : 'Its yap name. Nobody else is in this repo.',
    },
  ]
  // Same working tree only: another worktree's edit to the same path is a merge, not a clobber.
  const shared = others
    .filter(o => o.top === s.top)
    .flatMap(o => o.files.filter(f => s.files.includes(f)).map(f => `${f} (${label(o)})`))
  if (shared.length) {
    const first = shared[0].split(' (')[0].split('/').at(-1)
    chips.push({
      text: shared.length === 1 ? `shared: ${first}` : `${shared.length} shared files`,
      tone: 'warn',
      title: `Also edited by another session in this working tree: ${shared.join(', ')}.`,
    })
  }
  if (mail && now - mail.at < MAIL_MS) {
    chips.push({
      text: `msg from ${mail.from.replace(/^session /, '')}`,
      tone: 'info',
      title: mail.text.length > 300 ? `${mail.text.slice(0, 300)}…` : mail.text,
    })
  }
  return chips
}
