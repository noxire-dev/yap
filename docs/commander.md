# The commander model

A commander is one agent session that doesn't do the work. It reads the task, splits it, starts one background
worker per piece with `yap spawn`, and waits. The workers are full Claude Code sessions, run as peers in the same
working tree. yap tells each of them what the others are editing while they work. Each worker's last message comes
back to the commander on its own. The commander's context holds the task and the workers' short reports, never their
work.

It sits between two setups people already use:

| | Subagents (Task tool) | Commander (yap spawn) | Parallel peers (separate sessions) |
|---|---|---|---|
| Workers are | in-process subagents of one session | separate Claude Code sessions | separate sessions the user started |
| Working tree | shared | shared | one each, merged at the end |
| Workers see each other | no | yes, through yap's hooks | yes, through yap's hooks |
| What the parent reads | every subagent's full report | each worker's last message | nothing: there is no parent |
| Worker start-up | ~3 s | ~12 s (a new process) | ~6 s |

This file explains the model, the parts of the YAP protocol it rests on, and three benchmarks (2026-11-21 and
2026-11-22, 216 runs in all) that measured it against the other two setups.

## How a run goes

```
 commander (claude -p)
   │  reads the task, writes one brief per piece (or points at a file)
   ├─ yap spawn "<piece 1>" ──► daemon starts worker 1 (claude -p, its own session id, a peer)
   ├─ yap spawn "<piece 2>" ──► daemon starts worker 2
   │  ends its turn: nothing to poll
   │
   │            worker 1 ◄── yap hooks ──► worker 2
   │            "Other agents are working in this repository right now…
   │             re-read a file listed here before you edit it"
   │            each runs the tests, ends with what it did
   │
   ◄── spawn ended: worker 1's last word (in the inbox; the commander is woken if idle)
   ◄── spawn ended: worker 2's last word
   │  done, unless a worker reported a failure: then fix it, test once
```

What each step rests on in the protocol (`docs/yap.md`):

- **Start a worker:** `spawn` (`text`, optional `agent: codex`, optional `skills`). The daemon starts the session
  under a new id and answers `{ id }`. At most `spawns` (3 by default, `yap config spawns <n>`) run at once; past
  that it answers 429.
- **Workers see each other:** they are peers like any session. `will-edit` before a write answers with a peer's
  live claim on the file, or a peer's edit there in the last 30 minutes. `turn` and `idle` deliver what peers did
  and said. Nobody has to call anything: Claude Code's hooks send these verbs.
- **Reports come back:** when a spawn ends, its final message goes to the sender's inbox as a `spawn` message
  (`ok` says finished or failed), and the sender is woken if idle. With no sender session, it waits in
  `yap spawns` and the user's inbox.
- **Following a worker live:** `spawns` with an `id` adds its `log`, one line per tool call.
- **Talking:** `say '@<id>'` reaches a worker mid-run. `say --question '@user'` lets a worker ask the person
  something without stopping.
- **Lean workers:** `spawn` with `skills` (`yap spawn --skills ponytail <task>`) reads none of the user's settings,
  plugins or skills, and loads only yap and the names given. A name is an installed plugin, loaded whole with its
  hooks, or a folder in `~/.claude/skills`, copied into a throwaway plugin. Without `skills` a worker loads the
  user's whole setup: 14 plugins on this machine, about 44k tokens of context before the task.

## The benchmarks

**Tasks.** CooperBench's go-chi pairs (arXiv 2601.13295): six pairs of features (26[1,2], 26[2,4], 27[2,4],
27[3,4], 56[1,5], 56[2,3]), each pair two features that touch the same code, mostly `mux.go`. A run passes when
both features' hidden tests pass on the final tree. For setups with separate trees that is the merged tree; a merge
conflict fails the run, as in CooperBench. Three repeats each.

