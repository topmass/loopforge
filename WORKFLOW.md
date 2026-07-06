---
version: 1
tracker:
  kind: loopforge-local
agent:
  max_concurrent_agents: 3
	  max_turns: 3
  max_retries: 1
  retry_backoff_ms: 1000
codex:
  model: gpt-5.5
  reasoning_effort: high
  fast_mode: true
github:
  pr_review: false
authority:
  publish: true
  max_triage_retries: 2
workspace:
  worktrees_dir: .loopforge/worktrees
  hooks:
    after_create: []
    before_run: []
    after_run: []
    before_remove: []
---
# LoopForge Workflow

LoopForge is a local Codex orchestration layer backed by this repository's Kanban board.
Use this file as the repo-owned contract for how agents should plan, implement, test, review,
and merge work.

## Board Contract
- Inbox is for raw or paused work that needs user input.
- Ready is dispatchable work.
- Started is work currently owned by a Codex worker.
- Review means implementation and validation evidence exist.
- Inbox also holds work that needs user direction or a resolved blocker.
- Done means the reviewer approved the work and LoopForge merged it.

## Loop Contract
Every task moves through a durable loop:
Queued -> Planning -> Working -> Testing -> Repairing -> Reviewing -> Remembering -> Done.
Blocked means LoopForge has a concrete blocker or user decision to show on the board.
Each phase should preserve the current gate, next action, verification summary, and any needed input.

## Workpad Contract
Every worker handoff should preserve:
- The task objective and any narrowed assumptions.
- Files or surfaces inspected.
- Files changed.
- Validation commands and observed results.
- Blockers, confusions, or follow-up tasks.

	## Agent Contract
	- Work in the assigned worktree only.
	- Keep edits scoped to the task acceptance criteria.
	- Follow the task verification plan and any discovered verification gates.
	- Use subagents only for independent investigation, verification, or implementation slices.
- Do not mutate .loopforge runtime state directly.
- Do not create commits; LoopForge records commits, reviews, and merges.
- If blocked, state the blocker and the exact user decision or repo change needed.

## Authority Contract
- Repo-level operations such as committing the root working tree and pushing to the remote are
  LoopForge harness actions, never agent actions. The authority frontmatter controls them:
  publish allows the harness publish action, max_triage_retries bounds triage-driven retries.
- When a worker blocks with a concrete question, the LoopForge main agent triages it first:
  resolve it with an allowed harness action, retry the worker once with corrected instructions,
  or escalate to the user with one clear ask.
- Hard external blockers (missing credentials, third-party accounts, user-only decisions) always
  escalate immediately. The same blocker appearing twice always escalates.

