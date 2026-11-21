# Brief: bench v2, four setups, clean agents

v1 (`docs/bench/brief.md`, branch `worktree-bench`, 1f2dacc) runs as committed. v2 starts from that harness and
changes what the dry run's traces (`bench/trace.ts` on main) showed was unfair or missing. Same tasks, same scoring.

## Changes from v1

1. **No crew.** Setups A, B, C, D only (`--setups A,B,C,D`). The user dropped E.
2. **Clean agents.** v1 loads all 14 of the user's plugins into every agent (gopls-lsp, ponytail, impeccable,
   telemetry…): about 44k tokens of base context each and 5–9 s of hook/LSP time per Edit, paid more by setups
   with more agents. v2 runs every agent with `--setting-sources ''` (no user settings, so no plugins) and adds yap
   only where the setup uses it: `--plugin-dir <this repo>` for C and D. A and B get no plugins. Every agent's
   `init` line in its log must list only yap (C, D) or nothing (A, B); the runner checks it and fails the run
   otherwise.
3. **Commander prompt.** D's commander polled `yap spawns` for 41 s, then re-ran `go test` for 28 s after both
   workers had tested. The prompt now says workers run the tests and their last word comes back on its own; the
   commander waits for both (the runner may still poll for it), then merges nothing and re-runs nothing unless a
   worker reported a failure.
4. **Its own ports and directories.** Daemons on 4300 + slot (v1 holds 4200 + slot and is running right now), run
   directories under `%TEMP%/yapbench/<date>-v2/`, results in `bench/results/<date>-v2.{json,md,log}`. A run id
   never reuses a directory that holds logs: a dry run and the full run each keep theirs.
5. **Timing report.** `bench/results/<date>-v2.md` adds the per-setup split from `bun bench/trace.ts --setups
   <date>-v2` (wall, start-up, model, tools, gaps), so "where the time went" is in the report, not only pass and
   cost.

C stays as it is: its v1 conflict came from an agent editing a claimed file through Bash, which claims don't see
(board #61). That is a real result for current yap.

## Done when

1. Dry run `--tasks 1 --repeats 1 --setups A,B,C,D` passes the init-line check for all four setups, with the rows
   shown.
2. Full run `--tasks 6 --repeats 3 --setups A,B,C,D` exits 0; `bench/results/<date>-v2.json` has 72 rows.
3. `bench/results/<date>-v2.md` has the median table, the timing split, and a paragraph per setup naming where it
   lost.
4. The log shows ports 43xx only; neither 4170 nor v1's 42xx daemons were touched.
5. `bun run check` exits 0.

## Needs you

- Plan usage: v1's 90 runs and v2's 72 run back to back or together. The dry run's cost × 72 goes in NEEDS-YOU.md
  if it looks like more than half a week's plan together with v1, and the full run waits.
- v1 and v2 running at the same time share the CPU, so wall-clock is comparable within v2, not between v1 and v2.
