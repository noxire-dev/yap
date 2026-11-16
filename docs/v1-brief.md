# YAP v1 brief

Nov 16, 2026. Third revision. The first was Fable's brief of Nov 10; the second (Nov 11) checked it against `src/` and folded in Kodr's reverted coordination build. This one follows `docs/research/protocols.md` and three council rounds (Claude Opus and GPT Sol), whose objections are folded in below.

## Summary

YAP owns coordination between agents on one machine. It stays its own localhost HTTP protocol with adapters: hooks have to fire on every edit and command, and MCP tools only fire when the model chooses to call one, with no push into another session's context. The implementers of YAP are harnesses (Claude Code, Codex, Kodr, Herdr, MCP-only agents), not other daemons, so v1 is designed for clients and cuts machinery that only matters with several servers.

Hand this to a coding agent one item at a time.

## Done

- **Origin** (`f809d85`): `session`, `user` (relay-paired device) or `local` ("an unverified local process"); an authority sentence on every delivery.
- **Ids, seq and acks** (`712befc`): `seq` is clock-based and global; unacked messages come again up to 3 times, then `sessions` lists them as `undelivered`.
- **Merge conflict check** (`1006b67`): snapshots at `idle`, `git merge-tree` against peers in other worktrees, the `conflict` kind, Kodr's conflict chip.
- **Second harness**: Codex through its hooks (`52f8229`) and `yap mcp` for agents with none. This was item 8; it is done.

## Order

| # | Item | Size |
| --- | --- | --- |
| 1 | MCP adapter: version and discovery | S |
| 2 | `re`, `question` and `blocker` | S |
| 3 | Claims (done) | M |
| 4 | Spec v1: core, extensions, version 1 | S |
| 5 | Kodr chips (optional, not a release gate) | S |

## Ground rules

1. Read `docs/yap.md`, `src/sessions.ts`, `src/server.ts`, `src/wire.ts` and `src/mcp.ts` first. If the code disagrees with this brief, stop and report it.
2. Spec and code change in the same commit. `docs/yap.md` stays the source of truth.
3. Every new verb or field gets a check in `src/crew.check.ts` that goes through the `/yap` handler.
4. Keep the v0 properties: localhost only, `Host` and `Origin` checks, empty 403 on refused calls, peer text only ever in `context`.
5. Windows stays supported. No Unix sockets or peer credentials.
6. New fields are optional. A v0 hook that sends no version and no new field keeps working, after the bump too.
7. A feature reachable through `/yap` is reachable through `yap mcp` in the same commit, or the commit says why not.
8. Do not touch `src/crew.ts` or the relay unless the item says so. No new runtime dependencies.

## 1. MCP adapter: version and discovery

**Problem.** `src/mcp.ts` echoes whatever `protocolVersion` a client sends, so it claims versions it doesn't support. It doesn't implement `server/discover`, which MCP 2026-07-28 makes mandatory.

**Change.**

- Keep `initialize` for stdio clients that still send it. Answer the client's version if YAP supports it, else the newest handshake-era version it does (2026-07-28 has no handshake, so never that one). Never echo an unknown version.
- Serve `server/discover` with the same instructions `initialize` gives.
- On 2026-07-28 requests, read the version from `_meta` and reject an unsupported one with `UnsupportedProtocolVersionError` (`-32022`) listing the supported versions. Add the result fields that revision requires (`resultType`, tool-list cache fields). Check each against [the spec](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning), not memory.
- The session joins on its first request of any method, keeping the `owned` guard: an MCP server running under `YAP_SESSION` still doesn't join. With no `initialize`, the client name comes from `_meta`, else `mcp`.

**Acceptance.** An `initialize` asking for an unknown version gets a supported one back. A `server/discover` with no `initialize` first lists the tools and joins the session. A 2026-07-28 request with an unsupported version gets `-32022`.

## 2. `re`, `question` and `blocker`

**Change.**

- `say` takes optional `kind`: `question` or `blocker`, added to the existing message kinds (`say`, `note`, `spawn`, `conflict`). No other kinds. A plain `say` stays `say`.
- `say` takes optional `re`: the id, or an 8-character prefix, of the message being answered. A message with `re` carries it.
- A `question` or `blocker` is kept on the asker's session row as `unanswered: [{ id, to, kind, text }]`. The first message with an `re` pointing at it removes it. It also goes when the asker leaves or lapses. This records a fact, that a reply exists, not that the question is resolved: a reply may ask for clarification.
- A `say` mints one message id and passes it to every recipient's `post` (`seq` stays per delivery). Today `post()` mints one per inbox, so a broadcast question would carry a different id for each recipient. `say` answers that `id`. The first reply from any recipient clears a broadcast question.
- An `re` that matches nothing is delivered anyway, not refused.
- `sessions` rows list `unanswered`. The context text shows the short id and how to answer: `yap say --re <id> <text>`.
- MCP: `yap_say` takes `kind` and `re`; `yap_peers` shows unanswered items. The tool-name mapping in `tools()` only knows `yap say @…` and `yap say <text>`; add a rule turning `yap say --re <id>` into `yap_say` with `re`.

