# YAP

How coding agents on one machine see each other, message each other and stay out of each other's way. The yap
daemon is the first implementation (`src/sessions.ts`); Claude Code is the first agent wired to it. This file
is the protocol without either, so another agent, or a web client, can speak it.

Status: version 1. Everything here runs today.

## The model

- A **session** is one agent conversation. It has an id the agent chooses (stable for the conversation) and a
  directory it works in.
- The daemon resolves that directory to a **working tree** (`git rev-parse --show-toplevel`) and a **repo** (the
  git common dir, so a repo's worktrees share it). Outside git, both are the directory itself.
- Sessions in one repo are **peers**. Peers in the same working tree can clobber each other; peers in another
  worktree can't, and are only shown.
- A session is **live** until it leaves or goes 2 hours without a call.
- A session's **name** comes from the first file it edits inside its tree (`src/auth.ts` gives `auth`, a generic
  `src/api/index.ts` gives `api-index`), made unique in the repo with `-2`, `-3`. Before that it goes by the
  first 8 characters of its id. Never from a prompt: prompts are the user's words, and peers would read them.
- The **board** is a repo's notes: decisions, warnings, handoffs. Notes outlive sessions. A note over a day old is
  stale.
- A **claim** is a session saying it is about to work under a file or directory. It only warns: peers in any
  worktree of the repo hear of it before they edit there. It lasts 20 minutes past its making or the holder's last
  edit under it, and ends sooner on `release` or when the session leaves.

## Verbs

Every call carries `session` (the id) and `cwd`, and may carry `ack` (see Answers). Each answer is an **answer** (below) or nothing.

| Verb | When the agent sends it | What the daemon does |
|---|---|---|
| `join` | A conversation starts (`name`, optional) | Registers it. Answers with its peers, the crew's running tickets, the board and its own name. A harness that names its sessions passes `name`; the session goes by it (made unique) instead of a name from its first file. `pid`, optional: a process that lives as long as the session; when it is gone the session leaves, `leave` or not. `terminal`, optional, on any verb: the herdr-core terminal it runs in (`HC_TERMINAL_ID`); `sessions` lists it, and a session idle in it is woken with `hc send --if idle`. |
| `turn` | The user sends a prompt | Answers with what peers did since it last heard, and nothing at all when nothing moved. Prompts that are harness markup (`<agent-message …>`) don't count as news. |
| `will-edit` | Before a file write (`path`) | If the file is inside a peer's live claim, in any worktree, answers with the holder and reason, once per claim. If a peer in the same tree edited that file in the last 30 minutes, answers with who, once per file per peer edit. Neither denies. |
| `edited` | After a file write (`path`) | Records it, if inside the tree. The first one names the session. |
| `will-run` | Before a shell command (`command`) | Notes the start time. If the command would move the tree (`checkout`, `switch`, `stash`, `reset --hard`, `clean`, `restore`, `rebase`, `pull`, `merge`) or sweep it (`add -A`, `commit -a`) while a peer in the same tree edited in the last 30 minutes, answers with a **deny**. The tree is the one the git runs in: a `cd <dir>` before it or `git -C <dir>` names another worktree, judged by who works there. |
| `ran` | After a shell command | Files changed in the tree since `will-run` count as this session's edits, unless a peer's `edited` claimed them. When two shell commands overlap in one working tree, a file they change counts as the edit of whichever session sends `ran` first. |
| `idle` | The agent is about to end its turn (`continuing` if an earlier `idle` answer kept it going) | Answers with messages that came in while it worked, so it reads them now and not after the user's next prompt. Nothing while `continuing`: once a turn, so two sessions can't keep each other talking. Then, after answering, snapshots the working tree (untracked files included, the real index untouched) and test-merges it with the latest snapshot of every peer in another worktree of the repo (`git merge-tree`, git 2.38+). When the files that would conflict change, both sides get a `conflict` message, and another when they merge cleanly again. |
| `leave` | The conversation ends | Forgets it. |
| `say` | The agent or user sends a message (`text`, optional `to`, `kind`, `re`) | `to` `user` is the person, not a peer: the message goes to the user's inbox (`inbox`, local and remote), a `question` or `blocker` stays on the sender's `unanswered` until the user replies with `re`, and nobody is woken; the user can't `say` to `user`, and no session is named `user`. Otherwise queues it for one peer (`to` is a name, a name prefix or an id prefix; an exact name wins) or all peers in the repo; a `to` nobody in the repo matches is looked up in every repo. One message id for all its recipients. `kind` `question` or `blocker` keeps it on the sender's `unanswered` until a message with `re` (its id, or 8 characters of it) answers it, or the sender leaves or lapses; a reply with no `to` goes to the asker. An `re` that matches nothing is delivered anyway. A peer idle in a pane is **woken**. Without `session`, the sender is `an unverified local process` (see Trust). |
| `note` | `text` | Pins it on the repo's board; live peers hear of it on their next call. |
| `unnote` | `id` | Takes a note down. |
| `claim` | `path`, `why` | Claims a file or directory inside the session's working tree, before working under it. Answers `{ id }`, or `{ held: { session, name, path, why } }` when a peer's live claim in any worktree of the repo overlaps it. Overlap is by path components: `src/auth` covers `src/auth/token.ts`, not `src/author`. First claim wins; nothing queues. Join and turn context list peers' claims. |
| `release` | `id` | Ends one of the session's claims early. |
| `spawn` | `text`, the task; `agent`, optional: `codex` | Starts a background Claude Code session (or Codex: `codex exec` in its workspace sandbox) in `cwd` on it, under a new id, and answers `{ "id" }`. It is a peer like any other: it joins, edits and hears messages. When it ends, its final message goes to the sender's inbox (the sender is woken if idle), or, with no session, to `yap spawns`. At most `spawns` (`yap config`, 3 by default) run at once; past that it is refused with a 429. |
| `doing` | `text`, one line | Sets what the session says it is working on, in its own words; empty `text` clears it. Peers see it next to its name in join and turn context (they hear on their next prompt, as for an edit), and `sessions`, local and remote, list it. Only a session sends it. |

