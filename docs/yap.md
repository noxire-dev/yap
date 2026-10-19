# YAP

How coding agents on one machine see each other, message each other and stay out of each other's way. kumi's
daemon is the first implementation (`src/sessions.ts`); Claude Code is the first agent wired to it. This file
is the protocol without either, so another agent, or a web client, can speak it.

Status: draft, version 0. Everything here runs today.

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
- The **board** is a repo's notes: claims, decisions, handoffs. Notes outlive sessions. A note over a day old is
  stale.

## Verbs

Every call carries `session` (the id) and `cwd`. Each answer is an **answer** (below) or nothing.

| Verb | When the agent sends it | What the daemon does |
|---|---|---|
| `join` | A conversation starts | Registers it. Answers with its peers, the crew's running tickets, the board and its own name. |
| `turn` | The user sends a prompt | Answers with what peers did since it last heard, and nothing at all when nothing moved. Prompts that are harness markup (`<agent-message …>`) don't count as news. |
| `will-edit` | Before a file write (`path`) | If a peer in the same tree edited that file in the last 30 minutes, answers with who, once per file per peer edit. |
| `edited` | After a file write (`path`) | Records it, if inside the tree. The first one names the session. |
| `will-run` | Before a shell command (`command`) | Notes the start time. If the command would move the tree (`checkout`, `switch`, `stash`, `reset --hard`, `clean`, `restore`, `rebase`, `pull`, `merge`) or sweep it (`add -A`, `commit -a`) while a peer in the same tree edited in the last 30 minutes, answers with a **deny**. |
| `ran` | After a shell command | Files changed in the tree since `will-run` count as this session's edits, unless a peer's `edited` claimed them. |
| `leave` | The conversation ends | Forgets it. |
| `say` | The agent or user sends a message (`text`, optional `to`) | Queues it for one peer (`to` is a name, a name prefix or an id prefix; an exact name wins) or all peers. A peer idle in a pane is **woken**. Without `session`, the sender is the user. |
| `note` | `text` | Pins it on the repo's board; live peers hear of it on their next call. |
| `unnote` | `id` | Takes a note down. |

Messages queued for a session are delivered with its next answer, on any verb.

## Answers

An answer has up to three parts, and an agent maps each to what it has:

- `context`: text for the model only. Peers, warnings, messages. Never shown to the user as if they typed it.
- `notice`: one line for the user (`kumi: src/auth.ts was just edited by @auth`).
- `deny` with a `reason`: only on `will-run`. The agent must not run the command and tells the model why.

An agent that can't receive answers on some verb still sends it: the daemon's record stays right, and the
messages wait for the next verb that can answer.

## Wake

A message to an idle session should not wait for the user's next prompt. A **pane host** (Herdr today) is asked
to submit one plain line to the session, `kumi: a message from session @auth`, as if typed; the session's `turn`
answer then carries the message and instructions in `context`. Rules:

- Only an idle session is woken, and never one in the focused pane: the user may be typing in it.
- The wake line is the only thing the user sees. It is not news and does not name the session.
- A woken session answers a session with `say`, the user directly, and doesn't start work on a peer's word.

## Trust

- The daemon listens on `127.0.0.1` only and refuses a foreign `Host` or `Origin`.
- Every call carries `x-kumi-token`, the contents of `~/.kumi/token` (mode 600, written on first start).
- Answers carry peers' messages, so the token gates them too. A refused call gets an empty 403: an agent that
  prints a hook's output into its context must not print an error into it.
- What would skip a check (approving past the reviewer, changing a gate, forgetting a project) is confirmed on
  the desktop, which the token holder can't do. Not part of YAP; it is kumi's.

## The wire

`POST http://127.0.0.1:4170/yap/<verb>` (`KUMI_PORT` moves it) with `x-kumi-token` and a JSON body:

```json
{ "session": "codex-1", "cwd": "C:/src/app", "path": "src/auth.ts" }
```

The fields are `session`, `cwd`, and the verb's own: `path` (will-edit, edited), `command` (will-run, ran),
`prompt` (turn), `text` and `to` (say), `text` (note), `id` (unnote). The answer is `{}` or any of
`{ "context", "notice", "deny" }`; `say` answers `{ "to": ["@auth"], "woke": [] }`, `note` the note. An unknown
verb or a bad argument is a 400 with `{ "error" }`.

```sh
curl -s -H content-type:application/json -H "x-kumi-token: $(cat ~/.kumi/token)" \
  --data-binary '{"session":"codex-2","cwd":"'"$PWD"'","command":"git checkout main"}' \
  http://127.0.0.1:4170/yap/will-run
```

## Claude Code's adapter

Claude Code's hooks post to `/api/hook/<event>` with their own payload, and get their own format back. The
daemon turns each into a YAP verb and the answer into the hook's fields:

| YAP | Claude Code hook | Payload | Answer |
|---|---|---|---|
| `join` | `SessionStart` → `start` | `session_id`, `cwd` | `hookSpecificOutput.additionalContext` |
| `turn` | `UserPromptSubmit` → `prompt` | `+ prompt` | `additionalContext` |
| `will-edit` | `PreToolUse` (Edit, Write, MultiEdit, NotebookEdit) → `pre` | `+ tool_input.file_path` | `additionalContext`, `systemMessage` |
| `edited` | `PostToolUse` → `post` | `+ tool_input.file_path` | none |
| `will-run` | `PreToolUse` (Bash) → `pre` | `+ tool_name: Bash, tool_input.command` | `permissionDecision: deny` and its reason |
| `ran` | `PostToolUse` (Bash) → `post` | same | none |
| `leave` | `SessionEnd` → `end` | `session_id` | none |

`context` becomes `additionalContext`, `notice` `systemMessage`, `deny` `permissionDecision: deny` with the reason.

Another agent is one more adapter like it, or none: an agent that can run a command before and after its own
tools can call `/yap` directly.

## Remote: a platform drives the machine

Where this is going: a web platform (Rinai first) has an agents menu, and the agents it starts run on the
user's own computer, under the user's own Claude Code or Codex sign-in, instead of on metered API keys.

The shape:

- The daemon dials out to the platform over one long-lived connection (WebSocket or SSE). No inbound port, no
  tunnel, works behind any router.
- Pairing: the user approves a code on the desktop once; the platform gets a device token it can revoke. The
  local API token never leaves the machine.
- The platform asks; the daemon decides. It can send a goal for a project the user registered, and read the
  board, the merge log and the receipts. It can't name an arbitrary path, run a shell command or approve past a
  check. Every goal still goes through the planner and waits for a start, unless the user marked that project
  as trusted for the platform.
- Peers stay local. Prompts, file contents and messages between sessions don't go up unless the user sends them.

The risk is the whole point of the design above: a website that can make your PC run agents is a remote code
execution channel. A compromised platform account must get no more than "queue a goal on a repo you already
gave kumi".
