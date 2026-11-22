# Brief: bench v3, a fair rematch of subagents and the commander, and lean workers with skills

v2 (`docs/bench/brief-v2.md`, results `bench/results/2026-11-21-v2.md`) had D, the commander, at 78% and 79 s
against A, subagents, at 67% and 109 s. The traces (`bun bench/trace.ts --setups 2026-11-21-v2`) showed two
things unfair or slow, and yap has a new way to start workers:

1. A's prompt says "read what they did and fix anything left", D's says "don't re-run the tests". 33 s of A's
   109 s is the parent re-running `go test` after its subagents. That's the prompt, not the architecture.
2. D's commander spends about 12 s retyping each feature's full text into `yap spawn`, as output tokens. A's
   parent does the same into the Task tool.
3. `yap spawn --skills <a,b>` (61d5094, cherry-picked here) starts a lean worker: no user settings, plugins or
   skills, only yap and the ones named. Backend workers can get `ponytail`, UI workers `frontend-craft`.

## Setups (v3 replaces A-D with three)

Same six go-chi pairs, same scoring, three repeats: 54 runs. Every agent clean as in v2 (the shim's
`--setting-sources ''`), Sonnet (`claude-sonnet-5-5`) unless said.

- **A2: subagents, trusting.** As A, but the features are files: `<run dir>/features/1.md` and `2.md`, outside the
  repo, so nothing lands in the patch. The prompt names the paths instead of pasting the text, tells the parent
  to give each subagent its file's path, and has the same trust rule as D: the subagents run `go test ./...`
  and report; the parent re-runs nothing and fixes nothing unless a subagent reported a failure, then
  `go test ./...` once after its fix.
- **D2: commander, pointing, on Haiku.** As D, with the same feature files: the commander tells each worker
  "implement the feature in `<path>`" in one line, never the text. The commander runs on `claude-haiku-5-5`
  (its own `--model`, which the shim keeps); workers on Sonnet.
- **D3: D2 with lean ponytail workers.** As D2, but the commander starts each worker with
  `yap spawn --skills ponytail <task>`. The init check expects the commander to load only yap and each worker
  yap and ponytail.

## Harness changes

- `SETUPS` becomes `A2, D2, D3`, with names, `WITH_YAP`, the init check per lane (D3's workers: `ponytail,yap`).
- Daemons on 4400 + slot, run dirs under `%TEMP%/yapbench/<date>-v3/`, results `bench/results/<date>-v3.*`.
  v2's guards against 4170 and other ports stay, moved to the 44xx range.
- The report's timing split from `trace.ts --setups <date>-v3` (it now counts a parent idle while it waits on a
  background subagent as idle, not model time: bd9fa10).
- The report adds the A-vs-D phase split: plan (start to the first worker), work (first worker start to last end),
  tail (last worker end to the run's end), the parent's turns and tokens read, the workers' tokens read. Make it a
  `phases` function in `bench/trace.ts` with a case in `bench/bench.check.ts`.
- The report compares against v2's A and D in one table (from `2026-11-21-v2.json`), so "what the changes bought"
  is a row, not a guess.

## Done when

1. `bun run check` exits 0, its output shown.
2. Dry run `--tasks 1 --repeats 1 --setups A2,D2,D3` passes the init check for every agent, rows shown, and a
   D3 worker's init line shows `ponytail` among its plugins.
3. Full run `--tasks 6 --repeats 3 --setups A2,D2,D3` exits 0; `bench/results/<date>-v3.json` has 54 rows.
4. `bench/results/<date>-v3.md` has the median table, the timing split, the phase split, the v2 comparison
   table, and a paragraph per setup on where it lost; a paragraph on whether ponytail changed pass rate, diff size
   (lines added in the patch, a new column) or time.
5. The log shows ports 44xx only; 4170 untouched.
6. Committed on branch `bench-v3`, not pushed. A `yap note` on the board with the headline numbers and where the
   report is.

## Needs you

- Plan usage: v2's 72 runs were about 3% of the weekly meter. 54 runs should be about 2-3%. If the dry run
  projects more than 10% for the full run, write it to NEEDS-YOU.md and stop before the full run.
