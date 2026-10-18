---
name: kumi
description: Hand work to kumi, an autonomous crew that plans, implements, reviews and merges tickets on the current repo, and read back what it did. Use when the user says to give something to kumi or the crew, asks what kumi is doing or did, wants kumi's status, or wants a Rinai issue worked by the crew.
---

# kumi

kumi runs a daemon on this machine. Each goal is planned into tickets with acceptance criteria; an agent writes
each ticket on its own branch in a worktree, a second agent in a fresh context reviews the diff against every
criterion, and the project's gate command runs on the merged result before the base branch moves. The author
never merges its own change. Everything is one-shot from the shell; never run bare `kumi`, which opens an
interactive board.

Run every command from inside the repo. The daemon starts on demand.

| Do | Run |
|---|---|
| See the board: what is drafted, running, needing a human, merged | `kumi status` |
| Read one ticket: criteria with verdicts, the crew's write-up, the journal | `kumi show 12` |
| Hand over work | `kumi goal "<what should be true when it is done>"` |
| Hand over work and file it on the Rinai board too | `kumi goal --rinai "<text>"` |
| Work a Rinai issue | `kumi take 154` |
| Start the drafted tickets | `kumi go` |
| A directory with no git yet | `kumi init` |
| Which other Claude sessions are in this repo, and what they are doing | `kumi sessions` |
| Tell another session something, or all of them in this repo | `kumi say [@<name>] <text>` |
| Leave a note for every session in this repo, now and later | `kumi note <text>` · `kumi notes` · `kumi note -d <id>` |

A goal is planned into drafts first and nothing runs until `kumi go`. Ask the user before running `kumi go`
unless they already said to start. Write goals as outcomes with enough context for an engineer who has not seen
this conversation: file paths, the behaviour wanted, what must not change.

When the user asks what kumi did, run `kumi status`, then `kumi show` on the tickets they care about, and relay
the write-up and anything marked "needs you". A ticket that needs a human is handled on the board, not here.
