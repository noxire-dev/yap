# Working on yap

yap is a protocol (YAP, spec in `docs/yap.md`) and a Bun daemon that lets coding-agent sessions on one machine see
each other, message each other and stay out of each other's way: Claude Code through its plugin hooks, Codex
through its hooks, anything else through `yap mcp` or plain HTTP. The crew (`src/crew.ts`) is a second product on
the same daemon: goals become tickets, worked and reviewed in worktrees, merged behind a gate. What is open is in
`PRODUCT.md` under "## Open" and the plan in `docs/v1-brief.md`.

## Words

- **session**: one agent conversation, by id. **peer**: another live session in the same repo.
- **repo**: the git common dir, so worktrees share it. **tree**: one working tree.
- **the daemon**: `src/server.ts` on 127.0.0.1:4170, state in `~/.yap`. **the user**: the person, never a peer.

## Two ways to hurt yourself

1. **The shared daemon.** Port 4170 is every session's yap on this machine, other agents included, right now.
   Try a change on a throwaway one: `YAP_HOME=<tmp dir> YAP_PORT=4199 bun src/cli.ts start`, and point calls at
   it with the same two variables. Restart the shared daemon (`yap stop && yap start`) only to ship a change, only
   when `yap spawns` shows nothing running, and say you did.
2. **The user's live apps.** Never drive Herdr, the Herdr app (`herdr-app do`) or herdr-core (`hc`) in the user's
   window to test something, never edit `~/.config/herdr-app`, and never kill a process found by name. Read their
   state if you need to.

## Hit every surface

A verb, a field or a message shape lives in all of these. Before finishing, say which applied:

- `src/sessions.ts` (the logic), `src/wire.ts` (`/yap/<verb>`), `src/server.ts` (`/api/hook/:event`, `/api/*`).
- The adapters: `hooks/yap.sh` (Claude Code, sh), `yap hook` in `src/cli.ts` (Codex, cmd on Windows),
  `src/mcp.ts` (`yap mcp`, including `tools()`, which rewrites `yap …` CLI mentions into tool names).
- `sdk/local.ts` (the client and its types), `src/cli.ts` (the command and its usage line).
- `docs/yap.md` (the spec, the source of truth), `README.md`, `skills/yap/SKILL.md`, `docs/kodr.md` if Kodr's side
  changes.
- Hook changes reach users only through the plugin cache: bump `.claude-plugin/plugin.json`'s version, then
  `claude plugin marketplace update yap && claude plugin update yap@yap`.

## Checks

- `bun src/crew.check.ts` prints `crew ok`; `bunx tsc --noEmit -p .` prints nothing.
- Proof fits the bug: logic, state or storage gets a failing case first. A new verb or field gets a case that goes
  through the `/yap` handler (`local(reg)`), not only `Sessions` directly.
- Fakes, never real services: `rig()` gives a `Workspace`, an in-memory `SqliteStore`, and you pass `Panes` and
  `AgentRunner` fakes. Extend `src/crew.check.ts`; a module that outgrows it gets its own `*.check.ts`.
- Never wait on time: the registry takes a `now()` you control.

## Windows

- Several files are CRLF. Edit with the Edit tool; a Python heredoc mangles backticks and `\n` in TypeScript.
- Paths are compared through `norm()` in `src/sessions.ts`, which also maps Git Bash's `/c/...` to `c:/...`.
- Codex runs hooks through cmd, so its adapter is `yap hook`, not `sh`.

## Finishing a change

1. Spec and code in the same commit; `docs/yap.md` says the new behaviour.
2. The surfaces above that apply, changed.
3. Checks pass, and the behaviour was seen once against a real daemon (a throwaway one unless shipping).
4. Commit as `area: what changed` and push to main. Another session's PR gets a review (`/code-review`), and the
   user merges it.
