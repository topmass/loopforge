# Project Specsheet

LoopForge durable project memory and implementation map.

Last checked: 2026-06-15.

## Current Status

- Product name is LoopForge. GoalForge is the former name.
- Local repo path is still `/home/topmass/Code/goalforge`.
- Git remote is `https://github.com/topmass/loopforge.git`.
- `./loopforge` is the primary launcher. `./goalforge` remains a compatibility alias.
- Git HEAD and `origin/main` are synced at `ca60ccb`; the current working tree may contain
  in-progress specsheet edits.
- `deno task test` passed on 2026-06-15 with 189 tests.
- `pnpm run smoke:opentui` currently fails in older mouse-coordinate phases, while the scroll,
  review, and dogfood phases pass. Treat the OpenTUI smoke harness as needing maintenance after
  recent layout changes.
- Current board health reports Needs Attention because old open smoke/publish goals remain with no
  tasks or evidence gaps. Code health and Git sync are separate from this board hygiene issue.

## Codex Native Alignment

Codex has three relevant product behaviors and integration surfaces:

- Goal mode (`/goal`) attaches a persistent objective to the active Codex thread. The goal text is
  both the starting prompt and the completion criteria. Codex keeps working toward it until the task
  is done, paused, cleared, or genuinely needs more input. Codex app shows active goal progress
  above the composer, and CLI supports `/goal`, `/goal pause`, `/goal resume`, and `/goal clear`.
- Codex subagents are explicit parallel child-agent workflows. Codex only spawns them when the user
  asks for subagents or parallel agent work. Codex handles spawning, routing follow-up instructions,
  waiting for results, closing child agent threads, and returning a consolidated summary.
- Codex-managed worktrees isolate independent app/cloud tasks from the user's current checkout.

Codex also has three relevant integration surfaces:

- Codex app-server is the rich-client protocol used by Codex clients. It exposes threads, turns,
  items, approvals, and streamed agent events over JSON-RPC style transports.
- The Codex SDK is the programmatic wrapper for automation and product integrations. The Python SDK
  drives a local Codex app-server process and ships with a pinned Codex CLI runtime dependency.
- Codex CLI has non-interactive `codex exec` and JSON event output for simpler automation where full
  rich-client control is not needed.

LoopForge currently integrates through `src/workers/codex_app_server.ts`, which starts
`scripts/loopforge_codex_bridge.py` via:

```bash
uv run --prerelease=allow --with openai-codex python scripts/loopforge_codex_bridge.py
```

That Python bridge imports `openai_codex`, starts `Codex()`, and exposes a small LoopForge-owned
JSONL protocol with ops such as `thread_start`, `thread_resume`, `thread_fork`, `turn_run`,
`turn_steer`, `turn_interrupt`, `thread_read`, `thread_list`, and `thread_compact`. This JSON is not
the public Codex app-server wire schema; it is an internal adapter that lets the Deno code use the
Python SDK without reimplementing the full app-server client.

LoopForge is close to Codex-native goal orchestration in these areas:

- It has a persistent project main thread seeded by `LoopForgeWorker.ensureMainThread()`.
- Task workers fork from the main thread when `forkSession` is available.
- It stores parent thread id, child thread id, active turn id, activity, validation, handoff, and
  evidence in the board.
- `LoopForgeWorker.runQueue()` already dispatches independent board tasks in parallel up to
  `WORKFLOW.md`'s `agent.max_concurrent_agents`.
- `GoalLoopRunner` provides one persistent owner for a whole goal with a dedicated worktree,
  `LOOP_PLAN.md`, queued user input, probe feedback, stall detection, merge gating, and closure
  evidence.

LoopForge is not yet the same as Codex's native subagent workflow:

- Goal Loop uses one persistent agent and explicitly tells task workers not to spawn delegated
  agents.
- The relay path runs parallel LoopForge task workers, but those workers are board tasks, not
  visible Codex subagent threads managed under one parent turn.
- The TUI can show LoopForge workers, external hook reports, and task/goal activity, but it does not
  yet render Codex-native child agent threads as children of a specific goal.
- Current external hook ingestion ignores `SubagentStart` and `SubagentStop`, so native Codex
  subagent lifecycle is not yet visible as goal-child activity.
- The activity feed intentionally filters raw agent deltas, so it gives an overview rather than a
  full Codex thread/event tree.

