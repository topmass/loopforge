import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import {
  configPath,
  contextPath,
  databasePath,
  normalizeRoot,
  promptsPath,
  runsPath,
  runtimeDirName,
  runtimePath,
  taskArtifactsPath,
  worktreesPath,
} from "../paths.ts";
import { PROMPTS } from "./prompts.ts";
import {
  LIFECYCLE_ROLE,
  LifecycleEvent,
  lifecycleToActivity,
  parseLifecycleEvent,
} from "./lifecycle.ts";
import { ensureAgentContext, ensureWorkflow } from "../workflow/workflow.ts";
import { summarizeGoalProgress } from "./goal_progress.ts";
import {
  ActivityEvent,
  ActivityEventInput,
  AgentPhase,
  AgentRisk,
  AgentStatus,
  BoardSnapshot,
  EXTERNAL_AGENT_STATES,
  ExternalAgentState,
  ExternalAgentStatus,
  Goal,
  GoalProbe,
  GoalProbeDraft,
  Idea,
  IdeaDraft,
  IdeaStatus,
  Lesson,
  OPS_ACTIONS,
  OpsAction,
  ProjectState,
  QueuedMessage,
  Run,
  Task,
  TASK_STATUS_LABELS,
  TASK_STATUSES,
  TaskDraft,
  TaskLoopPhase,
  TaskRiskLevel,
  TaskStatus,
  TransitionResult,
} from "./types.ts";

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface LoopForgeConfig {
  name: string;
  port: number;
  workerMode: "codex";
  maxConcurrentAgents: number;
  codexTransport: "sdk";
  boardStates: readonly TaskStatus[];
  model: string;
  reasoningEffort: ReasoningEffort;
  fastMode: boolean;
  githubPrReview: boolean;
}

const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  inbox: ["ready", "blocked"],
  ready: ["in_progress", "blocked", "inbox"],
  in_progress: ["review", "blocked", "ready"],
  review: ["merging", "done", "in_progress", "blocked"],
  merging: ["done", "blocked", "review"],
  blocked: ["ready", "in_progress"],
  done: ["review"],
};

type SqlRow = Record<string, unknown>;

export class BoardStore {
  readonly root: string;
  readonly db: DatabaseSync;

  constructor(root = Deno.cwd()) {
    this.root = normalizeRoot(root);
    ensureRuntimeDirectories(this.root);
    this.db = new DatabaseSync(databasePath(this.root));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.ensureSchema();
  }

  close(): void {
    this.db.close();
  }

  initProject(): void {
    ensureRuntimeDirectories(this.root);
    this.ensureSchema();
    ensureWorkflow(this.root);
    ensureAgentContext(this.root);
    ensureConfig(this.root);
    ensurePrompts(this.root);
    ensureGitignore(this.root);
  }

  createGoal(text: string): { goal: Goal; task: Task } {
    const result = this.createGoalWithTasks(text, [defaultTaskDraft(text)]);
    return { goal: result.goal, task: result.tasks[0] };
  }

  createGoalWithTasks(
    text: string,
    drafts: TaskDraft[],
    options: { completionContract?: string; probes?: GoalProbeDraft[] } = {},
  ): { goal: Goal; tasks: Task[] } {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("Goal text is required.");
    }
    const taskDrafts = drafts.length ? drafts : [defaultTaskDraft(trimmed)];

    const now = timestamp();
    const goalId = this.nextHumanId("GOAL", "goals");

    this.db.prepare(
      "INSERT INTO goals (id, text, completion_contract, status, closure_summary, created_at) VALUES (?, ?, ?, 'open', '', ?)",
    ).run(goalId, trimmed, normalizeCompletionContract(trimmed, taskDrafts, options), now);

    const existingTaskCount = this.maxIdNumber("tasks");
    const planned = taskDrafts.map((draft, index) => ({
      draft,
      taskId: `TASK-${existingTaskCount + index + 1}`,
    }));
    const titleToId = new Map(
      planned.map(({ draft, taskId }) => [normalizeTitle(draft.title), taskId]),
    );

    const tasks: Task[] = [];
    for (const { draft, taskId } of planned) {
      const dependencyIds = normalizeDependencies(draft.dependsOn, titleToId);
      this.db.prepare(`
        INSERT INTO tasks (
          id, goal_id, title, description, status, kind, ops_action, priority, branch_name, worktree_path,
          thread_id, dependency_ids_json, risk_level, verification_plan, loop_phase, loop_attempt,
          current_gate, verification_summary, next_action, needs_input_prompt, supervisor_decision, workpad,
          acceptance_criteria, validation, blocked_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        taskId,
        goalId,
        normalizeTitle(draft.title),
        draft.description.trim() || trimmed,
        "ready",
        draft.kind === "ops" ? "ops" : "code",
        draft.kind === "ops" ? normalizeOpsAction(draft.opsAction) : null,
        normalizePriority(draft.priority),
        null,
        null,
        null,
        JSON.stringify(dependencyIds),
        normalizeRiskLevel(draft.riskLevel),
        draft.verificationPlan?.trim() || defaultVerificationPlan(trimmed),
        "queued",
        0,
        "waiting",
        "",
        "Start this task when its dependencies are done.",
        null,
        "",
        draft.workpad?.trim() || "Created from LoopForge intake. Awaiting worker handoff.",
        draft.acceptanceCriteria.trim() || defaultAcceptance(trimmed),
        "",
        null,
        now,
        now,
      );
      tasks.push(this.getTask(taskId));
    }

    if (options.probes?.length) {
      this.addProbes(goalId, options.probes);
    }
    const goal = this.getGoal(goalId);
    this.appendEvent(
      tasks[0]?.id ?? null,
      null,
      "compiler",
      "goal",
      `Created ${tasks.length} task${tasks.length === 1 ? "" : "s"} from ${goalId}.`,
    );
    return { goal, tasks };
  }

  addTasksToGoal(goalId: string, drafts: TaskDraft[]): { goal: Goal; tasks: Task[] } {
    const goal = this.getGoal(goalId);
    if (goal.status === "closed") {
      throw new Error(`${goalId} is closed.`);
    }
    const taskDrafts = drafts.length ? drafts : [defaultTaskDraft(goal.text)];
    const now = timestamp();
    const existingTaskCount = this.maxIdNumber("tasks");
    const planned = taskDrafts.map((draft, index) => ({
      draft,
      taskId: `TASK-${existingTaskCount + index + 1}`,
    }));
    const titleToId = new Map(
      planned.map(({ draft, taskId }) => [normalizeTitle(draft.title), taskId]),
    );

    const tasks: Task[] = [];
    for (const { draft, taskId } of planned) {
      const dependencyIds = normalizeDependencies(draft.dependsOn, titleToId);
      this.db.prepare(`
        INSERT INTO tasks (
          id, goal_id, title, description, status, kind, ops_action, priority, branch_name, worktree_path,
          thread_id, dependency_ids_json, risk_level, verification_plan, loop_phase, loop_attempt,
          current_gate, verification_summary, next_action, needs_input_prompt, supervisor_decision, workpad,
          acceptance_criteria, validation, blocked_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        taskId,
        goalId,
        normalizeTitle(draft.title),
        draft.description.trim() || goal.text,
        "ready",
        draft.kind === "ops" ? "ops" : "code",
        draft.kind === "ops" ? normalizeOpsAction(draft.opsAction) : null,
        normalizePriority(draft.priority),
        null,
        null,
        null,
        JSON.stringify(dependencyIds),
        normalizeRiskLevel(draft.riskLevel),
        draft.verificationPlan?.trim() || defaultVerificationPlan(goal.text),
        "queued",
        0,
        "waiting",
        "",
        "Start this task when its dependencies are done.",
        null,
        "",
        draft.workpad?.trim() || "Created as LoopForge follow-up work.",
        draft.acceptanceCriteria.trim() || defaultAcceptance(goal.text),
        "",
        null,
        now,
        now,
      );
      tasks.push(this.getTask(taskId));
    }

    this.appendEvent(
      tasks[0]?.id ?? null,
      null,
      "compiler",
      "goal",
      `Added ${tasks.length} follow-up task${tasks.length === 1 ? "" : "s"} to ${goalId}.`,
    );
    return { goal, tasks };
  }

  getBoard(): BoardSnapshot {
    return {
      goals: this.listGoals(),
      tasks: this.listTasks(),
      runs: this.listRuns(),
      agentStatuses: this.listAgentStatuses(),
      externalAgents: this.listExternalAgents(),
      probes: this.listProbes(),
      lessons: this.listLessons(20),
      ideas: this.listIdeas("proposed"),
      messages: this.listMessages(),
      events: this.listEvents(250),
      statuses: TASK_STATUSES.map((id) => ({ id, label: TASK_STATUS_LABELS[id] })),
      projectState: this.getProjectState(),
    };
  }

  getProjectState(): ProjectState {
    return {
      mainThreadId: this.getProjectValue("main_thread_id"),
      mainThreadCreatedAt: this.getProjectValue("main_thread_created_at"),
      mainThreadResetAt: this.getProjectValue("main_thread_reset_at"),
      mainThreadSummary: this.getProjectValue("main_thread_summary") ?? "",
    };
  }

  setMainThread(threadId: string, summary = ""): ProjectState {
    const now = timestamp();
    this.setProjectValue("main_thread_id", threadId);
    this.setProjectValue("main_thread_created_at", now);
    this.setProjectValue("main_thread_summary", summary);
    this.appendEvent(
      null,
      null,
      "main-thread",
      "thread",
      `Project main thread set to ${threadId}.`,
    );
    return this.getProjectState();
  }

