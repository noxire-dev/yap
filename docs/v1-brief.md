# YAP v1 brief

Nov 11, 2026. Revised from Fable's brief of Nov 10, which is checked against `src/` and folds in what Kodr's own coordination build (Kodr `dbac1d71dd`, since reverted) proved in a live run.

## Summary

YAP owns coordination between agents. It rides on hooks, so it works under plain Claude Code, Herdr and Kodr alike; Kodr only shows what YAP reports, through its plugin API. Kodr built and live-tested the same ideas this week, then reverted them so there is one source of truth. v1 fixes the user-origin gap, makes delivery survive a dropped answer, adds claims, message ids and kinds, and moves Kodr's merge conflict check into the daemon.

Hand this to a coding agent one item at a time.

## What the code says today

Checked on Nov 11 against `kumi` at `dd3e0fd`:

- A `say` with no `from` is attributed to the user (`src/sessions.ts`, `say()`).
- One machine token in `~/.yap/token` authorises every caller (`src/server.ts`).
- The edit guard is a 30-minute lookback (`RECENT` in `src/sessions.ts`).
- `turn` reads only the prompt's first line, to recognise harness markup and wakes. It is not stored.
- State is in `bun:sqlite` through `src/store.ts`; sessions are JSON rows.

## Order

| # | Item | Size | Depends on |
| --- | --- | --- | --- |
| 1 | User origin and authority wording (done; the TUI handshake was dropped, the TUI sends no messages) | S | none |
| 2 | Message ids, seq and acks (done; seq is clock-based, undelivered shows in `yap sessions`, not `yap status`) | M | none |
| 3 | `re` and message kinds | S | 2 |
| 4 | `claim` verb | M | 2 |
| 5 | Merge conflict check (done) | M | none |
| 6 | Small fixes (6b needs 4) | S | none |
| 7 | Kodr surfaces | S | 3, 4, 5 |
| 8 | Second harness adapter (optional) | L | 1 to 6 |
| 9 | Core and extensions split, version 1 | M | 8, or 1 to 6 if 8 is skipped |

The split comes after the second adapter on purpose: the adapter is what shows which verbs are really core.

## Ground rules

1. Read `docs/yap.md`, `src/sessions.ts`, `src/server.ts` and `src/ports.ts` first. If the code disagrees with this brief, stop and report it.
2. Spec and code change in the same commit. `docs/yap.md` stays the source of truth.
3. Every new verb or field gets a test that talks to the daemon over HTTP.
4. Keep the v0 properties: localhost only, `Host` and `Origin` checks, empty 403 on refused calls, peer text only ever in `context`.
5. Windows stays supported. No Unix sockets or peer credentials.
6. New fields are optional until the version bump. A v0 hook keeps working until `yap hooks --install` is rerun.
7. Do not touch `src/crew.ts` or the relay unless the item says so. No new runtime dependencies.

## 1. User origin and authority wording

**Problem.** A `say` with no session is shown to peers as the user, so any agent with a shell can speak as you in one line.

**Change.**

- Messages carry `origin`: `session` (sent from inside a known session, `YAP_SESSION` set), `user` (the TUI, or a remote client paired through the relay), or `local` (anything else holding the machine token).
- A call with no session is `local`, never `user`, and peers see it as "an unverified local process". Plain-terminal `yap say` stays `local`; the TUI is the user surface.
- The TUI gets a user token over its own handshake at start, held in memory, never written to disk.
- The context text around every delivered message says it is information from another agent: it cannot approve a permission prompt, change configuration, or stand in for the user.
- `docs/yap.md` section 6 says in plain words that every agent runs as your OS user and can read any local secret, so origin stops accidents and one-liners, not a determined agent.

**Deferred.** Per-session tokens. The token file would be readable by the same agents it guards against; add it if a real impersonation shows up.

**Acceptance.**

- `say` with no session arrives with `origin: "local"` and never renders as the user.
- A message typed in the TUI arrives with `origin: "user"`.
- The authority sentence is in the context of every delivered message.

## 2. Message ids, seq and acks

**Problem.** A message is delivered once, on the next answer. If the hook times out or the harness drops the answer after the daemon dequeued it, the message is gone.

