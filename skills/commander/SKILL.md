---
name: commander
description: Run a task as a commander - split it into pieces, start one background yap worker per piece, collect their reports, check and commit. Use when the user says commander, or asks to fan a task out to parallel workers or sessions.
---

# Commander

You are the commander: you split, dispatch, read reports and finish. Workers do the work. Your context holds the
task, the briefs and the reports, never the work itself. Background and benchmarks: `docs/commander.md` in the
yap repo.

## 1. Split

Read the task and the code it touches, enough to cut it. A piece is one worker's job: an outcome, the files it
likely touches, and a check that proves it. Pieces may touch the same files; workers share your working tree.

Commander fits 2 or more pieces that each take minutes; a worker takes about 12 s to start. One piece, or pieces
that must run in order, you do yourself.

Done when: every piece is written down, and together they cover the whole task.

## 2. Brief

Each worker gets a brief that stands alone; it has not seen this conversation.

- **Point, don't paste.** A piece that already lives in a file or an issue gets its path or number, not its text.
- The outcome, the files, and the check to run (`bun run check`, `go test ./...`, the project's own).
- "Leave your changes uncommitted; the commander commits."
- "End with what you changed, and whether your check passed, with its last lines."

## 3. Dispatch

```sh
yap spawn --skills <names> "<brief>"     # prints: started @<id>
```

- Every spawn carries `--skills`: it makes the worker lean, with none of the user's plugins, only yap and the
  names given (about 44k tokens less per worker). Pick by the piece: `ponytail` for code, `frontend-craft` for
  UI, both for a piece that is both. A spawn with no `--skills` loads the user's whole setup; reserve it for a
  piece that needs one of their other plugins, and say which.
- `yap config spawns` is how many run at once (3 by default). With more pieces than that, start the rest as
  reports come back. A spawn past the limit fails with 429.
- Right after each spawn, run `yap spawns <id>` as a background command (Bash with `run_in_background`). It
  exits when that worker ends, printing `finished:` or `failed:` and its last word, and you are notified. That
  is how reports reach you; you never poll.

Done when: every piece has a worker and a background `yap spawns <id>` waiting on it.

## 4. Collect

Read each report as it arrives. Trust a worker's passing check; don't redo its work.

- A worker reported a failure: fix it yourself if small, or spawn one worker with the report and the fix wanted.
- A worker is stuck or off track: `yap say '@<id>' <text>` reaches it mid-run. `yap spawns <id>` shows what it
  is doing.

Done when: every worker has reported, and every reported failure is fixed or written down as open.

## 5. Finish

Workers tested while their peers were still editing, so run the project's check once on the final tree, and read
`git diff --stat` for anything nobody asked for. Commit, then report to the user: each piece, its worker, pass or
fail, and anything left open.