  resetMainThread(threadId: string, summary = ""): ProjectState {
    const now = timestamp();
    this.setProjectValue("main_thread_id", threadId);
    this.setProjectValue("main_thread_created_at", now);
    this.setProjectValue("main_thread_reset_at", now);
    this.setProjectValue("main_thread_summary", summary);
    this.appendEvent(
      null,
      null,
      "main-thread",
      "reset",
      `Project main thread reset to ${threadId}.`,
    );
    return this.getProjectState();
  }

  updateMainThreadSummary(summary: string): ProjectState {
    this.setProjectValue("main_thread_summary", summary);
    this.appendEvent(null, null, "main-thread", "summary", "Project main thread summary updated.");
    return this.getProjectState();
  }

  getTask(id: string): Task {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as SqlRow | undefined;
    if (!row) {
      throw new Error(`Task not found: ${id}`);
    }
    return taskFromRow(row);
  }

  getGoal(id: string): Goal {
    const row = this.db.prepare("SELECT * FROM goals WHERE id = ?").get(id) as SqlRow | undefined;
    if (!row) {
      throw new Error(`Goal not found: ${id}`);
    }
    return goalFromRow(row);
  }

  closeGoal(goalId: string, summary = "", options: { force?: boolean } = {}): { goal: Goal; event: ActivityEvent } {
    const goal = this.getGoal(goalId);
    if (goal.status === "closed") {
      const event = this.appendEvent(
        null,
        null,
        "goal",
        "close",
        `${goalId} already closed.`,
      );
      return { goal, event };
    }
    const progress = summarizeGoalProgress(this.getBoard(), goalId);
    // The goal loop closes through its own deterministic gate (win-condition
    // probes), not the relay's task-evidence contract; force skips that check.
    if (!options.force && !progress?.completionReady) {
      throw new Error(
        `${goalId} is not ready to close: ${
          progress?.completionReason ?? "goal progress is unavailable"
        }`,
      );
    }
    const closureSummary = summary.trim() ||
      `${progress?.done ?? 0}/${progress?.total ?? 0} tasks done. ${
        progress?.completionReason ?? "Closed by the goal loop."
      }`;
    const now = timestamp();
    this.db.prepare(
      "UPDATE goals SET status = 'closed', closed_at = ?, closure_summary = ? WHERE id = ?",
    ).run(now, closureSummary, goalId);
    const event = this.appendEvent(
      null,
      null,
      "goal",
      "close",
      `Closed ${goalId}: ${closureSummary}`,
    );
    return { goal: this.getGoal(goalId), event };
  }

  deleteTask(taskId: string): ActivityEvent {
    this.getTask(taskId);
    this.db.prepare(
      "UPDATE runs SET status = 'failed', finished_at = ? WHERE task_id = ? AND status = 'running'",
    )
      .run(timestamp(), taskId);
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
    return this.appendEvent(
      null,
      null,
      "user",
      "delete",
      `Deleted ${taskId}. Any branch/worktree created for it was left on disk.`,
    );
  }

  // Remove a goal and everything scoped to it (tasks -> runs cascade, plus
  // probes and goal messages). Lifecycle events keep their payload goalId but
  // are harmless orphans once the goal is gone from the board.
  deleteGoal(goalId: string): ActivityEvent {
    this.getGoal(goalId);
    this.db.prepare(
      "UPDATE runs SET status = 'failed', finished_at = ? WHERE task_id IN (SELECT id FROM tasks WHERE goal_id = ?) AND status = 'running'",
    ).run(timestamp(), goalId);
    this.db.prepare("DELETE FROM goals WHERE id = ?").run(goalId);
    return this.appendEvent(
      null,
      null,
      "user",
      "delete",
      `Deleted ${goalId} and its tasks. Any branches/worktrees were left on disk.`,
    );
  }