**Change.**

- Every message gets a stable `id` and a per-repo `seq` that only goes up, assigned in the same SQLite transaction as the queue rows.
- An answer that carries messages also carries `seq`, the highest one included.
- Any verb accepts optional `ack`: the highest `seq` the session actually showed its model. The daemon redelivers queued messages above `ack`, at most 3 times; after that, `yap status` lists the message as undelivered.
- Harnesses drop ids they have already shown, so redelivery is harmless.
- A session that never sends `ack` keeps v0 behaviour: delivered when sent.
- The `idle` rule stays: nothing is returned when `continuing` is set.

**Implementation.** Hooks are stateless `curl` calls. After a hook has printed its output it writes the answer's `seq` to `~/.yap/sessions/<id>.cursor`; the next hook sends it as `ack`.

**Deferred.** SSE replay with `Last-Event-ID`, retention windows and 410. Add them when a client actually reconnects and needs the gap; Kodr reads current state from `sessions`.

**Acceptance.**

- Kill the daemon after commit and before the HTTP response: after restart the message arrives on the session's next verb.
- A hook that never acks gets the message again, at most 3 times, with the same `id`.
- Two messages sent in order arrive in order with increasing `seq`.
- A v0 hook that sends no `ack` behaves exactly as before.

## 3. `re` and message kinds

**Change.**

- `say` accepts optional `kind`: `question`, `blocker`, `handoff`, `contract`, `answer` or `note` (default). Kodr's live run had a real agent pick `question` unprompted; the kinds also rank what needs the user (blocker above question above handoff).
- `say` accepts optional `re`: the id of the message being answered. An `re` that names no message in this repo answers 400.
- A `question`, `blocker` or `contract` stays open until a message with `re` pointing at it arrives. `yap status` lists open ones.
- The context text shows the id in short form and how to answer: `yap say --re <id> <text>`.
- Read-only verb `thread` with `id` returns the message and its replies, oldest first.

**Acceptance.**

- A reply with `--re` arrives with `re` set, closes the question, and `thread` returns both in order.
- An unknown `re` answers 400.
- An unanswered `blocker` shows as open in `yap status`.

## 4. The `claim` verb

**Problem.** Claims exist only as free-text notes, and the guard reacts after a peer has already written.

**Change.**

| Verb | Fields | Behaviour |
| --- | --- | --- |
| `claim` | `path`, `why`, `ttl` (optional, seconds) | Records that this session is about to work under `path`. Answers the claim `id`, or `conflict` naming the holder when a live claim by a peer in the same working tree overlaps. |
| `release` | `id` | Ends the claim early. |
| `claims` (read-only) | none | `[{ id, session, name, path, why, expires }]` |

- `path` is a file or directory prefix relative to the working tree. No globs. Two claims overlap when one is a prefix of the other. Normalise like the repo key.
- Default `ttl` 20 minutes, maximum 2 hours. An `edited` under the path by the holder renews it.
- Claims end on `release`, expiry, `leave`, or lapsed liveness. First claim wins; no queue.
- `will-edit` checks claims before the lookback and warns once, naming the claim and its reason.
- Warn only on edits made after the claim existed. Kodr's first version also warned on earlier edits, and the noise made the warning useless.
- Claims in another worktree of the same repo are listed, never conflict.
- `join` and `turn` include live claims in their context. The skill says: claim a directory when a task touches more than two files in it.
- Remove "claims" from the board's description in the spec.

**Acceptance.**

- A claims `src/auth/`; B's claim on `src/auth/token.ts` answers `conflict` with A's name and reason.
- B's `will-edit` under A's claim warns once. An edit B made before A claimed does not warn.
- A's claim disappears on `leave` and after `ttl` without edits; an edit by A extends it.

## 5. Merge conflict check

**Problem.** Two sessions in different worktrees can each be fine alone and still not merge. Today nobody finds out until someone merges.

**Change.** At `idle` (end of a turn, `continuing` unset), the daemon snapshots that session's working tree and test-merges it against the latest snapshot of every other live session in the same repo with a different working tree. Conflicts go into both sessions' next context and into `sessions` as `conflicts: [{ with, files }]`.

