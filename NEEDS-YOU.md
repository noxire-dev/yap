# Needs you: bench v2 (branch bench-v2)

- Merge or push bench-v2. Per the goal, it is committed here but not pushed or merged. When it merges, `bench/trace.ts`
  conflicts with main's 5e3dff6 in two lines: v2 exports `setups` and skips `<run>_limited<n>` dirs. @readme agreed
  that v2's version wins.
- Plan usage, for the record: the full run took the weekly meter from 29% to 32% (API-equivalent $17.97 for 72 runs),
  with v1 running at the same time. That was under the half-plan line, so the full run went ahead.