  clearDoneTasks(): { count: number; event: ActivityEvent } {
    const rows = this.db.prepare("SELECT id FROM tasks WHERE status = 'done'").all() as SqlRow[];
    const ids = rows.map((row) => String(row.id));
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(", ");
      this.db.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...ids);
    }
    const event = this.appendEvent(
      null,
      null,
      "user",
      "delete",
      ids.length
        ? `Cleared ${ids.length} completed task${
          ids.length === 1 ? "" : "s"
        } from the board. Branches and worktrees were left on disk.`
        : "No completed tasks to clear.",
    );
    return { count: ids.length, event };
  }

  findDispatchableTask(): Task | null {
    const row = this.db.prepare(`
      SELECT * FROM tasks
      WHERE status IN ('ready', 'inbox') AND kind != 'loop'
      ORDER BY priority DESC, created_at ASC
    `).all() as SqlRow[];
    return row.map(taskFromRow).find((task) =>
      this.dependenciesDone(task) && !this.hasUnresolvedConflict(task)
    ) ?? null;
  }

  listDispatchableTasks(limit = 20): Task[] {
    return (this.db.prepare(`
      SELECT * FROM tasks
      WHERE status IN ('ready', 'inbox') AND kind != 'loop'
      ORDER BY priority DESC, created_at ASC
    `).all() as SqlRow[]).map(taskFromRow).filter((task) =>
      this.dependenciesDone(task) && !this.hasUnresolvedConflict(task)
    ).slice(
      0,
      limit,
    );
  }

  hasRunningRun(taskId: string): boolean {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS count FROM runs WHERE task_id = ? AND status = 'running'",
    ).get(taskId) as { count: number };
    return Number(row.count) > 0;
  }

  createRun(taskId: string, role: string): Run {
    if (this.hasRunningRun(taskId)) {
      throw new Error(`${taskId} already has a running agent.`);
    }

    const run: Run = {
      id: makeId("RUN"),
      taskId,
      role,
      status: "running",
      startedAt: timestamp(),
      finishedAt: null,
      stopRequestedAt: null,
    };
    this.db.prepare(
      "INSERT INTO runs (id, task_id, role, status, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(run.id, run.taskId, run.role, run.status, run.startedAt, run.finishedAt);
    this.appendEvent(taskId, run.id, role, "run", `Started ${role} run ${run.id}.`);
    const task = this.getTask(taskId);
    this.updateTaskLoop(taskId, {
      phase: "planning",
      attempt: task.loopAttempt + 1,
      currentGate: "worktree",
      nextAction: "LoopForge is preparing project context and an isolated worktree.",
      needsInputPrompt: null,
    });
    this.upsertAgentStatus({
      taskId,
      runId: run.id,
      threadId: null,
      turnId: null,
      phase: "starting",
      headline: "Preparing worker run.",
      detail: "LoopForge is setting up this task.",
      risk: "none",
      lastSupervisorAction: null,
      needsInputPrompt: null,
      interruptible: false,
    });
    return run;
  }

  requestTaskStop(taskId: string, reason = "User requested this task to stop."): ActivityEvent {
    const task = this.getTask(taskId);
    const run = this.getRunningRunForTask(task.id);
    if (!run) {
      throw new Error(`${task.id} does not have a running agent to stop.`);
    }
    const now = timestamp();
    this.db.prepare("UPDATE runs SET stop_requested_at = ? WHERE id = ?").run(now, run.id);
    this.updateTaskLoop(task.id, {
      currentGate: "stopping",
      nextAction: "LoopForge is stopping the active Codex turn for this task.",
      needsInputPrompt: "Stop requested. Wait for the active turn to halt before restarting.",
    });
    this.upsertAgentStatus({
      taskId: task.id,
      runId: run.id,
      phase: "blocked",
      headline: "Stop requested.",
      detail: reason,
      risk: "needs_user",
      lastSupervisorAction: "User requested this task to stop.",
      needsInputPrompt: "Stop requested. Wait for the active turn to halt before restarting.",
      interruptible: false,
    });
    return this.appendEvent(task.id, run.id, "user", "stop", reason);
  }

  isRunStopRequested(runId: string): boolean {
    return Boolean(this.getRun(runId).stopRequestedAt);
  }

  getRunningRunForTask(taskId: string): Run | null {
    const row = this.db.prepare(
      "SELECT * FROM runs WHERE task_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
    ).get(taskId) as SqlRow | undefined;
    return row ? runFromRow(row) : null;
  }

  finishRun(runId: string, status: "completed" | "failed"): Run {
    const finishedAt = timestamp();
    this.db.prepare("UPDATE runs SET status = ?, finished_at = ? WHERE id = ?").run(
      status,
      finishedAt,
      runId,
    );
    const run = this.getRun(runId);
    this.appendEvent(run.taskId, run.id, run.role, "run", `Run ${run.id} ${status}.`);
    const task = this.getTask(run.taskId);
    if (
      !(status === "completed" && task.loopPhase === "done") &&
      // A completed run that parked its task for manual verification keeps the
      // hold state; rewriting it would erase the checklist and the resume gate.
      !(status === "completed" && task.currentGate === "manual-verification") &&
      !(status === "failed" && task.loopPhase === "blocked" && task.needsInputPrompt)
    ) {
      this.updateTaskLoop(run.taskId, {
        phase: status === "completed" ? "done" : "blocked",
        currentGate: status === "completed" ? "complete" : "stopped",
        nextAction: status === "completed"
          ? "Task run is complete."
          : "Read the blocker, add input if needed, then restart the task.",
        needsInputPrompt: status === "completed" ? null : "LoopForge stopped before completion.",
      });
    }
    this.upsertAgentStatus({
      taskId: run.taskId,
      runId: run.id,
      phase: status === "completed" ? "done" : "blocked",
      headline: status === "completed" ? "Run complete." : "Run stopped.",
      detail: status === "completed"
        ? "LoopForge finished this worker run."
        : "LoopForge stopped this worker run before completion.",
      risk: status === "completed" ? "none" : "needs_user",
      interruptible: false,
    });
    return run;
  }

  upsertAgentStatus(
    status: {
      taskId: string;
      runId: string;
      threadId?: string | null;
      turnId?: string | null;
      phase?: AgentPhase;
      headline?: string;
      detail?: string;
      risk?: AgentRisk;
      lastSupervisorAction?: string | null;
      needsInputPrompt?: string | null;
      interruptible?: boolean;
    },
  ): AgentStatus {
    const existing = this.getAgentStatus(status.runId);
    const now = timestamp();
    const next = {
      taskId: status.taskId,
      runId: status.runId,
      threadId: status.threadId ?? existing?.threadId ?? null,
      turnId: status.turnId ?? existing?.turnId ?? null,
      phase: status.phase ?? existing?.phase ?? "starting",
      headline: status.headline ?? existing?.headline ?? "Worker is starting.",
      detail: status.detail ?? existing?.detail ?? "",
      risk: status.risk ?? existing?.risk ?? "none",
      lastSeenAt: now,
      lastSupervisorAction: status.lastSupervisorAction === undefined
        ? existing?.lastSupervisorAction ?? null
        : status.lastSupervisorAction,
      needsInputPrompt: status.needsInputPrompt === undefined
        ? existing?.needsInputPrompt ?? null
        : status.needsInputPrompt,
      interruptible: status.interruptible ?? existing?.interruptible ?? false,
    };
    this.db.prepare(`
      INSERT INTO agent_status (
        run_id, task_id, thread_id, turn_id, phase, headline, detail, risk,
        last_seen_at, last_supervisor_action, needs_input_prompt, interruptible
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        task_id = excluded.task_id,
        thread_id = excluded.thread_id,
        turn_id = excluded.turn_id,
        phase = excluded.phase,
        headline = excluded.headline,
        detail = excluded.detail,
        risk = excluded.risk,
        last_seen_at = excluded.last_seen_at,
        last_supervisor_action = excluded.last_supervisor_action,
        needs_input_prompt = excluded.needs_input_prompt,
        interruptible = excluded.interruptible
    `).run(
      next.runId,
      next.taskId,
      next.threadId,
      next.turnId,
      next.phase,
      next.headline,
      next.detail,
      next.risk,
      next.lastSeenAt,
      next.lastSupervisorAction,
      next.needsInputPrompt,
      next.interruptible ? 1 : 0,
    );
    return this.getAgentStatus(status.runId) ?? next;
  }

  addProbes(goalId: string, drafts: GoalProbeDraft[]): GoalProbe[] {
    this.getGoal(goalId);
    for (const draft of drafts) {
      if (!draft.label.trim() || !draft.command.trim()) {
        continue;
      }
      this.db.prepare(
        "INSERT INTO goal_probes (goal_id, label, command, expect_contains, timeout_ms) VALUES (?, ?, ?, ?, ?)",
      ).run(
        goalId,
        draft.label.trim(),
        draft.command.trim(),
        draft.expectContains?.trim() || null,
        Number.isInteger(draft.timeoutMs) && draft.timeoutMs! > 0 ? draft.timeoutMs! : 60000,
      );
    }
    return this.listProbes(goalId);
  }

  listProbes(goalId?: string): GoalProbe[] {
    const rows = goalId
      ? this.db.prepare("SELECT * FROM goal_probes WHERE goal_id = ? ORDER BY id ASC").all(goalId)
      : this.db.prepare("SELECT * FROM goal_probes ORDER BY id ASC").all();
    return (rows as SqlRow[]).map(probeFromRow);
  }

  recordProbeResult(probeId: number, status: "passed" | "failed", output: string): void {
    this.db.prepare(
      "UPDATE goal_probes SET last_status = ?, last_output = ?, last_run_at = ? WHERE id = ?",
    ).run(status, limitText(output, 4000), timestamp(), probeId);
  }

  addLesson(text: string, source = ""): Lesson {
    const trimmed = text.replace(/\s+/g, " ").trim().slice(0, 400);
    if (!trimmed) {
      throw new Error("Lesson text is required.");
    }
    const existing = this.db.prepare("SELECT id FROM lessons WHERE text = ?").get(trimmed) as
      | SqlRow
      | undefined;
    if (!existing) {
      this.db.prepare("INSERT INTO lessons (text, source, created_at) VALUES (?, ?, ?)").run(
        trimmed,
        source,
        timestamp(),
      );
    }
    return this.listLessons(1)[0];
  }

  listLessons(limit = 20): Lesson[] {
    return (this.db.prepare("SELECT * FROM lessons ORDER BY id DESC LIMIT ?").all(
      limit,
    ) as SqlRow[])
      .map((row) => ({
        id: Number(row.id),
        text: String(row.text),
        source: String(row.source ?? ""),
        createdAt: String(row.created_at),
      }))
      .reverse();
  }

  // Scout ideas: rejected ideas keep their fingerprints forever so the same
  // idea can never be re-pitched; ranks come from the scout's ordering.
  addIdeas(drafts: IdeaDraft[]): Idea[] {
    const added: Idea[] = [];
    for (const draft of drafts) {
      const title = draft.title.replace(/\s+/g, " ").trim().slice(0, 160);
      const pitch = draft.pitch.trim().slice(0, 4000);
      if (!title || !pitch) {
        continue;
      }
      const fingerprint = ideaFingerprint(title);
      const existing = this.db.prepare("SELECT id FROM ideas WHERE fingerprint = ?").get(
        fingerprint,
      ) as SqlRow | undefined;
      if (existing) {
        continue;
      }
      const id = this.nextHumanId("IDEA", "ideas");
      const now = timestamp();
      this.db.prepare(
        `INSERT INTO ideas (id, title, pitch, sources, builds_on, rank, status, fingerprint, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?)`,
      ).run(
        id,
        title,
        pitch,
        (draft.sources ?? []).join("\n"),
        (draft.buildsOn ?? "").trim().slice(0, 160),
        this.listIdeas("proposed").length + added.length + 1,
        fingerprint,
        now,
        now,
      );
      added.push(this.getIdea(id));
    }
    return added;
  }

  listIdeas(status?: IdeaStatus): Idea[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM ideas WHERE status = ? ORDER BY rank ASC, id ASC").all(
        status,
      )
      : this.db.prepare("SELECT * FROM ideas ORDER BY rank ASC, id ASC").all();
    return (rows as SqlRow[]).map(ideaFromRow);
  }

  getIdea(ideaId: string): Idea {
    const row = this.db.prepare("SELECT * FROM ideas WHERE id = ?").get(ideaId) as
      | SqlRow
      | undefined;
    if (!row) {
      throw new Error(`Idea ${ideaId} was not found.`);
    }
    return ideaFromRow(row);
  }

  setIdeaStatus(ideaId: string, status: IdeaStatus): Idea {
    this.getIdea(ideaId);
    this.db.prepare("UPDATE ideas SET status = ?, updated_at = ? WHERE id = ?").run(
      status,
      timestamp(),
      ideaId,
    );
    return this.getIdea(ideaId);
  }

  // The scout re-ranks pending ideas each run; unknown ids are ignored and
  // unmentioned pending ideas keep their relative order after the ranked ones.
  applyIdeaOrder(orderedIds: string[]): void {
    const pending = this.listIdeas("proposed");
    const ranked = orderedIds.filter((id) => pending.some((idea) => idea.id === id));
    const rest = pending.filter((idea) => !ranked.includes(idea.id)).map((idea) => idea.id);
    [...ranked, ...rest].forEach((id, index) => {
      this.db.prepare("UPDATE ideas SET rank = ?, updated_at = ? WHERE id = ?").run(
        index + 1,
        timestamp(),
        id,
      );
    });
  }

  setGoalText(goalId: string, text: string): Goal {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("Goal text cannot be empty.");
    }
    this.getGoal(goalId);
    this.db.prepare("UPDATE goals SET text = ? WHERE id = ?").run(trimmed, goalId);
    return this.getGoal(goalId);
  }

  setGoalLoopState(
    goalId: string,
    state: { threadId?: string | null; branch?: string | null; worktree?: string | null },
  ): Goal {
    const goal = this.getGoal(goalId);
    this.db.prepare(
      "UPDATE goals SET loop_thread_id = ?, loop_branch = ?, loop_worktree = ? WHERE id = ?",
    ).run(
      state.threadId !== undefined ? state.threadId : goal.loopThreadId,
      state.branch !== undefined ? state.branch : goal.loopBranch,
      state.worktree !== undefined ? state.worktree : goal.loopWorktree,
      goalId,
    );
    return this.getGoal(goalId);
  }

  // Mirror the loop owner's LOOP_PLAN.md checklist onto the board as kind=loop
  // tasks: pure visualization, never dispatchable, status follows the file.
  syncLoopPlanTasks(
    goalId: string,
    items: Array<{ title: string; status: "todo" | "doing" | "done"; note: string }>,
  ): ActivityEvent[] {
    this.getGoal(goalId);
    const events: ActivityEvent[] = [];
    const existing = (this.db.prepare(
      "SELECT * FROM tasks WHERE goal_id = ? AND kind = 'loop'",
    ).all(goalId) as SqlRow[]).map(taskFromRow);
    const byTitle = new Map(existing.map((task) => [normalizeTitle(task.title), task]));
    const now = timestamp();
    for (const item of items) {
      const status = item.status === "done"
        ? "done"
        : item.status === "doing"
        ? "in_progress"
        : "ready";
      const current = byTitle.get(normalizeTitle(item.title));
      if (!current) {
        const taskId = this.nextHumanId("TASK", "tasks");
        this.db.prepare(`
          INSERT INTO tasks (
            id, goal_id, title, description, status, kind, ops_action, priority, branch_name, worktree_path,
            thread_id, dependency_ids_json, risk_level, verification_plan, loop_phase, loop_attempt,
            current_gate, verification_summary, next_action, needs_input_prompt, supervisor_decision, workpad,
            acceptance_criteria, validation, blocked_reason, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          taskId,
          goalId,
          normalizeTitle(item.title),
          item.note,
          status,
          "loop",
          null,
          100,
          null,
          null,
          null,
          "[]",
          "low",
          "",
          status === "done" ? "done" : status === "in_progress" ? "working" : "queued",
          0,
          "loop-plan",
          "",
          "Worked by the goal loop; mirrored from LOOP_PLAN.md.",
          null,
          "",
          "Mirrored from LOOP_PLAN.md.",
          "",
          "",
          null,
          now,
          now,
        );
        events.push(
          this.appendEvent(taskId, null, "loop", "plan", `${goalId} plan item: ${item.title}`),
        );
        continue;
      }
      if (current.status !== status || current.description !== item.note) {
        this.db.prepare(
          "UPDATE tasks SET status = ?, description = ?, loop_phase = ?, updated_at = ? WHERE id = ?",
        ).run(
          status,
          item.note,
          status === "done" ? "done" : status === "in_progress" ? "working" : "queued",
          now,
          current.id,
        );
        if (current.status !== status) {
          events.push(
            this.appendEvent(
              current.id,
              null,
              "loop",
              "plan",
              `${current.id}: ${item.title} -> ${status === "in_progress" ? "working" : status}.`,
            ),
          );
        }
      }
    }
    return events;
  }

  // The goal loop's attended hold: one ordinary code task carrying the goal
  // branch, parked at the manual-verification gate so the existing
  // restart-to-merge shortcut lands the whole loop's work.
  createLoopMergeHoldTask(
    goalId: string,
    branchName: string,
    needsInputPrompt: string,
    validation: string,
  ): Task {
    const goal = this.getGoal(goalId);
    const taskId = this.nextHumanId("TASK", "tasks");
    const now = timestamp();
    this.db.prepare(`
      INSERT INTO tasks (
        id, goal_id, title, description, status, kind, ops_action, priority, branch_name, worktree_path,
        thread_id, dependency_ids_json, risk_level, verification_plan, loop_phase, loop_attempt,
        current_gate, verification_summary, next_action, needs_input_prompt, supervisor_decision, workpad,
        acceptance_criteria, validation, blocked_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      taskId,
      goalId,
      `Merge ${goalId} loop work`,
      `Loop work for "${goal.text.slice(0, 120)}" is complete and verified; merge ${branchName}.`,
      "review",
      "code",
      null,
      200,
      branchName,
      goal.loopWorktree,
      null,
      "[]",
      "low",
      "",
      "reviewing",
      0,
      "manual-verification",
      validation,
      "Verify the listed items by hand, then restart this task to merge.",
      needsInputPrompt,
      "",
      "Created by the goal loop completion gate.",
      "",
      validation,
      null,
      now,
      now,
    );
    this.appendEvent(
      taskId,
      null,
      "loop",
      "hold",
      `${goalId} loop work parked in Review as ${taskId}; restart it to merge ${branchName}.`,
    );
    return this.getTask(taskId);
  }

  // When the goal loop merges a goal, any relay-intake tasks it carried are
  // superseded: the work shipped through the loop branch, not through them.
  settleGoalTasksForLoop(goalId: string, reason: string): ActivityEvent[] {
    const events: ActivityEvent[] = [];
    const open = (this.db.prepare(
      "SELECT * FROM tasks WHERE goal_id = ? AND kind != 'loop' AND status != 'done'",
    ).all(goalId) as SqlRow[]).map(taskFromRow);
    const now = timestamp();
    for (const task of open) {
      this.db.prepare(
        `UPDATE tasks SET status = 'done', loop_phase = 'done', current_gate = 'complete',
         next_action = ?, needs_input_prompt = NULL, updated_at = ? WHERE id = ?`,
      ).run(reason, now, task.id);
      events.push(this.appendEvent(task.id, null, "loop", "settle", `${task.id}: ${reason}`));
    }
    return events;
  }

  setTaskDependencies(taskId: string, dependencyIds: string[]): Task {
    this.getTask(taskId);
    this.db.prepare("UPDATE tasks SET dependency_ids_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(dependencyIds), timestamp(), taskId);
    return this.getTask(taskId);
  }

  recordTriageAttempt(taskId: string, fingerprint: string): Task {
    const task = this.getTask(taskId);
    this.db.prepare(
      "UPDATE tasks SET triage_attempts = ?, blocked_fingerprint = ?, updated_at = ? WHERE id = ?",
    ).run(task.triageAttempts + 1, fingerprint, timestamp(), task.id);
    return this.getTask(taskId);
  }

  resetTriageAttempts(taskId: string): Task {
    this.db.prepare(
      "UPDATE tasks SET triage_attempts = 0, updated_at = ? WHERE id = ?",
    ).run(timestamp(), taskId);
    return this.getTask(taskId);
  }

  setBlockedFingerprint(taskId: string, fingerprint: string): Task {
    this.db.prepare(
      "UPDATE tasks SET blocked_fingerprint = ?, updated_at = ? WHERE id = ?",
    ).run(fingerprint, timestamp(), taskId);
    return this.getTask(taskId);
  }

  setTaskKind(taskId: string, kind: "code" | "ops", opsAction: OpsAction | null): Task {
    this.db.prepare(
      "UPDATE tasks SET kind = ?, ops_action = ?, updated_at = ? WHERE id = ?",
    ).run(kind, kind === "ops" ? opsAction : null, timestamp(), taskId);
    return this.getTask(taskId);
  }

  reportExternalAgent(
    report: {
      id: string;
      agent: string;
      state: ExternalAgentState;
      headline?: string;
      cwd?: string;
      sessionId?: string | null;
    },
  ): { status: ExternalAgentStatus; changed: boolean } {
    const existing = this.getExternalAgent(report.id);
    const now = timestamp();
    const next: ExternalAgentStatus = {
      id: report.id,
      agent: report.agent,
      state: report.state,
      headline: report.headline ?? existing?.headline ?? "",
      cwd: report.cwd ?? existing?.cwd ?? "",
      sessionId: report.sessionId === undefined ? existing?.sessionId ?? null : report.sessionId,
      startedAt: existing?.startedAt ?? now,
      lastSeenAt: now,
    };
    this.db.prepare(`
      INSERT INTO external_agents (
        id, agent, state, headline, cwd, session_id, started_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        agent = excluded.agent,
        state = excluded.state,
        headline = excluded.headline,
        cwd = excluded.cwd,
        session_id = excluded.session_id,
        last_seen_at = excluded.last_seen_at
    `).run(
      next.id,
      next.agent,
      next.state,
      next.headline,
      next.cwd,
      next.sessionId,
      next.startedAt,
      next.lastSeenAt,
    );
    return { status: next, changed: existing?.state !== next.state };
  }

  getExternalAgent(id: string): ExternalAgentStatus | null {
    const row = this.db.prepare("SELECT * FROM external_agents WHERE id = ?").get(id) as
      | SqlRow
      | undefined;
    return row ? externalAgentFromRow(row) : null;
  }

  listExternalAgents(): ExternalAgentStatus[] {
    return (this.db.prepare(
      "SELECT * FROM external_agents ORDER BY last_seen_at DESC",
    ).all() as SqlRow[]).map(externalAgentFromRow);
  }

  pruneExternalAgents(maxAgeMs: number): number {
    const nowMs = Date.now();
    let removed = 0;
    for (const status of this.listExternalAgents()) {
      const lastSeen = Date.parse(status.lastSeenAt);
      if (Number.isFinite(lastSeen) && nowMs - lastSeen <= maxAgeMs) {
        continue;
      }
      this.db.prepare("DELETE FROM external_agents WHERE id = ?").run(status.id);
      removed++;
    }
    return removed;
  }

  getAgentStatus(runId: string): AgentStatus | null {
    const row = this.db.prepare("SELECT * FROM agent_status WHERE run_id = ?").get(runId) as
      | SqlRow
      | undefined;
    return row ? agentStatusFromRow(row) : null;
  }

  listActiveAgentStatuses(): AgentStatus[] {
    return (this.db.prepare(`
      SELECT agent_status.* FROM agent_status
      JOIN runs ON runs.id = agent_status.run_id
      WHERE runs.status = 'running'
      ORDER BY agent_status.last_seen_at DESC
    `).all() as SqlRow[]).map(agentStatusFromRow);
  }

  markStaleAgentStatuses(maxAgeMs: number): ActivityEvent[] {
    const nowMs = Date.now();
    const events: ActivityEvent[] = [];
    for (const status of this.listActiveAgentStatuses()) {
      const lastSeen = Date.parse(status.lastSeenAt);
      if (!Number.isFinite(lastSeen) || nowMs - lastSeen <= maxAgeMs || status.risk === "stale") {
        continue;
      }
      this.upsertAgentStatus({
        taskId: status.taskId,
        runId: status.runId,
        phase: status.phase,
        headline: "No recent agent activity.",
        detail: "LoopForge has not seen new Codex events for this active run.",
        risk: "stale",
        interruptible: status.interruptible,
      });
      this.recordSupervisorDecision(
        status.taskId,
        "Marked active task stale because no recent Codex events arrived.",
      );
      events.push(
        this.appendEvent(
          status.taskId,
          status.runId,
          "supervisor",
          "stale",
          "No recent Codex activity for this running task.",
        ),
      );
    }
    return events;
  }

  recoverStaleRuns(): ActivityEvent[] {
    const events: ActivityEvent[] = [];
    const runningRuns = this.db.prepare("SELECT * FROM runs WHERE status = 'running'")
      .all() as SqlRow[];
    if (!runningRuns.length) {
      return events;
    }
    const now = timestamp();
    this.db.prepare("UPDATE runs SET status = 'failed', finished_at = ? WHERE status = 'running'")
      .run(now);
    events.push(
      this.appendEvent(
        null,
        null,
        "orchestrator",
        "startup",
        `Recovered ${runningRuns.length} stale running run${
          runningRuns.length === 1 ? "" : "s"
        } after restart.`,
      ),
    );
    const stuckTasks = this.db.prepare(
      "SELECT * FROM tasks WHERE status IN ('in_progress', 'review', 'merging')",
    )
      .all() as SqlRow[];
    for (const row of stuckTasks) {
      const task = taskFromRow(row);
      events.push(
        this.requestTransition(
          task.id,
          "blocked",
          "orchestrator",
          "LoopForge restarted while this task was active. Add a message or restart it.",
        ).event,
      );
    }
    return events;
  }

  getRun(id: string): Run {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as SqlRow | undefined;
    if (!row) {
      throw new Error(`Run not found: ${id}`);
    }
    return runFromRow(row);
  }

  requestTransition(
    taskId: string,
    to: TaskStatus,
    actor = "daemon",
    reason = "",
  ): TransitionResult {
    if (!TASK_STATUSES.includes(to)) {
      throw new Error(`Unknown task status: ${to}`);
    }

    const task = this.getTask(taskId);
    if (task.status === to) {
      const event = this.appendEvent(
        taskId,
        null,
        actor,
        "transition",
        `${taskId} already ${TASK_STATUS_LABELS[to]}.`,
      );
      return { task, event };
    }

    if (!TRANSITIONS[task.status].includes(to)) {
      throw new Error(
        `Invalid transition for ${taskId}: ${TASK_STATUS_LABELS[task.status]} -> ${
          TASK_STATUS_LABELS[to]
        }`,
      );
    }

    if (to === "review" && !task.validation.trim()) {
      throw new Error(`Validation evidence is required before ${taskId} can move to Review.`);
    }

    const blockedReason = to === "blocked" ? reason || "Blocked without details." : null;
    const loopPatch = loopPatchForTransition(to, reason);
    const now = timestamp();
    this.db.prepare(
      `UPDATE tasks
       SET status = ?, blocked_reason = ?, loop_phase = ?, current_gate = ?, next_action = ?,
           needs_input_prompt = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      to,
      blockedReason,
      loopPatch.phase,
      loopPatch.currentGate,
      loopPatch.nextAction,
      loopPatch.needsInputPrompt,
      now,
      taskId,
    );

    const updated = this.getTask(taskId);
    const event = this.appendEvent(
      taskId,
      null,
      actor,
      "transition",
      `${taskId}: ${TASK_STATUS_LABELS[task.status]} -> ${TASK_STATUS_LABELS[to]}${
        reason ? ` | ${reason}` : ""
      }`,
    );
    return { task: updated, event };
  }

  updateTaskWorkpad(taskId: string, workpad: string): Task {
    this.db.prepare("UPDATE tasks SET workpad = ?, updated_at = ? WHERE id = ?").run(
      workpad,
      timestamp(),
      taskId,
    );
    return this.getTask(taskId);
  }

  updateTaskValidation(taskId: string, validation: string): Task {
    this.db.prepare("UPDATE tasks SET validation = ?, updated_at = ? WHERE id = ?").run(
      validation,
      timestamp(),
      taskId,
    );
    return this.getTask(taskId);
  }

  updateTaskLoop(
    taskId: string,
    patch: {
      phase?: TaskLoopPhase;
      attempt?: number;
      currentGate?: string;
      verificationSummary?: string;
      nextAction?: string;
      needsInputPrompt?: string | null;
      supervisorDecision?: string;
    },
  ): Task {
    const task = this.getTask(taskId);
    const phase = patch.phase ?? task.loopPhase;
    const attempt = patch.attempt ?? task.loopAttempt;
    const currentGate = patch.currentGate ?? task.currentGate;
    const verificationSummary = patch.verificationSummary ?? task.verificationSummary;
    const nextAction = patch.nextAction ?? task.nextAction;
    const needsInputPrompt = patch.needsInputPrompt === undefined
      ? task.needsInputPrompt
      : patch.needsInputPrompt;
    const supervisorDecision = patch.supervisorDecision ?? task.supervisorDecision;
    this.db.prepare(`
      UPDATE tasks
      SET loop_phase = ?, loop_attempt = ?, current_gate = ?, verification_summary = ?,
          next_action = ?, needs_input_prompt = ?, supervisor_decision = ?, updated_at = ?
      WHERE id = ?
    `).run(
      phase,
      attempt,
      currentGate,
      verificationSummary,
      nextAction,
      needsInputPrompt,
      supervisorDecision,
      timestamp(),
      taskId,
    );
    return this.getTask(taskId);
  }

  assignWorktree(taskId: string, branchName: string, worktreePathValue: string): Task {
    this.db.prepare(
      "UPDATE tasks SET branch_name = ?, worktree_path = ?, updated_at = ? WHERE id = ?",
    ).run(branchName, worktreePathValue, timestamp(), taskId);
    return this.getTask(taskId);
  }

  assignThread(taskId: string, threadId: string): Task {
    this.db.prepare("UPDATE tasks SET thread_id = ?, updated_at = ? WHERE id = ?").run(
      threadId,
      timestamp(),
      taskId,
    );
    return this.getTask(taskId);
  }

  assignThreadLineage(
    taskId: string,
    parentThreadId: string | null,
    threadId: string | null,
  ): Task {
    this.db.prepare(
      "UPDATE tasks SET parent_thread_id = ?, thread_id = ?, updated_at = ? WHERE id = ?",
    ).run(parentThreadId, threadId, timestamp(), taskId);
    return this.getTask(taskId);
  }

  updateTaskActiveTurn(taskId: string, turnId: string | null): Task {
    this.db.prepare("UPDATE tasks SET active_turn_id = ?, updated_at = ? WHERE id = ?").run(
      turnId,
      timestamp(),
      taskId,
    );
    return this.getTask(taskId);
  }

  updateTaskContextManifest(taskId: string, manifestPath: string): Task {
    this.db.prepare("UPDATE tasks SET context_manifest_path = ?, updated_at = ? WHERE id = ?").run(
      manifestPath,
      timestamp(),
      taskId,
    );
    return this.getTask(taskId);
  }

  updateTaskCard(taskId: string, taskCard: string): Task {
    this.db.prepare("UPDATE tasks SET task_card = ?, updated_at = ? WHERE id = ?").run(
      taskCard,
      timestamp(),
      taskId,
    );
    return this.getTask(taskId);
  }

  updateTaskHandoff(taskId: string, handoffSummary: string): Task {
    this.db.prepare("UPDATE tasks SET handoff_summary = ?, updated_at = ? WHERE id = ?").run(
      handoffSummary,
      timestamp(),
      taskId,
    );
    return this.getTask(taskId);
  }

  updateTaskTouchedPaths(taskId: string, paths: string[]): Task {
    const unique = uniqueStrings(paths);
    this.db.prepare("UPDATE tasks SET touched_paths_json = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify(unique),
      timestamp(),
      taskId,
    );
    return this.getTask(taskId);
  }

  addConflictSignal(taskId: string, signal: string): Task {
    const task = this.getTask(taskId);
    const signals = uniqueStrings([...task.conflictSignals, signal]);
    this.db.prepare("UPDATE tasks SET conflict_signals_json = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify(signals),
      timestamp(),
      taskId,
    );
    this.appendEvent(taskId, null, "orchestrator", "conflict", signal);
    return this.getTask(taskId);
  }

  recordSupervisorDecision(taskId: string, decision: string): Task {
    const task = this.getTask(taskId);
    const text = decision.replace(/\s+/g, " ").trim();
    if (!text) {
      return task;
    }
    const next = task.supervisorDecision
      ? `${task.supervisorDecision}\n${timestamp()} ${text}`
      : `${timestamp()} ${text}`;
    this.db.prepare("UPDATE tasks SET supervisor_decision = ?, updated_at = ? WHERE id = ?").run(
      limitText(next, 2000),
      timestamp(),
      taskId,
    );
    this.appendEvent(taskId, null, "supervisor", "decision", text);
    return this.getTask(taskId);
  }

  appendEvent(
    taskId: string | null,
    runId: string | null,
    role: string,
    kind: string,
    message: string,
    raw?: unknown,
  ): ActivityEvent {
    const now = timestamp();
    const rawJson = raw === undefined ? null : JSON.stringify(raw);
    const result = this.db.prepare(
      "INSERT INTO events (task_id, run_id, role, kind, message, created_at, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(taskId, runId, role, kind, message, now, rawJson);
    return {
      id: Number(result.lastInsertRowid),
      taskId,
      runId,
      role,
      kind,
      message,
      createdAt: now,
      rawJson,
    };
  }

  appendAgentEvent(event: ActivityEventInput): ActivityEvent {
    return this.appendEvent(
      event.taskId,
      event.runId,
      event.role,
      event.kind,
      event.message,
      event.raw,
    );
  }

  // Emit a canonical lifecycle event onto the same stream subscribers already
  // read. Returns the stored ActivityEvent so callers can broadcast it.
  appendLifecycleEvent(event: LifecycleEvent): ActivityEvent {
    const activity = lifecycleToActivity(event);
    return this.appendEvent(
      activity.taskId,
      activity.runId,
      activity.role,
      activity.kind,
      activity.message,
      activity.raw,
    );
  }

  // The typed lifecycle feed for a goal (or all goals), newest last, for the
  // Kanban and any external dashboard.
  listLifecycleEvents(goalId?: string, limit = 500): LifecycleEvent[] {
    // Query lifecycle rows directly. Pulling the last N of ALL events and then
    // filtering loses lifecycle events behind high-volume agent chatter (a
    // fan-out emits hundreds of fanout:<title> lines), so the GUI would rehydrate
    // with missing sub-agents/plan. Filtering in SQL keeps the window accurate.
    const events = (this.db.prepare(
      "SELECT * FROM events WHERE role = ? ORDER BY id DESC LIMIT ?",
    ).all(LIFECYCLE_ROLE, limit) as SqlRow[])
      .map(eventFromRow)
      .reverse() // chronological (oldest first); the dashboard replays in order
      .map(parseLifecycleEvent)
      .filter((event): event is LifecycleEvent => event !== null);
    return goalId ? events.filter((event) => event.goalId === goalId) : events;
  }

  enqueueMessage(taskId: string, role: string, message: string): ActivityEvent {
    this.db.prepare(
      "INSERT INTO messages (task_id, role, message, processed, created_at) VALUES (?, ?, ?, 0, ?)",
    ).run(taskId, role, message, timestamp());
    return this.appendEvent(
      taskId,
      null,
      role,
      "queue",
      `Queued message for ${taskId}: ${message}`,
    );
  }

  listPendingMessages(taskId: string): QueuedMessage[] {
    return (this.db.prepare(
      "SELECT * FROM messages WHERE task_id = ? AND processed = 0 ORDER BY id ASC",
    ).all(taskId) as SqlRow[]).map(messageFromRow);
  }

  // Goal-level steer queue: adding a task to a goal lands here, and the goal
  // loop folds pending entries into its plan on the next turn. Separate from
  // task messages because messages.task_id is foreign-keyed to a task.
  enqueueGoalMessage(goalId: string, role: string, message: string): ActivityEvent {
    this.getGoal(goalId);
    this.db.prepare(
      "INSERT INTO goal_messages (goal_id, role, message, processed, created_at) VALUES (?, ?, ?, 0, ?)",
    ).run(goalId, role, message, timestamp());
    return this.appendEvent(
      null,
      null,
      role,
      "queue",
      `Queued task for ${goalId}: ${message}`,
    );
  }

  listPendingGoalMessages(goalId: string): QueuedMessage[] {
    return (this.db.prepare(
      "SELECT * FROM goal_messages WHERE goal_id = ? AND processed = 0 ORDER BY id ASC",
    ).all(goalId) as SqlRow[]).map(messageFromRow);
  }

  markGoalMessagesProcessed(ids: number[]): void {
    if (!ids.length) {
      return;
    }
    const placeholders = ids.map(() => "?").join(", ");
    this.db.prepare(
      `UPDATE goal_messages SET processed = 1 WHERE id IN (${placeholders})`,
    ).run(...ids);
  }

  markMessagesProcessed(ids: number[]): void {
    if (!ids.length) {
      return;
    }
    const placeholders = ids.map(() => "?").join(", ");
    this.db.prepare(`UPDATE messages SET processed = 1 WHERE id IN (${placeholders})`).run(...ids);
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        completion_contract TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        closed_at TEXT,
        closure_summary TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        branch_name TEXT,
        worktree_path TEXT,
        parent_thread_id TEXT,
        thread_id TEXT,
        active_turn_id TEXT,
	        context_manifest_path TEXT,
	        dependency_ids_json TEXT NOT NULL DEFAULT '[]',
	        risk_level TEXT NOT NULL DEFAULT 'medium',
	        verification_plan TEXT NOT NULL DEFAULT '',
	        loop_phase TEXT NOT NULL DEFAULT 'queued',
	        loop_attempt INTEGER NOT NULL DEFAULT 0,
	        current_gate TEXT NOT NULL DEFAULT 'waiting',
	        verification_summary TEXT NOT NULL DEFAULT '',
	        next_action TEXT NOT NULL DEFAULT 'Start this task.',
	        needs_input_prompt TEXT,
	        supervisor_decision TEXT NOT NULL DEFAULT '',
	        task_card TEXT NOT NULL DEFAULT '',
        handoff_summary TEXT NOT NULL DEFAULT '',
        touched_paths_json TEXT NOT NULL DEFAULT '[]',
        conflict_signals_json TEXT NOT NULL DEFAULT '[]',
        workpad TEXT NOT NULL DEFAULT '',
        acceptance_criteria TEXT NOT NULL DEFAULT '',
        validation TEXT NOT NULL DEFAULT '',
        blocked_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        stop_requested_at TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_status (
        run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        thread_id TEXT,
        turn_id TEXT,
        phase TEXT NOT NULL,
        headline TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        risk TEXT NOT NULL DEFAULT 'none',
        last_seen_at TEXT NOT NULL,
        last_supervisor_action TEXT,
        needs_input_prompt TEXT,
        interruptible INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        role TEXT NOT NULL,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        raw_json TEXT
      );

      CREATE TABLE IF NOT EXISTS file_claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(path)
      );

      CREATE TABLE IF NOT EXISTS project_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        message TEXT NOT NULL,
        processed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS goal_probes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        command TEXT NOT NULL,
        expect_contains TEXT,
        timeout_ms INTEGER NOT NULL DEFAULT 60000,
        last_status TEXT NOT NULL DEFAULT 'pending',
        last_output TEXT NOT NULL DEFAULT '',
        last_run_at TEXT
      );

      CREATE TABLE IF NOT EXISTS goal_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        message TEXT NOT NULL,
        processed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lessons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ideas (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        pitch TEXT NOT NULL,
        sources TEXT NOT NULL DEFAULT '',
        builds_on TEXT NOT NULL DEFAULT '',
        rank INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'proposed',
        fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS external_agents (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        state TEXT NOT NULL,
        headline TEXT NOT NULL DEFAULT '',
        cwd TEXT NOT NULL DEFAULT '',
        session_id TEXT,
        started_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
    `);
    this.ensureColumn("tasks", "parent_thread_id", "TEXT");
    this.ensureColumn("goals", "completion_contract", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("goals", "status", "TEXT NOT NULL DEFAULT 'open'");
    this.ensureColumn("goals", "closed_at", "TEXT");
    this.ensureColumn("goals", "closure_summary", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("goals", "loop_thread_id", "TEXT");
    this.ensureColumn("goals", "loop_branch", "TEXT");
    this.ensureColumn("goals", "loop_worktree", "TEXT");
    this.ensureColumn("tasks", "thread_id", "TEXT");
    this.ensureColumn("tasks", "active_turn_id", "TEXT");
    this.ensureColumn("tasks", "context_manifest_path", "TEXT");
    this.ensureColumn("tasks", "dependency_ids_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("tasks", "risk_level", "TEXT NOT NULL DEFAULT 'medium'");
    this.ensureColumn("tasks", "verification_plan", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("tasks", "loop_phase", "TEXT NOT NULL DEFAULT 'queued'");
    this.ensureColumn("tasks", "loop_attempt", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("tasks", "current_gate", "TEXT NOT NULL DEFAULT 'waiting'");
    this.ensureColumn("tasks", "verification_summary", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("tasks", "next_action", "TEXT NOT NULL DEFAULT 'Start this task.'");
    this.ensureColumn("tasks", "needs_input_prompt", "TEXT");
    this.ensureColumn("tasks", "supervisor_decision", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("tasks", "task_card", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("tasks", "handoff_summary", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("tasks", "touched_paths_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("tasks", "conflict_signals_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("events", "raw_json", "TEXT");
    this.ensureColumn("agent_status", "thread_id", "TEXT");
    this.ensureColumn("agent_status", "turn_id", "TEXT");
    this.ensureColumn("agent_status", "headline", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("agent_status", "detail", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("agent_status", "risk", "TEXT NOT NULL DEFAULT 'none'");
    this.ensureColumn("agent_status", "last_supervisor_action", "TEXT");
    this.ensureColumn("agent_status", "needs_input_prompt", "TEXT");
    this.ensureColumn("agent_status", "interruptible", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("runs", "stop_requested_at", "TEXT");
    this.ensureColumn("tasks", "kind", "TEXT NOT NULL DEFAULT 'code'");
    this.ensureColumn("tasks", "ops_action", "TEXT");
    this.ensureColumn("tasks", "triage_attempts", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("tasks", "blocked_fingerprint", "TEXT");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    if (!columns.some((row) => row.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private listGoals(): Goal[] {
    return (this.db.prepare("SELECT * FROM goals ORDER BY created_at ASC").all() as SqlRow[]).map(
      goalFromRow,
    );
  }

  private listTasks(): Task[] {
    return (this.db.prepare(
      "SELECT * FROM tasks ORDER BY priority DESC, created_at ASC",
    ).all() as SqlRow[]).map(taskFromRow);
  }

  private listRuns(): Run[] {
    return (this.db.prepare("SELECT * FROM runs ORDER BY started_at DESC").all() as SqlRow[]).map(
      runFromRow,
    );
  }

  private listAgentStatuses(): AgentStatus[] {
    return (this.db.prepare(
      "SELECT * FROM agent_status ORDER BY last_seen_at DESC",
    ).all() as SqlRow[]).map(agentStatusFromRow);
  }

  private listMessages(): QueuedMessage[] {
    return (this.db.prepare("SELECT * FROM messages ORDER BY id ASC").all() as SqlRow[]).map(
      messageFromRow,
    );
  }

  private listEvents(limit: number): ActivityEvent[] {
    return (this.db.prepare(
      "SELECT * FROM events ORDER BY id DESC LIMIT ?",
    ).all(limit) as SqlRow[]).map(eventFromRow).reverse();
  }

  private nextHumanId(prefix: string, table: "goals" | "tasks" | "ideas"): string {
    return `${prefix}-${this.maxIdNumber(table) + 1}`;
  }

  // Ids must survive deletions (Clear Done, manual deletes), so number from the
  // highest existing suffix rather than the row count.
  private maxIdNumber(table: "goals" | "tasks" | "ideas"): number {
    const rows = this.db.prepare(`SELECT id FROM ${table}`).all() as Array<{ id: string }>;
    let max = 0;
    for (const row of rows) {
      const match = String(row.id).match(/-(\d+)$/);
      if (match) {
        max = Math.max(max, Number(match[1]));
      }
    }
    return max;
  }

  private dependenciesDone(task: Task): boolean {
    if (!task.dependencyIds.length) {
      return true;
    }
    const placeholders = task.dependencyIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`SELECT id, status FROM tasks WHERE id IN (${placeholders})`).all(
      ...task.dependencyIds,
    ) as SqlRow[];
    const done = new Set(rows.filter((row) => row.status === "done").map((row) => String(row.id)));
    return task.dependencyIds.every((id) => done.has(id));
  }

  private hasUnresolvedConflict(task: Task): boolean {
    if (!task.conflictSignals.length) {
      return false;
    }
    const ids = uniqueStrings(
      task.conflictSignals.flatMap((signal) => signal.match(/\bTASK-\d+\b/g) ?? []),
    );
    if (!ids.length) {
      return true;
    }
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db.prepare(`SELECT id, status FROM tasks WHERE id IN (${placeholders})`).all(
      ...ids,
    ) as SqlRow[];
    const done = new Set(rows.filter((row) => row.status === "done").map((row) => String(row.id)));
    return ids.some((id) => !done.has(id));
  }

  private getProjectValue(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM project_state WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  private setProjectValue(key: string, value: string): void {
    this.db.prepare(
      "INSERT INTO project_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, value);
  }
}

export function ensureRuntimeDirectories(root: string): void {
  Deno.mkdirSync(runtimePath(root), { recursive: true });
  Deno.mkdirSync(worktreesPath(root), { recursive: true });
  Deno.mkdirSync(runsPath(root), { recursive: true });
  Deno.mkdirSync(promptsPath(root), { recursive: true });
  Deno.mkdirSync(contextPath(root), { recursive: true });
  Deno.mkdirSync(taskArtifactsPath(root), { recursive: true });
}

function ensureConfig(root: string): void {
  const target = configPath(root);
  try {
    Deno.statSync(target);
  } catch {
    Deno.writeTextFileSync(target, JSON.stringify(defaultConfig(), null, 2) + "\n");
  }
}

export function readConfig(root: string): LoopForgeConfig {
  try {
    const parsed = JSON.parse(Deno.readTextFileSync(configPath(root))) as Record<string, unknown>;
    return normalizeConfig(parsed);
  } catch {
    return defaultConfig();
  }
}

export function updateConfig(root: string, patch: Partial<LoopForgeConfig>): LoopForgeConfig {
  ensureRuntimeDirectories(root);
  const config = normalizeConfig({ ...readConfig(root), ...patch });
  Deno.writeTextFileSync(configPath(root), JSON.stringify(config, null, 2) + "\n");
  return config;
}

function defaultConfig(): LoopForgeConfig {
  return {
    name: "LoopForge",
    port: 4733,
    workerMode: "codex",
    maxConcurrentAgents: 2,
    codexTransport: "sdk",
    boardStates: TASK_STATUSES,
    model: "gpt-5.5",
    reasoningEffort: "high",
    fastMode: true,
    githubPrReview: false,
  };
}

function normalizeConfig(value: Record<string, unknown>): LoopForgeConfig {
  const defaults = defaultConfig();
  const reasoning = typeof value.reasoningEffort === "string" &&
      ["low", "medium", "high", "xhigh"].includes(value.reasoningEffort)
    ? value.reasoningEffort as ReasoningEffort
    : defaults.reasoningEffort;
  return {
    ...defaults,
    port: typeof value.port === "number" && Number.isInteger(value.port)
      ? value.port
      : defaults.port,
    maxConcurrentAgents:
      typeof value.maxConcurrentAgents === "number" && Number.isInteger(value.maxConcurrentAgents)
        ? value.maxConcurrentAgents
        : defaults.maxConcurrentAgents,
    model: typeof value.model === "string" && value.model.trim()
      ? value.model.trim()
      : defaults.model,
    reasoningEffort: reasoning,
    fastMode: typeof value.fastMode === "boolean" ? value.fastMode : defaults.fastMode,
    githubPrReview: typeof value.githubPrReview === "boolean"
      ? value.githubPrReview
      : defaults.githubPrReview,
  };
}

function ensurePrompts(root: string): void {
  for (const [name, content] of Object.entries(PROMPTS)) {
    const target = path.join(promptsPath(root), name);
    try {
      Deno.statSync(target);
    } catch {
      Deno.writeTextFileSync(target, content);
    }
  }
}

// Runtime dirs are excluded via .git/info/exclude, never .gitignore: an
// untracked LoopForge-written .gitignore at the root blocks any merge whose
// branch adds its own .gitignore (git refuses to overwrite untracked files).
function ensureGitignore(root: string): void {
  const gitPath = path.join(root, ".git");
  let gitDir: string;
  try {
    const stat = Deno.statSync(gitPath);
    if (stat.isDirectory) {
      gitDir = gitPath;
    } else {
      const pointer = Deno.readTextFileSync(gitPath).match(/^gitdir:\s*(.+)$/m);
      if (!pointer) {
        return;
      }
      gitDir = path.isAbsolute(pointer[1].trim())
        ? pointer[1].trim()
        : path.join(root, pointer[1].trim());
    }
  } catch {
    return;
  }
  const target = path.join(gitDir, "info", "exclude");
  let current = "";
  try {
    current = Deno.readTextFileSync(target);
  } catch {
    current = "";
  }
  const required = [`/${runtimeDirName(root)}/`, "/.omx/"];
  const additions = required.filter((entry) => !current.split(/\r?\n/).includes(entry));
  if (additions.length) {
    try {
      Deno.mkdirSync(path.join(gitDir, "info"), { recursive: true });
      const prefix = current && !current.endsWith("\n") ? "\n" : "";
      Deno.writeTextFileSync(target, `${current}${prefix}${additions.join("\n")}\n`);
    } catch {
      // Excludes are best effort; a read-only .git never blocks init.
    }
  }
}

function defaultTaskDraft(text: string): TaskDraft {
  return {
    title: normalizeTitle(text),
    description: text.trim(),
    priority: 100,
    acceptanceCriteria: defaultAcceptance(text),
    workpad: "Created from /goal intake. Awaiting worker handoff.",
  };
}

function defaultAcceptance(text: string): string {
  return [
    `- Clarify and implement: ${text.trim()}`,
    "- Record workpad notes before implementation handoff.",
    "- Produce validation evidence before requesting Review.",
  ].join("\n");
}

function defaultVerificationPlan(text: string): string {
  return [
    `- Inspect the changed surface for: ${text.trim()}`,
    "- Run the most relevant existing build, typecheck, lint, test, or smoke command.",
    "- Add or update a focused test only when the project has a clear test seam.",
    "- Record commands, observed results, changed files, and remaining risk.",
  ].join("\n");
}

function normalizeCompletionContract(
  text: string,
  drafts: TaskDraft[],
  options: { completionContract?: string },
): string {
  const supplied = options.completionContract?.trim();
  if (supplied) {
    return supplied;
  }
  const taskCount = drafts.length || 1;
  return [
    `Goal: ${text.trim()}`,
    `- ${taskCount} planned task${taskCount === 1 ? "" : "s"} must reach Done.`,
    "- Every Done task must include implementation evidence, validation evidence, approved review, commit evidence, clean git status, and a compact handoff or task card.",
    "- Project memory must preserve the final behavior, changed surfaces, validation results, and remaining risks.",
    "- LoopForge may close this goal only when the active goal verdict is Ready To Close.",
  ].join("\n");
}

function normalizeTitle(title: string): string {
  const trimmed = title.trim() || "Untitled task";
  return trimmed.length > 84 ? `${trimmed.slice(0, 81)}...` : trimmed;
}

function normalizeDependencies(
  values: string[] | undefined,
  titleToId: Map<string, string>,
): string[] {
  if (!values?.length) {
    return [];
  }
  return uniqueStrings(
    values.map((value) => {
      const trimmed = value.trim();
      return titleToId.get(normalizeTitle(trimmed)) ?? trimmed;
    }).filter(Boolean),
  );
}

function loopPatchForTransition(
  status: TaskStatus,
  reason: string,
): {
  phase: TaskLoopPhase;
  currentGate: string;
  nextAction: string;
  needsInputPrompt: string | null;
} {
  if (status === "in_progress") {
    return {
      phase: "working",
      currentGate: "implementation",
      nextAction: "LoopForge is letting the Codex worker implement the task.",
      needsInputPrompt: null,
    };
  }
  if (status === "review") {
    return {
      phase: "reviewing",
      currentGate: "review",
      nextAction: "LoopForge is reviewing validation evidence and the diff.",
      needsInputPrompt: null,
    };
  }
  if (status === "done") {
    return {
      phase: "done",
      currentGate: "complete",
      nextAction: "Task is complete and ready to remain in project memory.",
      needsInputPrompt: null,
    };
  }
  if (status === "blocked") {
    return {
      phase: "blocked",
      currentGate: "needs-input",
      nextAction: "Read the blocker, add input if needed, then restart the task.",
      needsInputPrompt: reason || "LoopForge needs direction before this task can continue.",
    };
  }
  return {
    phase: "queued",
    currentGate: "waiting",
    nextAction: "Start this task when its dependencies are done.",
    needsInputPrompt: null,
  };
}

function normalizeRiskLevel(value: unknown): TaskRiskLevel {
  return value === "low" || value === "high" ? value : "medium";
}

function normalizeLoopPhase(value: unknown): TaskLoopPhase {
  const phase = String(value ?? "");
  return [
      "queued",
      "planning",
      "working",
      "testing",
      "repairing",
      "reviewing",
      "remembering",
      "done",
      "blocked",
    ].includes(phase)
    ? phase as TaskLoopPhase
    : "queued";
}

function normalizePriority(priority: number): number {
  if (!Number.isFinite(priority)) {
    return 100;
  }
  return Math.max(0, Math.min(999, Math.round(priority)));
}

function goalFromRow(row: SqlRow): Goal {
  return {
    id: String(row.id),
    text: String(row.text),
    completionContract: String(row.completion_contract ?? ""),
    status: row.status === "closed" ? "closed" : "open",
    closedAt: nullableString(row.closed_at),
    closureSummary: String(row.closure_summary ?? ""),
    loopThreadId: nullableString(row.loop_thread_id),
    loopBranch: nullableString(row.loop_branch),
    loopWorktree: nullableString(row.loop_worktree),
    createdAt: String(row.created_at),
  };
}

function taskFromRow(row: SqlRow): Task {
  return {
    id: String(row.id),
    goalId: String(row.goal_id),
    title: String(row.title),
    description: String(row.description),
    status: String(row.status) as TaskStatus,
    kind: row.kind === "ops" ? "ops" : row.kind === "loop" ? "loop" : "code",
    opsAction: normalizeOpsAction(row.ops_action),
    priority: Number(row.priority),
    branchName: nullableString(row.branch_name),
    worktreePath: nullableString(row.worktree_path),
    parentThreadId: nullableString(row.parent_thread_id),
    threadId: nullableString(row.thread_id),
    activeTurnId: nullableString(row.active_turn_id),
    contextManifestPath: nullableString(row.context_manifest_path),
    dependencyIds: parseStringArray(row.dependency_ids_json),
    riskLevel: normalizeRiskLevel(row.risk_level),
    verificationPlan: String(row.verification_plan ?? ""),
    loopPhase: normalizeLoopPhase(row.loop_phase),
    loopAttempt: Number(row.loop_attempt ?? 0),
    currentGate: String(row.current_gate ?? "waiting"),
    verificationSummary: String(row.verification_summary ?? ""),
    nextAction: String(row.next_action ?? "Start this task."),
    needsInputPrompt: nullableString(row.needs_input_prompt),
    supervisorDecision: String(row.supervisor_decision ?? ""),
    taskCard: String(row.task_card ?? ""),
    handoffSummary: String(row.handoff_summary ?? ""),
    touchedPaths: parseStringArray(row.touched_paths_json),
    conflictSignals: parseStringArray(row.conflict_signals_json),
    workpad: String(row.workpad ?? ""),
    acceptanceCriteria: String(row.acceptance_criteria ?? ""),
    validation: String(row.validation ?? ""),
    blockedReason: nullableString(row.blocked_reason),
    triageAttempts: Number(row.triage_attempts ?? 0),
    blockedFingerprint: nullableString(row.blocked_fingerprint),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function normalizeOpsAction(value: unknown): OpsAction | null {
  return OPS_ACTIONS.includes(String(value) as OpsAction) ? String(value) as OpsAction : null;
}

function runFromRow(row: SqlRow): Run {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    role: String(row.role),
    status: String(row.status) as Run["status"],
    startedAt: String(row.started_at),
    finishedAt: nullableString(row.finished_at),
    stopRequestedAt: nullableString(row.stop_requested_at),
  };
}

function agentStatusFromRow(row: SqlRow): AgentStatus {
  return {
    taskId: String(row.task_id),
    runId: String(row.run_id),
    threadId: nullableString(row.thread_id),
    turnId: nullableString(row.turn_id),
    phase: normalizeAgentPhase(row.phase),
    headline: String(row.headline ?? ""),
    detail: String(row.detail ?? ""),
    risk: normalizeAgentRisk(row.risk),
    lastSeenAt: String(row.last_seen_at),
    lastSupervisorAction: nullableString(row.last_supervisor_action),
    needsInputPrompt: nullableString(row.needs_input_prompt),
    interruptible: Boolean(row.interruptible),
  };
}

function eventFromRow(row: SqlRow): ActivityEvent {
  return {
    id: Number(row.id),
    taskId: nullableString(row.task_id),
    runId: nullableString(row.run_id),
    role: String(row.role),
    kind: String(row.kind),
    message: String(row.message),
    createdAt: String(row.created_at),
    rawJson: nullableString(row.raw_json),
  };
}

function messageFromRow(row: SqlRow): QueuedMessage {
  return {
    id: Number(row.id),
    taskId: String(row.task_id),
    role: String(row.role),
    message: String(row.message),
    processed: Boolean(row.processed),
    createdAt: String(row.created_at),
  };
}

function ideaFromRow(row: SqlRow): Idea {
  const status = String(row.status ?? "proposed");
  return {
    id: String(row.id),
    title: String(row.title),
    pitch: String(row.pitch),
    sources: String(row.sources ?? "").split("\n").map((item) => item.trim()).filter(Boolean),
    buildsOn: String(row.builds_on ?? ""),
    rank: Number(row.rank ?? 0),
    status: status === "approved" || status === "rejected" ? status : "proposed",
    fingerprint: String(row.fingerprint),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function ideaFingerprint(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, "-").slice(0, 120);
}

function probeFromRow(row: SqlRow): GoalProbe {
  const status = String(row.last_status ?? "pending");
  return {
    id: Number(row.id),
    goalId: String(row.goal_id),
    label: String(row.label),
    command: String(row.command),
    expectContains: nullableString(row.expect_contains),
    timeoutMs: Number(row.timeout_ms ?? 60000),
    lastStatus: status === "passed" || status === "failed" ? status : "pending",
    lastOutput: String(row.last_output ?? ""),
    lastRunAt: nullableString(row.last_run_at),
  };
}

function externalAgentFromRow(row: SqlRow): ExternalAgentStatus {
  return {
    id: String(row.id),
    agent: String(row.agent),
    state: normalizeExternalAgentState(row.state),
    headline: String(row.headline ?? ""),
    cwd: String(row.cwd ?? ""),
    sessionId: nullableString(row.session_id),
    startedAt: String(row.started_at),
    lastSeenAt: String(row.last_seen_at),
  };
}

export function normalizeExternalAgentState(value: unknown): ExternalAgentState {
  const text = String(value);
  return EXTERNAL_AGENT_STATES.includes(text as ExternalAgentState)
    ? text as ExternalAgentState
    : "working";
}

function normalizeAgentPhase(value: unknown): AgentPhase {
  const text = String(value);
  const phases: AgentPhase[] = [
    "starting",
    "planning",
    "reading",
    "editing",
    "running",
    "testing",
    "reviewing",
    "merging",
    "blocked",
    "done",
  ];
  return phases.includes(text as AgentPhase) ? text as AgentPhase : "running";
}

function normalizeAgentRisk(value: unknown): AgentRisk {
  const text = String(value);
  const risks: AgentRisk[] = [
    "none",
    "test_failed",
    "conflict",
    "stale",
    "needs_user",
    "session",
  ];
  return risks.includes(text as AgentRisk) ? text as AgentRisk : "none";
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      : [];
  } catch {
    return [];
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function limitText(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) {
    return value;
  }
  return value.slice(value.length - maxCharacters);
}

function timestamp(): string {
  return new Date().toISOString();
}

function makeId(prefix: string): string {
  const random = crypto.randomUUID().slice(0, 8).toUpperCase();
  return `${prefix}-${random}`;
}
