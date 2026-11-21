# Brief: how agents share a repo, measured

## What it is

A benchmark that runs the same conflicting coding tasks through five setups and publishes pass rate, cost and
collisions for each, including the ones where yap loses. Readers are people deciding how to run several agents
at once; the numbers go on mirako.computer/yap.html with the harness and raw results.

## Prior work (checked 2026-11-21)

- CooperBench (arXiv 2601.13295): 652 tasks, two agents each build a feature on one repo state, conflicts built
  in. Agents do ~30% worse together than alone. Use its task pairs; don't write our own.
- "Passes Alone, Fails Together" (arXiv 2609.25396): hidden tests for changes that merge cleanly but break each
  other. Use the idea: score the merged result, not each branch.
- Nobody publishes cost per setup. That column is ours.

## Setups

| | Setup | Who coordinates |
|---|---|---|
| A | One Claude Code session with subagents (Task tool) | the parent, which reads every result |
| B | N sessions in parallel, no yap | nobody |
| C | N sessions with yap | the agents, with each other |
| D | A commander session using `yap spawn`, workers coordinate over yap | the agents; the parent reads summaries only |
| E | The crew (`yap goal` + `yap go`) | planner and reviewer, behind a test gate |

Same model, same prompt text per task, same repo state. Runs on the user's Claude plan (`claude -p`), never an
API key.

## Measured, per run

- Pass: CooperBench's tests for both features, run on the final merged tree.
- Cost: `total_cost_usd` and tokens from `claude -p --output-format json`, summed over every agent in the run.
- Wall-clock, first prompt to last exit.
- Collisions: edits overwritten, work lost to stash/checkout/reset, textual merge conflicts.
- Interventions: times a person would have had to step in (an agent stuck, asking, or out of turns).

## Done when

1. `bun bench/run.ts --tasks 6 --repeats 3` runs all five setups unattended and exits 0. Proof: its log.
2. `bench/results/<date>.json` holds one row per run with every field above. Proof: the file, 90 rows.
3. `bench/results/<date>.md` has a table of medians per setup, and a paragraph per setup naming where it lost.
   Proof: the file.
4. The harness runs B, C and D in throwaway `YAP_HOME`/`YAP_PORT` daemons, never the shared one on 4170.
   Proof: the run log shows the ports.
5. A dry run (`--tasks 1 --repeats 1`) finishes before the full run starts, and its cost sets the cap for the
   full run. Proof: the dry run's row.

## Not doing

- Fixing yap's commander gaps (worktree per spawn, teams, shared brief, budget caps) before measuring. Measure
  first; the numbers say which gap matters.
- Other models or Codex. Claude only this round.
- Publishing. The page update waits for the user.

## Needs you

- Plan usage: 6 tasks × 5 setups × 3 repeats is ~90 runs of 2+ agents. Expect a large share of a week's limit.
  The dry run gives the real figure before the full run.
- Publishing the results on mirako.computer.

## The run

Paste in a fresh session in this repo, in auto mode:

```
/goal Build and run the benchmark in docs/bench/brief.md. Done when: (1) the dry run `bun bench/run.ts --tasks 1 --repeats 1` has run all five setups (A subagents, B bare parallel, C yap peers, D commander with yap spawn, E crew) on one CooperBench task pair and its result row is shown; (2) if that dry run's usage, times 90, looks like more than half a weekly plan limit, the projection is written to NEEDS-YOU.md and the goal stops there, without the full run; (3) otherwise `bun bench/run.ts --tasks 6 --repeats 3` exits 0, with the tail of its log shown; (4) bench/results/<date>.json has 90 rows, each with pass, total_cost_usd, tokens, wall-clock, collisions and interventions, and a row count is shown; (5) bench/results/<date>.md has the median table per setup and one paragraph per setup naming where it lost, and is shown; (6) the log shows B, C and D used throwaway YAP_HOME/YAP_PORT daemons, never port 4170, and the shared daemon was never stopped or restarted; (7) `bun run check` exits 0 with its output shown. Every agent runs on the user's Claude plan through claude -p, never an API key. A setup that can't run is reported with why, not dropped or rescored. Work moved to later or a follow-up does not count as done. Anything only the user can do (publishing, plan limits) goes in NEEDS-YOU.md and does not block. No test, check or scoring rule was removed or weakened to make a setup look better. The last turn lists each check with its result and the NEEDS-YOU.md items. Or stop after 60 turns.
```

## Where it lives

`bench/` in this repo (runner, task fetch, scoring), results in `bench/results/`, this brief in `docs/bench/`.
