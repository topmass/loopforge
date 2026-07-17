# Project Specsheet

LoopForge durable project memory and implementation map.

Last checked: 2026-07-06.

## Current Status

- Product name is LoopForge. GoalForge is the former name.
- Local repo path is still `/home/topmass/Code/goalforge`.
- Git remote is `https://github.com/topmass/loopforge.git`.
- `./loopforge` is the primary launcher. `./goalforge` remains a compatibility alias.
- Git HEAD and `origin/main` are synced (thread-first migration steps 1-10 landed 2026-07-06).
- `deno task test` passed on 2026-07-06 with 292 tests.
- The React GUI under `app/` is the only interface, served at `/app/` by the server. Bare
  `loopforge` serves it and opens the browser. The legacy server-rendered `static/` GUI and the
  entire terminal command center (`src/tui/`, OpenTUI, Bun dependency, smoke harness) were
  deleted; `/` now 302-redirects to `/app/` and unknown paths 404.
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
- The GUI can show LoopForge workers, external hook reports, and task/goal activity, but it does
  not yet render Codex-native child agent threads as children of a specific goal.
- Current external hook ingestion ignores `SubagentStart` and `SubagentStop`, so native Codex
  subagent lifecycle is not yet visible as goal-child activity.
- The activity feed intentionally filters raw agent deltas, so it gives an overview rather than a
  full Codex thread/event tree.

Future subagent alignment should preserve LoopForge as the visible goal tracker while letting Codex
do native delegation where it is strongest. A practical design is: one LoopForge goal owns the
parent Codex thread and worktree, LoopForge passes explicit "spawn agents in parallel" instructions
only for independent investigation or implementation slices, the bridge records subagent/thread
lifecycle events when the SDK exposes them, and the board maps those child agents into the GUI's
sub-agent nodes without forcing every child into a separate task card. Keep board tasks for durable
planning, evidence, review, merge, and retries.

## Product Summary

LoopForge is a local-first coding-agent orchestration tool. It keeps a SQLite Kanban board under the
target project, plans rough goals, runs agents in isolated git worktrees, supervises live activity,
verifies evidence, reviews, merges, and closes goals only when completion proof exists.

The primary user experience is the GUI:

- `loopforge` with no command serves the GUI and opens the browser (`guiCommand`: picks the next
  free port when 4733 is busy; `--no-open` suppresses the browser).
- `loopforge -C <path> ...` runs any command against another project directory.
- The terminal command center (OpenTUI/native TUI) was removed 2026-07-06; there is no `tui`,
  `opentui`, or `command-center` command anymore.

LoopForge can also run as a server/API with the React GUI:

- `loopforge serve --port 4733` starts a hub plus per-project child servers (children run in the
  same Deno process; killing it kills all of them). Binds 127.0.0.1 with localhost-only CORS.
- `/` 302-redirects to `/app/`, which serves the built React GUI from `app/dist` (gitignored;
  build with `pnpm build` inside `app/`). Files are read per request, so a rebuild shows on
  browser refresh without a server restart.
- `/api/events` streams board/activity updates over SSE.
- `/api/board`, `/api/runtime`, `/api/goals`, `/api/tasks`, `/api/agents/report`, and
  loop/scout/config endpoints are served from `src/web/server.ts`.
- `POST /api/projects` and `GET /api/fs/dirs` route user paths through `parseFolderInput`
  (`src/paths.ts`): trims quotes/whitespace, decodes `file://` links, expands `~`, accepts
  Windows drive/UNC shapes only on Windows hosts (clear 400 otherwise), requires absolute paths.
- `PATCH /api/workflow/workspace` takes `{useWorktrees: boolean}` and edits the project's
  WORKFLOW.md (`setWorkflowUseWorktrees`); the GUI settings modal drives it.
- Probe editing: `PATCH /api/probes/:id` (label/command/expectContains; editing the check resets
  the row to pending), `DELETE /api/probes/:id`, `POST /api/goals/:id/probes` (add). The GUI
  win-conditions strip toggles `ProbePanel` (list, edit, add, delete, re-run). `POST
  /api/goals/:id/check` runs probes in the goal's loop worktree when one exists (root otherwise)
  and 409s while a loop is running (the loop re-checks every turn itself).