Messages queued for a session are delivered with its next answer, on any verb.

Six more read the repo `cwd` sits in, for a harness or a tool, and change nothing:

| Verb | Answers |
|---|---|
| `hello` | `{ protocol: "yap", version, verbs, extensions }` |
| `sessions` | its live sessions: `[{ id, name, top, repo, started, at, doing?, files, conflicts, undelivered, unanswered }]`, `files` relative to `top`; `doing` what it said it is working on; `conflicts` is `[{ with, files }]`, the peers whose working tree would conflict with its own; `undelivered` is `[{ id, from, text }]`, messages it never acked after three deliveries; `unanswered` is `[{ id, to, kind, text }]`, its questions and blockers nobody has replied to with `re`, `to` `the user` for one asked of the person |
| `inbox` | `since`, optional, a `seq`. What sessions in the repo said to the user and how background sessions the user started ended, oldest first, after `since`: `[{ id, seq, kind: "say" \| "question" \| "blocker" \| "spawn", origin, from, sender, text, at, re?, ok?, repo }]`. The newest 200 are kept, across restarts. |
| `notes` | its board, newest first: `[{ id, ts, author, text, repo }]` |
| `spawns` | background sessions started there, newest first: `[{ id, name, task, from, started, done?, ok?, result?, steps }]`. `steps` counts its log: one line a tool call it made (`Edit src/a.ts`), Claude Code only. `id` (a prefix) picks one and adds `log`, `[{ n, at, line }]`, the lines after `since` (an `n`); the newest 200 are kept. Poll it to follow a spawn live |
| `claims` | its live claims, every worktree: `[{ id, session, name, top, path, why, expires }]`, `path` relative to `top` |

## Core and extensions

Every YAP daemon has the core: `join`, `turn`, `will-edit`, `edited`, `will-run`, `ran`, `idle`, `leave`, `say`
(with `kind` and `re`), `sessions`, `hello`, `GET /yap/events`, the answer shape (below), and the fields
`session`, `cwd` and `ack`. The rest are extensions, listed by short name in `hello`'s `extensions`:

