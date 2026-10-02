export type Status = 'draft' | 'todo' | 'working' | 'review' | 'gate' | 'merged' | 'escalated' | 'dropped'

export interface Project {
  id: number
  name: string
  path: string
  base: string
  /** Shell command run on the merged result. Empty = review is the only gate. */
  gate: string
  workers: number
  running: boolean
}

export interface Goal {
  id: number
  project_id: number
  text: string
  status: 'planning' | 'ready' | 'failed'
  note: string
}

export interface Ticket {
  id: number
  project_id: number
  goal_id: number | null
  title: string
  body: string
  criteria: string[]
  /** Ticket ids that must be merged (or dropped) first. */
  deps: number[]
  status: Status
  round: number
  /** Rounds left before the ticket escalates to a human. */
  tries: number
  findings: string[]
  /** Why an escalated ticket needs a human. */
  note: string
  /** A human approved past the reviewer: the run goes straight to the gate, and the merge records it. */
  override: boolean
  sha: string | null
  updated: number
}

export interface Event {
  id: number
  project_id: number
  ticket_id: number | null
  ts: number
  kind: 'plan' | 'claim' | 'submit' | 'verdict' | 'gate' | 'merge' | 'escalate' | 'human'
  data: Record<string, unknown>
}

export interface Store {
  projects(): Project[]
  addProject(p: Omit<Project, 'id'>): Project
  patchProject(id: number, patch: Partial<Project>): void
  goals(): Goal[]
  addGoal(g: Omit<Goal, 'id'>): Goal
  patchGoal(id: number, patch: Partial<Goal>): void
  tickets(): Ticket[]
  addTicket(t: Omit<Ticket, 'id' | 'updated'>): Ticket
  patchTicket(id: number, patch: Partial<Ticket>): void
  log(project_id: number, ticket_id: number | null, kind: Event['kind'], data?: Event['data']): void
  events(filter: { ticket_id?: number; project_id?: number; limit?: number }): Event[]
}

export interface Ran {
  ok: boolean
  log: string
}

/** Git worktrees plus the one shell command the gate runs in them. */
export interface Workspace {
  /** Current branch of a repo, or null if `repo` isn't one. */
  branch(repo: string): Promise<string | null>
  /** Ensure `dir` is a worktree of `repo` on `branch`, created from `base` if new. */
  worktree(repo: string, dir: string, branch: string, base: string): Promise<void>
  /** Merge `base` into the worktree's branch. False = conflicts were left in the tree. */
  mergeBase(dir: string, base: string): Promise<boolean>
  commitAll(dir: string, message: string): Promise<Ran>
  diff(repo: string, base: string, branch: string): Promise<string>
  /** Throw away uncommitted changes in a worktree. */
  discard(dir: string): Promise<void>
  /** Squash `branch` onto `base` in the scratch worktree. `sha` is set when it committed. */
  squash(repo: string, scratch: string, base: string, branch: string, message: string): Promise<Ran & { sha?: string }>
  exec(dir: string, command: string): Promise<Ran>
  /** Fast-forward `base` to `sha`. Fails rather than clobbering if `base` moved or the checkout is dirty. */
  advance(repo: string, base: string, sha: string): Promise<Ran>
  cleanup(repo: string, dir: string, branch: string): Promise<void>
}

export interface AgentRun {
  cwd: string
  prompt: string
  /** Read/search tools only: reviewers and planners never edit. */
  readOnly?: boolean
  /** JSON Schema the agent must answer with; the answer lands in `data`. */
  schema?: object
  signal?: AbortSignal
  onActivity?: (line: string) => void
}

export interface AgentRunner {
  run(o: AgentRun): Promise<{ ok: boolean; text: string; data?: any }>
}