- Probe robustness (validated on live local-27B fleet tests 2026-07-16, three independent
  failure hits): the planner prompt enforces quoting discipline (fixed-string `grep -qiF`, no
  regex escapes, no embedded `python -c`); `addProbes` drops and `updateProbe` rejects commands
  that fail `bash -n` (nested-quote garbage can never run); and the goal loop detects probes
  whose OUTPUT is a tool/syntax error (`probeLooksBroken`) - after one warning it finishes
  BLOCKED with a "repair in the win conditions panel" ask instead of burning its whole
  iteration budget re-verifying correct work. `pi_rpc_client` waiter/request promises register
  no-op rejection handlers so a turn that dies before its awaiter can never take down the whole
  server via an unobserved rejection (this crashed a live server once).
- Probe safety (found by adversarial testing 2026-07-06): probes run under `setsid` and timeouts
  kill the whole process group, or orphaned background servers (http.server probes) squat on
  ports and poison later runs; `runGoalProbes` discards results for probes edited mid-run
  (counted not-passed that run, never recorded) and drops deleted probes without crashing.
- `POST /api/goals/loop` takes `{text, hours, tokens, iterations, questionMode}` and starts a
  planned goal loop. One loop runs at a time per project (in-memory `goalLoopRunning` lock,
  released when the runner settles).
- `POST /api/goals/:id/task` steers an open goal's loop and resumes a closed goal server-side.
- `DELETE /api/goals/:id` deletes a goal; a running loop notices within one turn (see Goal Loop).

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
- `package.json` only carries the dogfood script and `@types/node`; the GUI has its own
  `app/package.json`.

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

Server:

- `src/web/server.ts` is the local API/SSE server (and serves the React GUI at `/app/`).

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