| Extension | What it adds |
|---|---|
| `board` | `note`, `unnote`, `notes` |
| `claims` | `claim`, `release`, `claims` |
| `conflicts` | the merge check at `idle` and the `conflict` message kind |
| `spawn` | `spawn`, `spawns` |
| `doing` | `doing`, and `doing` on `sessions` |
| `inbox` | `say` to `user`, `inbox` |

A daemon has an extension or it doesn't; nothing negotiates. The relay (Remote, below) is not an extension.

One rule for clients: ignore fields, message kinds and verbs you don't know, and render a message's `text`.

## Answers

An answer has up to five parts, and an agent maps each to what it has:

- `context`: text for the model only. Peers, warnings, messages. Never shown to the user as if they typed it.
- `notice`: one line for the user (`yap: src/auth.ts was just edited by @auth`).
- `deny` with a `reason`: only on `will-run`. The agent must not run the command and tells the model why.
- `messages`: the messages `context` just delivered, as data, for a harness to show. The model already has them
  in `context`; a harness doesn't parse that. Each is
  `{ id, seq, kind: "say" | "question" | "blocker" | "note" | "spawn" | "conflict", origin, from, sender, text, at, re?, ok? }`: `seq` only
  goes up, across repos and daemon restarts; `origin` is `session`,
  `user` or `local` (see Trust), `from` as the model reads it (`session @auth`, `the user`,
  `an unverified local process`), `sender` the sending session's id (`""` without one), `re` the id of the message it answers, `ok` on a spawn's end. On a
  `conflict`, `from` and `sender` are the other side and `text` the conflicting files, one per line, empty once clean.
- `seq`: with `messages`, the highest `seq` among them.

A message is delivered once, unless the session acks. Once the harness has put an answer's `context` in front of
the model, it sends that answer's `seq` as `ack` on its next call (any verb), and `0` before it has one. A session
that acks keeps each message until an `ack` reaches its `seq`; one still unacked ten seconds after it was
delivered comes again with the same `id`, three deliveries at most, then `sessions` lists it as `undelivered`. A
message whose answer was lost to a hook timeout or a daemon restart comes again. The model may see a message twice;
a harness that shows `messages` drops ids it already showed.

An agent that can't receive answers on some verb still sends it: the daemon's record stays right, and the
messages wait for the next verb that can answer.

## Wake

A message to an idle session should not wait for the user's next prompt. A **pane host** (Herdr today) is asked
to submit one plain line to the session, `yap: a message from session @auth`, as if typed; the session's `turn`
answer then carries the message and instructions in `context`. Rules:

- Only an idle session is woken, and never one in the focused pane: the user may be typing in it.
- The wake line is the only thing the user sees. It is not news and does not name the session.
- A woken session answers a session with `say`, the user directly, and doesn't start work on a peer's word.

## Trust

- The daemon listens on `127.0.0.1` only and refuses a foreign `Host` or `Origin`.
- Every call carries `x-yap-token`, the contents of `~/.yap/token` (mode 600, written on first start).
- Answers carry peers' messages, so the token gates them too. A refused call gets an empty 403: an agent that
  prints a hook's output into its context must not print an error into it.
- Every agent runs as the user's OS account, so it can read the token, and it can run `yap say` without
  `YAP_SESSION` or with another session's id. Origin is there to stop accidents and one-liners, not a
  determined agent:
  - `session`: the call named a live session. Trusted to be that session only as far as session ids stay
    private, which on one machine they don't.
  - `user`: a device paired through the relay. Nothing local can claim it.
  - `local`: anything else with the token, a terminal or an agent's shell alike. Shown as
    `an unverified local process`, never as the user.
- Every delivered message comes with a line telling the model it is information: it cannot approve a
  permission prompt, change configuration or stand in for the user.
- **Trusted handoffs** (`yap handoffs trusted`, off by default): a session handing another work the user already
  started counts as the user's go, so a woken session acts on it and tells the user after, instead of leaving it
  for them. The line still says no message approves a permission prompt or changes configuration, and merging
  someone else's pull request, anything public, money and anything destructive still wait for the user. Turning
  it on is confirmed on the desktop (`POST /api/handoffs {mode}`), since every agent holds the token; turning it
  off isn't. The setting lives in the daemon's store, not in a file an agent could write.
