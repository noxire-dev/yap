# AI coding setup and /goal-style autonomy: web research

Researched 2026-11-20. Recency is given per source. "Primary" means vendor docs or the author's own repo/post.

Bottom line: the quality gap is mostly verification, not prompting. The people shipping good AI-built code give the agent a check it can run, enforce the check in the harness (Stop hook, CI), and get the diff reviewed by a context that did not write it. Every autonomy tool below is only as good as its definition of done.

---

## A. Setups that produce high-quality output

### A1. Anthropic's own guidance (primary, current docs, Nov 2026)

[Best practices for Claude Code](https://code.claude.com/docs/en/best-practices) was rewritten for Opus 5.5 and is the single most useful page. Its model:

- Two kinds of instruction. Non-deterministic: prompt, CLAUDE.md, skills (Claude decides). Deterministic: hooks, deny rules, managed settings (harness enforces). "If you keep adding emphasis to a CLAUDE.md line and Claude still misses it, that line belongs in a hook." The reverse also holds: delete hooks that encode preferences.
- CLAUDE.md stays short (memory guide says under 200 lines). Contents: exact test/typecheck/lint commands, how to run one test file, decisions not visible in the repo. "The single most useful line in your CLAUDE.md is the command that runs [the check]." Path-specific rules go in `.claude/rules/` with a `paths:` filter. Procedures go in skills; side-effecting ones get `disable-model-invocation: true`.
- Spec first for fuzzy work: "Interview me until you could write the spec, then write it to SPEC.md", then build in a fresh session from SPEC.md.
- Done-ness ladder, weakest to strongest: ask for evidence → `/goal` → Stop hook → reviewer that never saw the conversation (`/code-review`, or a read-only `.claude/agents/reviewer.md` with `tools: Read, Grep, Glob`) → CI.
- Review against the spec, and say "skip style": "A reviewer that's asked to find problems will always find something. If you fix every finding, you end up with extra abstraction layers."
- Stop hook in `.claude/settings.json`: `{"type":"command","command":"pnpm tsc --noEmit 1>&2 || exit 2"}`. Exit 2 blocks the stop, stderr goes back to Claude. Cap: 8 consecutive blocks with no tool call, then the harness lets it stop (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`).
- PostToolUse formatter hook on Edit/Write; PreToolUse hook exiting 2 for protected paths.
- Keep the enforced set small: "If you ever find yourself at forty of them, most are probably preferences."
- Dropped advice: IMPORTANT/ALL CAPS, aggressive context management, subagents "for a better answer". `ultrathink` and `/effort xhigh` are the real knobs.
- Pre-unattended checklist: knows what done looks like; can check its own work; limited in what it can touch (worktree, one branch); has a stop (`--max-turns`, `--max-budget-usd`); a person signs off on the result.

[Harness design for long-running apps](https://www.anthropic.com/engineering/harness-design-long-running-apps) (Anthropic Engineering, Mar 2026): planner → generator → separate evaluator (Playwright clicking through the app, hard pass/fail thresholds). Out of the box Claude was a poor QA agent: "noticed real issues, then talked itself into approving them." A solo run took 20 min/$9 and shipped a broken core feature; the harness took 6 h/$200 and worked. With Opus 4.6 they dropped sprints and kept one end-of-run evaluator pass. Lesson: every harness component encodes an assumption about what the model can't do; re-test them as models improve.

[Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) (Anthropic, Nov 2025, older than 6 months but still the base pattern): initializer agent writes a full feature list, `claude-progress.txt`, init script, first commit. Each later session reads progress + feature list + git log, runs tests, does one feature, commits, updates progress.

### A2. Practitioners (primary where linked)

- **Boris Cherny** (Claude Code lead, thread Jan 2026, via [InfoQ](https://www.infoq.com/news/2026/01/claude-code-creator-workflow)): nearly stock config, shared team CLAUDE.md updated whenever Claude errs, PostToolUse formatter, a `verify-app` subagent, a `code-simplifier` subagent, 5 parallel sessions. "Verification loops are non-negotiable." Doesn't use `--dangerously-skip-permissions`.
- **Mitchell Hashimoto**, [My AI Adoption Journey](https://mitchellh.com/writing/my-ai-adoption-journey) (Feb 2026): "harness engineering" means every repeated agent mistake gets a fix (an AGENTS.md line or a script such as a filtered test runner or screenshot tool, documented in AGENTS.md). Separate planning sessions from execution. Last 30 min of the day: kick off agents for research/triage so there is a head start in the morning. One agent at a time, notifications off.
- **Armin Ronacher** (talks 2025–2026, [summary via Simon Willison](https://simonwillison.net/tags/armin-ronacher/)): prefer a Makefile/script the agent can run over MCP; consolidated logs the agent can tail; the harness barely changed while models got better.
- **Anthropic internally** ([The New Stack, Nov 2026](https://thenewstack.io/anthropic-claude-code-verification), paywalled/403 to fetch, summary from search): agents may not skip flaky tests or rerun until green; unclear root cause means delete the test and document why.

### A3. Skills and plugins worth knowing (star counts and last push checked via `gh` on 2026-11-20)

| Name | What it does | Signal |
|---|---|---|
| [obra/superpowers](https://github.com/obra/superpowers) | Full method: brainstorm → design doc → worktree → plan in 2–5 min tasks with file paths and verify steps → subagent per task with review between tasks → strict TDD (code before test gets deleted) → finish-branch. Claude Code `/plugin install superpowers@claude-plugins-official`; also a Codex plugin. | 323k stars, pushed Nov 3 2026. Heavy; opinionated TDD can fight small edits. |
| [mattpocock/skills](https://github.com/mattpocock/skills) | tdd, diagnosing-bugs, codebase-design, grilling, code-review (standards + spec axes). | 329k, pushed Nov 19. Already installed here. |
| [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | 27 skills: spec-driven-development, planning-and-task-breakdown, incremental-implementation, browser-testing-with-devtools, doubt-driven-development, code-simplification, security-and-hardening, ci-cd. Has `.claude-plugin` and `.codex-plugin`, plus evals. | 119k, pushed Nov 18. Lighter than Superpowers; pick skills à la carte. |
| [github/spec-kit](https://github.com/github/spec-kit) | Spec-driven dev: constitution → specify → plan → tasks → implement, as slash commands for Claude/Codex. | 151k, pushed today. Ceremony-heavy for solo work. |
| [gsd-build/get-shit-done](https://github.com/gsd-build/get-shit-done) | Spec + context-engineering system for Claude Code. | 64k, last push May 31 2026 — going stale. |
| [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | Official marketplace: ralph-loop, code-review, frontend-design, etc. | 48k, pushed today. |
| [anthropics/skills](https://github.com/anthropics/skills) | skill-creator, document skills, reference skills. | 198k, pushed Nov 16. |
| [trailofbits/skills](https://github.com/trailofbits/skills) | Security audit and vuln-hunting skills. | 8k, pushed today. |

Skill listicles (firecrawl, designrevision, etc.) were skipped as SEO. Caveat across all of these: skill descriptions load into every session; installing three overlapping methodologies gives the router a coin flip. Pick one methodology.

### A4. Codex parity (primary docs)

- Codex reads `AGENTS.md`. Hooks are on by default ([Codex hooks](https://learn.chatgpt.com/docs/hooks)): `Stop` hook exits 2 (or returns `"decision":"block"`) and the reason becomes a continuation prompt, same semantics as Claude Code. `command_windows` gives a Windows-specific command. New or changed hooks must be trusted in `/hooks` before they run.
- Codex desktop app is native on Windows since Mar 2026, with a Windows sandbox and PowerShell by default ([Neowin](https://www.neowin.net/news/openai-releases-the-much-awaited-codex-app-for-windows/)).

### A5. Test/CI discipline that shows up everywhere

1. One command that proves the repo is OK (`pnpm check` = typecheck + lint + fast tests), named in CLAUDE.md/AGENTS.md.
2. The same command in a Stop hook, fast enough to run every stop. Slow suites go to CI.
3. Fix flaky tests before adding the hook, or the agent chases ghosts.
4. Guard tests against tampering: a PreToolUse deny on editing test files during implement tasks, or a reviewer told to flag test edits ([dev.to, 2026](https://dev.to/gabrielanhaia/your-coding-agent-saying-done-proves-nothing-let-your-test-suite-decide-joj)).
5. Fresh-context review against the spec before merge, "skip style".
6. CI on every PR, and branch protection so an agent can't push to main.

---

## B. /goal-style autonomy

Common failure modes across all tools: a vague condition never resolves, or resolves early; the evaluator only sees the transcript, so "tests pass" can be claimed without being shown; tests get weakened to pass; context compaction drops the objective; usage limits pause the run mid-way; unattended diffs nobody reviewed.

### B1. Claude Code `/goal` (built in, v2.1.139+, May 2026; primary [docs](https://code.claude.com/docs/en/goal))

- What: `/goal <condition>` (up to 4,000 chars). After each turn a small fast model (Haiku by default) judges met / not met / impossible against the transcript. Not met → another turn, with the reason as guidance. It is a session-scoped prompt-based Stop hook.
- On track: the evaluator cannot run commands or read files, so the condition must name the proof: "`pnpm test` exits 0 and output is shown; no test file modified; or stop after 30 turns". Stops after several turns with no tool use. Background work defers evaluation; check-ins every 30 min, backing off.
- Errors: auth failure, exhausted credit, unrecoverable context overflow → goal cleared. Rate/usage limit → goal paused; resumes when the limit resets if the session is set to wait for reset. Survives `--resume`; turn/time/token counters reset.
- Needs auto mode to run unattended (manual mode still prompts). Works headless: `claude -p "/goal ..." --output-format stream-json --verbose`.
- Cost: evaluator tokens negligible; the main turns are the cost, against the same 5-hour and weekly limits. `/goal` with no args shows token spend.
- Windows: yes, it's core CLI.
- Verdict: best default. Pair it with a real Stop hook so the check is enforced, not merely judged from the transcript.

### B2. Stop hook loop / Ralph (primary: [plugin](https://claude.com/plugins/ralph-loop), [snarktank/ralph](https://github.com/snarktank/ralph))

- Ralph plugin (`/ralph-loop "task" --completion-promise "DONE" --max-iterations N`): a Stop hook re-feeds the same prompt until the promise string appears. Same session, so context accumulates. Mostly superseded by `/goal` for in-session work.
- snarktank/ralph (22k stars, last push Feb 2026): a bash loop spawning a fresh agent per iteration (Amp default, `--tool claude`). State lives in `prd.json` (stories with `passes: true/false`), `progress.txt` (append-only learnings) and AGENTS.md. Each iteration takes the top unfinished story, implements it, runs typecheck/tests, commits if green, and marks it passed. Stops on `<promise>COMPLETE</promise>` or the iteration cap (default 10). Stories must fit one context window.
- Its edge over `/goal`: a fresh context per story and a file-based definition of done (`prd.json`), so nothing depends on compaction.
- Goes wrong: the agent marks `passes: true` on weak checks; big stories thrash.
- Windows: bash + jq, so Git Bash or WSL. Trivial to port to PowerShell (it's a for loop around `claude -p`).

### B3. Codex `/goal` (CLI 0.128+, GA May 21 2026; [docs](https://learn.chatgpt.com/use-cases/follow-goals), [Daniel Vaughan, May 2026](https://codex.danielvaughan.com/2026/05/07/codex-cli-goal-command-persisted-long-horizon-workflows-pause-resume-budget/))

- `/goal <objective>`, `/goal pause|resume|clear`. Persisted: it survives a closed laptop or crash and resumes. States: pursuing, paused, achieved, unmet, budget-limited. A token budget is a soft stop: the turn finishes and Codex writes a progress report. You can steer mid-run.
- On track: the model itself decides completion ("stops when it's confident"), with no separate evaluator. OpenAI's advice: one objective, one stopping condition, the commands that prove progress, checkpoints, a short progress log.
- Goes wrong: open bugs where compaction resurrects old instructions over the goal, including a Windows-app one ([#46953](https://github.com/openai/codex/issues/46953), Sep 2026; [#29811](https://github.com/openai/codex/issues/29811), Jun 2026). Mitigation: keep the goal and progress in a file and reference it.
- Cost: Plus has a 5-hour window plus a weekly cap ([Codex pricing](https://chatgpt.com/codex/pricing/)); reported Plus ranges are small (tens of local messages per window). A multi-hour goal on Plus will hit the window. Third-party report: ChatGPT and Codex move to one shared token pool in Dec 2026 ([extraheadroom](https://extraheadroom.com/codex-usage-limits), unverified).
- Windows: CLI and native app both.
- Verdict: good as a second worker for scoped jobs. Plus quota makes it a poor primary overnight engine.

### B4. Claude Code `/loop`, background sessions, cloud scheduled tasks (primary docs)

- [`/loop`](https://code.claude.com/docs/en/scheduled-tasks): interval-driven, not goal-driven. Fixed interval (`/loop 15m check CI, fix red jobs, push`) or self-paced (1 min–1 h). `.claude/loop.md` replaces the default maintenance prompt (continue unfinished work → tend PR/CI → cleanup). Session-scoped, 7-day expiry, max 50 tasks. Use it for babysitting PRs, not for building features.
- [Agent view / background sessions](https://code.claude.com/docs/en/agent-view) (research preview): `claude --bg --name x "prompt"` and `claude agents` for a dashboard of Working / Needs input / Completed. A supervisor daemon keeps sessions alive when the terminal closes, each in its own worktree under `.claude/worktrees/`. `claude agents --json --all` is scriptable. Each session draws its own quota. Windows-specific behavior is documented (taskkill for a stalled supervisor), so it runs there.
- [Cloud scheduled tasks (formerly routines)](https://code.claude.com/docs/en/routines) (research preview): prompt + repos + connectors run on Anthropic's cloud on a schedule, API POST or GitHub events. Fresh clone, pushes to `claude/*` branches. 100 scheduled runs/hour/account. Draws normal subscription usage. Windows-irrelevant. Protect main with a ruleset first.
- `/batch <change>` splits a mechanical change into 5–30 worktree units, each opening a PR.

### B5. Orchestrators and task boards

| Tool | What | Keeps on track by | Windows | Note |
|---|---|---|---|---|
| [Shepherdr](https://github.com/eliasstravik/shepherdr) (1.2k stars, pushed Nov 19 2026) | Herdr-app layout: per-space Assistant turns requests into tasks, each a Claude Code/Codex agent in its own worktree/branch. Board: Needs you / Ready / Working / Done. Autopilot and schedules. | Separate reviewer agent per task; Accept card shows proof; merge asks first by default. Brief rules are "guidance, not a sandbox". | No. README lists macOS and Linux. Needs Herdr app 0.1.12+ / herdr-core 0.1.17+. | Closest match to "task board agents pull from" in this person's stack. Blocked on Windows; WSL untested. |
| Herdr TUI ([docs](https://herdr.dev/docs/windows-beta/)) | Agent-aware multiplexer. | Shows agent state only. | Native Windows GA in 0.9.5, minus terminal attach, live handoff, clipboard image bridge. | Already in use. |
| [Conductor](https://www.conductor.build/) | Mac app: parallel Claude/Codex in worktrees, diff review. | Human review per workspace. | No (macOS, Apple Silicon). | Skip. |
| [vibe-kanban](https://github.com/BloopAI/vibe-kanban) (29k, pushed Nov 15) | Kanban; each card runs an agent in an isolated worktree, opens PR. | Human review of the card's diff. | Cross-platform (npx). | Most mature cross-platform board. |
| [Backlog.md](https://github.com/MrLesk/Backlog.md) (7k, pushed today) | Tasks as markdown files in git, MCP/CLI for agents; `backlog init` writes agent instructions. | Acceptance criteria per task file. | Yes (npm). | A file-based board; pairs with a Ralph-style loop. |
| [beads](https://github.com/gastownhall/beads) (29k, pushed today) | Steve Yegge's git-backed issue graph as agent memory; agents file and pick up issues. | Dependency graph, `ready` queue. | Go binary, cross-platform. | Strong for long multi-session work. |
| Claude Agent SDK | Build your own harness (planner/generator/evaluator as in A1). | Whatever you code. | Yes. | Overkill solo; headless `claude -p` without `--bare` keeps subscription login. `--bare` needs an API key. |

### B6. Subscription reality

- Claude Max: rolling 5-hour window plus a weekly cap, with a separate Sonnet weekly cap ([Max usage](https://support.claude.com/en/articles/11014257-about-claude-s-max-plan-usage)). The 50% weekly boost ended Aug 31 2026. Parallel background sessions, subagents, `/loop` and `/goal` all draw from the same pool; `/usage` breaks it down by skill/subagent.
- Anthropic's harness numbers (A1) put a serious multi-hour build at $100–200 API-equivalent. That is roughly a full 5-hour window or more on Max. Plan on "one overnight goal", not "five".
- Codex Plus: small windows; treat Codex as reviewer or second opinion, or for scoped goals.

---

## What to adopt (ranked)

1. **One check command + Stop hook, per repo.** Add `check` (typecheck + lint + fast tests) and name it in CLAUDE.md/AGENTS.md. Wire `<check> 1>&2 || exit 2` as a Stop hook in `.claude/settings.json`, and the same in Codex `[hooks]` with `command_windows`. Why: this is the main gap between "said done" and done; it's harness-enforced and makes `/goal` honest. Effort: ~15 min per repo. [Docs](https://code.claude.com/docs/en/best-practices#enforce-the-check-with-a-stop-hook)
2. **`/goal` in auto mode with a proof-bearing condition.** Template: "`<spec items>` implemented per SPEC.md; `pnpm check` exits 0 with output shown; no test files weakened; commit per item; or stop after 40 turns." Run it in a worktree session (`claude -w name` or `--bg`). Why: built in, Windows-native, separate evaluator, pauses and resumes on usage limits. Effort: none to try. [Docs](https://code.claude.com/docs/en/goal)
3. **Spec interview → fresh build session.** "Interview me until you could write the spec, then write SPEC.md", then `/clear` and build from it. You already have `grilling`; point its output at SPEC.md. Why: gives `/goal` and the reviewer the same definition of done. Effort: habit. [Docs](https://code.claude.com/docs/en/best-practices)
4. **Read-only spec reviewer before merge.** `.claude/agents/reviewer.md` with `tools: Read, Grep, Glob`, prompted "review diff against SPEC.md, every requirement implemented, edge cases tested, skip style". Or `/code-review`, or Codex as the cross-model reviewer. Why: Anthropic found self-evaluation praises itself; a fresh context doesn't. Effort: one file. [Docs](https://code.claude.com/docs/en/best-practices#review-against-your-spec)
5. **Harness engineering habit (Hashimoto).** Every repeated agent mistake becomes either one AGENTS.md line or a script/hook. Keep CLAUDE.md under 200 lines and move non-negotiables to hooks. Why: compounding quality, and it's how the "far higher quality" repos got that way. Effort: ongoing. [Post](https://mitchellh.com/writing/my-ai-adoption-journey)
6. **File-backed task queue for multi-hour work.** `prd.json`-style stories with `passes` flags (Ralph) or Backlog.md/beads, driven by a PowerShell loop of `claude -p` (fresh context per story, `--max-turns`, `--permission-mode auto`), or by `/goal "every story in prd.json passes"`. Why: survives compaction and crashes, and done is a file rather than a vibe. Effort: ~1 h. [snarktank/ralph](https://github.com/snarktank/ralph)
7. **One methodology skill pack, not three.** If you want more structure than mattpocock/skills, add à-la-carte skills from addyosmani/agent-skills (spec-driven-development, incremental-implementation, browser-testing-with-devtools) rather than all of Superpowers. Why: overlapping skills confuse routing, which your CLAUDE.md already calls a config bug. Effort: 10 min. [agent-skills](https://github.com/addyosmani/agent-skills)
8. **Branch protection + end-of-day kickoff.** Ruleset on main for every repo agents touch. Spend the last 30 min of the day dispatching `claude --bg` goals for research, triage or one spec'd feature; review PRs in the morning. Why: unattended work is safe only if it can't merge itself. Effort: 10 min per repo. [Cloud tasks warning](https://code.claude.com/docs/en/best-practices#start-runs-on-a-schedule-or-an-event)

Not adopted: Conductor (macOS only); Shepherdr (best fit with Herdr, but no Windows; revisit if it ships Windows or works under WSL); Agent SDK custom harness (YAGNI for a solo dev); Codex `/goal` as the primary overnight engine (Plus quota plus open compaction bugs on Windows).
