# Brief: yap as a bus

Bench v1-v4 (`docs/commander.md`, bench-v4 branch `bench/results/2026-11-22-v4.md`): yap's peer-activity context
never changed an outcome. Commander workers with yap's hooks off matched those with them on and cost about 20%
less. What sessions do use, every day, is the bus: the board, `say`, handoffs, `spawn` and the report back,
`inbox`, across Claude Code, Codex and MCP. Claude Code's own agent teams (experimental) cover a lead and its
teammates inside one session; yap's job is the sessions nobody launched together.

So: yap sends less, and says what it is first.

## What changes

1. **A session is told once, then only what's new.** `join` (SessionStart) answers with the overview as now: peers
   one line each, claims, the board, the paragraph on how to use yap. `turn` answers with news only, each
   item once: messages, a note pinned since the session was last told, a peer that joined or left, a new claim by
   a peer. Never the full board or the instruction paragraph again, and nothing at all when nothing is new.
   Today `overview()` in `src/sessions.ts` re-sends everything whenever anything changed.
2. **Spawned sessions get no overview.** A worker started by `spawn` has its brief. Its `join` answers with the
   instruction paragraph only. Messages and the guards still reach it.
3. **The guards stay:** the deny on a git command that would wipe or sweep up a peer's work, the warning before
   editing a file inside a peer's live claim or one a peer edited in the last 30 minutes, the `ran` warning (#61).
   They fire only on an overlap, so they cost nothing the rest of the time.
4. **README leads with the bus**: sessions you start separately, in any agent, leave notes, message, hand off and
   spawn. The hero example shows a board and a message, not a peer-activity list. Guards come after.

## Done when

1. Failing cases first in `src/crew.check.ts`, through `local(reg)`: a `turn` with nothing new answers no
   context; a `turn` after a peer pins a note answers that note alone, and the next `turn` answers nothing;
   a spawned session's `join` has no peers or board.
2. `bun run check` prints `all checks passed`, output shown.
3. Seen once on a throwaway daemon (`YAP_HOME=<tmp> YAP_PORT=4199`): two sessions, the second's turns, the
   context printed before and after a note.
4. Every surface that describes the context says the new behaviour: `docs/yap.md` (join, turn), `README.md`,
   `skills/yap/SKILL.md`, `src/mcp.ts` (GUIDE and `tools()`), `hooks/yap.sh` if it shapes the text, the plugin
   version bumped.
5. Committed as `sessions: ...` on main and pushed; the shared daemon restarted only if `yap spawns` shows nothing
   running; a `yap note` with what changed.

## Not doing

- Removing the hooks, or a config switch for the old behaviour.
- A bench re-run. The change only drops text the bench showed does nothing.