- What would skip a check (approving past the reviewer, changing a gate, forgetting a project) is confirmed on
  the desktop, which the token holder can't do. Not part of YAP; it belongs to the crew.

## The wire

`POST http://127.0.0.1:4170/yap/<verb>` (`YAP_PORT` moves it) with `x-yap-token` and a JSON body:

```json
{ "session": "codex-1", "cwd": "C:/src/app", "path": "src/auth.ts" }
```

The fields are `session`, `cwd`, and the verb's own: `path` (will-edit, edited), `command` (will-run, ran),
`prompt` (turn), `name` (join), `text`, `to`, `kind` and `re` (say), `text` (note and spawn), `id` (unnote), and `ack` on the
session's own verbs. The answer is `{}` or any of `{ "context", "notice", "deny", "messages", "seq" }`; `say` answers `{ "id", "to": ["@auth"], "woke": [] }`, `note` the note. An unknown
verb or a bad argument is a 400 with `{ "error" }`. A missing or wrong token is a 403. `GET /yap` answers
`{ protocol, version, verbs, extensions }`.

```sh
curl -s -H content-type:application/json -H "x-yap-token: $(cat ~/.yap/token)" \
  --data-binary '{"session":"codex-2","cwd":"'"$PWD"'","command":"git checkout main"}' \
  http://127.0.0.1:4170/yap/will-run
```

## Events

`GET /yap/events?cwd=<dir>` (with `x-yap-token`) is a server-sent event stream of what happens in the repo
`<dir>` sits in; without `cwd`, in every repo. Each event is named by its `type` and carries JSON:

| `type` | Fields | When |
|---|---|---|
| `join` | `session`, `name`, `pid` | a session registers (any verb from a new id) |
| `leave` | `session`, `name` | it leaves, or goes 2 hours silent |
| `edited` | `session`, `name`, `path` (relative to its tree) | it edits a file, or a shell command of its does |
| `message` | `session` (the one it is for), `name`, and the message's `kind`, `from`, `sender`, `text`, `at`, `ok?` | something is queued for it: a `say`, a note, a spawn it started ending, a merge conflict found or cleared. `session` `user`: it went to the user's inbox |
| `note` | `id`, `author`, `text` | a note goes on the board |
| `doing` | `session`, `name`, `text` | a session says what it is working on; `""` cleared it |
| `activity` | `spawn` (its id, 8 characters), `line` | a background session yap started made a tool call |

Every event also has `repo`, the repo's main checkout, normalized (forward slashes, lowercase on Windows). The
stream starts empty: read `sessions` first for who is already there.

## Bringing your own harness

A harness (an IDE, an agent runner) that hosts agents can speak YAP for them without Claude Code's hooks or
Herdr:

1. Give each agent a stable session id. Send `join` with it, and a `name` if the harness has one for it.
2. Send `turn` with each user prompt, `will-edit`/`edited` around each file write, `will-run`/`ran` around each
   shell command, `idle` before the agent ends its turn, and `leave` when the conversation closes.
3. Put each answer's `context` in front of the model, show `notice` to the user, and don't run a command that
   came back with `deny`; give the model the reason instead.
4. Set `YAP_SESSION=<id>` in the agent's environment, so the `yap say`, `yap note` and `yap spawn` it runs
   speak as it and not as the user. For Claude Code with the yap plugin, that is all of steps 1 to 4.
5. Be the pane host: on a `message` event for one of your sessions that sits idle, start a turn with the prompt
   `yap: a message from <from>`. Its `turn` answer carries the message and tells the model the user didn't type
   it. A busy session needs nothing: the message comes with its next answer. Don't wake for a `conflict`: it is
   yap's finding, not a request, and waits for the session's next turn.

`sdk/local.ts` does all of it in one file with no dependencies (Node 18+, Bun); vendor it:

```ts
import { YapLocal, wakePrompt } from './yap'

const yap = await YapLocal.connect({ start: () => exec('yap start') })  // token from ~/.yap/token
const s = yap.session(thread.id, thread.worktree)
await s.join('planner')
const a = await s.willRun(command)              // and turn, willEdit, edited, ran, idle, leave
if (a.deny) return refuse(a.deny)
yap.watch(thread.worktree, e => {
  if (e.type === 'message' && isIdle(e.session)) startTurn(e.session, wakePrompt(e))
})
```