Worktrees are per-project optional (`workspace.use_worktrees` in WORKFLOW.md, default true;
GUI toggle "Isolated worktrees" via `PATCH /api/workflow/workspace`). When false the loop runs
directly in the project root: no loop branch, no auto-commits, no merge, no worktree cleanup, and
no fan-out (the plan contract flips to its serial form and a LOOP_FANOUT token gets a rejection
feedback turn). Green probes close the goal with outcome `complete` ("passed in the project
root"); attended merge-holds are skipped since there is nothing to merge - weak gates and
manual-verification notes are appended to the closure text instead. Root mode never stores the
project root as `loopWorktree` (the closure cleanup path reclaims stored worktrees).

Independent completion check: once at least one plan item is done, the shell runs the win
conditions itself after every turn where the agent did not claim completion. A genuine all-green
pass (at least one probe that was red at baseline now passes) first injects a declare-or-name-
what-remains nudge; a second consecutive green pass closes the goal via `completeGoal` without
the agent's declaration. This is the fix for models grinding on verification busywork instead of
saying done - the probes, not the worker, decide completion.

Each iteration also emits a `loop.status` lifecycle event (`{iteration, maxIterations,
tokensUsed, elapsedMs, reason}`) that feeds the GUI's live loop telemetry strip.

Loop outcomes are `complete | merged | held | blocked | budget | stalled | closed | deleted`.
Deleting a goal mid-run stops its loop cleanly: the runner checks `store.goalExists()` at the top
of each iteration and after each turn, and a 500ms watch during `runTurn` calls the backend's
optional `interruptTurn` so the in-flight turn aborts instead of running to completion.

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

## React GUI (app/)

The GUI is a Vite + React 19 app in `app/` (build with `pnpm build` inside `app/`; output in
`app/dist` is gitignored and served by `loopforge serve` at `/app/`).

Stack and layout:

- Tailwind v4 CSS-first design tokens in `app/src/index.css`. Two themes: Paper Terminal (light)
  and Night Ops (dark, the flagship default), switched via `data-theme` on `<html>` and persisted
  as `lf-theme` in localStorage.
- Three panels in `app/src/App.tsx`: `Sidebar` (projects + loops), center `CenterTabs`
  (`BoardView` Kanban / `ThreadView` transcript), right `RightPanel` (Detail / Activity / Diff).
  `ChatBar` is the global composer at the bottom.
- State is one zustand store (`app/src/store.ts`) fed by a single SSE connection to `/api/events`
  plus REST calls (`app/src/api.ts`). Board and all views project the same state.
- Status/liveness vocabulary lives in the `STATUS` map in `app/src/components/ui.ts`; live things
  get the amber `radar-dot` (keyframes in `index.css`). No left-border accent stripes on cards -
  state is signaled with STATUS dots and surface/shadow shifts.

Live loop telemetry: `loop.status` lifecycle events land in `loopStatusByGoal` (store) and
render in the scoped board's win-conditions strip as "iter N/M · Xk tok · Ym · waiting on: ..."
while the loop is active (recent `loopActiveAt`) and the goal is open (`BoardView`).

Loop-scoped board and composer targets:

- The sidebar has an "All loops" row plus one row per goal. Selecting a goal scopes the Kanban to
  that loop's own To Do / Doing / Done; "All loops" shows the unified board grouped by goal.
- `ChatBar` takes the active goal and renders explicit target chips: "New loop" vs
  "GOAL-N - add task/resume". Sends dispatch through `useChatSend().send(value, target)` with
  `SendTarget = {kind: "new", ask?} | {kind: "goal", id}`. Adding to a closed goal resumes it
  server-side; nothing is targeted silently.
- Selection stickiness (`applyBoard` in `store.ts`): a selected loop stays selected while the goal
  exists (closed goals are valid selections); auto-focus of the first open goal happens only on
  the very first board snapshot or when the selection was deleted; an explicit "All" (null)
  choice sticks.

Rules:

- zustand selectors must never return fresh arrays/objects (React error #185 infinite rerender).
  Select stable references and apply fallbacks like `?? []` outside the selector.
- Frontend ownership: app/src is authored by Claude/Opus under review, never delegated to codex.

## External Agent Hooks

External coding agents can report into the board:

- `loopforge hooks print`
- `loopforge hooks install claude`
- `loopforge hooks install codex`

Hooks call `scripts/hooks/loopforge_agent_hook.py`, which posts to `/api/agents/report`. Reports
outside the active project root are ignored. External agents appear in the GUI activity feed and
agent status.

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

## Thread-First Migration (in progress)

Direction: one main chat thread per project (chief-of-staff agent, short control-plane turns,
never blocked) becomes the default surface; Kanban demotes to an optional Operations/Evidence
view. The SQLite board model and every existing API stay as the execution substrate. The full
hardened plan (10 steps) came from the 2026-07-06 codex ideation loop; the durable capsule lives
in agent memory (`thread-first-blueprint`).

Landed so far (steps 1-3, all additive):

- `tests/contract_test.ts` freezes today's wire contracts: board snapshot keys, goal/task/probe
  field names, runtime keys, the lifecycle event shape (`role: "lifecycle"` + rawJson
  goalId/data), and the merge-hold task's restart-to-merge semantics. Breaking any of these in a
  later step fails the suite.
- Front thread identity is SEPARATE from `main_thread_id` (task workers fork from the main
  thread; user chat must not contaminate that lineage): `front_thread_id` project-state key +
  `front_messages` table (`store.getFrontThreadId/setFrontThreadId/appendFrontMessage/
  listFrontMessages`), and `store.eventRevision()` (max event id) as the ledger revision stamp.
- Ledger-backed front reads: `GET /api/front/status` (deterministic digest: goals with probe
  counts/lights, loop state, blockers, receipts, activeWorkers, revision),
  `GET /api/front/messages[?after=id]`, `POST /api/front/messages` (persists the user message;
  NO model turn - the conversational front runner is a later step).

- Step 4, the repository coordinator (`src/workers/repo_coordinator.ts`): `withRepoLock(store,
  root, label, fn)` - ONE advisory lock key per project root (`repo:<root>`) guarding every
  shared-git mutation, heartbeated every 5s while held (a live holder can never be stolen; a
  crashed holder goes stale in 20s). Routed through it: `gitMergeBranchLeased` (now delegates to
  the coordinator - goal loop + relay worker), both CLI manual-merge paths, both server
  manual-merge routes, goal/task/fan-out worktree creation and reclamation, and root publish.
  Fan-out's merge INTO its own loop worktree stays unleased (private to that loop). Rule: any
  new code that merges to root, runs `git worktree add/prune/remove`, or publishes MUST go
  through `withRepoLock` - never call those git operations bare.

- Step 5: per-goal loop admission (`activeLoops` registry in server.ts) - same goal never
  double-runs, total bounded by `agent.max_concurrent_agents`; probe execution serializes on a
  `probes:<root>` lease (`withLease`); manual checks 409 only for the checked goal's own loop.
- Step 6: `POST /api/goals/:id/approve-merge` maps to the held task's restart-to-merge path; the
  GUI shows an Approve banner on a scoped loop with a hold; holds surface in /api/front/status.
- Step 7: `FrontRunner` (src/workers/front_runner.ts) - one control-plane turn at a time on the
  front thread, every turn grounded in a fresh ledger digest, closed action grammar
  (answer / DELEGATE_GOAL {text} / STEER_GOAL GOAL-N). POST /api/front/messages triggers turns;
  replies + loop outcome receipts stream over the `front` SSE event.
- Step 8: thread-first GUI - Main agent pinned in the sidebar, `FrontThreadView` is the default
  center (receipt chips link to their loop), composer defaults to the Main agent target,
  Board/Thread tabs appear only for a selected loop / All loops.
- Step 9: idle compaction - after a turn, past 12 messages / 24k chars of uncompacted tail the
  runner regenerates `.loopforge/context/current-state.md` (deterministic resume capsule, a
  rebuildable cache, never truth), advances `front_last_compact_id`, then calls the backend's
  optional `compactThread`.
- Step 10: armed schedules (`schedules` table + src/workers/schedules.ts + a 60s server ticker):
  probe-recheck (skips goals with running loops; reports probe REGRESSIONS to the front
  transcript) and scout passes only. last_run_at stamps BEFORE the action (no double-fire), and
  schedules can never start implementation or approve holds. CRUD at /api/schedules; managed
  from the settings modal.

Deferred from the blueprint: the local GPU governor (Quiet/Balanced/Overnight profiles) waits
until local-model testing is allowed again; machine-level cross-project admission waits until
the CLI can join the server's broker.

## Model Routing

Default worker backend is Codex through the Python SDK bridge over local Codex app-server.

Backends:

- `--codex`
- `--claude`
- `--local --endpoint URL --agent-model MODEL` (the local backend IS the pi coding agent; `--pi`
  survives as a legacy alias and configs migrate `pi` to `local` in `readGlobalConfig`)

Local backend, validated end-to-end 2026-07-02 against a remote llama.cpp server (`qwen3-6-27b`,
2 slots, RTX 5090):

- `ensureLocalPiProvider` (`src/board/global_config.ts`) writes a `loopforge-local` provider into
  `~/.pi/agent/models.json` from `local.endpoint`/`local.model`; `PiRpcClient` drives the pi
  binary with `--provider loopforge-local`.
- Parallel fan-out is proven: one goal spawned two sub-agents in the same second, each on its own
  llama.cpp slot, merged 65s later. Slot count comes from the model server (`-np N`), concurrency
  from `maxParallelAgents`.
- Known trap: MTP fork builds collapse at 2+ concurrent slots (`single-token chunking` fallback
  makes prefill so slow pi times out and turns come back empty). Serve plain non-MTP GGUFs for
  multi-agent work.
- Known trap: small local models write subtly broken shell quoting into planner probes. Failing
  probes are repairable in `goal_probes` while the loop runs; a probe-edit GUI affordance is the
  planned fix.

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
./loopforge dogfood
./loopforge doctor
./loopforge health
```

## Current Board Hygiene

The local LoopForge board in this repo contains old open smoke goals with no tasks plus `GOAL-7`
with evidence gaps. This makes `loopforge health` report Needs Attention even though Git is clean
and tests pass.

Current meaningful closed goal:

- `GOAL-8`: commit and push current state to GitHub. The repo was published and synced to origin.

Recommended cleanup:

- Close or delete old 0-task smoke goals if they are no longer useful.
- Repair or clear `GOAL-7` so health stops pointing at stale publish evidence gaps.

## Rules for Future Changes

- Keep repo-local durable behavior in this file when a feature is confirmed working.
- Keep broad historical notes in the vault, but this specsheet should explain how LoopForge works
  now.
- Update shared formatters/helpers instead of one-off copies:
  - status/health: `src/board/status_lines.ts`
  - goal progress/evidence: `src/board/goal_progress.ts`
- Do not mutate `.loopforge/board.sqlite` directly in normal work. Use `BoardStore`, CLI commands,
  or server APIs.
- Never filter streamed agent text deltas with `trim()` in bridge emit paths - whitespace-only
  deltas are real content (codex splits the space before numbers into its own delta). Filter on
  `length` only. See `CodexAppServerClient.emit()` and its regression test.
- Any store read polled from a worker timer must tolerate deleted rows: an uncaught throw inside
  `setTimeout` kills the whole server process. Precedent: `isRunStopRequested()` reports a
  missing run as stop-requested.
- Do not create extra markdown docs unless explicitly requested. Keep this specsheet as the
  repo-local source of truth.