Future subagent alignment should preserve LoopForge as the visible goal tracker while letting Codex
do native delegation where it is strongest. A practical design is: one LoopForge goal owns the
parent Codex thread and worktree, LoopForge passes explicit "spawn agents in parallel" instructions
only for independent investigation or implementation slices, the bridge records subagent/thread
lifecycle events when the SDK exposes them, and the board maps those child agents into Active Agents
and Agent Flow without forcing every child into a separate task card. Keep board tasks for durable
planning, evidence, review, merge, and retries.

## Product Summary

LoopForge is a local-first coding-agent orchestration tool. It keeps a SQLite Kanban board under the
target project, plans rough goals, runs agents in isolated git worktrees, supervises live activity,
verifies evidence, reviews, merges, and closes goals only when completion proof exists.

The primary user experience is a terminal command center:

- `loopforge` with no command opens the TUI.
- `loopforge tui` starts the OpenTUI command center through Bun when available.
- `loopforge tui --native` uses the Deno-native fallback renderer.
- `loopforge -C <path> ...` runs any command against another project directory.

LoopForge can also run as a server/API:

- `loopforge serve --port 4733`
- `/api/events` streams board/activity updates over SSE.
- `/api/board`, `/api/runtime`, `/api/goals`, `/api/tasks`, `/api/agents/report`, and
  loop/scout/config endpoints are served from `src/web/server.ts`.

## Runtime and Storage

Project runtime state lives under `.loopforge/`:

- `.loopforge/board.sqlite` is the board database.
- `.loopforge/worktrees/` holds task and goal worktrees.
- `.loopforge/tasks/<TASK-ID>/` holds generated task context artifacts.
- `.loopforge/prompts/` and `.loopforge/context/` hold project prompt/context state.

Legacy `.goalforge/` project folders and `~/.goalforge` config are still honored through
`src/paths.ts` and `src/board/global_config.ts`.

Machine-level config lives in `~/.loopforge/config.json` unless `LOOPFORGE_HOME` or legacy
`GOALFORGE_HOME` overrides it. It stores:

- worker backend: codex, pi, claude, or local
- local OpenAI-compatible endpoint/model
- rescue backend/settings
- planner backend/settings
- scout backend/settings
- optional search endpoint

## Core Domain Model

Main types are in `src/board/types.ts`.

Goals:

- `Goal` has id, text, completion contract, open/closed state, closure summary, and optional loop
  thread/worktree state.
- Goal probes are executable win conditions stored as `GoalProbe`.
- Goals can close only when required task evidence or loop probe evidence is present.

Tasks:

- Statuses are `inbox`, `ready`, `in_progress`, `review`, `merging`, `blocked`, and `done`.
- Loop phases are `queued`, `planning`, `working`, `testing`, `repairing`, `reviewing`,
  `remembering`, `done`, and `blocked`.
- Task kinds are `code`, `ops`, and `loop`.
- Ops actions currently support `publish`.
- Dependencies block dispatch only when a real upstream task is required.
- Blocked tasks carry `needsInputPrompt`, `blockedReason`, `blockedFingerprint`, and triage attempt
  state.

Events and live state:

- `ActivityEvent` stores durable raw and readable activity.
- `AgentStatus` stores normalized live worker phase/headline/detail/risk.
- `ExternalAgentStatus` records external Claude/Codex hook reports.
- `QueuedMessage` stores user guidance that gets injected into a running or resumed worker/loop.

## Main Code Map

CLI and launch:

- `src/cli.ts` is the command dispatcher.
- `loopforge` is the shell launcher.
- `goalforge` is the compatibility wrapper.
- `deno.json` defines `loopforge`, `check`, `fmt`, `lint`, and `test` tasks.
- `package.json` defines OpenTUI smoke/dogfood scripts using `pnpm`.

Board and status:

- `src/board/store.ts` owns SQLite schema, migrations, state transitions, runs, goals, probes,
  lessons, ideas, external agents, queued messages, and activity events.
- `src/board/goal_progress.ts` computes goal progress, closure readiness, evidence gaps, and
  verdicts.
- `src/board/status_lines.ts` formats `status`, `health`, `goals`, standup/manual verification
  summaries.
- `src/board/validation_evidence.ts` parses machine-readable validation evidence.
- `src/board/prompts.ts` contains shared autonomy contracts and prompt policy text.

Workflow config:

- `src/workflow/workflow.ts` reads and edits `WORKFLOW.md` frontmatter.
- `WORKFLOW.md` controls max agents, retry policy, backend defaults, worktree dir, hooks, GitHub PR
  review, and authority for publish/triage.