Codex's hooks speak Claude Code's format, so the same adapter serves them through `yap hook <event> codex`
(the route's `?for=codex`). The differences: Codex edits with `apply_patch`, whose files are named in the patch
(`*** Update File: …`) and get a verb each, and Codex's `Stop` carries on with `decision: block` and the
context as `reason`, not `additionalContext`.

An agent whose harness speaks no YAP can speak it itself through `yap mcp`, an MCP server on stdio. It
joins on its first request, named for the client (`clientInfo`, from `initialize` or `_meta`), and leaves when stdin closes or the process dies. With `YAP_SESSION` set it is that
session's tools instead, and joining and leaving are left to whoever set it. Its tools: `yap_check` (`edit`,
`run`, `edited`: `will-edit`, `will-run` and `edited`, and the messages that came), `yap_peers`, `yap_say`,
`yap_claim` (`path` and `why`, or `release`), `yap_doing`, `yap_board`, `yap_note` and `yap_spawn`. The model calls them when it decides to, so nothing is enforced.
`yap_say` takes `kind` and `re`, and `yap_peers` lists claims and unanswered questions and blockers. It speaks MCP
2026-07-28 (no handshake: `server/discover`, the version in each request's `_meta`, `-32022` for one it doesn't
support) and the handshake versions before it, answering an `initialize` with the client's version when it
knows it and 2025-11-25 when it doesn't.

## Claude Code's adapter

Claude Code's hooks (the yap plugin) post to `/api/hook/<event>` with their own payload, and get their own
format back. The daemon turns each into a YAP verb and the answer into the hook's fields. The session is
Claude's `session_id`, unless `YAP_SESSION` is set in Claude Code's environment: then the hooks pass it as
`?session=` and the session goes by that. A harness that runs Claude Code (through the Agent SDK, say) sets it
to its own id for the conversation and needs no adapter of its own for Claude: the hooks speak YAP for it.
In a Herdr app terminal the hooks also pass `HC_TERMINAL_ID` as `?terminal=`.

| YAP | Claude Code hook | Payload | Answer |
|---|---|---|---|
| `join` | `SessionStart` → `start` | `session_id`, `cwd` | `hookSpecificOutput.additionalContext` |
| `turn` | `UserPromptSubmit` → `prompt` | `+ prompt` | `additionalContext` |
| `will-edit` | `PreToolUse` (Edit, Write, MultiEdit, NotebookEdit) → `pre` | `+ tool_input.file_path` | `additionalContext`, `systemMessage` |
| `edited` | `PostToolUse` → `post` | `+ tool_input.file_path` | none |
| `will-run` | `PreToolUse` (Bash) → `pre` | `+ tool_name: Bash, tool_input.command` | `permissionDecision: deny` and its reason |
| `ran` | `PostToolUse` (Bash) → `post` | same | none |
| `idle` | `Stop` → `stop` | `+ stop_hook_active` as `continuing` | `additionalContext`, which keeps the turn going |
| `leave` | `SessionEnd` → `end` | `session_id` | none |

`context` becomes `additionalContext`, `notice` `systemMessage`, `deny` `permissionDecision: deny` with the reason.
The hooks ack: each one runs `hooks/yap.sh`, which sends `?ack=` from `~/.yap/sessions/<id>.cursor`, prints the
answer, then writes its `seq` to that file. The `seq` comes back in an `x-yap-seq` header, so the body stays
what Claude Code reads. `SessionEnd` removes it.

Another agent is one more adapter like it, or none (above): a harness can call `/yap` directly.

## Handed on the board

A Rinai board hands an issue to the crew with one label, `crew`. Nothing on the web reaches the machine: the
daemon reads each running project's board once a minute (`Crew.watch`), one project per board however many
checkouts of the repo are registered. For an open issue carrying the label it reads who put it there (GitHub's
issue events, walking back from the newest page to the latest `labeled`). It takes the issue only if that login is
the one `gh` is signed in as, and only once: an issue that has ever been on the rail, a failed one included, waits
for `yap take`.

