# Agent setup: what the high-quality AI-coded repos do that we don't

Researched 2026-11-20. Sources are primary: the repos' own files (read with `gh api`) and Anthropic's docs.

Short version: yap's `AGENTS.md` already copies herdr-t3's best text rules ("Two ways to hurt yourself",
"Hit every surface", "Proof fits the bug"). The gap is not prose. It is that shepherdr and herdr-t3 turn their
rules into things that run: CI, a repo-rules test file, a staged demo instance, a reviewer loop with a stop
condition, and decision records. Our rules are read; theirs are executed.

## Findings

### shepherdr (eliasstravik/shepherdr)

| Practice | Source |
|---|---|
| `CLAUDE.md` is one line: `@AGENTS.md`. One file serves Claude and Codex. | [CLAUDE.md](https://github.com/eliasstravik/shepherdr/blob/main/CLAUDE.md) |
| `AGENTS.md` is mostly a "Trying a change" cookbook: exact recipes for reproducing hard cases (fake mic via oscillator, CDP touch events, throwaway cores with `HC_SESSION`, before-checks against `git archive origin/main`). Almost no style rules. | [AGENTS.md](https://github.com/eliasstravik/shepherdr/blob/main/AGENTS.md) |
| Lessons flow back: a worker ends with `herdr-task ready --agents-md "<one line>"`; the coordinator decides whether it lands. Lines appear as `From SHEP-263: …`, commits as `AGENTS.md: note from SHEP-263`. | [templates/worker.md](https://github.com/eliasstravik/shepherdr/blob/main/templates/worker.md), commit log |
| Repo rules are a test file, not prose: `test/test_repo.py` has `test_no_hover_tooltips`, `test_nothing_personal`, `test_no_leftovers`, `test_parity_has_no_open_rows`, `test_menus_from_one_list`, `test_features_have_both_sides`, `test_version_everywhere`, `test_no_bash4_builtins`, `test_every_test_file_loads_the_guard_first`. | `test/test_repo.py` |
| A home guard: every Python test imports `home_guard` first; touching the real `$HOME` fails the test at once. | `test/home_guard.py` |
| CI on every PR and merge (`check.yml`): shared-copy sync check, `node --check` loop, tsc, JSON parse, `bash -n`, all tests, and a full installer run into a throwaway home. Merging waits on it. | [.github/workflows/check.yml](https://github.com/eliasstravik/shepherdr/blob/main/.github/workflows/check.yml) |
| Parity specs: `docs/parity/<surface>.md` is a table of every element of the window surface, its web twin (file:line), and a state ✓ / ◇ (deliberate difference, with why) / ✗. A surface is done when nothing is ✗, and a test enforces that. | [docs/parity.md](https://github.com/eliasstravik/shepherdr/blob/main/docs/parity.md) |
| Shared words live in `core/` with a test that no string in `WORDS` is retyped in either UI. Drift is caught mechanically. | `docs/parity/chat.md` |
| A UI building-block doc (`lib/UI.md`): one table of sizes, three status colours, named parts, and rules ("No other sizes", "never write hex in a mod"). | [lib/UI.md](https://github.com/eliasstravik/shepherdr/blob/main/lib/UI.md) |
| Reviewer loop with a stop condition: worker commits, a fresh read-only reviewer (different CLI/model allowed) gets brief + diff + `reviewer.md`, reports findings as blocker/major/minor with proof. Fix everything at or above the bar, re-review, stop when a round finds none or rounds run out. "Never agree with a finding just to end the loop." Each round is recorded on the commit; `ready` refuses an unreviewed final commit. | [templates/worker.md](https://github.com/eliasstravik/shepherdr/blob/main/templates/worker.md), [templates/reviewer.md](https://github.com/eliasstravik/shepherdr/blob/main/templates/reviewer.md) |
| Proof artifact before "done": what changed in 1–3 lines, each proof (screenshot, before/after pair, real command output) with a caption, then a "Not proven" list. "A mocked test is no proof of what people see." A bug fix reproduces first. Screenshots at 390 and 1280 widths. | `templates/worker.md` |
| Done summary is for the person: ≤160 chars, no file names; details folded separately. | `templates/worker.md` |
| Guard rails on the human's domain: README design, releases and non-patch bumps need an explicit yes. | `AGENTS.md` |

### herdr-t3 (JinJieBeWater/herdr-t3)

| Practice | Source |
|---|---|
| Opening paragraph sets the taste, then says "the developer's preference overrides them; when one fights the task, say so and get a sign-off". | [AGENTS.md](https://github.com/JinJieBeWater/herdr-t3/blob/main/AGENTS.md) |
| "Hit every surface": a checklist the agent must walk and report which entries applied (entry points, mods, machines, sidebar states, reverse states: "a one-way door is a bug"). | AGENTS.md |
| Behaviour rules as product invariants: one action one name, state tells the truth, undo don't ask, nothing waits on motion, quiet until needed. | AGENTS.md |
| Checks rules: proof fits the bug (logic → failing check first; visual → before/after screenshots, no check), check at the lowest layer that fails without the fix, extend an existing check file before adding one, never wait on time. | AGENTS.md |
| `GLOSSARY.md` with `_Avoid_:` synonyms per term (Space, not workspace). | [GLOSSARY.md](https://github.com/JinJieBeWater/herdr-t3/blob/main/GLOSSARY.md) |
| 21 ADRs, each 1–3 sentences. "Before working in an area, read the ADRs that touch it; when your output contradicts one, say which and why it's worth reopening." | [docs/adr/](https://github.com/JinJieBeWater/herdr-t3/tree/main/docs/adr) |
| Per-surface specs (`docs/internals/specs/<surface>.md`) hold sizes, timings, ordering and edge rules. AGENTS.md routes by trigger: "read before changing a surface's sizes, timings, limits or edge rules". | [docs/internals/specs/inbox.md](https://github.com/JinJieBeWater/herdr-t3/blob/main/docs/internals/specs/inbox.md) |
| Doc discipline: "ask what a maintainer would get wrong without it; if reading the code answers that, leave it out". Rewrite, never append. Plans and scratch stay out of git; the commit is the record, an ADR records what outlives it. | AGENTS.md |
| `demo-window` skill: `stage.sh up/do/scene/shot/down` runs an isolated app with its own HOME under `$DEMO`. Rules: own folder per task, drive by commands only and report hover/drag as unverified, "before" shot taken before the first edit, an "after" from before the last edit is stale, whole window at default width before any crop. | [.agents/skills/demo-window/SKILL.md](https://github.com/JinJieBeWater/herdr-t3/blob/main/.agents/skills/demo-window/SKILL.md) |
| `scripts/check.sh` is the single gate and prints `all checks passed`; it also fails on a drifted copy of a shared module. Mods carry `check-*.cjs` files next to the code. | AGENTS.md, repo tree |
| Skills live in `.agents/skills`, `.claude/skills` links to it: one skill set for Claude and Codex. | AGENTS.md |

### Anthropic, Claude Code best practices ([code.claude.com/docs/en/best-practices](https://code.claude.com/docs/en/best-practices))

- Split instructions into non-deterministic (CLAUDE.md, skills) and deterministic (hooks, deny rules, CI).
  "If you keep adding emphasis to a CLAUDE.md line and Claude still misses it, that's a sign the line belongs in a hook."
- "Only write down what Claude can't find by reading the repo." Test: could it find this, and would it go look?
- "If your repo already has [a check], the single most useful line in your CLAUDE.md is the command that runs it."
- Enforce done with a `Stop` hook: `"command": "pnpm tsc --noEmit 1>&2 || exit 2"` blocks the turn until it passes.
- Review by someone who didn't write it: `/code-review` in a fresh subagent; or review against `SPEC.md` and
  "don't drop the `skip style` part ... a reviewer that's asked to find problems will always find *something*".
- Ask for evidence, not "all tests pass". `/verify` builds and runs the app and looks at the result.
- Interview → `SPEC.md` → fresh session builds from it with a written definition of done.
- Path-scoped rules in `.claude/rules/*.md` with `paths:`; procedures with side effects as skills with
  `disable-model-invocation: true`.

### obra/superpowers ([github.com/obra/superpowers](https://github.com/obra/superpowers))

- `verification-before-completion`: "NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE", a gate function
  (identify command → run → read → verify → claim) and a table of claim vs. sufficient evidence ("Agent completed"
  needs a VCS diff, not the agent's report).
- `receiving-code-review`: verify each finding against the codebase before implementing; reasoned pushback over
  "You're absolutely right!".
- `subagent-driven-development`: fresh implementer subagent per task, spec-compliance + quality review after each,
  whole-branch review at the end; decisions logged as `Ruling: <what> — <why> — <cost if wrong>` instead of stalling.
- `writing-plans`: plan names the files, signatures and the test that proves each task, for an engineer who has
  not seen the codebase.

### anthropics/skills ([github.com/anthropics/skills](https://github.com/anthropics/skills))

- `webapp-testing`: Playwright-driven checks of a local app, with a server-lifecycle helper. Same idea as
  frontend-craft; nothing to add beyond what you have.
- `skill-creator`: evals for skills. Relevant only if skills keep misfiring.

## Recurring practices across sources

| Practice | shepherdr | herdr-t3 | Anthropic | superpowers | yap / your setup |
|---|---|---|---|---|---|
| One instruction file for all agents (`CLAUDE.md` = `@AGENTS.md`) | yes | yes | – | – | yes |
| Hazard list (what not to touch) | yes | yes | deny rules | – | yes |
| Hit-every-surface checklist | parity docs | yes | – | – | yes |
| Proof fits the bug | yes | yes | yes | yes | yes |
| A single gate command that prints pass | CI + tests | `check.sh` | Stop hook | gate fn | two commands, no gate |
| Gate enforced by machine (CI or Stop hook) | CI | check.sh | Stop hook | – | no |
| Repo rules as tests | `test_repo.py` | `check.sh` (copies, icon paths) | hooks | – | no |
| Isolated, scripted app instance for proof | stubs, throwaway cores | `demo-window` skill | `/verify` | – | one-line recipe in AGENTS.md |
| Before/after proof with a "Not proven" list | yes | PR screenshots | evidence | yes | no |
| Fresh-eyes reviewer loop with severity and a stop rule | yes | – | `/code-review`, skip style | yes | `/code-review` + council, no loop rule |
| Glossary with avoided synonyms | – | yes | – | – | "Words" section, no avoid list |
| ADRs, short, read before touching an area | – | yes | "decisions not in the repo" | – | none |
| Per-surface spec files | parity tables | specs/ | SPEC.md | plans | `docs/yap.md` only |
| Lessons written back to AGENTS.md | `--agents-md` | rewrite-not-append | "correct twice → write it" | – | none |

## Gaps in this setup

1. **No mechanical gate.** yap has no CI (`.github/` absent) and no Stop hook; `~/.claude/settings.json` has only a
   `SessionStart` hook. "Checks pass" depends on the agent remembering two commands. Both reference repos make
   "done" a command that prints one line.
2. **Rules live only as prose.** Nothing like `test_repo.py`. "Hit every surface" in yap lists `sdk/local.ts`,
   `src/mcp.ts`, `docs/yap.md`, `skills/yap/SKILL.md`; nothing checks a new `/yap/<verb>` appears in all of them.
   shepherdr would have a test for exactly that.
3. **No staged instance as a skill.** yap's throwaway daemon is one line in AGENTS.md. herdr-t3 packaged the same
   idea as `demo-window` with lifecycle, per-task folder, stale-shot rules and "report unverified". frontend-craft
   covers web UI but not your daemons/CLIs.
4. **No proof artifact.** Reports say what changed; none carry before/after evidence plus a "Not proven" list.
   Your global CLAUDE.md bans claiming success without running it, but doesn't define what the evidence is.
5. **Review has no loop contract.** You have `/code-review`, mattpocock `code-review` and council, but no rule for
   severity, the fix bar, when to stop, or "don't agree to end the loop". Council at 3 rounds is a cap, not a bar.
6. **No decision records.** `mattpocock-skills:domain-modeling` is installed (it writes GLOSSARY.md and ADRs) but no
   mirako repo has `docs/adr/` or `GLOSSARY.md`. Decisions sit in `PRODUCT.md`, `docs/v1-brief.md` and commit messages,
   which agents won't consult before touching an area.
7. **Learning doesn't flow back.** Nothing asks an agent to propose a one-line AGENTS.md addition when it found a
   non-obvious setup fact. shepherdr's AGENTS.md is mostly accumulated `From SHEP-…` lines; that is where its
   reproduction recipes came from.
8. **Instruction sprawl and drift.** Five `issues-*` AGENTS.md files are identical 215-line copies; of the three
   212-line `kodr*` files, one has already drifted from the other two.
   `~/AGENTS.md` is a stale copy of `~/.claude/CLAUDE.md`: its skills path reads `.Codex/skills` (a find-replace
   accident) and its Permissions line contradicts the CLAUDE.md one on `git push`. Anthropic's guidance is under
   200 lines and "only what Claude can't find".

## Recommended changes (ranked by value / effort)

1. **One gate per repo, enforced by a Stop hook.** Add `bun run check` (tsc + `crew.check.ts` + any `*.check.ts`)
   that prints `all checks passed`. Put it in project `.claude/settings.json` as
   `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"bun run check 1>&2 || exit 2"}]}]}}`.
   AGENTS.md's Checks section shrinks to that command. Effort: 15 min per repo. Value: highest; removes "forgot to run it".
2. **CI that runs the same gate.** `.github/workflows/check.yml` with `bun install && bun run check`. Catches Codex
   sessions and PRs the hook doesn't see. Effort: 10 min.
3. **Repo-rules check file (`src/repo.check.ts`).** Turn every "Hit every surface" bullet that can be grepped into an
   assertion: each verb in `src/wire.ts` appears in `sdk/local.ts`, `src/cli.ts` usage, `docs/yap.md` and
   `skills/yap/SKILL.md`; plugin version bumped when `hooks/` changed; no personal paths. Grow it each time a
   review finds a missed surface. Effort: 1–2 h. Value: converts your best rule from prose to proof.
4. **A `stage` skill per repo with a live app.** Package the throwaway daemon (yap) or isolated app (Herdr mods,
   uriel preview) as `.agents/skills/stage/SKILL.md` with `up / do / shot / down`, own folder per task, "before
   shot before first edit", "report what you couldn't drive as unverified". Symlink `.claude/skills` →
   `.agents/skills` so Codex shares it. Effort: 1 h. Value: makes "seen once against a real daemon" cheap and
   repeatable.
5. **Review loop contract in global CLAUDE.md.** Five lines: review by a fresh agent that didn't write the change
   (`/code-review` or council), findings graded blocker/major/minor with proof, fix blocker+major, re-review, stop
   at a clean round or 3 rounds, unfixed findings listed with why, "skip style" in every review prompt. Effort: 10 min.
6. **Proof block in done reports.** Add to global CLAUDE.md: a finished change ends with Proof (command output or
   before/after screenshot, each one line) and Not proven (what you couldn't verify). Fits inside your 120-word cap
   and makes "never claim it works" checkable. Effort: 5 min.
7. **ADRs + glossary via domain-modeling, starting with yap.** Run `mattpocock-skills:domain-modeling` to lift the
   decisions from `docs/v1-brief.md` and `PRODUCT.md` into `docs/adr/000N-*.md` (1–3 sentences each) and move
   "Words" into `GLOSSARY.md` with `_Avoid_:` lines. Add herdr-t3's rule: read the ADRs that touch an area; say which
   one you contradict. Effort: 1 h. Value: stops agents re-litigating settled calls.
8. **Lessons back + dedupe the instruction files.** Add one rule: "a setup or testing fact the next agent would need
   goes in AGENTS.md as one line, in the section it belongs to; rewrite, don't append". Then fix `~/AGENTS.md` (or make
   it `@.claude/CLAUDE.md`), and collapse the five `issues-*` and three `kodr*` copies to one source each.
   Effort: 30 min. Value: cumulative.

Skipped: shepherdr's parity tables (only worth it with two UIs that must match), anthropics/skills `webapp-testing`
(frontend-craft covers it), superpowers' full plan/subagent pipeline (overlaps council + mattpocock, and the skill
routing table says one skill per job).
