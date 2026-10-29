import type { Database } from 'bun:sqlite'
import type { Event, Goal, Note, Project, Store, Ticket } from './ports'

type Table = 'project' | 'goal' | 'ticket'

// ponytail: rows are JSON blobs and filtering happens in JS. Real columns and
// indexes when a project passes a few thousand tickets.
export class SqliteStore implements Store {
  constructor(private db: Database) {
    db.run('PRAGMA journal_mode = WAL')
    for (const t of ['project', 'goal', 'ticket'])
      db.run(`CREATE TABLE IF NOT EXISTS ${t} (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL)`)
    db.run(`CREATE TABLE IF NOT EXISTS event (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, ticket_id INTEGER,
      ts INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL)`)
    db.run('CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
    db.run('CREATE TABLE IF NOT EXISTS spawn (n INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, data TEXT NOT NULL)')
    db.run('CREATE TABLE IF NOT EXISTS note (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, ts INTEGER NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL)')
  }

  private all<T>(table: Table): T[] {
    const rows = this.db.query(`SELECT id, data FROM ${table} ORDER BY id`).all() as { id: number; data: string }[]
    return rows.map(r => ({ ...JSON.parse(r.data), id: r.id }))
  }

  private add<T>(table: Table, data: object): T {
    const { lastInsertRowid } = this.db.query(`INSERT INTO ${table} (data) VALUES (?)`).run(JSON.stringify(data))
    return { ...data, id: Number(lastInsertRowid) } as T
  }

  private patch(table: Table, id: number, patch: object) {
    const row = this.db.query(`SELECT data FROM ${table} WHERE id = ?`).get(id) as { data: string } | null
    if (!row) throw new Error(`no ${table} ${id}`)
    const next = { ...JSON.parse(row.data), ...patch, id: undefined }
    this.db.query(`UPDATE ${table} SET data = ? WHERE id = ?`).run(JSON.stringify(next), id)
  }

  projects = () => this.all<Project>('project')
  addProject = (p: Omit<Project, 'id'>) => this.add<Project>('project', p)
  patchProject = (id: number, patch: Partial<Project>) => this.patch('project', id, patch)
  removeProject = (id: number) =>
    this.db.transaction(() => {
      for (const t of ['goal', 'ticket']) this.db.query(`DELETE FROM ${t} WHERE json_extract(data, '$.project_id') = ?`).run(id)
      this.db.query('DELETE FROM event WHERE project_id = ?').run(id)
      this.db.query('DELETE FROM project WHERE id = ?').run(id)
    })()

  goals = () => this.all<Goal>('goal')
  addGoal = (g: Omit<Goal, 'id'>) => this.add<Goal>('goal', g)
  patchGoal = (id: number, patch: Partial<Goal>) => this.patch('goal', id, patch)

  tickets = () => this.all<Ticket>('ticket')
  addTicket = (t: Omit<Ticket, 'id' | 'updated'>) => this.add<Ticket>('ticket', { ...t, updated: Date.now() })
  patchTicket = (id: number, patch: Partial<Ticket>) => this.patch('ticket', id, { ...patch, updated: Date.now() })

  log(project_id: number, ticket_id: number | null, kind: Event['kind'], data: Event['data'] = {}) {
    this.db
      .query('INSERT INTO event (project_id, ticket_id, ts, kind, data) VALUES (?, ?, ?, ?, ?)')
      .run(project_id, ticket_id, Date.now(), kind, JSON.stringify(data))
  }

  events({ ticket_id, project_id, limit = 200 }: { ticket_id?: number; project_id?: number; limit?: number }) {
    const rows = this.db
      .query(
        `SELECT * FROM event WHERE (?1 IS NULL OR ticket_id = ?1) AND (?2 IS NULL OR project_id = ?2)
         ORDER BY id DESC LIMIT ?3`,
      )
      .all(ticket_id ?? null, project_id ?? null, limit) as (Omit<Event, 'data'> & { data: string })[]
    return rows.map(r => ({ ...r, data: JSON.parse(r.data) }))
  }

  addNote(n: Omit<Note, 'id'>) {
    const { lastInsertRowid } = this.db.query('INSERT INTO note (repo, ts, author, text) VALUES (?, ?, ?, ?)').run(n.repo, n.ts, n.author, n.text)
    return { ...n, id: Number(lastInsertRowid) }
  }

  notes = (repo: string) => this.db.query('SELECT * FROM note WHERE repo = ? ORDER BY id DESC').all(repo) as Note[]

  removeNote = (repo: string, id: number) => this.db.query('DELETE FROM note WHERE repo = ? AND id = ?').run(repo, id).changes > 0

  sessions = () => (this.db.query('SELECT data FROM session').all() as { data: string }[]).map(r => r.data)
  saveSession = (id: string, data: string) => void this.db.query('INSERT OR REPLACE INTO session (id, data) VALUES (?, ?)').run(id, data)
  dropSession = (id: string) => void this.db.query('DELETE FROM session WHERE id = ?').run(id)

  spawns = () => (this.db.query('SELECT data FROM spawn ORDER BY n').all() as { data: string }[]).map(r => r.data)
  saveSpawn = (id: string, data: string) =>
    void this.db.query('INSERT INTO spawn (id, data) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data').run(id, data)
}