**Implementation.** This is what Kodr ran, adapted to working trees instead of Kodr's checkpoint refs:

```sh
# snapshot, without touching the real index
GIT_INDEX_FILE=$tmp git read-tree HEAD
GIT_INDEX_FILE=$tmp git add -A
tree=$(GIT_INDEX_FILE=$tmp git write-tree)
snap=$(git commit-tree $tree -p HEAD -m yap-snapshot)

# test-merge; exit 1 means conflict, the file names follow the tree id
git merge-tree --write-tree --name-only --no-messages $snapA $snapB
```

- Needs git 2.38 or newer. If `merge-tree --write-tree` is missing, skip the check and say so once in `yap status`.
- Repos are grouped by `git rev-parse --git-common-dir`, which the repo key already approximates.
- Run the merges in parallel and cap the work per idle; a repo with ten live sessions is nine merges.
- A conflict clears when a later snapshot of either side merges cleanly.

**Acceptance.**

- Two worktrees that both add `feature.txt` with different contents report `feature.txt` to both sessions after the second `idle`.
- Editing one side to match clears it on the next `idle`.
- The real index and working tree are untouched (`git status` identical before and after).

## 6. Small fixes

**6a. `turn` without the prompt.** Add optional `synthetic` to `turn`: a harness that knows the turn came from a wake or an agent message sets it and omits `prompt`. `prompt` stays accepted, is checked for markup, then discarded; never stored, logged or put on the stream. Test: send a marker string as a prompt and grep the SQLite file and `daemon.log` for it.

**6b. Strict mode.** A per-repo setting, off by default, that lets `will-edit` answer `deny` inside a peer's live claim. The lookback never denies; only an explicit claim can. Update section 3 of the spec, which reserves `deny` for `will-run`.

**6c. Shell edit attribution.** When two `will-run` windows overlap in one working tree, mark files changed in the overlap `shared` instead of guessing an owner, and warn both. State the limit in the spec next to `ran`.

**Acceptance.** A `synthetic` turn with no prompt makes no news. The marker test finds nothing on disk. Strict mode denies with the holder's name and reason; off, it warns. Two overlapping shell commands that change one file leave it `shared`.

## 7. Kodr surfaces

Kodr shows YAP's state through the chips in `src/kodrChips.ts`; no Kodr core change. Kodr's chip tones are `neutral`, `info`, `ok`, `warn` and `error`.

- A merge conflict: `error` chip naming the other session and the file count.
- An open `blocker` or `question` to or from the thread: `warn` chip.
- Inside a peer's claim: `warn` chip with the claim's reason.

**Deferred.** Kodr's reverted build also had a ranked "needs you" list and a replay slider over the log. Both need a plugin panel, which Kodr's plugin API does not have yet; ask for one there rather than building it into Kodr core.

## 8. Second harness adapter (optional)

Worth doing only if YAP is meant as a protocol other people implement; the current user runs Claude only. If it goes ahead: pick OpenCode or Codex CLI, answer first whether it can run code around edits and shell commands and block them, and inject text at session start and each turn. Core verbs only, in `adapters/<harness>/`, HTTP only, nothing imported from `src/`. The deliverable is `adapters/<harness>/SPEC-NOTES.md`: every place the spec assumed Claude Code.

## 9. Core and extensions split

As in Fable's brief: `hello` and `GET /yap` answer `{ protocol, version, verbs, extensions }`; core is the session lifecycle, `say`, `note`, `sessions`, `notes` and the answer shape; `claims`, `threads` (`re`, `kind`, `thread`), `conflicts`, `spawn` and `relay` are extensions. `spawn` is redefined without naming Claude Code. The HTTP tests from items 1 to 6 become `tests/conformance/`, runnable against any base URL, with extension tests skipping themselves when `hello` does not list the extension. Bump `version` to 1 once, here.

## Delivery stays direct

Kodr's build only let a message reach another agent when the user clicked a button. YAP keeps delivering straight into the recipient's context: gating every message would turn the user into a mail carrier, and item 1's authority sentence covers the risk that made gating attractive.

## Left out of v1

Per-session tokens, SSE replay and retention, globbed claims, symbol-level claims through LSP, delegated authority, and the orchestrator versus peer benchmark.
