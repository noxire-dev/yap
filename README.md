# kumi

A crew of coding agents that works through a goal without you watching. Modelled on [niwa](https://niwa.build).

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

Needs [Bun](https://bun.sh), git, and [Claude Code](https://claude.com/claude-code) signed in. For the Rinai
board, the GitHub CLI signed in too.

```
bun install
bun link        # puts `kumi` in bun's global bin
cd ~/some/repo
kumi            # the repo becomes a project; the daemon starts if it isn't running
```

| Command | |
|---|---|
| `kumi` | The board. Closing it leaves the crew running. |
| `kumi status` | Print every project's rail and exit. |
| `kumi start` / `kumi stop` | Daemon in the background. Stopping kills running agents and requeues their tickets. |
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

Install it for every session with a junction (or copy) into `~/.claude/skills`, or load the repo as a plugin
for one session with `claude --plugin-dir <this repo>`.

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
  worktrees. The planner runs in your checkout with read-only tools.
- **The gate runs in a fresh worktree.** If your checks need installed dependencies, put the install in the
  gate: `bun install --frozen-lockfile && bun test`. `c` suggests one from the repo's lockfile.
- **Your checkout is only ever fast-forwarded.** If the base branch moved or your tree has conflicting local
  changes, the ticket escalates instead.

## Layout

`src/crew.ts` is the loop and talks only to the interfaces in `src/ports.ts`: `Store` (SQLite), `Workspace`
(git and the gate shell), `AgentRunner` (`claude -p`), `Tracker` (Rinai). `src/server.ts` wires them into the
daemon; `src/tui.ts` is a client of its HTTP API. `bun run check` runs the loop against fakes.
