# Agent protocols vs YAP

Nov 15, 2026. Checked against primary sources on that date. YAP as described in `docs/yap.md`, `docs/v1-brief.md`, `src/wire.ts` and `src/mcp.ts`.

## Comparison

| | Problem | Transport | Message model | Identity, authority | Delivery | Extensions, versioning |
|---|---|---|---|---|---|---|
| **YAP** | Peer sessions on one machine stay out of each other's way | HTTP POST on 127.0.0.1, SSE events, relay WebSocket | Lifecycle verbs; answers carry `context`/`notice`/`deny`/`messages` | One machine token; `origin` session/user/local; relay token is the user | Per-message id, `seq`, `ack`, redelivered 3x | `hello` version 0; extensions planned for v1 |
| **Yab** | Coding agents drive a signed-in browser | MCP, `yab` CLI | Browser tools, `task` delegation | Agent acts as you; send/pay/delete/upload need your yes | Not published | Not published |
| **ACP** | Editor talks to one coding agent | JSON-RPC, stdio subprocess; HTTP/WS in RFD | `session/prompt` turn, `session/update` stream, `request_permission` | Client is the user's surface; info fields self-reported | None beyond JSON-RPC | Integer major version; `_meta`, `_`-methods |
| **MCP** | Model gets tools and context from servers | JSON-RPC, stdio or Streamable HTTP | Tool calls; MRTR for input; opt-in list-changed subscriptions | OAuth on HTTP; none on stdio | Stateless; broken stream loses the request | Date version per request; `extensions` capability |
| **A2A** | Opaque agents across vendors delegate tasks | JSON-RPC/HTTP, gRPC, REST; SSE; webhooks | Message, Task, Artifact, `contextId` | Transport-layer auth, signed Agent Cards | Push at-least-once; stream ordered | `A2A-Version` header; extension URIs |
| **ABP** | Browser state is async, agents think in steps | REST in a Chromium fork, MCP | One request = one settled step | None; localhost only | Synchronous per step | `/api/v1/` path |
| **BrowserOS** | Built-in agent on your model; external agents via MCP | Local MCP URL | Browser tools | Not documented | Not documented | Not documented |
| **agent-coord, Agent Mail** | Several coding agents in one repo | SQLite + hooks + MCP; MCP HTTP | Locks/leases, messages | Self-declared names; no auth boundary | Read/ack tools; no formal guarantee | Release versions only |

## Yab

No public protocol exists. What is published:

