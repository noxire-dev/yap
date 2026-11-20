import type { Card, Tracker } from './ports'

// A constant, as in gh-rinai: nothing an issue says can send the token anywhere else.
const HOST = process.env.RINAI_URL ?? 'https://rinai.dev'
const GITHUB = 'https://api.github.com'
const ORDER = ['ongoing', 'todo', 'in-review', 'blocked', 'future']

/** Rinai (rinai.dev), a board over GitHub issues. Acts as the user, through gh's own token. */
export class Rinai implements Tracker {
  private token: { value: string; at: number } | null = null

  private async auth() {
    if (!this.token || Date.now() - this.token.at > 5 * 60_000) {
      let value = ''
      try {
        const p = Bun.spawn(['gh', 'auth', 'token'], { stdout: 'pipe', stderr: 'ignore', windowsHide: true })
        value = (await new Response(p.stdout).text()).trim()
      } catch {}
      if (!value) throw new Error('rinai needs the GitHub CLI signed in: run `gh auth login`')
      this.token = { value, at: Date.now() }
    }
    return this.token.value
  }

  private async call(method: string, path: string, body?: object | string) {
    const headers: Record<string, string> = { authorization: `Bearer ${await this.auth()}`, 'user-agent': 'yap' }
    if (body !== undefined) headers['content-type'] = typeof body === 'string' ? 'text/plain' : 'application/json'
    const res = await fetch(HOST + path, { method, headers, body: typeof body === 'object' ? JSON.stringify(body) : body })
    const text = await res.text()
    if (res.ok) return text
    let message = `rinai answered ${res.status}`
    try {
      message = JSON.parse(text).error.message
    } catch {}
    throw new Error(message)
  }

  async cards(repo: string) {
    const [all, cycle] = await Promise.all(
      ['', '?cycle=1'].map(async q => JSON.parse(await this.call('GET', `/api/${repo}/issues${q}`)).issues as Card[]),
    )
    const now = cycle.map(c => c.number)
    const rank = (c: Card) => (now.includes(c.number) ? now.indexOf(c.number) : 1000 + ORDER.indexOf(c.column))
    return all
      .filter(c => c.column !== 'done')
      .map(c => ({ ...c, cycle: now.includes(c.number) }))
      .sort((a, b) => rank(a) - rank(b))
  }

  brief = (repo: string, n: number) => this.call('GET', `/${repo}/issues/${n}.md`)

  file = async (repo: string, title: string, body: string) => JSON.parse(await this.call('POST', `/api/${repo}/issues`, { title, body })) as Card

  async claim(repo: string, n: number) {
    await this.call('PATCH', `/api/${repo}/issues/${n}`, { column: 'ongoing', assignees: ['@me'] })
  }

  async move(repo: string, n: number, column: 'in-review' | 'blocked') {
    await this.call('PATCH', `/api/${repo}/issues/${n}`, { column })
  }

  async comment(repo: string, n: number, text: string) {
    await this.call('POST', `/api/${repo}/issues/${n}/comments`, text)
  }

  /** GitHub itself, for what Rinai does not answer: who applied a label, and who we are. */
  private async github(path: string, token?: string) {
    const res = await fetch(GITHUB + path, { headers: { authorization: `Bearer ${token ?? (await this.auth())}`, 'user-agent': 'yap', accept: 'application/vnd.github+json' } })
    if (!res.ok) throw new Error(`github answered ${res.status}`)
    return res
  }

  async handed(repo: string, label: string) {
    const body = JSON.parse(await this.call('GET', `/api/${repo}/issues?label=${encodeURIComponent(label)}`))
    // A capped board would make a label look like it came off.
    if (body.truncated) throw new Error(`${repo} has more tasks than the board reads at once`)
    return (body.issues as Card[]).filter(c => c.column !== 'done')
  }

  async labeler(repo: string, n: number, label: string) {
    // Events come oldest first and the latest `labeled` counts: walk back from the last page to the first that has one.
    const path = `/repos/${repo}/issues/${n}/events?per_page=100`
    const first = await this.github(path)
    const pages = Number(first.headers.get('link')?.match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/)?.[1] ?? 1)
    for (let page = pages; page >= 1; page--) {
      const events: any[] = await (page === 1 ? first : await this.github(`${path}&page=${page}`)).json()
      const last = events.filter(e => e.event === 'labeled' && e.label?.name?.toLowerCase() === label.toLowerCase()).pop()
      if (last) return (last.actor?.login as string | undefined) ?? null
    }
    return null
  }

  /** Cached with the token it was read with: `gh auth switch` is a different person. */
  private login?: { token: string; login: string }
  async me() {
    const token = await this.auth()
    if (this.login?.token !== token) this.login = { token, login: (await (await this.github('/user', token)).json()).login }
    return this.login.login
  }
}
