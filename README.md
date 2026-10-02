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

Needs [Bun](https://bun.sh), git, and [Claude Code](https://claude.com/claude-code) signed in.

```
bun install
bun link        # puts `kumi` in bun's global bin
kumi            # opens the board; starts the daemon if needed
```

| Command | |
|---|---|
| `kumi` | The board. Closing it leaves the crew running. |
| `kumi status` | Print every project's rail and exit. |
| `kumi start` / `kumi stop` | Daemon in the background. Stopping kills running agents and requeues their tickets. |
| `kumi serve` | Daemon in the foreground. |

State lives in `~/.kumi` (`KUMI_HOME`): the database, worktrees, and `daemon.log`. The daemon listens on
`127.0.0.1:4170` (`KUMI_PORT`).

## The board

The base branch runs down the screen like `git log --graph`. Above the first merge is everything on its way in,
most urgent first.

```
 ├─╮ t13 idempotency keys on redelivery                          needs you
 │ ✗ still failing after 4 rounds
 │
▌├─╮ t12 cap webhook retries                                       round 2
 │ ⠸ working 5m · Bash bun test src/webhook.test.ts
 │
 ┆ goal webhook delivery survives a flaky receiver   2 drafts · s starts them
 ┆   t16 dead-letter queue for exhausted deliveries                  draft
 │
 ● 22:15 t11 add retry backoff (main)          ✓ 3/3 · 1 round · a1b2c3d new
```

`A` add a repo · `g` goal · `n` ticket · `↵` open · `d` diff · `s` start a goal's drafts · `r` retry with a note ·
`a` approve past the reviewer · `x` drop · `e` edit in `$EDITOR` · `p` pause · `c` gate and worker count ·
`tab` next project · `q` quit.

## Things to know

- **No sandbox.** Authors run under Claude Code's `auto` permission mode on your machine. Reviewers and the
  planner get read-only tools.
- **The gate runs in a fresh worktree.** If your checks need installed dependencies, put the install in the
  gate: `bun install --frozen-lockfile && bun test`.
- **Your checkout is only ever fast-forwarded.** If the base branch moved or your tree has conflicting local
  changes, the ticket escalates instead.

## Layout

`src/crew.ts` is the loop and talks only to the three interfaces in `src/ports.ts`: `Store` (SQLite),
`Workspace` (git and the gate shell), `AgentRunner` (`claude -p`). `src/server.ts` wires them into the daemon;
`src/tui.ts` is a client of its HTTP API. `bun run check` runs the loop against fakes.