**Where.** On the user's Claude plan through `claude -p`, never an API key. Sonnet (`claude-sonnet-5-5`) unless
said. Every run had its own throwaway yap daemon (ports 42xx, 43xx and 44xx), never the shared one on 4170. Cost is
Claude Code's own `total_cost_usd`, the API-price equivalent. The plan was what got billed.

**Harness.** `bench/run.ts`, with a `claude` shim that logs every agent's stream. `bench/trace.ts` splits each
run's time per agent into start-up, model and tools, and splits plan, work and tail. The code is on the bench
branches:

| Run | Branch | Brief | Results |
|---|---|---|---|
| v1, 90 runs | main (eaa0df2) | `docs/bench/brief.md` | `bench/results/2026-11-21.md` |
| v2, 72 runs | `bench-v2` | `docs/bench/brief-v2.md` | `bench/results/2026-11-21-v2.md` |
| v3, 54 runs | `bench-v3` | `docs/bench/brief-v3.md` | `bench/results/2026-11-22-v3.md` |

### v1: five setups, agents with the user's whole setup

| Setup | Pass | Median cost | Median tokens | Median wall |
|---|---|---|---|---|
| A subagents | 67% | $0.50 | 953k | 1:47 |
| B bare parallel (two trees, no yap) | 0% | $0.35 | 556k | 0:59 |
| C yap peers (two trees, with yap) | 0% | $0.35 | 612k | 1:08 |
| D commander | 67% | $0.58 | 898k | 1:53 |
| E crew (`yap goal` + `yap go`, test gate) | 67% | $0.86 | 1,025k | 4:51 |

- **B and C fail by construction.** Both agents edit `mux.go`, so 34 of 36 merges conflicted. C's peers used yap
  in 11 of 18 runs and still conflicted. A claim is checked only before Edit and Write, and one agent edited the
  claimed file with `sed` in Bash (board #61, not fixed yet).
- **D was the most expensive and slowest of A/D.** Every agent loaded 14 plugins (about 44k tokens), and D runs
  three agents to A's one process. The commander then spent 69 s after its workers finished: 41 s polling
  `yap spawns`, 28 s re-running `go test`.
- **E is too heavy for two small features.** Its gate also put a dialog on the user's desktop every run (fixed for
  the bench with `YAP_YOLO=1`).

### v2: clean agents, no crew, a commander that trusts its workers

All agents ran with `--setting-sources ''` (no plugins), and yap only where the setup uses it. D's prompt now says
workers run the tests and their last word comes back on its own: don't poll, don't re-test.

| Setup | Pass | Median cost | Median tokens | Median wall |
|---|---|---|---|---|
| A subagents | 67% | $0.30 | 547k | 107s |
| B bare parallel | 0% | $0.18 | 278k | 54s |
| C yap peers | 0% | $0.19 | 315k | 58s |
| D commander | 78% | $0.28 | 468k | 83s |

Clean agents cut cost by 40-50%, and D gained most: it went from the most expensive to cheaper than A. Where A and
D's time went, as medians over 18 runs each:

| Phase | A | D |
|---|---|---|
| Plan: start to the first worker | 14.1s | 12.7s |
| Work: first worker starts to last ends | 72.1s | 65.9s |
| Tail: last worker ends to the run's end | 33.5s | 0s |
| Parent turns | 6 | 2 |
| Parent tokens read | 161k | 43k |
| Workers' tokens read | 303k | 396k |

- **The 30 s D won was the tail.** A's parent re-ran `go test -count=1 ./...` (about 28 s) after its subagents,
  because its prompt said "read what they did and fix anything left". D's said not to.
- **The commander's lasting edge is context.** Its parent reads about a quarter of what A's does. The workers read
  more, since each is a full session with its own system prompt and yap context, so total cost is close.
- **Coordination was all passive.** D's workers never used `yap say` or `yap claim` (0 of 18 runs). yap's hooks
  warned them about each other 72 times across the 18 runs, and no D run broke on a clash in the shared tree.
- **D's 78% against 67% is two runs**, both on pair 56[1,5].

