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
  /** `owner/repo` on the tracker, when the repo has a GitHub remote. */
  tracker: string | null
  /** A gate command guessed from the repo, offered when `gate` is empty. */
  hint: string
}

export interface Goal {
  id: number
  project_id: number
  text: string
  status: 'planning' | 'ready' | 'failed'
  note: string
  /** The tracker issue this goal came from or was filed as. */
  issue: number | null
  /** The issue in full, for the planner. */
  brief: string
  /** What the crew did, written for the person who asked, once every ticket has merged. */
  summary: string
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
  /** The author's own report from its latest round. */
  summary: string
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
  kind: 'plan' | 'claim' | 'submit' | 'verdict' | 'gate' | 'merge' | 'escalate' | 'human' | 'tracker' | 'digest'
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
  /** The repo a directory sits in, or null. */
  root(dir: string): Promise<string | null>
  /** The working tree a directory sits in and the repo's shared git dir (one per repo, across worktrees), or null. */
  where(dir: string): Promise<{ top: string; common: string } | null>
  /** Make `dir` a repo with one commit, so the crew has a base to branch from. */
  init(dir: string): Promise<void>
  /** Current branch of a repo, or null if `repo` isn't one. */
  branch(repo: string): Promise<string | null>
  /** `owner/repo` of the GitHub remote, or null. */
  slug(repo: string): Promise<string | null>
  /** A plausible gate command for the repo, or ''. */
  gateHint(repo: string): string
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
  /** Read and search tools only. The planner runs in the user's own checkout, so it gets nothing else. */
  readOnly?: boolean
  /** JSON Schema the agent must answer with; the answer lands in `data`. */
  schema?: object
  signal?: AbortSignal
  onActivity?: (line: string) => void
}

export interface AgentRunner {
  run(o: AgentRun): Promise<{ ok: boolean; text: string; data?: any }>
}

export interface Card {
  number: number
  title: string
  column: string
  priority: string
  cycle: boolean
}

/** An issue board the crew can read from, file to, and report back on. */
export interface Tracker {
  /** Open cards, what the board is doing now first. */
  cards(repo: string): Promise<Card[]>
  /** One issue in full, as markdown. */
  brief(repo: string, n: number): Promise<string>
  file(repo: string, title: string, body: string): Promise<Card>
  /** Take the issue: in progress, assigned to the user. */
  claim(repo: string, n: number): Promise<void>
  move(repo: string, n: number, column: 'in-review' | 'blocked'): Promise<void>
  comment(repo: string, n: number, text: string): Promise<void>
}