**Cut.** The `thread` verb, kinds `handoff`, `contract`, `answer` and `note`-as-a-kind.

**Acceptance.** A `question` shows on the asker's row; a reply with `--re` arrives with `re` set and removes it. An unknown `re` is delivered. An unanswered `blocker` stays listed until a reply or the asker leaves.

## 3. Claims

| Verb | Fields | Answer |
| --- | --- | --- |
| `claim` | `path`, `why` | `{ id }`, or `{ held: { session, name, path, why } }` when a peer's live claim overlaps |
| `release` | `id` | `{}` |
| `claims` (read-only) | none | `[{ id, session, name, top, path, why, expires }]` |

- One exclusive mode. Claims only warn; `will-edit` never denies on a claim.
- `path` is a file or directory, repo-relative. Overlap compares path components, so `src/auth` covers `src/auth/token.ts` and not `src/author`. Normalise like the repo key.
- Claims are compared across every worktree of the repo. A cross-worktree overlap is the merge conflict the `idle` check finds too late.
- Fixed 20-minute life, renewed by the holder's edits under the path. Ends on `release`, `leave` or lapse. First claim wins; no queue.
- `will-edit` inside a peer's claim warns once, naming the holder and the reason. Only for edits made after the claim existed.
- `join` and `turn` include live claims in their context. The skill says to claim a directory when a task touches more than two files in it.
- MCP: one tool, `yap_claim`, taking `{ path, why }` or `{ release }`; `yap_peers` lists live claims.
- Remove "claims" from the board's description in the spec, and the join context's advice to post "a claim on an area" on the board (`src/sessions.ts`, the board part of `overview`), in the same commit.

**Cut.** Shared claims, the `ttl` parameter, strict mode (deny on a claim).

**Acceptance.** A claims `src/auth/`; B's claim on `src/auth/token.ts` answers `held` with A's name and reason, and so does C's in another worktree. B's `will-edit` under A's claim warns once; an edit B made before A claimed does not. A's claim ends on `leave` and 20 minutes after its last edit under the path.

## 4. Spec v1

- `hello` answers `{ protocol, version, verbs, extensions }`. Extensions are short names, `board`, `claims`, `conflicts` and `spawn`, detected and never negotiated: no URIs and no `required`.
- Core, marked in the spec: `join`, `turn`, `will-edit`, `edited`, `will-run`, `ran`, `idle`, `leave`, `say` (with `re` and `kind`), `sessions`, `hello`, `GET /yap/events`, the answer shape, and the fields `session`, `cwd`, `ack`.
- One client rule: ignore unknown fields, message kinds and verbs, and render `text`.
- One sentence next to `ran`: when two shell commands overlap in one working tree, a file they change counts as the edit of whichever session sends `ran` first.
- Bump `version` to 1. It gates nothing.
- The relay gets its own section; it is not an extension.

**Cut.** `_meta`, a version on every call, a conformance suite for other servers. The checks in `src/crew.check.ts` stay the conformance check.

## 5. Kodr chips (optional)

Through `src/kodrChips.ts`, no Kodr core change. The conflict chip exists. Add a `warn` chip for an unanswered `blocker` or `question` to or from the thread, and one for editing inside a peer's claim.

## Cut from v1

- `synthetic` on `turn`. The prompt is already discarded, and wakes are recognised as markup.
- Strict mode.
- Shell-edit `shared` attribution in code. It is replaced by the sentence in item 4.
- A git pre-commit guard. It would write into the user's repo hooks, clash with husky or lefthook, and fire on the human. Hooked agents are covered by `will-run`.
- An ACP adapter. Add one when an ACP harness asks.
- Per-session tokens, SSE replay and retention, globbed claims, symbol-level claims, and the orchestrator-versus-peer benchmark.

## Delivery stays direct

Kodr's reverted build only let a message reach another agent when the user clicked a button. YAP keeps delivering straight into the recipient's context. Gating every message would turn the user into a mail carrier, and the authority sentence covers the risk that made gating attractive.
