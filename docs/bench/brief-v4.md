# Brief: bench v4, long tasks, peak parent context, and a no-hooks control

v1-v3 (`docs/commander.md` on main) ran two-feature tasks. There, the commander tied subagents on everything,
including peak parent context (about 28k tokens per turn for both). Two claims are still untested:

1. **Context:** a commander's parent stays flat as pieces are added, while a subagent parent grows with each report.
2. **Hooks:** yap's hooks help workers sharing one tree. D's workers got 72 warnings in v2 and never used `say` or
   `claim`, and subagents with no yap passed at the same rate. Nobody has run D with the hooks off.

v4 tests both with long tasks.

## Tasks

Every feature of a CooperBench go-chi task that shares one base commit, given at once:

- **L8:** task26 features 1-4 plus task27 features 1-4 (both on base 9436cc85), 8 pieces.
- **L5:** task56 features 1-5 (base 7f280968), 5 pieces.

Scoring per feature: apply the final patch (tests dropped, as now) on a fresh base, add each feature's
`tests.patch`, and run its tests. Report features passed out of N, plus whether all passed. Features of different
tasks were never meant to coexist, so some tests may clash. Run `--gold` on the union of the gold patches first, and
report which features the union itself can pass. That number is the ceiling, and a run is scored against it.

## Setups

Clean agents as in v2/v3, Sonnet unless said, features as files outside the repo (`<run dir>/features/<n>.md`),
the v3 trust rule (workers test; the parent re-runs nothing unless a worker reported a failure, then tests once
after its fix).

- **A4: subagents.** One session, one Task subagent per feature, all at once.
- **D4: commander.** As v3's D2: Haiku commander, one `yap spawn` per feature pointing at its file. The throwaway
  daemon's `spawns` config is raised to the piece count, so all workers run at once, like A4's subagents.
- **D0: commander, no hooks.** As D4, but the workers' yap hooks send nothing: no peer warnings, no edits recorded,
  nothing at turn or idle. The spawn plumbing stays (start, last word back, wake). For example, run the workers with
  `YAP_AGENT=1` passed through to them, which `hooks/yap.sh` already honours. Check it: zero
  `Other agents are working` lines in any D0 worker's log, at least one in D4's.

Three repeats: 2 tasks × 3 setups × 3 = 18 runs. A run's deadline is 45 minutes.

## Measured, new

- **Peak parent context:** the largest input + cache read + cache write of any one parent model call (main lane,
  deduped by message id). Also the parent context per turn as a series, so growth across reports shows.
- Per-feature pass, lines added, wall, cost, tokens, the plan/work/tail phases (`trace.ts --phases`), and
  quartiles (p25/p75) plus min and max for wall, cost and peak context, not medians alone.
- Collisions in the shared tree: a file two workers both edited, and whether either clobbered the other (a hunk
  one wrote that is missing from the final patch).

## Harness

Branch `bench-v4` from `bench-v3`. Daemons on 4500 + slot, run dirs `%TEMP%/yapbench/<date>-v4/`, results
`bench/results/<date>-v4.*`. Keep v3's guards (never 4170 or `~/.yap`, the per-lane init check, a run dir with
logs is never reused). New code gets a case in `bench/bench.check.ts`: per-feature scoring, peak context, and the
D0 no-hooks check.

## Done when

1. `bun run check` exits 0, output shown.
2. `--gold` on the union of each long task's gold patches, its per-feature result shown (the ceiling).
3. Dry run `--tasks L8 --repeats 1 --setups A4,D4,D0`: rows shown, the init check passing, D0's zero-warning check
   and D4's nonzero one shown.
4. Full run `--repeats 3 --setups A4,D4,D0` on L8 and L5 exits 0; `bench/results/<date>-v4.json` has 18 rows.
5. `bench/results/<date>-v4.md`: the table with quartiles, per-feature pass against the ceiling, the peak-context
   table and per-turn growth for A4 and D4, D4 against D0 (pass, collisions, clobbers), and a hand-written
   reading that says plainly whether each claim held. "Not shown at n=3" is an allowed answer.
6. `docs/commander.md` on this branch gets a v4 section and updated findings, in the doc's own voice: no claim
   the data doesn't show.
7. Committed on `bench-v4`, not pushed. A `yap note` with the headline numbers and the report path.

## Needs you

- Plan usage: v3's 54 runs were about 1% of the weekly meter. These runs are about four times longer. If the dry
  run projects more than 10% for the full run, write it to NEEDS-YOU.md and stop before the full run.
- Windows Firewall prompts on every new `go test` binary. Turn NotifyOnListen off for the run
  (`sudo pwsh -NoProfile -File` a script with `Set-NetFirewallProfile -All -NotifyOnListen False`, since plain sudo
  output is lost), turn it back on when done, and say both in the log.
