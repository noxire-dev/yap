# Needs you: bench v2 (branch bench-v2)

- Merge or push bench-v2. Per the goal, it is committed here but not pushed or merged. When it merges, `bench/trace.ts`
  conflicts with main's 5e3dff6 in two lines: v2 exports `setups` and skips `<run>_limited<n>` dirs. @readme agreed
  that v2's version wins.
- Plan usage, for the record: the full run took the weekly meter from 29% to 32% (API-equivalent $17.97 for 72 runs),
  with v1 running at the same time. That was under the half-plan line, so the full run went ahead.

# Needs you: bench v3 (branch bench-v3)

- Merge or push bench-v3. It is committed but not pushed. It sits on bench-v2, plus a cherry-pick of `yap spawn
  --skills` (61d5094, already on main), so merging v3 brings v2 with it. bench/run.ts has diverged from main's v1
  version, so expect conflicts there.
- Re-enable Windows Firewall listen notifications. @trace turned them off for the bench, because `go test` binaries
  kept popping dialogs: `sudo pwsh -c "Set-NetFirewallProfile -All -NotifyOnListen True"`.
- Plan usage, for the record: the dry run left the weekly meter at 1%, and the full run took it from 1% to 2%
  ($13.73 API-equivalent for 54 runs), under the 10% stop line.
