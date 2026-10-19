# kumi

A crew of coding agents that works through a goal without you watching. Modelled on [niwa](https://niwa.build).
It also lets parallel Claude Code sessions on one repo see and message each other; see "Parallel sessions" below.

You type a goal. A planner turns it into tickets with acceptance criteria. Each ticket gets an agent on its own
branch in its own git worktree. A second agent, in a fresh context, checks the diff against every criterion and
either approves or sends it back with findings. Approved work is squashed onto the base branch in a scratch
worktree, your gate command runs on that merged result, and only then does the base branch move. A ticket that
fails four rounds lands in front of you.

The agent that wrote a change never decides whether it merges, and every merge carries its receipt:

```
t1: Collapse dash runs and trim edge dashes in slugify

Ticket: 1
Rounds: 1
Reviewed-by: kumi reviewer (fresh context, not the author)
Criterion: [pass] slugify collapses consecutive dashes to one
Criterion: [pass] slugify strips leading and trailing dashes
```

## Run

Needs [Bun](https://bun.sh) 1.2.3 or later, git 2.28 or later, and a recent [Claude Code](https://claude.com/claude-code)
signed in (2.1 or later: the agents use `--permission-prompts` and `--json-schema`). For the Rinai board, the
GitHub CLI signed in too.

```
bun install
bun link            # puts `kumi` in bun's global bin (~/.bun/bin, which has to be on PATH)
kumi hooks --install  # optional: parallel Claude Code sessions see and message each other
cd ~/some/repo
kumi                # the repo becomes a project; the daemon starts if it isn't running
```

A new project's gate is the test command kumi guesses from the repo (`c` on the board changes it). With no
gate, the reviewer is the only check and merged tickets are never run together.

| Command | |
|---|---|
| `kumi` | The board. Closing it leaves the crew running. |
| `kumi status` | Print every project's rail and exit. |
| `kumi start` / `kumi stop` | Daemon in the background. Stopping kills running agents and requeues their tickets. |
| `kumi forget [name]` | Take this repo's project, or the named one, off the board. Refused while tickets are queued or running. |
| `kumi serve` | Daemon in the foreground. |

State lives in `~/.kumi` (`KUMI_HOME`): the database, worktrees, and `daemon.log`. The daemon listens on
`127.0.0.1:4170` (`KUMI_PORT`). A daemon running older code than the `kumi` you launch is restarted, unless an
agent is mid-ticket.

## The board

The base branch runs down the screen like `git log --graph`. Above the first merge is everything on its way in,
most urgent first. On a wide terminal the selected ticket's criteria, verdicts and journal sit beside the rail.

```
 ├─╮ t13 idempotency keys on redelivery                          needs you
 │ ✗ still failing after 4 rounds
 │
▌├─╮ t12 cap webhook retries                                       round 2
 │ ⠸ working 5m · Bash bun test src/webhook.test.ts
 │
 ┆ goal #154 webhook delivery survives a flaky receiver  2 drafts · s starts them
 ┆   t16 dead-letter queue for exhausted deliveries                  draft
 │
 ● 22:15 t11 add retry backoff (main)          ✓ 3/3 · 1 round · a1b2c3d new
```

`n` say what you want done · `i` take issues from the Rinai board · `↵` open · `d` diff · `s` start a goal's
drafts · `e` edit a draft · `r` retry with a note · `a` approve past the reviewer · `x` drop · `p` pause ·
`c` gate and agent count · `A` add a repo by path · `tab` next project · `?` help · `q` quit.

Everything you type goes through the planner: it reads the repo and drafts tickets with acceptance criteria.
Edit them if you like, then `s`. Nothing runs before that.

When a goal's last ticket merges, a reporter reads everything that landed and writes what the crew did, for
you: what changed and where, calls it made, anything left. It sits on every merged ticket of the goal, next to
the author's own report and the reviewer's verdict per criterion. The rail says how many merges happened since
you last looked.

The prompts are in `src/crew.ts` and follow `docs/research/agent-prompts.md`. Tickets carry exact files, the
verify command and the planner's assumptions. Authors make the calls a ticket left open and record each as a
ruling; an author that reports `Status: BLOCKED` goes straight to you instead of the reviewer. Reviewers pass
only on evidence they produced, keep style in non-blocking nits, and from round 2 check every previous finding.

A directory that isn't a git repo yet is offered `git init` on the spot; the crew needs a base branch to work
from. Worktrees are always automatic, one per ticket, outside the repo.

## From Claude Code

`skills/kumi` is a skill that teaches Claude Code the one-shot commands, so you can say "give this to kumi"
in a session and read back what it did:

```
kumi goal "<what should be true when it is done>"   # plans drafts; --rinai files it as an issue too
kumi take 154                                        # plans from a Rinai issue
kumi go                                              # starts the drafts
kumi status · kumi show 12 · kumi init
```

Install it for every session with a symlink, `ln -s "$PWD/skills/kumi" ~/.claude/skills/kumi` (a junction on
Windows: `mklink /J`), or load the repo as a plugin for one session with `claude --plugin-dir <this repo>`.

## Parallel sessions

Every Claude Code session on this machine reports to the daemon through five hooks in `~/.claude/settings.json`
(a `curl` to `127.0.0.1:4170/api/hook/*`; silent when the daemon is down). `kumi hooks --install` puts them
there, replacing kumi's earlier ones and keeping a `.bak-kumi` copy; `kumi hooks` prints them instead. Sessions are grouped by repo,
worktrees included, and kumi's own crew counts as one more worker.

- A new session is told who else is in the repo, which files each touched (not what it was asked:
  a prompt is yours), plus any tickets the crew is running.
- On your next prompt it hears what moved since, and nothing at all when nothing did.
- Before an edit to a file another session in the same working tree changed in the last 30 minutes, the model
  is told who and why and to re-read it first, and you see a one-line notice. Once per file per change.
- A session is named from the first file it edits (`@auth`, `@api-index`), never from your prompt; before that, by
  its id. Only edits inside its working tree count, so a scratchpad or temp file never warns anyone.
- Sessions talk: `kumi say @<name> <text>` to one (a prefix of the name or id will do), `kumi say <text>` to all of them in the repo. A message lands
  on the recipient's next edit, shell command or prompt. Run from your own terminal, it comes from "the user".
  A recipient sitting idle in a Herdr pane is prompted to read it at once, unless that pane is focused: you may
  be typing in it. A woken session answers but is told not to start work on another session's word.
- A git command that moves or discards the tree (`checkout`, `switch`, `stash`, `reset --hard`, `clean`,
  `restore`, `rebase`, `pull`, `merge`) is refused while another session edited in the same working tree in the
  last 30 minutes. The model is told to ask that session, use a worktree, or ask you.
- The board: `kumi note <text>` pins a note on the repo's board (a claim, a decision, a handoff), `kumi notes`
  reads it, `kumi note -d <id>` takes one down. Notes outlive the session and the daemon: every session that
  starts in the repo, worktrees included, reads the latest ten, and live ones hear of a new note at once. A
  note over a day old is marked "may be stale", and sessions are told to check it before acting on it.
- Who is live, what each edited and undelivered messages survive a daemon restart.
- `kumi sessions` lists them.

Shell commands count as edits too: after each one, files `git status` shows changed since it started are
recorded as that session's. Two sessions running shell commands at the same instant can be mixed up.
`kumi` has to be on PATH for sessions to talk (`~/.bun/bin` after `bun link`).
The crew's own agents run with `KUMI_AGENT=1` and stay out of the registry.

## Herdr

`herdr-plugin.toml` makes the repo a Herdr plugin: `herdr plugin link <this repo>`.

- The daemon starts when the Herdr server does. It is spawned detached, so restarting Herdr never kills an agent
  mid-ticket.
- Actions, each on the focused pane's repo: `kumi.board` (popup), `kumi.board-tab`, `kumi.new` (board opened
  on the composer), `kumi.go` (start the drafts; the answer comes back as a toast).
- Bind them in Herdr's `config.toml`:

```toml
[[keys.command]]
key = "prefix+u"
type = "plugin_action"
command = "kumi.board"
```

## Rinai

A repo with a GitHub remote is a board on [rinai.dev](https://rinai.dev).

- `i` lists the board's open cards, the cycle first. Taking one fetches its brief and plans tickets from it.
- `n` can file what you typed as an issue too (`tab` in the composer), so the board knows about it.
- When the crew starts on an issue it is claimed: Ongoing, assigned to you. When a ticket lands in front of you
  the issue moves to Blocked with a comment saying why. When the last ticket merges, a comment lists the merges and
  the issue moves to In review; the commit says `Fixes #n`, so pushing closes it.

`RINAI_URL` points at a local worker instead.

## Things to know

- **No sandbox.** Authors and reviewers run under Claude Code's `auto` permission mode on your machine, in
  worktrees. Claude Code has no sandbox on native Windows. The planner runs in your checkout with read-only
  tools. An issue you take from a public tracker is text an agent acts on; read it first.
- **Agents and the gate get a trimmed environment.** System paths, your profile dirs and toolchain homes; not
  tokens, not the Claude Code or Herdr session the daemon was started from. Claude's own key reaches Claude but
  not the commands it runs. A gate that needs a variable: `KUMI_PASS=DATABASE_URL,REDIS_URL` on the daemon.
  Files are another matter: an agent can still read anything you can.
- **The API wants a token.** The daemon writes `~/.kumi/token` on first start and every client sends it. The
  hooks send it too, read from the file on each call. Hooks installed before that are refused silently: run
  `kumi hooks --install` again and restart open sessions.
- **What skips a check asks you on the desktop.** Approving past the reviewer, changing or clearing a gate,
  editing an escalated ticket's body or criteria, and `kumi forget` pop a native yes/no dialog (No by default,
  gone after two minutes). A crew agent can read the token, but it can't answer the dialog. Don't care? Set `KUMI_YOLO=1`
  where the daemon starts (`setx KUMI_YOLO 1` on Windows, then restart it) and the token is enough.
- **The tracker only hears kumi's own words.** A stuck ticket's comment names the ticket and the first line of
  why. A finished goal's comment lists each commit, its title and how it passed. Author reports and the goal
  summary stay on the board.
- **A change to agent config goes to you.** A diff that touches `.claude/`, `CLAUDE.md`, `AGENTS.md` or
  `.mcp.json` without the ticket naming it escalates before any reviewer runs in it.
- **The gate runs in a fresh worktree.** If your checks need installed dependencies, put the install in the
  gate: `bun install --frozen-lockfile && bun test`. `c` suggests one from the repo's lockfile.
- **Your checkout is only ever fast-forwarded,** in whichever worktree has the base branch checked out. If the
  base branch moved or that tree has conflicting local changes, the ticket escalates instead.
- **What merges is what was reviewed.** The gate squashes the commit the reviewer saw; anything committed on
  the branch after it is thrown away.

## Layout

`src/crew.ts` is the loop and talks only to the interfaces in `src/ports.ts`: `Store` (SQLite), `Workspace`
(git and the gate shell), `AgentRunner` (`claude -p`), `Tracker` (Rinai). `src/server.ts` wires them into the
daemon; `src/tui.ts` is a client of its HTTP API. `bun run check` runs the loop against fakes.
