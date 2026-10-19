---
name: yap
description: Hand work to yap, an autonomous crew that plans, implements, reviews and merges tickets on the current repo, and read back what it did. Use when the user says to give something to yap or the crew, asks what yap is doing or did, wants yap's status, or wants a Rinai issue worked by the crew.
---

# yap

yap runs a daemon on this machine. Each goal is planned into tickets with acceptance criteria; an agent writes
each ticket on its own branch in a worktree, a second agent in a fresh context reviews the diff against every
criterion, and the project's gate command runs on the merged result before the base branch moves. The author
never merges its own change. Everything is one-shot from the shell; never run bare `yap`, which opens an
interactive board.

Run every command from inside the repo. The daemon starts on demand.

| Do | Run |
|---|---|
| See the board: what is drafted, running, needing a human, merged | `yap status` |
| Read one ticket: criteria with verdicts, the crew's write-up, the journal | `yap show 12` |
| Hand over work | `yap goal "<what should be true when it is done>"` |
| Hand over work and file it on the Rinai board too | `yap goal --rinai "<text>"` |
| Work a Rinai issue | `yap take 154` |
| Start the drafted tickets | `yap go` |
| A directory with no git yet | `yap init` |
| Which other Claude sessions are in this repo, and what they are doing | `yap sessions` |
| Tell another session something, or all of them in this repo | `yap say [@<name>] <text>` |
| Leave a note for every session in this repo, now and later | `yap note <text>` · `yap notes` · `yap note -d <id>` |

A goal is planned into drafts first and nothing runs until `yap go`. Ask the user before running `yap go`
unless they already said to start. Write goals as outcomes with enough context for an engineer who has not seen
this conversation: file paths, the behaviour wanted, what must not change.

When the user asks what yap did, run `yap status`, then `yap show` on the tickets they care about, and relay
the write-up and anything marked "needs you". A ticket that needs a human is handled on the board, not here.