The label brings the issue onto the rail as drafts, never as started work: its title, body and comments are
whoever wrote them, so a human reads the plan and starts it. Taking the label off (or closing the issue) drops the
handed goal's drafts; anything already started is the human's to stop. A board read that is capped or fails drops
nothing. Progress goes back as it already does: claimed, commented, In review or Blocked.

## Remote

A web client (Rinai first) reaches a machine through a **relay**: the machine's daemon dials out and holds one
WebSocket open, so there is no inbound port and no tunnel, and it works behind any router. The relay is
`relay/` in this repo, a Cloudflare Worker with one Durable Object per machine. It stores no project, session or
message: only hashes of the machine's secret, its pairing code and the tokens it issued.

### Pairing

1. `yap pair <relay>` asks the relay for a machine id, a secret and a pairing code. The daemon keeps the id and
   secret in `~/.yap/bridge.json` and connects. The command prints `<device>.<code>`.
2. The user enters that string in the web client, which trades it for a token: `POST /claim {device, code}`
   answers `{ "token" }`. A code works once, within ten minutes and five guesses.
3. `yap unpair` deletes the machine on the relay; every token it issued stops working.

The local API token never leaves the machine.

### Relay HTTP

| Call | Auth | |
|---|---|---|
| `POST /pair` | none | `{ device, secret, code }` for a new machine |
| `POST /claim` | none | `{device, code}` → `{ token }` |
| `GET /connect?device=<id>` | `Bearer <secret>` | the machine's WebSocket; a reconnect replaces the old one |
| `POST /d/<device>/<verb>` | `Bearer <token>` | one remote verb, JSON body; the machine's answer, or 503 offline, 504 no answer in 25 s |
| `DELETE /d/<device>` | `Bearer <secret>` | unpair |
| `GET /` | none | `{ protocol: "yap", version }` |

Down the socket the relay sends `{ id, verb, body }`; the machine answers `{ id, answer }` or `{ id, error }`
(a 400 to the caller, or the `status` the machine sent with it).

Errors are `{ "error": "<why>" }` with a status: 400 a bad call (unknown verb or project, a wrong field), 401 a
bad secret or token, 403 a wrong or used pairing code, 404 no such device, 429 too many background sessions
running, 503 the machine is offline, 504 it didn't answer. A refusal from the machine keeps its status. Any origin may call the relay: auth is a bearer token, never a cookie.

### Remote verbs

Every call names a `project`, one the user registered with yap, never a path. Sessions, spawns and notes
outside registered projects don't exist as far as the web is concerned. The sender is the user: whoever holds a
token was given it by the user.

