# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Bun (no dependencies): a `Bun.serve` daemon on `bun:sqlite`, and a terminal board (`src/tui.ts`) as its client. No build step.
Delegated: the owner's standing rule is stdlib and native platform features before dependencies.

## Users

A solo developer with several repositories that no longer need their attention. They want work to keep moving
on those repos without supervising agents step by step. They check in occasionally, often once in the morning,
and otherwise only want to hear about decisions that are genuinely theirs.

Personal tool first, on the owner's Windows machine. It should stay releasable: no hardcoded paths, a first run
someone else could follow.

## Product Purpose

yap lets coding agents on one machine see each other, message each other and stay out of each other's way. The
protocol is YAP (`docs/yap.md`); it is meant to grow into mirako.computer's layer for agents talking, local and
from the web.

On top of it, a crew turns a goal into merged commits without a human in the loop. A planner breaks the goal into tickets with
acceptance criteria. An agent takes each ticket on its own branch in its own git worktree. A second agent, in a
fresh context that never saw the author's reasoning, checks the diff against every criterion. Approved work is
squashed onto the base branch in a scratch worktree, the project's gate command runs on that merged result, and
only then does the base branch move.

Success: the owner types a goal, leaves, and comes back to a merge log they trust, plus a short list of tickets
that needed them.

## Positioning

The agent that wrote a change never decides whether it merges. Every merge carries its receipt in the commit
message: ticket, rounds, reviewer, and each criterion. Modelled on niwa.build, which is closed and has no
Windows build.

## Operating Context

- Runs on localhost. Code, board and journal stay on the machine; prompts go to the owner's existing Claude account.
- Agents are headless Claude Code processes (`claude -p`), one process per run.
- Several projects at once; each is a git repo with a base branch, an optional gate command and a worker count.
- The owner is rarely watching. The usual visit is short: read what merged, clear what escalated, add a goal.

## Capabilities and Constraints

- Ticket states: draft, todo, working, review, gate, merged, escalated, dropped.
- A planned goal produces draft tickets. One click starts them; nothing runs before that.
- A ticket gets four review rounds, then escalates. Agent crashes and a base branch that cannot fast-forward
  also escalate.
- Human actions on an escalated ticket: retry with a note, approve past the reviewer (goes to the gate), drop.
- Tickets can depend on other tickets and wait for them to merge.
- Reviewer is Claude in a fresh context. A different-vendor reviewer is not built.
- No sandbox: agents run under Claude Code's auto permission mode on the owner's machine, with an allowlisted
  environment.
- Terminology: goal, ticket, criterion, round, verdict, gate, receipt, journal, escalation.

## Open

Known gaps, roughly in the order they bite. Fix from the top.

- No sandbox: crew agents can read any file the owner can (`~/.ssh`, the gh token, `~/.yap/token`).
  Claude Code sandboxes only on macOS, Linux and WSL2. Their environment is trimmed to an allowlist; files are
  not. With the token an agent can drive the API, but skipping a check needs a yes on the desktop, unless
  YAP_YOLO. An agent set on it could still restart the daemon with YAP_YOLO=1 or kill it.
- An API key or OAuth token in the daemon's environment reaches agents' shell commands. Claude Code's
  CLAUDE_CODE_SUBPROCESS_ENV_SCRUB would strip it, but in 2.1.310 it makes `-p` auto mode deny every write
  (undocumented). Subscription sign-in is a file, so nothing changes there. Retry the scrub on a newer Claude Code.
- Outside Herdr, an idle session hears a message only on its next prompt. The PreToolUse hook skips Read and
  Grep (about 67 ms a call), so a session that only reads hears nothing until it edits or runs a command.
- `yap show` is about 110 lines a ticket. `yap status` lists every project and prints the board's key hint.
- One-shot commands (`yap gate`, `status` in a repo) register the current repo as a project as a side effect.
- `seen` can't be reset from the CLI. Deliberate for now: agents run `yap status`.
- The `issues` project has no gate.

## Brand Commitments

Name: yap, for the protocol and the tool. YAP in prose about the protocol, `yap` for the command. The crew
and its board may split off later as kumi (組, a crew), a client of the protocol.

## Evidence on Hand

No real usage data yet. Any numbers, repos or tickets shown in mock-ups are synthetic and must be labelled so.

## Product Principles

1. Exception-driven. The interface speaks up only when a decision belongs to the human.
2. The receipt is the product. Every verdict is traceable to named criteria and readable later.
3. One click, not zero. Plans wait for a start; everything after it runs alone.
4. Nothing is hidden, nothing is streamed. The record is available in full; the firehose is not the default view.