Server and TUI:

- `src/web/server.ts` is the local API/SSE server.
- `src/tui/opentui_client.ts` is the Bun/OpenTUI command center.
- `src/tui/command_center.ts` is the Deno-native fallback TUI.
- `src/tui/activity.ts` formats visible activity and filters raw agent noise.
- `src/tui/task_recommendation.ts` formats the selected task's next action.
- `src/tui/choreography.ts` diffs board state into visual flow events.
- `src/tui/flow_field.ts` renders the Agent Flow particle band.
- `src/tui/input.ts` normalizes prompt input and control keys.

Workers and agents:

- `src/workers/loopforge_worker.ts` is the classic task relay worker.
- `src/workers/goal_loop.ts` is the loop-native runner where one persistent agent owns a whole goal.
- `src/workers/goal_planner.ts` compiles rough goals into tasks, probes, contracts, and ops tasks.
- `src/workers/goal_scheduler.ts` schedules ready tasks.
- `src/workers/goal_reviewer.ts` reviews completed task work.
- `src/workers/goal_test_engineer.ts` runs/verifies the independent test-engineer pass.
- `src/workers/goal_pursuer.ts` runs long unattended pursue loops.
- `src/workers/goal_scout.ts` proposes gated ideas.
- `src/workers/goal_probes.ts` runs goal win-condition probes.
- `src/workers/blocker_triage.ts` lets the main agent triage blockers before asking the user.
- `src/workers/rescue.ts` asks a stronger model for diagnosis guidance after repeated failures.
- `src/workers/dependency_review.ts` revalidates stale dependency chains.
- `src/workers/live_supervisor.ts` normalizes live agent events and sends one conservative steer on
  clear failures/conflicts.
- `src/workers/git_utils.ts` handles worktree prep, nested repo commits, merges, and root publish.
- `src/workers/agent_backend.ts`, `pi_rpc_client.ts`, and `codex_app_server.ts` abstract
  Codex/pi/Claude/local backends.
- `src/workers/agent_hooks.ts` installs external agent hooks.
- `src/workers/project_context.ts`, `project_memory.ts`, and `task_memory.ts` build prompt context
  and durable task artifacts.

## Execution Modes

### Classic Task Relay

The relay path plans a goal into one or more tasks, creates one git worktree per task, runs a worker
turn, runs an independent test-engineer turn, reviews, merges, records validation, and closes the
goal when proof is complete.

Use it with:

- `loopforge goal "<text>"` to plan only
- `loopforge build "<text>"` to plan and run
- `loopforge run TASK-ID`
- `loopforge run --all`

Task worktrees use branches like `loopforge/task-1` under `.loopforge/worktrees/TASK-1`.

### Goal Loop

The loop path is the preferred newer architecture for whole-goal ownership.

Use it with:

- `loopforge loop "<goal text>"`
- `loopforge loop GOAL-ID`
- `loopforge loop GOAL-ID --hours N`

`GoalLoopRunner` creates one goal worktree and one persistent agent session. The agent maintains
`LOOP_PLAN.md` as a markdown checklist committed to the worktree. LoopForge mirrors the checklist to
board tasks of kind `loop`, injects queued messages and probe feedback, detects stalls, runs probes,
and merges/closes only when win conditions pass.

Attended mode holds merge when manual verification notes exist. Unattended mode is used for timed
runs and can merge with honest manual-verification notes recorded.

### Pursue

`loopforge pursue` keeps working goals over a time budget:

- runs ready work
- probes goals
- replans from failures
- rotates repair strategy
- records lessons
- escalates or stops when the same failure repeats
- can use a rescue/escalation backend

Timed pursue runs tag a baseline (`loopforge/run-<stamp>`) before starting.

### Ops Publish

Publish goals are modeled as `ops` tasks with `opsAction: publish`. They do not use Codex and do not
create a task worktree.

`gitPublishRoot` commits the root tree if needed, fetches the remote, refuses to push if the remote
is ahead, pushes, verifies ahead/behind counts, and writes parser-compatible validation evidence.

Publishing is controlled by `authority.publish` in `WORKFLOW.md`.

## TUI Behavior

OpenTUI command center:

- Task rail groups active/ready, needs input, done, and ideas.
- Task Details shows recommendation, validation, activity, worktree/thread info, handoff, and
  evidence.