- "Claude Code, Codex and Cursor drive Yab through MCP or the `yab` command" ([home](https://yetanotherbrowser.com/)).
- [Developers](https://yetanotherbrowser.com/developers) lists the MCP tools (`snapshot`, `click`, `type`, `run`, `fetch`, `task`, `task_steer`, `task_queue`, `native_*` and more) and CLI verbs (`yab setup`, `yab mcp`, `yab every`, `yab serve`, `yab session steer`). Exit code 3 means "needs you".
- Authority: the agent acts in your signed-in tabs. Send, pay, delete and upload wait for an approval card. Passwords never reach the model ([AI page](https://yetanotherbrowser.com/ai)).
- Up to eight Yab-run helpers browse at once, each in its own folder. Locking or conflict handling between agents is not described.

No GitHub repo, wire spec, transport detail or versioning is published. The [changelog](https://yetanotherbrowser.com/changelog/0.47.10) mentions only CLI fixes. A search found no HN or Reddit thread.

Yab resembles YAP only loosely. It is an MCP *tool server* for one shared resource, the browser. It is not a peer protocol between agents. The `task`/`task_steer` pair is the closest match to YAP's `spawn` and `say`.

## ACP (Agent Client Protocol)

- Problem: an editor (client) talks to one coding agent it launches ([overview](https://agentclientprotocol.com/protocol/overview)).
- Transport: newline-delimited JSON-RPC over stdio. "The client launches the agent as a subprocess." Streamable HTTP is still "being specified" ([transports](https://agentclientprotocol.com/protocol/v1/transports.md), [RFD](https://agentclientprotocol.com/rfds/streamable-http-websocket-transport)).
- Message model: `session/prompt` starts a turn, `session/update` streams it, `session/request_permission` asks the user, and the client serves `fs/*` and `terminal/*`.
- Identity: `clientInfo`/`agentInfo` are self-reported and "should not" be used for security. "Permission requests are advisory." Intermediaries should not answer permissions for the user ([security](https://agentclientprotocol.com/protocol/v1/security.md)).
- Delivery: plain JSON-RPC. Nothing about ordering or retries.
- Extensions: `_meta`, underscore-prefixed methods, reverse-DNS capability names ([extensibility](https://agentclientprotocol.com/protocol/v1/extensibility.md)). Version is an integer major ([initialization](https://agentclientprotocol.com/protocol/v1/initialization.md)).
- Multi-agent: none in the spec. ACP "assumes a 1:1 relationship between a client and an agent session". [PR #533](https://github.com/agentclientprotocol/agent-client-protocol/pull/533) (open) proposes `session/attach`. The [proxy-chains RFD](https://agentclientprotocol.com/rfds/proxy-chains) lets proxies inject prompts and intercept tool calls, but peer-to-peer is future work.

## MCP (Model Context Protocol)

The current revision is **2026-07-28**, not 2025-11-25 ([versioning](https://modelcontextprotocol.io/specification/versioning)). It changed what matters here ([changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)):

- Stateless. The `initialize` handshake and `Mcp-Session-Id` are gone. Version and capabilities ride in each request's `_meta`. `server/discover` is mandatory for servers.
- Server push is limited to `subscriptions/listen`, for list-changed and resource-change notifications. No server-pushed messages to the model.
- SSE resumability and `Last-Event-ID` are removed. "A broken response stream loses the in-flight request."
- Server-initiated sampling and elicitation are replaced by Multi Round-Trip Requests: the server returns `input_required` and the client retries. Sampling and Roots are deprecated.
- An `extensions` capability field was added. Tasks moved to an extension.

Identity: OAuth for HTTP. Elicitation requires the client to show "which server is requesting", and says servers "MUST NOT rely on client-provided user identification" ([elicitation, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)). The transport spec requires `Origin` validation and localhost binding ([transports, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)). YAP already does both.

Multi-client: one Streamable HTTP server "can handle multiple client connections". Nothing lets clients see or message each other.

## A2A (Agent2Agent)

- Problem: "interoperability between independent, potentially opaque AI agent systems" ([spec](https://a2a-protocol.org/latest/specification/)).
- Transport: JSON-RPC over HTTP, gRPC and REST, functionally equivalent. Streaming over SSE. Push over client webhooks.
- Message model: `Message` (role user or agent, parts), stateful `Task`, `Artifact` outputs, `contextId` grouping, `referenceTaskIds`.
- Identity: auth per the Agent Card's `securitySchemes`. Cards may carry JWS signatures. "Identity information is handled at the protocol layer, not within A2A semantics." `ROLE_USER` only means client-to-server, so a calling agent is "user" by definition.
- Delivery: push is "at least once"; clients "SHOULD process notifications idempotently". Stream events "MUST NOT be reordered". Messages "MUST NOT be considered a reliable delivery mechanism for critical information".
- Extensions: URIs in `capabilities.extensions` with `required`. `A2A-Version` header; unsupported returns `VersionNotSupportedError`.

## ABP (Agent Browser Protocol)

- A Chromium fork "with MCP + REST baked directly into the browser engine" ([repo](https://github.com/theredsix/agent-browser-protocol)).
- "One request = one completed step": input, wait for settle, screenshot, event log, then JS and time freeze.
- REST on localhost under `/api/v1/`. MCP over stdio or HTTP. No auth or multi-agent isolation described.
- Relevance to YAP: one idea only. An answer should describe settled state, never a moving target.

## BrowserOS

- BYO LLM means API keys, OAuth to ChatGPT Plus/Pro and GitHub Copilot, or local models ([docs](https://docs.browseros.com/features/bring-your-own-llm)). Claude OAuth is not listed.
- The "Bring Your Own Agent" post is about the built-in agent on your subscription ([blog](https://www.browseros.com/blog/bring-your-own-agent/)).
- External agents connect to a local MCP endpoint, `http://127.0.0.1:9200/mcp` ([docs](https://docs.browseros.com/neo/mcp/index.md)). Auth, tools and multi-agent handling are not documented there.
- No coordination protocol.

## Same-machine coordination tools

Neither is a spec. Both are products with an MCP face.

- **agent-coord** ([repo](https://github.com/v2matosevic/agent-coord)). Shared SQLite, no daemon. Claude Code `PreToolUse` blocks writes to a file a peer holds. A lock "only blocks while it's warm". A global git pre-commit refuses files a live agent is editing. Messaging has `ask_agent`, `reply`, `request_yield`. "There's no auth boundary in the store." Fails open.
- **MCP Agent Mail** ([repo](https://github.com/Dicklesworthstone/mcp_agent_mail), now superseded by a [Rust version](https://github.com/Dicklesworthstone/mcp_agent_mail_rust)). An MCP HTTP server with registered agent names, inboxes, `thread_id`, importance, `ack_required`. Advisory file reservations with TTL, exclusive or shared mode, globs, and an optional pre-commit guard.
- Unverified: agent-lease-mcp and coordinationhub. Their pages did not load or were listing-only.

## Verdict

### Borrow

- **Agent Mail's message shape** for v1 item 3: `thread_id` on reply and `ack_required` map to YAP's `re` and open questions. Shared vs exclusive reservations are worth a field on `claim`. Skip globs, as the brief already does.
- **agent-coord's commit guard**: a git pre-commit hook covers committers with no harness hooks. YAP's `will-run` deny only sees Bash.
- **A2A's extension declaration**: a URI plus `required` in `hello`. That is the shape v1 item 9 needs.
- **ACP's `_meta` and `_`-method rule**: unknown fields are ignored and custom verbs never collide with future core ones.
- **MCP's per-request version**: put `version` on each call, not only in `hello`. That lets one daemon serve v0 hooks and v1 harnesses at once.

### Already covered (don't reinvent)

- Tool exposure to the model: MCP. YAP's `yap mcp` is correctly just an adapter.
- Editor-to-agent turns, permission prompts and streaming: ACP.
- Cross-vendor task delegation: A2A. YAP's `spawn` is local only and should stay that way.
- Browser control: Yab, ABP, BrowserOS.

### YAP-only

- Repo and worktree resolution through the git common dir, with peers grouped by it.
- `will-edit` warnings and `will-run` denies tied to peer edits in the same tree.
- Shell-command edit attribution (`ran`).
- `idle` cross-worktree merge-tree conflict checks.
- Messages delivered inside the agent's next hook answer, with a wake for idle panes.
- `origin` (session, user, local) with an authority line on every delivered message. No protocol above labels a local, unverified sender. A2A's `user` role is just a direction.

### Ride on MCP or ACP?

Stay its own HTTP protocol with adapters.

- `will-edit`, `will-run`, `ran`, `idle` must fire on every edit and command, enforced by the harness. MCP tools fire only when the model chooses, as `docs/yap.md` already says of `yap mcp`. ACP has the client in the path, but a YAP daemon is neither the client nor the agent.
- `say` and `turn` deliver messages into another session's next answer. MCP 2026-07-28 has no server-to-model push and no sessions. ACP is 1:1 client-to-agent; multi-client attach is an open PR.
- `join`/`leave` with a stable session id and `pid`: MCP removed protocol sessions. ACP sessions belong to one client.
- `ack`/`seq` redelivery: MCP removed redelivery. ACP has none.
- Hooks are stateless `curl` calls. JSON-RPC framing over stdio would be a regression for them.

ACP is still worth one adapter: a proxy in a conductor chain could speak YAP for any ACP agent, the way the Claude Code hooks do now.

### Fix in `src/mcp.ts`

The adapter joins on `initialize` and echoes back whatever `protocolVersion` it is sent. A 2026-07-28 client sends no `initialize`. It calls `server/discover` or `tools/list` with version in `_meta`. YAP answers `no method` to the first and never joins. Add `server/discover`, and join on the first call of any kind.
