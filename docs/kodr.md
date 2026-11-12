# YAP in Kodr

How to wire YAP into Kodr (`~/falke/Projects/mirako/kodr`, a T3 Code fork). Written for the agent doing it. The
protocol is [yap.md](yap.md); read "Bringing your own harness" and "Claude Code's adapter" first. File and line
references are from Kodr at `983178133e` and will drift: search for the named symbol if a line is off.

## What you get

Every Kodr thread is a YAP session under its own `ThreadId`. Threads in one repo, and Claude Code sessions in
terminals or Herdr next to them, see each other, are warned before they edit a file another just touched, can't
run a git command that would wipe another's work in the same tree, and can message each other. An idle thread
wakes when a message comes for it. The sidebar shows what each agent is editing.

## Ground truth

- Kodr runs Claude through `@anthropic-ai/claude-agent-sdk` (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`).
  `makeClaudeQueryOptions` passes no `settingSources`, so the SDK loads user settings and installed plugins.
  With the yap plugin installed (`claude plugin install yap@yap`), its hooks already fire in Kodr's Claude
  threads. They report under Claude's session id until step 1.
- Every provider's events land in one stream: `OrchestratorV2.streamDomainEvents` (`Orchestrator.ts`), typed
  `OrchestrationV2DomainEvent` (`packages/contracts/src/orchestrationV2.ts`).
- Use the app `ThreadId` as the YAP session id. Provider and Claude session ids change on reset, fork and
  provider switch; the thread id doesn't.
- The thread's directory: `turnInput.runtimePolicy.cwd`, or the `cwd` on `provider-session.*` events, or the
  thread's `worktreePath` (null: the project root).

## 1. Claude threads: one line

In `ClaudeAdapterV2.ts`, where the query runner builds the child env (`env: { ...(sdkOptions.env ??
hostEnvironment), [AGENT_THREAD_ENV]: input.threadId }`, around line 983), add `YAP_SESSION: input.threadId`.

That is the whole Claude integration. The plugin's hooks pass `YAP_SESSION` to the daemon as the session id, so
`join`, `turn`, `will-edit`, `edited`, `will-run` (with its deny), `ran`, `idle` and `leave` all report as the
thread, and `yap say` run by the agent speaks as the thread. Don't add a second YAP path for Claude: the hooks
are the one that can deny a command before it runs.

Check: start a Claude thread in a repo, then `yap sessions` in that repo lists the thread id.

## 2. Codex and the others: the same env, for `yap say`

Codex gets `T3CODE_THREAD_ID` through `shell_environment_policy.set` (`CodexAdapterV2.ts`, around line 1369).
Set `YAP_SESSION` to the thread id there too, and wherever another adapter sets `T3CODE_THREAD_ID`.

Codex has hooks in Claude Code's format, and `yap setup` puts yap's in `~/.codex/hooks.json`. They fire in
Kodr's Codex threads too, with the same deny before a git command and warning before an `apply_patch`, once the
user has trusted them in `/hooks`. They report under Codex's thread id unless `YAP_SESSION` is in the env of
the Codex process itself (`yap hook` reads it), not just its shell. Set it there when Kodr runs one Codex process
per thread. Otherwise leave it: the session is then Codex's thread id, and step 3 maps it to the Kodr thread
for presence and wake. With the hooks in, step 3's reporting table is for providers with no hooks at all.

## 3. `YapService`: wake, and report for providers without hooks

`apps/server/src/yap/YapService.ts`, shaped like `IdleCompactionService` (`make`, `start()` forking a stream
consumer), registered next to `layerIdleCompactionWorker` in `apps/server/src/server.ts` as
`Layer.effectDiscard(make.pipe(Effect.flatMap(s => s.start())))`.

Talk to the daemon with `sdk/local.ts` from the yap repo (`~/falke/Projects/mirako/kumi/sdk/local.ts`, or
`https://github.com/noxire-dev/yap/blob/main/sdk/local.ts`). Vendor it as `apps/server/src/yap/client.ts`: one file,
no dependencies. Put it behind a service interface (a `Yap` tag with the calls the service uses) so tests fake
it; build the real one at the layer edge with `YapLocal.connect({ start })`, where `start` runs `yap start`.
If the daemon isn't there and won't start, log once and do nothing: YAP is never on Kodr's critical path.

What the service does:

- **Wake.** `yap.watch(undefined, onEvent)` (every repo). On a `message` event whose `session` is a Kodr thread
  that is idle (no active run), dispatch `message.dispatch` on that thread with `text: wakePrompt(e)`,
  `dispatchMode: 'start_immediately'`, `createdBy: 'agent'`, `creationSource: 'server'` and a deterministic
  `commandId` from the event (`yap:${e.session}:${e.at}`), the way `IdleCompactionService` dispatches. The
  thread's next `turn` answer carries the message and tells the model the user didn't type that prompt. A busy
  thread needs nothing: its next hook delivers the message. Never wake a thread the user is typing in, if Kodr
  can tell.
- **Report, for threads whose provider is not Claude.** Claude threads report through the hooks (step 1); skip
  them here or they count twice. For the rest, from `streamDomainEvents`:

  | Domain event | YAP |
  |---|---|
  | first event for the thread, or `provider-session.attached` | `session.join(threadTitle)` |
  | `turn-item.updated`, kind `user_message`, first seen | `turn(text)` |
  | `turn-item.updated`, kind `file_change`, completed | `edited(path)` for each `changes[].path` |
  | `turn-item.updated`, kind `command_execution`, in progress, first seen | `willRun(input)` |
  | `turn-item.updated`, kind `command_execution`, completed | `ran(input)` |
  | `run.updated` to a terminal status | `idle()` |
  | `provider-session.detached`, thread archived or deleted | `leave()` |

  These answers can't stop a tool: it already ran by the time Kodr sees it. Put any answer's `context` in front
  of the thread's next turn instead: add a YAP record kind to the composer context union
  (`composerContext.ts`) and let `projectComposerContextForProvider` render it, or prepend the text at its call
  in `ProviderTurnStartService.ts`. A `deny` from `willRun` is too late to enforce for these providers; turn
  it into context ("yap: that command was unsafe because …") so the model stops repeating it.
- **Name.** Pass the thread title to `join`, so peers address `@fix-login` and not a hash.

## 4. Presence in the UI

- A streaming RPC, `subscribeYapPresence`, copying the device-state pattern (`packages/contracts/src/rpc.ts`
  `stream: true` RPCs, handler in `apps/server/src/ws.ts`, client in `packages/client-runtime`). Server side:
  `yap.sessions(cwd)` per open project on subscribe, then the `join`, `leave`, `edited` and `message` events.
- Sidebar: on a thread row (`apps/web/src/components/sidebar/SidebarSpaces.tsx`, next to the title), the last
  file it edited; on a project, the sessions in it that are not Kodr threads (a terminal Claude Code, a Herdr
  pane, a spawn), by name.
- Show each answer's `messages` (structured: `kind`, `from`, `text`) in the thread as a small "from @auth" item,
  and `notice` as a toast. Don't parse `context`; it is for the model.

## 5. A setting

`yap: boolean` in `ServerSettings` and `ServerSettingsPatch` (`packages/contracts/src/settings.ts`), default
on, with the decoding-default style used there. Off: no `YAP_SESSION` in child envs, no service, no presence.

## Order and checks

Ship 1 and 2 first: they are three lines and most of the value. Then wake, then the other providers, then
presence. After each: two threads in one repo, one edits `README.md`, the other is asked to edit it and is
warned; one runs `git stash` and is denied (Claude) or told after (others); `yap say @<thread title> hi` from a
terminal wakes the idle one.