### v3: a fair rematch, and lean workers with a skill

- **A2:** subagents with the same trust rule as D, features as files outside the repo.
- **D2:** the commander on Haiku, pointing each worker at its feature file instead of retyping it.
- **D3:** D2 with workers started as `yap spawn --skills ponytail`.

| Setup | Pass | Median cost | Median tokens | Median wall | Median lines added |
|---|---|---|---|---|---|
| A2 subagents, trusting | 67% | $0.24 | 446k | 73s | 128 |
| D2 Haiku commander, pointing | 72% | $0.23 | 471k | 86s | 136 |
| D3 D2 + ponytail workers | 67% | $0.23 | 497k | 88s | 107 |

| Phase | A2 | D2 | D3 |
|---|---|---|---|
| Plan | 6.6s | 7.5s | 7.4s |
| Work | 64.7s | 74.1s | 77.4s |
| Tail | 4.0s | 0s | 0s |
| Parent tokens read | 105k | 80k | 80k |
| Workers' tokens read | 351k | 401k | 425k |

v3 counts tokens read as input plus cache reads plus cache writes, so its token figures aren't comparable with v2's.

- **With the same trust rule, subagents are fastest.** A2's tail fell from 33.5 s to 4 s and its wall from 107 s to
  73 s, at the same pass rate. The 33 s in v2 was the prompt, not the architecture.
- **Haiku and pointing bought cost, not time.** The commander's plan phase went from 12.7 s to 7.5 s and the median
  cost from $0.28 to $0.23. The work phase grew 8 s, because each worker reads its file itself, and every spawned
  worker pays about 12 s to start (`start` in the timing split: D2 12.1 s, A2 3.5 s).
- **Ponytail made smaller patches and changed little else.** Patches were 21% smaller; cost and time were within 3%.
  The skill loaded (its SessionStart hook ran) but no worker invoked it: the features are too small to trim.
- **Pass rates are noise.** Every failure in all three setups is feature 1 of 27[3,4], which has never passed in
  any of the 216 runs, or of 56[1,5]. The spread between setups is one run.

## What the numbers say

1. **Two agents in one tree beat two trees and a merge.** Every shared-tree setup passed 67-78%; every two-tree setup
   0%. Telling each other what they were doing didn't stop separate trees from conflicting.
2. **The prompt costs more than the architecture.** A re-test at the end is 28-69 s. Retyping a brief is about 12 s.
   Fix those first.
3. **On small tasks the commander ties subagents.** It is about as fast, about as cheap, and about as correct.
4. **What the commander buys is a small parent context:** 43-80k tokens read against 105-161k for a subagent parent.
   That should grow with the task. A long session dispatching many pieces stays light, where a subagent parent fills
   up with every report. None of these tasks was long enough to show it, which is the next benchmark.
5. **Spawning costs about 12 s per worker.** Subagents start in 3 s. A commander pays it once per piece, so it
   suits pieces that run minutes, not seconds.

## Rules for a commander, from the runs

- Point, don't paste. Give each worker a file path or an issue number, not the text.
- Tell workers to run the tests and end with whether they passed. Then trust them: re-run nothing unless a worker
  reported a failure.
- Don't poll. A worker's last word arrives on its own.
- Run the commander on a small model (Haiku). It reads and dispatches.
- Let workers share the tree when their pieces touch the same files; yap's hooks keep them from clobbering each
  other. Separate trees need a merge step that understands both changes.
- Give lean workers only the skills their piece needs (`--skills ponytail` for backend, `--skills frontend-craft`
  for UI). Without `--skills`, every worker pays for the whole setup.

## Not measured yet

- Long tasks, more than two pieces, and tasks where the pieces depend on each other.
- Languages other than Go (this machine has no Docker for CooperBench's other repos).
- The claim check after Bash edits (#61), and setup C run again once it lands.
- A UI task, where `frontend-craft` would have something to do.