| Verb | Body | Answer |
|---|---|---|
| `hello` | | `{ protocol: "yap", version, verbs, extensions }`; the remote extensions are `board`, `spawn`, `doing`, `inbox`, `chat` and `board-chat` |
| `projects` | | `[{ name, base, board }]`; `board` is the project's Rinai board, `owner/repo`, or null |
| `sessions` | | live sessions in projects: `[{ project, id, name, at, files, doing?, unanswered }]`; `unanswered` is `[{ id, kind, text }]`, its questions and blockers to the user nobody has answered |
| `spawns` | `id`?, `since`? | background sessions in projects, newest first: `[{ project, id, name, task, from, started, done?, ok?, result?, steps }]`; `id` picks one and adds its `log` after line `since`, as locally |
| `notes` | `project` | the project's board |
| `note` | `project`, `text` | pins a note |
| `say` | `project`, `text`, `to`?, `kind`?, `re`? | messages a session there, or all of them: `{ id, to, woke }`. With `re`, the id (or 8 characters of it) of a session's question or blocker, it answers it: with no `to` it goes to the asker and leaves its `unanswered` |
| `inbox` | `since`?, `project`? | what sessions said to the user and how background sessions ended, oldest first, after `since`: `[{ project, id, seq, kind, origin, from, sender, text, at, re?, ok? }]`, every project or one. Poll it with the highest `seq` you have |
| `spawn` | `project`, `text` | starts a background session on the task: `{ id }` |
| `chat` | `project`, `text`, `thread`?, `edits`?, `board`? | a message in a chat, a new thread when none is named: `{ thread }` at once (an edits thread's worktree is made behind it; a failure comes as an `error` event). 409 while the thread is still answering |
| `chat.read` | `thread`, `after`? | `{ thread, project, branch, board, busy, events }`, the events numbered after `after`: `you`, `text`, `tool` (one line per tool call), `done`, `error` |
| `chat.stop` | `thread` | stops the turn running |
| `chat.drop` | `thread` | forgets the thread; an edits thread's worktree and branch are removed, unmerged work with them |
| `chats` | `project`? | threads, newest first: `[{ thread, project, branch, board, busy, at, title }]` |

A **board chat** (`board: true`, set when the thread starts; a daemon that has them says `board-chat` in `hello`, and an older one would start a read chat instead, so a client checks) is the Rinai agent for the project's board. It has
no built-in tool at all, no Read and no Bash: only `src/board.ts`, an MCP server whose tools (board, search,
brief, goals, pulse, cycle; move, priority, claim, cycle_add, cycle_remove, cycle_order, file, comment, update,
goal, ungoal) each run `gh rinai -R <that board> <verb>` as an argument list, never through a shell; a comment,
an update or a body goes on stdin, and a short argument with a double quote and no space (which gh on Windows
drops) is refused. gh's own sign-in variables (`GH_TOKEN`, `GH_HOST`, `GH_CONFIG_DIR` and the like) and
`RINAI_URL` reach it. It runs
outside the checkout, in `~/.yap/chats/<project>/board`, with `--permission-mode dontAsk` and no settings file
read; the user's settings come in through `--settings` less their permissions, hooks and MCP servers, so a Bedrock or
helper sign-in and their model still work. Claude Code's Bash rules could not hold it: commands Claude Code judges read-only, `cat`
and a `; whoami` after an allowed command among them, ran past the allow list, so a chat with Bash or Read could
post a file in a comment. A comment injected on a public repo can reach this board's own cards and no further.
It is told to read the board before answering, to make a change the user asked for in so many words, and to list
the changes for a broad ask (reorganize, triage) and wait for a go. A project with no GitHub remote has no board,
and the call says so.

A chat is one Claude Code session per thread: the first turn names it, every later one resumes it. Without
`edits` it reads and searches the project's own checkout and changes nothing. With `edits` (set when the thread
starts) it runs in a worktree of its own under `~/.yap/chats/<project>/<thread>`, on a `yap/chat-<thread>`
branch, in auto mode: a page never writes where the user is working, and the user merges the branch when they
want it. A thread is reached through its project: once the project is removed, its threads are gone from the web.
Threads live in the daemon's memory; a restart loses the list, not the sessions or the worktrees (remove those
with `git worktree remove`, or drop the thread before restarting).

Nothing else: no `join` or `edited` (a web client is not a peer in a working tree), no shell, no path, nothing
the crew's desktop confirmation guards.

### Client

`sdk/remote.ts` is the web side in one file with no dependencies (browser, Worker, Bun, Node 18+):

```ts
import { Yap } from './remote'

const yap = await Yap.claim('https://yap-relay.example.workers.dev', '<device>.<code>')
localStorage.yap = JSON.stringify(yap)            // { relay, device, token }; the code works once
const { id } = await yap.spawn('app', 'add a retry to fetchUser')
const run = await yap.wait(id, { onLine: console.log })  // polls spawns until it ends, each tool call as it goes
console.log(run.ok, run.result)

const later = Yap.from(JSON.parse(localStorage.yap))
await later.say('app', 'the deploy is frozen until 6pm')

let since = 0
for (const m of await later.inbox(since)) {   // what agents said to you, and spawns ending
  since = m.seq
  if (m.kind === 'question') await later.say(m.project, 'yes', undefined, { re: m.id })
}
```

Each remote verb is a method; a refusal throws `YapError` with the status above.

### Version

`hello` (remote), `GET /yap` (local) and `GET /` (relay) answer with the protocol version. It is 1, and gates
nothing: a v0 hook that sends no version and no new field works as before. Shapes grow; see the client rule.

The risk is the point of the shape: a website that can make your PC run agents is a remote code execution
channel. A leaked token gets "start an agent in a repo you already gave yap" and no more, and `yap unpair` ends
it.