- Active Agents shows current worker/external-agent status.
- Project Memory shows project health, active goal, closed goals, contracts, probes, and manual
  verification items.
- Activity is an overview, not a raw transcript. Raw `codex` and `main-thread` agent text deltas are
  filtered from display.
- Agent Flow is a particle band driven by board diffs and external-agent reports; `p` toggles it.
- Footer has create/run actions, board operations, and config toggles for Rescue, Planner, Scout,
  and agent count.

Scrollable panels use native OpenTUI `onMouseScroll` handlers and retain per-panel offsets across
refreshes. PageUp/PageDown are decoded as fallback scroll keys.

## External Agent Hooks

External coding agents can report into the board:

- `loopforge hooks print`
- `loopforge hooks install claude`
- `loopforge hooks install codex`

Hooks call `scripts/hooks/loopforge_agent_hook.py`, which posts to `/api/agents/report`. Reports
outside the active project root are ignored. External agents appear in Active Agents, Activity, and
Agent Flow.

## Autonomy and Blockers

LoopForge should avoid asking the user for anything it can decide or verify itself.

Hard Needs Input is reserved for:

- missing credentials or third-party accounts
- destructive actions needing explicit user approval
- product decisions only the user can make
- true external blockers

Manual verification is not a blocker by itself. In unattended mode, work can merge with a recorded
"needs manual verification" note. In attended mode, reviewed work can hold in Review until the user
verifies and restarts the task to merge.

Blockers go through main-agent triage before reaching the user. Triage can:

- resolve via an allowed harness action
- retry with corrected instructions
- escalate with one clear decision brief

Repeated blocker fingerprints and `authority.max_triage_retries` prevent loops.

## Model Routing

Default worker backend is Codex through the Python SDK bridge over local Codex app-server.

Backends:

- `--codex`
- `--pi`
- `--claude`
- `--local --endpoint URL --agent-model MODEL`

Planner routing:

- `--planner codex|claude|local|pi|off`
- Used for goal planning and pursue replans while workers stay on the main backend.

Rescue routing:

- `--rescue codex|claude|local|pi|off`
- `--rescue-after N`
- Rescue diagnoses stuck work and gives guidance. It does not directly implement.

Scout routing:

- `--scout codex|claude|local|pi|off`
- `--search <url|off>`
- Scout proposes ideas only. Nothing runs until the user approves an idea.

## Validation Commands

Primary validation:

```bash
/home/topmass/.deno/bin/deno task test
```

Other useful checks:

```bash
/home/topmass/.deno/bin/deno task check
/home/topmass/.deno/bin/deno fmt --check
pnpm run smoke:opentui
pnpm run dogfood:opentui
./loopforge dogfood --live
./loopforge doctor
./loopforge health
```

Current caveat: `pnpm run smoke:opentui` is not green as of 2026-06-14 because old mouse-coordinate
expectations do not match the current TUI layout. Do not treat the OpenTUI smoke as passing until
those harness phases are repaired. The scroll, review, and dogfood smoke phases did pass during the
latest check.

## Current Board Hygiene

The local LoopForge board in this repo contains old open smoke goals with no tasks plus `GOAL-7`
with evidence gaps. This makes `loopforge health` report Needs Attention even though Git is clean
and tests pass.

Current meaningful closed goal:

- `GOAL-8`: commit and push current state to GitHub. The repo was published and synced to origin.

Recommended cleanup:

- Close or delete old 0-task smoke goals if they are no longer useful.
- Repair or clear `GOAL-7` so health stops pointing at stale publish evidence gaps.
- Repair the OpenTUI smoke harness after TUI layout changes.

## Rules for Future Changes

- Keep repo-local durable behavior in this file when a feature is confirmed working.
- Keep broad historical notes in the vault, but this specsheet should explain how LoopForge works
  now.
- Update shared formatters/helpers instead of one-off TUI copies:
  - activity: `src/tui/activity.ts`
  - task recommendation: `src/tui/task_recommendation.ts`
  - status/health: `src/board/status_lines.ts`
  - goal progress/evidence: `src/board/goal_progress.ts`
- When task statuses or board types change, check OpenTUI manually because
  `src/tui/opentui_client.ts` is exercised mainly through smoke tests rather than `deno check`.
- Do not mutate `.loopforge/board.sqlite` directly in normal work. Use `BoardStore`, CLI commands,
  or server APIs.
- Do not create extra markdown docs unless explicitly requested. Keep this specsheet as the
  repo-local source of truth.
