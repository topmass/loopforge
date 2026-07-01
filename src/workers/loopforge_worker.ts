import { BoardStore, readConfig } from "../board/store.ts";
import { summarizeGoalProgress } from "../board/goal_progress.ts";
import { ActivityEvent, ActivityEventInput, QueuedMessage, Task } from "../board/types.ts";
import {
  CodexClient,
  CodexSession,
  CodexSessionOptions,
  CodexTurnResult,
} from "./codex_app_server.ts";
import { createAgentClient, createPlannerClient, createReviewerClient } from "./agent_backend.ts";
import { readGlobalConfig } from "../board/global_config.ts";
import { consultRescue, RescueClientFactory } from "./rescue.ts";
import { extractTurnId } from "./codex_event_normalizer.ts";
import { shouldRecordActivity } from "./activity_filter.ts";
import {
  gitChangedFiles,
  gitCommitAll,
  gitDiffStat,
  gitMergeBranchLeased,
  gitPublishRoot,
  gitStatus,
  prepareTaskWorktree,
  PublishResult,
  removeTaskWorktree,
} from "./git_utils.ts";
import { buildTriagePrompt, fingerprintBlocker, parseTriageResponse } from "./blocker_triage.ts";
import { GoalReviewer } from "./goal_reviewer.ts";
import { buildDependencyReviewPrompt, parseDependencyReview } from "./dependency_review.ts";
import { GoalTestEngineer, parseVerificationResponse } from "./goal_test_engineer.ts";
import { GhPullRequestGate, PullRequestGate, PullRequestInfo } from "./github_pr.ts";
import { LiveSupervisor } from "./live_supervisor.ts";
import { collectAgentsInstructions } from "./project_context.ts";
import { buildProjectMemory } from "./project_memory.ts";
import { discoverVerificationGates, formatVerificationGates } from "./verification_gates.ts";
import {
  appendSpecsheetHandoff,
  buildFinalHandoff,
  buildMainThreadAbsorptionPrompt,
  buildTaskCard,
  ensureProjectKnowledgeFiles,
  writeTaskContextArtifacts,
} from "./task_memory.ts";
import { runWorkflowHooks } from "./workflow_hooks.ts";
import { autonomyContract, PROMPTS, RunMode } from "../board/prompts.ts";
import { listManualVerificationItems } from "../board/status_lines.ts";
import { readWorkflow, WorkflowRuntime } from "../workflow/workflow.ts";

export interface LoopForgeWorkerOptions {
  onEvent?: (event: ActivityEvent) => void;
  runMode?: RunMode;
  createCodexClient?: (
    onEvent: (event: ActivityEventInput) => void,
  ) => CodexClient;
  createPlannerClient?: (
    onEvent: (event: ActivityEventInput) => void,
  ) => CodexClient;
  createReviewerClient?: (
    onEvent: (event: ActivityEventInput) => void,
  ) => CodexClient;
  createRescueClient?: RescueClientFactory;
  pullRequestGate?: PullRequestGate;
}

class TaskStopRequestedError extends Error {}

class TriageRetryError extends Error {}

export class LoopForgeWorker {
  readonly root: string;
  readonly store: BoardStore;
  readonly onEvent?: (event: ActivityEvent) => void;
  readonly createCodexClient: (
    onEvent: (event: ActivityEventInput) => void,
  ) => CodexClient;
  readonly createPlannerClient: (
    onEvent: (event: ActivityEventInput) => void,
  ) => CodexClient;
  readonly createReviewerClient: (
    onEvent: (event: ActivityEventInput) => void,
  ) => CodexClient;
  readonly pullRequestGate: PullRequestGate;
  readonly runMode: RunMode;
  private readonly createRescueClient?: RescueClientFactory;
  private mergeChain: Promise<void> = Promise.resolve();

  constructor(root: string, store: BoardStore, options: LoopForgeWorkerOptions = {}) {
    this.root = root;
    this.store = store;
    this.onEvent = options.onEvent;
    this.createCodexClient = options.createCodexClient ??
      ((onEvent) => createAgentClient(this.root, onEvent));
    this.createPlannerClient = options.createPlannerClient ?? options.createCodexClient ??
      ((onEvent) => createPlannerClient(this.root, onEvent));
    this.createReviewerClient = options.createReviewerClient ?? options.createCodexClient ??
      ((onEvent) => createReviewerClient(this.root, onEvent));
    this.createRescueClient = options.createRescueClient;
    this.pullRequestGate = options.pullRequestGate ?? new GhPullRequestGate(this.root);
    this.runMode = options.runMode ?? "attended";
  }

  async runNext(): Promise<Task> {
    const task = this.store.findDispatchableTask();
    if (!task) {
      throw new Error("No Inbox or Ready task is available.");
    }
    return await this.runTask(task.id);
  }

  async runQueue(
    limit = Number.POSITIVE_INFINITY,
    maxConcurrency?: number,
    options: { filter?: (task: Task) => boolean; shouldStop?: () => boolean } = {},
  ): Promise<Task[]> {
    const completed: Task[] = [];
    const touchedGoalIds = new Set<string>();
    const running = new Map<string, Promise<void>>();
    const failures: unknown[] = [];
    const failedIds = new Set<string>();
    let started = 0;
    let revalidationAttempted = false;
    // Slot-based dispatch: the moment an agent finishes, the next dispatchable
    // task starts. No batch barriers; one slow task never idles the other slots.
    while (true) {
      const workflow = readWorkflow(this.root);
      const cap = Math.max(1, maxConcurrency ?? workflow.maxConcurrentAgents);
      while (running.size < cap && started < limit && !options.shouldStop?.()) {
        const next = this.store.listDispatchableTasks(20).find((task) =>
          !running.has(task.id) && !failedIds.has(task.id) &&
          (options.filter?.(task) ?? true)
        );
        if (!next) {
          break;
        }
        started++;
        const taskId = next.id;
        this.emit(
          this.store.appendEvent(
            null,
            null,
            "scheduler",
            "dispatch",
            `Dispatching ${taskId} (${running.size + 1}/${cap} agents busy).`,
          ),
        );
        const slot = this.runTask(taskId)
          .then((task) => {
            completed.push(task);
            touchedGoalIds.add(task.goalId);
          })
          .catch((error) => {
            failures.push(error);
            failedIds.add(taskId);
            const message = error instanceof Error ? error.message : String(error);
            try {
              this.emit(
                this.store.appendEvent(
                  taskId,
                  null,
                  "orchestrator",
                  "task-error",
                  `${taskId} failed: ${message}`,
                ),
              );
            } catch {
              // Recording the failure is best effort.
            }
          })
          .finally(() => {
            running.delete(taskId);
          });
        running.set(taskId, slot);
      }
      if (running.size) {
        await Promise.race(running.values());
        continue;
      }
      if (options.shouldStop?.() || started >= limit) {
        break;
      }
      if (this.createMissingGoalEvidenceRepairTasks(null)) {
        continue;
      }
      if (!revalidationAttempted) {
        revalidationAttempted = true;
        if (await this.revalidateDependencies(options.filter)) {
          continue;
        }
      }
      break;
    }
    this.closeReadyGoals(touchedGoalIds);
    if (!completed.length && failures.length) {
      throw failures[0];
    }
    return completed;
  }

  // One planner turn re-judges the dependency graph when the queue is stuck:
  // ready tasks exist but every one waits on an unfinished dependency.
  private async revalidateDependencies(filter?: (task: Task) => boolean): Promise<boolean> {
    const board = this.store.getBoard();
    const doneIds = new Set(
      board.tasks.filter((task) => task.status === "done").map((task) => task.id),
    );
    const gated = board.tasks.filter((task) =>
      (task.status === "ready" || task.status === "inbox") &&
      (filter?.(task) ?? true) &&
      task.dependencyIds.some((id) => !doneIds.has(id))
    );
    if (!gated.length) {
      return false;
    }
    const unfinished = board.tasks.filter((task) => task.status !== "done");
    this.emit(
      this.store.appendEvent(
        null,
        null,
        "planner",
        "revalidate",
        `Nothing is dispatchable; planner is re-checking dependencies for ${gated.length} gated task${
          gated.length === 1 ? "" : "s"
        }.`,
      ),
    );
    let responseText = "";
    const planner = this.createPlannerClient((event) => {
      if (event.role === "codex" && event.kind === "agent") {
        responseText += event.message;
      }
      const activity = { ...event, role: "planner" };
      if (shouldRecordActivity(activity)) {
        this.emit(this.store.appendAgentEvent(activity));
      }
    });
    try {
      const session = await planner.startSession(this.root);
      await planner.runTurn(session, {
        title: "LoopForge dependency revalidation",
        prompt: buildDependencyReviewPrompt(gated, unfinished),
      });
    } catch (error) {
      this.emit(
        this.store.appendEvent(
          null,
          null,
          "planner",
          "revalidate",
          `Dependency revalidation failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
      return false;
    } finally {
      await planner.stop().catch(() => {});
    }
    const reviewed = parseDependencyReview(
      responseText,
      gated.map((task) => task.id),
      board.tasks.map((task) => task.id),
      new Map(unfinished.map((task) => [task.id, task.dependencyIds])),
    );
    if (!reviewed) {
      this.emit(
        this.store.appendEvent(
          null,
          null,
          "planner",
          "revalidate",
          "Dependency revalidation returned no usable changes; keeping the current graph.",
        ),
      );
      return false;
    }
    let changed = false;
    for (const [taskId, deps] of reviewed) {
      const current = board.tasks.find((task) => task.id === taskId)?.dependencyIds ?? [];
      if (JSON.stringify(current) === JSON.stringify(deps)) {
        continue;
      }
      this.store.setTaskDependencies(taskId, deps);
      changed = true;
      this.emit(
        this.store.appendEvent(
          taskId,
          null,
          "planner",
          "dependencies",
          `${taskId} dependencies revalidated: ${current.join(", ") || "none"} -> ${
            deps.join(", ") || "none"
          }.`,
        ),
      );
    }
    return changed;
  }

  private closeReadyGoals(goalIds: Set<string>): void {
    if (!goalIds.size) {
      return;
    }
    const board = this.store.getBoard();
    for (const goalId of goalIds) {
      const goal = board.goals.find((candidate) => candidate.id === goalId);
      if (!goal || goal.status === "closed") {
        continue;
      }
      const progress = summarizeGoalProgress(board, goalId);
      if (!progress?.completionReady) {
        continue;
      }
      const result = this.store.closeGoal(
        goalId,
        `${progress.done}/${progress.total} tasks done. ${progress.completionReason}`,
      );
      this.emit(result.event);
    }
  }

  async runTask(taskId: string): Promise<Task> {
    const workflow = readWorkflow(this.root);
    const maxAttempts = Math.max(workflow.maxRetries, workflow.maxTurns, 1);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const task = await this.runTaskAttempt(taskId);
        this.closeReadyGoals(new Set([task.goalId]));
        return task;
      } catch (error) {
        if (attempt >= maxAttempts) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        this.emit(
          this.store.appendEvent(
            taskId,
            null,
            "orchestrator",
            "retry",
            `Retrying ${taskId} after failure ${attempt}/${maxAttempts}: ${message}`,
          ),
        );
        try {
          const task = this.store.getTask(taskId);
          if (task.status === "blocked") {
            this.emit(
              this.store.requestTransition(
                taskId,
                "ready",
                "orchestrator",
                `Retry ${attempt + 1}/${maxAttempts} after transient failure.`,
              ).event,
            );
          }
        } catch {
          // Preserve the original failure if the task disappeared during retry handling.
        }
        await delay(workflow.retryBackoffMs);
      }
    }
    throw new Error(`Unable to run ${taskId}.`);
  }

  async steerTask(taskId: string, message: string): Promise<ActivityEvent> {
    const task = this.store.resetTriageAttempts(taskId);
    if (task.threadId && task.activeTurnId) {
      const codex = this.createCodexClient((event) => {
        if (shouldRecordActivity(event)) {
          this.emit(this.store.appendAgentEvent(event));
        }
      });
      try {
        const session = await codex.resumeSession(task.worktreePath ?? this.root, task.threadId);
        if (codex.steerTurn) {
          await codex.steerTurn(session, message);
          return this.store.appendEvent(task.id, null, "steerer", "steer", message);
        }
      } finally {
        await codex.stop().catch(() => {});
      }
    }
    return this.store.enqueueMessage(taskId, "steerer", message);
  }

  async readTaskThread(taskId: string): Promise<unknown> {
    const task = this.store.getTask(taskId);
    if (!task.threadId) {
      throw new Error(`${task.id} does not have a Codex task thread yet.`);
    }
    const codex = this.createCodexClient((event) => {
      if (shouldRecordActivity(event)) {
        this.emit(this.store.appendAgentEvent(event));
      }
    });
    try {
      const session = await codex.resumeSession(
        task.worktreePath ?? this.root,
        task.threadId,
        taskThreadOptions(this.root, task),
      );
      return await codex.readThread?.(session, true);
    } finally {
      await codex.stop().catch(() => {});
    }
  }

  async compactTaskThread(taskId: string): Promise<ActivityEvent> {
    const task = this.store.getTask(taskId);
    if (!task.threadId) {
      throw new Error(`${task.id} does not have a Codex task thread yet.`);
    }
    const codex = this.createCodexClient((event) => {
      if (shouldRecordActivity(event)) {
        this.emit(this.store.appendAgentEvent(event));
      }
    });
    try {
      const session = await codex.resumeSession(
        task.worktreePath ?? this.root,
        task.threadId,
        taskThreadOptions(this.root, task),
      );
      await codex.compactThread?.(session);
      return this.store.appendEvent(
        task.id,
        null,
        "main-thread",
        "compact",
        "Task thread compaction started.",
      );
    } finally {
      await codex.stop().catch(() => {});
    }
  }

  private async runTaskAttempt(taskId: string): Promise<Task> {
    let task = this.store.getTask(taskId);
    if (!["inbox", "ready", "blocked", "review"].includes(task.status)) {
      throw new Error(`Cannot start ${task.id} while it is ${task.status}.`);
    }
    if (task.kind === "ops") {
      return await this.runOpsTaskAttempt(task.id);
    }
    if (task.kind === "loop") {
      throw new Error(
        `${task.id} is a goal-loop plan mirror; the goal loop works it. Run the goal loop instead.`,
      );
    }
    // A task held in Review for manual verification resumes straight to merge:
    // restarting it is the user's confirmation, not a request to redo the work.
    if (
      task.status === "review" && task.currentGate === "manual-verification" && task.branchName
    ) {
      const mergeRun = this.store.createRun(task.id, "merger");
      this.emit(
        this.store.appendEvent(
          task.id,
          mergeRun.id,
          "merger",
          "resume",
          `Manual verification confirmed by restart; merging ${task.id} now.`,
        ),
      );
      try {
        const merged = await this.mergeApprovedTask(task, mergeRun.id, null);
        this.store.finishRun(mergeRun.id, "completed");
        return merged;
      } catch (error) {
        this.store.finishRun(mergeRun.id, "failed");
        throw error;
      }
    }
    const run = this.store.createRun(task.id, "worker");
    this.emit(
      this.store.appendEvent(task.id, run.id, "worker", "phase", "Preparing isolated worktree."),
    );

    let currentSession: { threadId: string; cwd: string } | null = null;
    let supervisor: LiveSupervisor | null = null;
    let captureTarget: "test-engineer" | "triage" | null = null;
    let capturedAgentText = "";
    let stopMonitor: (() => void) | null = null;
    const codex = this.createCodexClient((event) => {
      if (captureTarget && event.role === "codex" && event.kind === "agent") {
        capturedAgentText += event.message;
      }
      if (shouldRecordActivity(event)) {
        this.emit(
          this.store.appendEvent(
            task.id,
            run.id,
            event.role,
            event.kind,
            event.message,
            event.raw,
          ),
        );
      }
      supervisor?.observe(event);
      const turnId = extractTurnId(event.raw);
      if (event.kind === "turn/started" && turnId) {
        this.store.updateTaskActiveTurn(task.id, turnId);
      }
    });
    supervisor = new LiveSupervisor({
      store: this.store,
      task,
      runId: run.id,
      codex,
      getSession: () => currentSession,
      onEvent: (event) => this.emit(event),
    });
    stopMonitor = this.startStopMonitor(task.id, run.id, codex, () => currentSession);

    try {
      ensureProjectKnowledgeFiles(this.root);
      const workflow = readWorkflow(this.root);
      task = this.store.updateTaskLoop(task.id, {
        phase: "planning",
        currentGate: "context",
        nextAction: "LoopForge is reading project instructions and preparing task context.",
        needsInputPrompt: null,
      });
      const assignment = await prepareTaskWorktree(this.root, task, workflow.worktreesDir);
      const projectInstructions = await collectAgentsInstructions(this.root);
      const projectMemory = buildProjectMemory(this.store);
      const queuedMessages = this.store.listPendingMessages(task.id);
      task = this.store.assignWorktree(task.id, assignment.branchName, assignment.worktreePath);
      task = this.store.updateTaskLoop(task.id, {
        phase: "planning",
        currentGate: "worktree",
        nextAction: "LoopForge assigned an isolated worktree and is writing the task packet.",
      });
      this.emit(
        this.store.appendEvent(
          task.id,
          run.id,
          "worker",
          "worktree",
          `Assigned ${assignment.branchName} at ${assignment.worktreePath}.`,
        ),
      );
      const contextArtifacts = writeTaskContextArtifacts({
        root: this.root,
        task,
        projectInstructions,
        workflowInstructions: workflow.instructions,
        projectMemory,
        queuedMessages: formatQueuedMessages(queuedMessages),
      });
      task = this.store.updateTaskContextManifest(task.id, contextArtifacts.manifestPath);
      task = this.store.updateTaskCard(task.id, buildTaskCard(task));
      task = this.store.updateTaskLoop(task.id, {
        phase: "planning",
        currentGate: "context-manifest",
        nextAction: "The Codex worker will read the task packet and begin implementation.",
      });
      this.emit(
        this.store.appendEvent(
          task.id,
          run.id,
          "worker",
          "context",
          `Wrote context manifest ${contextArtifacts.manifestPath}.`,
        ),
      );
      if (assignment.created) {
        await this.runHooks(workflow, "after_create", assignment.worktreePath, task.id, run.id);
      }
      await this.runHooks(workflow, "before_run", assignment.worktreePath, task.id, run.id);

      if (task.status === "inbox") {
        this.emit(
          this.store.requestTransition(task.id, "ready", "scheduler", "Dispatching Codex worker.")
            .event,
        );
      }
      this.emit(
        this.store.requestTransition(task.id, "in_progress", "worker", "Codex worker claimed task.")
          .event,
      );

      let wasContinuation = Boolean(task.threadId);
      let parentThreadId = task.parentThreadId ?? await this.ensureMainThread();
      let session: CodexSession;
      try {
        session = await openTaskSession(
          codex,
          task,
          assignment.worktreePath,
          parentThreadId,
          taskThreadOptions(this.root, task),
        );
      } catch (error) {
        if (!isMissingCodexThreadError(error)) {
          throw error;
        }
        this.emit(
          this.store.appendEvent(
            task.id,
            run.id,
            "worker",
            "thread",
            "Saved Codex session was unavailable. Reopening with a fresh project session.",
          ),
        );
        parentThreadId = await this.replaceMainThread(codex);
        task = this.store.assignThreadLineage(task.id, parentThreadId, null);
        wasContinuation = false;
        session = await openTaskSession(
          codex,
          task,
          assignment.worktreePath,
          parentThreadId,
          taskThreadOptions(this.root, task),
        );
      }
      currentSession = session;
      supervisor.markThread(session);
      task = this.store.assignThreadLineage(task.id, parentThreadId, session.threadId);
      this.emit(
        this.store.appendEvent(
          task.id,
          run.id,
          "worker",
          "thread",
          `${wasContinuation ? "Resumed" : "Started"} Codex thread ${session.threadId}.`,
        ),
      );

      const maxTurns = Math.max(workflow.maxTurns, 1);
      let turn: CodexTurnResult | null = null;
      let testTurn: CodexTurnResult | null = null;
      let verificationGates = "";
      let verificationNotes = "VERIFICATION_PASSED\n- Verification did not report failures.";
      let repairEvidence = "";
      let rescueConsulted = false;
      for (let loopTurn = 1; loopTurn <= maxTurns; loopTurn++) {
        const isRepair = Boolean(repairEvidence);
        this.throwIfStopRequested(run.id);
        this.store.updateTaskActiveTurn(
          task.id,
          isRepair ? `repair-${loopTurn}` : "implementation",
        );
        task = this.store.updateTaskLoop(task.id, {
          phase: isRepair || wasContinuation ? "repairing" : "working",
          attempt: Math.max(task.loopAttempt, loopTurn),
          currentGate: isRepair ? "repair" : "implementation",
          nextAction: isRepair
            ? `Codex is repairing verification failure ${loopTurn - 1}/${maxTurns - 1}.`
            : wasContinuation
            ? "Codex is applying queued input and repairing the task."
            : "Codex is implementing this task in the assigned worktree.",
          needsInputPrompt: null,
        });
        turn = await codex.runTurn(session, {
          title: isRepair ? `${task.id}: repair ${loopTurn}` : `${task.id}: ${task.title}`,
          prompt: buildWorkerPrompt(
            this.root,
            task,
            projectInstructions,
            workflow.instructions,
            projectMemory,
            queuedMessages,
            repairEvidence,
            repairStrategy(loopTurn),
            this.runMode,
          ),
        });
        this.store.updateTaskActiveTurn(task.id, null);
        this.throwIfStopRequested(run.id);
        if (!isRepair) {
          this.store.markMessagesProcessed(queuedMessages.map((message) => message.id));
        }
        verificationGates = formatVerificationGates(discoverVerificationGates(session.cwd, task));
        const testEngineer = new GoalTestEngineer(
          projectInstructions,
          projectMemory,
          workflow.instructions,
          verificationGates,
          {
            runMode: this.runMode,
            onEvent: (event) => {
              this.emit(
                this.store.appendEvent(
                  task.id,
                  run.id,
                  event.role,
                  event.kind,
                  event.message,
                  event.raw,
                ),
              );
            },
          },
        );
        this.store.updateTaskActiveTurn(task.id, "test-engineer");
        task = this.store.updateTaskLoop(task.id, {
          phase: "testing",
          currentGate: "test-engineer",
          verificationSummary: repairEvidence,
          nextAction: `LoopForge test engineer is checking attempt ${loopTurn}/${maxTurns}.`,
        });
        supervisor.markPhase("testing", "LoopForge test engineer is validating the task.");
        this.throwIfStopRequested(run.id);
        capturedAgentText = "";
        captureTarget = "test-engineer";
        try {
          testTurn = await testEngineer.run(codex, session, task);
        } finally {
          captureTarget = null;
        }
        this.store.updateTaskActiveTurn(task.id, null);
        this.throwIfStopRequested(run.id);
        const verification = parseVerificationResponse(capturedAgentText);
        verificationNotes = verification.notes;
        if (verification.verdict === "passed") {
          if (repairEvidence) {
            try {
              this.store.addLesson(
                `${task.id} needed a repair turn; first failure: ${shortName(repairEvidence, 200)}`,
                "repair",
              );
            } catch {
              // Lessons are best effort.
            }
          }
          break;
        }
        if (verification.verdict === "needs_input" || loopTurn >= maxTurns) {
          // The full verifier output stays in verificationSummary/validation; the
          // needs-input prompt is the concise ask, not the dump.
          let prompt = verification.verdict === "needs_input"
            ? verification.notes
            : `Verification failed after ${maxTurns} attempt${
              maxTurns === 1 ? "" : "s"
            }. Latest failure: ${
              shortName(firstFailureLine(verification.notes), 220)
            } Full evidence is in this task's validation. Add guidance, then restart the task.`;
          if (verification.verdict === "needs_input") {
            const triage = await this.triageBlocker({
              taskId: task.id,
              runId: run.id,
              codex,
              blocker: prompt,
              workflow,
              startCapture: () => {
                capturedAgentText = "";
                captureTarget = "triage";
              },
              stopCapture: () => {
                captureTarget = null;
                return capturedAgentText;
              },
            });
            if (triage.outcome === "resolved") {
              supervisor.markPhase("done", "Main agent triage resolved the blocker.");
              this.store.finishRun(run.id, "completed");
              return triage.task;
            }
            if (triage.outcome === "retry") {
              this.emit(
                this.store.requestTransition(
                  task.id,
                  "ready",
                  "core",
                  "Main agent triage queued corrected instructions and requested a retry.",
                ).event,
              );
              throw new TriageRetryError(
                `Main agent triage requested a retry for ${task.id}.`,
              );
            }
            prompt = triage.prompt;
          }
          this.store.updateTaskLoop(task.id, {
            phase: "blocked",
            currentGate: "verification",
            verificationSummary: verification.notes,
            nextAction:
              "Read the verification failure, add guidance if needed, then restart this task.",
            needsInputPrompt: prompt,
          });
          this.emit(
            this.store.requestTransition(
              task.id,
              "blocked",
              "test-engineer",
              prompt,
            ).event,
          );
          this.store.finishRun(run.id, "failed");
          return this.store.getTask(task.id);
        }
        repairEvidence = verification.notes;
        const globalConfig = readGlobalConfig();
        if (
          globalConfig.rescue.enabled && !rescueConsulted &&
          loopTurn >= globalConfig.rescue.afterAttempts
        ) {
          rescueConsulted = true;
          this.emit(
            this.store.appendEvent(
              task.id,
              run.id,
              "rescue",
              "consult",
              `Rescue model (${globalConfig.rescue.backend}) is reviewing ${task.id} after ${loopTurn} failed attempt${
                loopTurn === 1 ? "" : "s"
              }.`,
            ),
          );
          const guidance = await consultRescue({
            root: this.root,
            task,
            worktreePath: session.cwd,
            failureNotes: verification.notes,
            attempts: loopTurn,
            onEvent: (event) => {
              if (shouldRecordActivity(event)) {
                this.emit(
                  this.store.appendEvent(
                    task.id,
                    run.id,
                    event.role,
                    event.kind,
                    event.message,
                    event.raw,
                  ),
                );
              }
            },
            createRescueClient: this.createRescueClient,
            config: globalConfig,
          });
          if (guidance) {
            repairEvidence =
              `${verification.notes}\n\nRescue model diagnosis (follow this exactly):\n${guidance}`;
            try {
              this.store.addLesson(`${task.id} rescue: ${shortName(guidance, 240)}`, "rescue");
            } catch {
              // Lessons are best effort.
            }
            this.emit(
              this.store.appendEvent(
                task.id,
                run.id,
                "rescue",
                "diagnosis",
                shortName(guidance, 300),
              ),
            );
          } else {
            this.emit(
              this.store.appendEvent(
                task.id,
                run.id,
                "rescue",
                "consult",
                "Rescue model returned no usable guidance; continuing with strategy rotation.",
              ),
            );
          }
        }
        this.emit(
          this.store.appendEvent(
            task.id,
            run.id,
            "test-engineer",
            "repair",
            `Verification failed on attempt ${loopTurn}/${maxTurns}. Starting repair turn.`,
          ),
        );
      }
      if (!turn || !testTurn) {
        throw new Error("LoopForge worker did not run implementation and verification turns.");
      }
      this.store.updateTaskLoop(task.id, {
        phase: "reviewing",
        currentGate: "verification",
        verificationSummary: verificationNotes,
        nextAction: "Verification passed. LoopForge is preparing commit and review.",
        needsInputPrompt: null,
      });
      this.throwIfStopRequested(run.id);
      await this.runHooks(workflow, "after_run", session.cwd, task.id, run.id);

      const touchedPaths = await safeGitChangedFiles(session.cwd);
      task = this.store.updateTaskTouchedPaths(task.id, touchedPaths);
      this.recordConflictSignals(task, touchedPaths);
      task = this.store.getTask(task.id);
      const preCommitStatus = await safeGitStatus(session.cwd);
      const preCommitDiff = await safeGitDiffStat(session.cwd);
      const verificationSummary = summarizeVerificationEvidence({
        task,
        turn,
        testTurn,
        touchedPaths,
        preCommitStatus,
        preCommitDiff,
        verificationGates,
        verificationNotes,
      });
      task = this.store.updateTaskLoop(task.id, {
        phase: "reviewing",
        currentGate: "commit",
        verificationSummary,
        nextAction: "LoopForge is creating a commit before automatic review.",
      });
      const commit = await safeGitCommit(
        session.cwd,
        `${task.id}: ${task.title}`,
      );
      const status = await safeGitStatus(session.cwd);
      const diff = await safeGitDiffStat(session.cwd);
      const validation = [
        `Codex App Server turn completed.`,
        `Thread: ${turn.threadId}`,
        `Turn: ${turn.turnId}`,
        `Turn status: ${turn.status}`,
        `Test turn: ${testTurn.turnId}`,
        `Test turn status: ${testTurn.status}`,
        "",
        "Discovered verification gates:",
        verificationGates,
        "",
        "Verification verdict:",
        verificationNotes,
        "",
        `Commit: ${
          commit ?? (touchedPaths.length ? "not created" : "not needed (no file changes)")
        }`,
        "",
        "Pre-commit git status:",
        preCommitStatus.trim() || "clean",
        "",
        "Pre-commit diff stat:",
        preCommitDiff.trim() || "no tracked diff",
        "",
        "Git status:",
        status.trim() || "clean",
        "",
        "Diff stat:",
        diff.trim() || "no diff",
      ].join("\n");

      task = this.store.updateTaskWorkpad(
        task.id,
        buildWorkpad(task, session.threadId, turn.turnId),
      );
      task = this.store.updateTaskValidation(task.id, validation);
      task = this.store.updateTaskCard(task.id, buildTaskCard(task, touchedPaths));
      task = this.store.updateTaskHandoff(task.id, buildFinalHandoff(task, touchedPaths));
      if (isCommitFailure(commit)) {
        this.store.updateTaskLoop(task.id, {
          phase: "blocked",
          currentGate: "commit",
          verificationSummary,
          nextAction: "Fix the git commit blocker, add input if needed, then restart this task.",
          needsInputPrompt:
            "LoopForge could not create a commit. Check validation for git status and nested repository details.",
        });
        this.emit(
          this.store.requestTransition(
            task.id,
            "blocked",
            "worker",
            "LoopForge could not create a commit. Check validation for git status and nested repository details.",
          ).event,
        );
        this.store.finishRun(run.id, "failed");
        return this.store.getTask(task.id);
      }
      const reviewTransition = this.store.requestTransition(
        task.id,
        "review",
        "worker",
        "Codex turn completed and validation evidence was recorded.",
      );
      this.emit(
        reviewTransition.event,
      );
      const result = await this.reviewAndMerge(reviewTransition.task, run.id);
      supervisor.markPhase("done", "Task run completed.");
      this.store.finishRun(run.id, "completed");
      return result;
    } catch (error) {
      try {
        this.store.updateTaskActiveTurn(task.id, null);
      } catch {
        // Keep the original worker error if task state is unavailable.
      }
      if (error instanceof TriageRetryError) {
        this.store.finishRun(run.id, "failed");
        throw error;
      }
      if (error instanceof TaskStopRequestedError) {
        const prompt =
          "Task stopped by request. Add input if you want to change direction, then restart it.";
        this.store.updateTaskLoop(task.id, {
          phase: "blocked",
          currentGate: "stopped",
          nextAction: "This task was stopped by request. Add input or restart it when ready.",
          needsInputPrompt: prompt,
        });
        supervisor?.markPhase("blocked", "Task stopped by request.");
        this.emit(this.store.appendEvent(task.id, run.id, "worker", "stop", error.message));
        try {
          this.emit(
            this.store.requestTransition(
              task.id,
              "blocked",
              "worker",
              prompt,
            ).event,
          );
        } catch {
          // Preserve the stop result if a race already moved the task.
        }
        this.store.finishRun(run.id, "failed");
        return this.store.getTask(task.id);
      }
      this.store.finishRun(run.id, "failed");
      const message = error instanceof Error ? error.message : String(error);
      supervisor?.markPhase("blocked", message);
      this.emit(this.store.appendEvent(task.id, run.id, "worker", "error", message));
      try {
        this.emit(
          this.store.requestTransition(
            task.id,
            "blocked",
            "worker",
            `LoopForge needs input: ${message}`,
          ).event,
        );
      } catch {
        // Keep the original worker error if the task cannot move to Blocked from its current state.
      }
      throw error;
    } finally {
      stopMonitor?.();
      await codex.stop().catch(() => {});
    }
  }

  private async runOpsTaskAttempt(taskId: string): Promise<Task> {
    let task = this.store.getTask(taskId);
    const workflow = readWorkflow(this.root);
    const run = this.store.createRun(task.id, "worker");
    try {
      if (task.opsAction !== "publish") {
        return this.blockOpsTask(
          task.id,
          run.id,
          `This ops task has no supported harness action (got ${
            task.opsAction ?? "none"
          }). Re-plan it or convert it to a code task.`,
        );
      }
      if (!workflow.authority.publish) {
        return this.blockOpsTask(
          task.id,
          run.id,
          "Publishing is disabled by the WORKFLOW.md authority policy. Set authority.publish to true or push manually.",
        );
      }
      if (task.status === "inbox") {
        this.emit(
          this.store.requestTransition(task.id, "ready", "scheduler", "Dispatching ops task.")
            .event,
        );
      }
      this.emit(
        this.store.requestTransition(
          task.id,
          "in_progress",
          "core",
          "LoopForge harness claimed this ops task.",
        ).event,
      );
      task = await this.executePublish(task.id, run.id);
      this.store.finishRun(run.id, "completed");
      return task;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit(this.store.appendEvent(task.id, run.id, "core", "error", message));
      return this.blockOpsTask(
        task.id,
        run.id,
        `LoopForge publish failed: ${
          shortName(message, 300)
        } Fix the remote or credentials, then restart this task.`,
      );
    }
  }

  private blockOpsTask(taskId: string, runId: string, prompt: string): Task {
    this.store.updateTaskLoop(taskId, {
      phase: "blocked",
      currentGate: "publish",
      nextAction: "Read the blocker, fix it or add input, then restart this task.",
      needsInputPrompt: prompt,
    });
    this.store.upsertAgentStatus({
      taskId,
      runId,
      phase: "blocked",
      headline: "Publish blocked.",
      detail: prompt,
      risk: "needs_user",
      needsInputPrompt: prompt,
      interruptible: false,
    });
    try {
      this.emit(this.store.requestTransition(taskId, "blocked", "core", prompt).event);
    } catch {
      // Keep the blocked loop state even if the task already moved.
    }
    this.store.finishRun(runId, "failed");
    return this.store.getTask(taskId);
  }

  private async executePublish(taskId: string, runId: string): Promise<Task> {
    let task = this.store.getTask(taskId);
    this.store.updateTaskLoop(task.id, {
      phase: "working",
      currentGate: "publish",
      nextAction: "LoopForge is committing the root working tree and pushing to the remote.",
      needsInputPrompt: null,
    });
    this.store.upsertAgentStatus({
      taskId: task.id,
      runId,
      phase: "running",
      headline: "Publishing repository state.",
      detail: "Committing the root working tree and pushing to the remote.",
      risk: "none",
      interruptible: false,
    });
    const result = await gitPublishRoot(this.root, publishCommitMessage(task));
    this.emit(
      this.store.appendEvent(
        task.id,
        runId,
        "core",
        "publish",
        result.committed
          ? `Committed ${result.commit} and pushed ${result.branch} to ${result.remote}.`
          : `Pushed ${result.branch} to ${result.remote} at ${result.commit} (nothing new to commit).`,
      ),
    );
    if (result.ahead !== 0) {
      throw new Error(
        `Publish verification failed: ${result.branch} is still ${result.ahead} commit(s) ahead of ${result.remote}/${result.branch} after push.`,
      );
    }
    this.store.updateTaskLoop(task.id, {
      phase: "testing",
      currentGate: "verification",
      nextAction: "LoopForge is verifying the remote matches the local head.",
    });
    task = this.store.updateTaskValidation(task.id, buildPublishValidation(result));
    task = this.store.updateTaskCard(task.id, buildTaskCard(task));
    task = this.store.updateTaskHandoff(task.id, publishHandoff(task, result));
    if (task.status !== "review") {
      this.emit(
        this.store.requestTransition(
          task.id,
          "review",
          "core",
          "Publish completed with recorded evidence.",
        ).event,
      );
    }
    this.emit(
      this.store.requestTransition(
        task.id,
        "done",
        "core",
        `Published ${result.branch} to ${result.remote}; remote matches the local head.`,
      ).event,
    );
    let doneTask = this.store.getTask(task.id);
    doneTask = this.store.updateTaskCard(doneTask.id, buildTaskCard(doneTask));
    appendSpecsheetHandoff(this.root, doneTask);
    this.store.updateTaskLoop(doneTask.id, {
      phase: "done",
      currentGate: "complete",
      nextAction: "Publish is complete and the remote matches the local head.",
      needsInputPrompt: null,
    });
    this.store.upsertAgentStatus({
      taskId: doneTask.id,
      runId,
      phase: "done",
      headline: "Publish complete.",
      detail: `Pushed ${result.branch} to ${result.remote} at ${result.commit}.`,
      risk: "none",
      interruptible: false,
    });
    return this.store.getTask(doneTask.id);
  }

  private async triageBlocker(input: {
    taskId: string;
    runId: string;
    codex: CodexClient;
    blocker: string;
    workflow: WorkflowRuntime;
    startCapture: () => void;
    stopCapture: () => string;
  }): Promise<
    | { outcome: "retry" }
    | { outcome: "resolved"; task: Task }
    | { outcome: "escalate"; prompt: string }
  > {
    const escalate = (reason: string, prompt: string) => {
      this.emit(this.store.appendEvent(input.taskId, input.runId, "core", "triage", reason));
      return { outcome: "escalate" as const, prompt };
    };
    const task = this.store.getTask(input.taskId);
    const fingerprint = fingerprintBlocker(input.blocker);
    if (task.blockedFingerprint && task.blockedFingerprint === fingerprint) {
      return escalate(
        "Triage skipped: the same blocker repeated, so LoopForge is escalating to the user.",
        input.blocker,
      );
    }
    this.store.setBlockedFingerprint(task.id, fingerprint);
    if (task.triageAttempts >= input.workflow.authority.maxTriageRetries) {
      return escalate(
        "Triage budget exhausted for this task. Escalating to the user.",
        input.blocker,
      );
    }
    const mainThreadId = this.store.getProjectState().mainThreadId;
    if (!mainThreadId) {
      return escalate(
        "Triage skipped: no project main thread is available.",
        input.blocker,
      );
    }
    this.store.recordTriageAttempt(task.id, fingerprint);
    this.store.updateTaskLoop(task.id, {
      phase: "reviewing",
      currentGate: "triage",
      nextAction: "LoopForge main agent is triaging the worker blocker.",
    });
    this.store.upsertAgentStatus({
      taskId: task.id,
      runId: input.runId,
      phase: "reviewing",
      headline: "Main agent is triaging the blocker.",
      detail: shortName(input.blocker, 160),
      risk: "none",
      interruptible: false,
    });
    this.emit(
      this.store.appendEvent(
        task.id,
        input.runId,
        "core",
        "triage",
        "Main agent is triaging the worker blocker before asking the user.",
      ),
    );
    const allowedActions = input.workflow.authority.publish ? ["publish"] : [];
    let responseText = "";
    try {
      const session = await input.codex.resumeSession(this.root, mainThreadId, {
        name: mainThreadName(this.root),
        developerInstructions: mainThreadDeveloperInstructions(this.root),
      });
      input.startCapture();
      try {
        await input.codex.runTurn(session, {
          title: `${task.id}: triage`,
          prompt: buildTriagePrompt({
            runMode: this.runMode,
            task,
            blocker: input.blocker,
            allowedActions,
            projectMemory: buildProjectMemory(this.store),
            workflowInstructions: input.workflow.instructions,
          }),
        });
      } finally {
        responseText = input.stopCapture();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return escalate(
        `Triage turn failed (${shortName(message, 120)}); escalating.`,
        input.blocker,
      );
    }
    const decision = parseTriageResponse(responseText, allowedActions);
    this.store.recordSupervisorDecision(
      task.id,
      `Main agent triage: ${decision.verdict}${decision.action ? ` ${decision.action}` : ""}. ${
        shortName(decision.message || input.blocker, 180)
      }`,
    );
    if (decision.verdict === "resolve" && decision.action === "publish") {
      this.emit(
        this.store.appendEvent(
          task.id,
          input.runId,
          "core",
          "triage",
          "Main agent resolved the blocker with the harness publish action.",
        ),
      );
      try {
        const done = await this.executePublish(task.id, input.runId);
        this.store.setTaskKind(done.id, "ops", "publish");
        return { outcome: "resolved", task: this.store.getTask(done.id) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return escalate(
          `Main agent tried to publish but it failed: ${shortName(message, 160)}`,
          `LoopForge tried to publish but it failed: ${
            shortName(message, 240)
          } Fix the remote or credentials, then restart this task.`,
        );
      }
    }
    if (decision.verdict === "retry") {
      this.store.enqueueMessage(task.id, "core", decision.message);
      try {
        this.store.addLesson(shortName(decision.message, 240), "triage");
      } catch {
        // Lessons are best effort.
      }
      this.emit(
        this.store.appendEvent(
          task.id,
          input.runId,
          "core",
          "triage",
          `Main agent queued corrected instructions and requested one retry (${
            task.triageAttempts + 1
          }/${input.workflow.authority.maxTriageRetries}).`,
        ),
      );
      return { outcome: "retry" };
    }
    return escalate(
      "Main agent escalated this blocker to the user.",
      decision.message || input.blocker,
    );
  }

  private emit(event: ActivityEvent): void {
    this.onEvent?.(event);
  }

  private throwIfStopRequested(runId: string): void {
    if (this.store.isRunStopRequested(runId)) {
      throw new TaskStopRequestedError("Task stopped by request.");
    }
  }

  private startStopMonitor(
    taskId: string,
    runId: string,
    codex: CodexClient,
    getSession: () => CodexSession | null,
  ): () => void {
    let interruptStarted = false;
    const tick = () => {
      if (interruptStarted || !this.store.isRunStopRequested(runId)) {
        return;
      }
      interruptStarted = true;
      this.store.upsertAgentStatus({
        taskId,
        runId,
        phase: "blocked",
        headline: "Stopping active turn.",
        detail: "LoopForge is asking Codex to stop this task.",
        risk: "needs_user",
        interruptible: false,
      });
      this.emit(
        this.store.appendEvent(
          taskId,
          runId,
          "worker",
          "stop",
          "Stopping active Codex turn for this task.",
        ),
      );
      const session = getSession();
      if (session && codex.interruptTurn) {
        codex.interruptTurn(session).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          this.emit(this.store.appendEvent(taskId, runId, "worker", "stop", message));
        });
      }
    };
    const timer = setInterval(tick, 300);
    return () => clearInterval(timer);
  }

  async ensureMainThread(): Promise<string | null> {
    const current = this.store.getProjectState();
    if (current.mainThreadId) {
      return current.mainThreadId;
    }
    ensureProjectKnowledgeFiles(this.root);
    const codex = this.createCodexClient((event) => {
      if (shouldRecordActivity(event)) {
        this.emit(this.store.appendAgentEvent({ ...event, role: "main-thread" }));
      }
    });
    try {
      const session = await this.startSeededMainThread(codex);
      this.store.setMainThread(
        session.threadId,
        "Project main thread created and seeded by LoopForge. Child task threads fork from this memory thread and report compact handoffs here.",
      );
      return session.threadId;
    } finally {
      await codex.stop().catch(() => {});
    }
  }

  async compactMainThread(): Promise<ActivityEvent> {
    const projectState = this.store.getProjectState();
    if (!projectState.mainThreadId) {
      throw new Error("Project main thread has not been started.");
    }
    const codex = this.createCodexClient((event) => {
      if (shouldRecordActivity(event)) {
        this.emit(this.store.appendAgentEvent({ ...event, role: "main-thread" }));
      }
    });
    try {
      const session = await codex.resumeSession(this.root, projectState.mainThreadId, {
        name: mainThreadName(this.root),
        developerInstructions: mainThreadDeveloperInstructions(this.root),
      });
      await codex.compactThread?.(session);
      this.store.updateMainThreadSummary(
        [
          projectState.mainThreadSummary,
          "Main thread compaction requested by LoopForge.",
        ].filter(Boolean).join("\n"),
      );
      return this.store.appendEvent(
        null,
        null,
        "main-thread",
        "compact",
        "Main thread compaction started.",
      );
    } finally {
      await codex.stop().catch(() => {});
    }
  }

  private async replaceMainThread(codex: CodexClient): Promise<string> {
    const session = await this.startSeededMainThread(codex);
    this.store.resetMainThread(
      session.threadId,
      "Project main thread recreated and seeded because the saved Codex session was unavailable.",
    );
    return session.threadId;
  }

  private async startSeededMainThread(codex: CodexClient): Promise<CodexSession> {
    const session = await codex.startSession(this.root, {
      name: mainThreadName(this.root),
      developerInstructions: mainThreadDeveloperInstructions(this.root),
    });
    await codex.runTurn(session, {
      title: "LoopForge main thread seed",
      prompt: buildMainThreadSeedPrompt(this.root),
    });
    await codex.setThreadName?.(session, mainThreadName(this.root));
    return session;
  }

  private async absorbTaskIntoMainThread(task: Task): Promise<void> {
    const projectState = this.store.getProjectState();
    if (!projectState.mainThreadId) {
      return;
    }
    const codex = this.createCodexClient((event) => {
      if (shouldRecordActivity(event)) {
        this.emit(this.store.appendAgentEvent({ ...event, role: "main-thread" }));
      }
    });
    try {
      const session = await codex.resumeSession(this.root, projectState.mainThreadId);
      const result = await codex.runTurn(session, {
        title: `${task.id}: absorb`,
        prompt: buildMainThreadAbsorptionPrompt(task),
      });
      const summary = [
        projectState.mainThreadSummary,
        `${task.id} absorbed via ${result.turnId}: ${task.title}`,
      ].filter(Boolean).join("\n");
      this.store.updateMainThreadSummary(summary);
      this.emit(
        this.store.appendEvent(
          task.id,
          null,
          "main-thread",
          "absorb",
          `Main thread absorbed ${task.id}.`,
        ),
      );
    } finally {
      await codex.stop().catch(() => {});
    }
  }

  private recordConflictSignals(task: Task, touchedPaths: string[]): void {
    if (!touchedPaths.length) {
      return;
    }
    const activeTasks = this.store.getBoard().tasks.filter((candidate) =>
      candidate.id !== task.id && candidate.status !== "done"
    );
    for (const candidate of activeTasks) {
      const overlaps = touchedPaths.filter((file) => candidate.touchedPaths.includes(file));
      if (!overlaps.length) {
        continue;
      }
      const signal = `${candidate.id} also touches ${overlaps.join(", ")}.`;
      this.store.addConflictSignal(task.id, signal);
      this.store.addConflictSignal(candidate.id, `${task.id} also touches ${overlaps.join(", ")}.`);
      this.store.recordSupervisorDecision(
        task.id,
        `Detected file overlap with ${candidate.id}: ${overlaps.join(", ")}.`,
      );
      this.store.recordSupervisorDecision(
        candidate.id,
        `Paused or warned because ${task.id} touched ${overlaps.join(", ")}.`,
      );
      this.store.enqueueMessage(
        candidate.id,
        "steerer",
        `${task.id} may conflict with your work: ${
          overlaps.join(", ")
        }. Inspect before finalizing.`,
      );
      if (candidate.status === "ready" || candidate.status === "inbox") {
        try {
          this.emit(
            this.store.requestTransition(
              candidate.id,
              "blocked",
              "supervisor",
              `${task.id} touched ${overlaps.join(", ")}. Review conflict before starting.`,
            ).event,
          );
        } catch {
          // Keep the completed task flow moving if a race changed candidate state.
        }
      }
    }
  }

  private async reviewAndMerge(task: Task, runId: string): Promise<Task> {
    const config = readConfig(this.root);
    const workflow = readWorkflow(this.root);
    const usePullRequestGate = config.githubPrReview || workflow.githubPrReview;
    this.emit(
      this.store.appendEvent(
        task.id,
        runId,
        "reviewer",
        "phase",
        "Automatic review started.",
      ),
    );
    this.store.upsertAgentStatus({
      taskId: task.id,
      runId,
      phase: "reviewing",
      headline: "Automatic review started.",
      detail: "LoopForge is reviewing the task before merge.",
      risk: "none",
      interruptible: false,
    });
    this.store.updateTaskLoop(task.id, {
      phase: "reviewing",
      currentGate: "automatic-review",
      nextAction: "LoopForge reviewer is checking scope, diff, and validation evidence.",
    });
    const reviewer = new GoalReviewer(this.root, {
      runMode: this.runMode,
      createCodexClient: this.createReviewerClient,
      onEvent: (event) => {
        if (shouldRecordActivity(event)) {
          this.emit(
            this.store.appendEvent(
              task.id,
              runId,
              event.role,
              event.kind,
              event.message,
              event.raw,
            ),
          );
        }
      },
    });
    let pullRequest: PullRequestInfo | null = null;
    if (usePullRequestGate) {
      const latest = this.store.getTask(task.id);
      pullRequest = await this.pullRequestGate.open(
        latest,
        buildPullRequestBody(latest.validation, latest.workpad),
      );
      const validation = [
        latest.validation,
        "",
        `GitHub PR: ${pullRequest.url}`,
      ].filter(Boolean).join("\n");
      this.store.updateTaskValidation(task.id, validation);
      this.emit(
        this.store.appendEvent(
          task.id,
          runId,
          "github",
          "pr",
          `Opened review PR ${pullRequest.url}.`,
        ),
      );
    }
    const result = await reviewer.review(task);
    const latest = this.store.getTask(task.id);
    const reviewText = [
      latest.validation,
      "",
      `LoopForge review: ${result.verdict.toUpperCase()}`,
      result.notes,
    ].filter(Boolean).join("\n");
    this.store.updateTaskValidation(task.id, reviewText);
    this.emit(
      this.store.appendEvent(
        task.id,
        runId,
        "reviewer",
        "review",
        result.verdict === "approved"
          ? "Review approved. Preparing merge."
          : "Review requested changes. Waiting for user direction.",
      ),
    );

    if (result.verdict !== "approved") {
      // Review findings are actionable by an agent: feed them back as a bounded
      // repair pass (shared triage-retry budget) before asking the user.
      const latest = this.store.getTask(task.id);
      if (latest.triageAttempts < workflow.authority.maxTriageRetries) {
        this.store.recordTriageAttempt(
          task.id,
          fingerprintBlocker(`review: ${result.notes}`),
        );
        this.store.enqueueMessage(
          task.id,
          "reviewer",
          `Automatic review requested changes. Address exactly these findings:
${result.notes}`,
        );
        this.emit(
          this.store.appendEvent(
            task.id,
            runId,
            "reviewer",
            "retry",
            `Review requested changes; queued the findings for one repair pass (${
              latest.triageAttempts + 1
            }/${workflow.authority.maxTriageRetries}).`,
          ),
        );
        this.emit(
          this.store.requestTransition(
            task.id,
            "ready",
            "reviewer",
            "Review findings queued; re-running the task to address them.",
          ).event,
        );
        throw new TriageRetryError(
          `Review requested changes on ${task.id}; retrying with the findings queued.`,
        );
      }
      this.store.updateTaskLoop(task.id, {
        phase: "blocked",
        currentGate: "review",
        nextAction: "Add guidance for the requested changes, then restart this task.",
        needsInputPrompt: result.notes ||
          "Automatic review requested changes. Add input to continue.",
      });
      this.store.upsertAgentStatus({
        taskId: task.id,
        runId,
        phase: "blocked",
        headline: "Review requested changes.",
        detail: result.notes,
        risk: "needs_user",
        needsInputPrompt: "Automatic review requested changes. Add input to continue.",
        interruptible: false,
      });
      this.emit(
        this.store.requestTransition(
          task.id,
          "blocked",
          "reviewer",
          "Automatic review requested changes. Add a message to continue this task.",
        ).event,
      );
      return this.store.getTask(task.id);
    }

    if (!task.branchName) {
      this.store.updateTaskLoop(task.id, {
        phase: "blocked",
        currentGate: "merge",
        nextAction: "LoopForge needs a task branch before it can merge this work.",
        needsInputPrompt: "LoopForge cannot merge because this task has no assigned branch.",
      });
      this.emit(
        this.store.requestTransition(
          task.id,
          "blocked",
          "merger",
          "LoopForge cannot merge because this task has no assigned branch.",
        ).event,
      );
      return this.store.getTask(task.id);
    }

    // Attended sessions hold the merge when the evidence lists work only a human
    // can verify; restarting the parked task merges it without re-running anything.
    // PR-gate runs skip the hold: the open PR is already the parking spot.
    if (this.runMode === "attended" && !pullRequest) {
      const manual = listManualVerificationItems({ tasks: [this.store.getTask(task.id)] })[0];
      if (manual) {
        const prompt = [
          "Review approved. Merge is held until you verify by hand:",
          ...manual.notes.map((note) => `- ${note}`),
          "When verified, restart this task and LoopForge merges it immediately.",
        ].join("\n");
        this.store.updateTaskLoop(task.id, {
          phase: "reviewing",
          currentGate: "manual-verification",
          nextAction: "Verify the listed items by hand, then restart this task to merge.",
          needsInputPrompt: prompt,
        });
        this.store.upsertAgentStatus({
          taskId: task.id,
          runId,
          phase: "reviewing",
          headline: "Merge held for manual verification.",
          detail: manual.notes.join(" "),
          risk: "needs_user",
          needsInputPrompt: prompt,
          interruptible: false,
        });
        this.emit(
          this.store.appendEvent(
            task.id,
            runId,
            "merger",
            "hold",
            `Attended mode: holding ${task.id} in Review until manual verification. Restart the task to merge.`,
          ),
        );
        return this.store.getTask(task.id);
      }
    }
    return await this.mergeApprovedTask(task, runId, pullRequest);
  }

  private async mergeApprovedTask(
    task: Task,
    runId: string,
    pullRequest: PullRequestInfo | null,
  ): Promise<Task> {
    this.emit(
      this.store.requestTransition(
        task.id,
        "merging",
        pullRequest ? "github" : "merger",
        pullRequest ? "Review approved. Merging GitHub PR." : "Review approved. Merging branch.",
      ).event,
    );
    const output = pullRequest
      ? await this.pullRequestGate.merge(task, pullRequest)
      : await this.mergeBranch(task.branchName!);
    this.store.updateTaskLoop(task.id, {
      phase: "reviewing",
      currentGate: "merge",
      nextAction: "LoopForge is merging the approved task branch.",
    });
    this.store.upsertAgentStatus({
      taskId: task.id,
      runId,
      phase: "merging",
      headline: "Merging approved task.",
      detail: output.trim() || `Merged ${task.branchName}.`,
      risk: "none",
      interruptible: false,
    });
    this.emit(
      this.store.appendEvent(
        task.id,
        runId,
        pullRequest ? "github" : "merger",
        pullRequest ? "pr" : "merge",
        output.trim() || `Merged ${task.branchName}.`,
      ),
    );
    this.emit(
      this.store.requestTransition(
        task.id,
        "done",
        "merger",
        `Review approved and merged ${task.branchName}.`,
      ).event,
    );
    // The branch is merged into root now; reclaim its worktree and branch so a
    // long unattended run doesn't leak them. PR-path branches are left for the PR.
    if (!pullRequest && task.worktreePath && task.branchName) {
      await removeTaskWorktree(this.root, task.worktreePath, task.branchName);
    }
    let doneTask = this.store.getTask(task.id);
    doneTask = this.store.updateTaskLoop(doneTask.id, {
      phase: "remembering",
      currentGate: "project-memory",
      nextAction: "LoopForge is updating durable project memory from the task handoff.",
    });
    doneTask = this.store.updateTaskCard(doneTask.id, buildTaskCard(doneTask));
    appendSpecsheetHandoff(this.root, doneTask);
    try {
      await this.runSerialized(() => this.absorbTaskIntoMainThread(doneTask));
    } catch (error) {
      // The work is already merged; losing one memory absorption never fails the task.
      this.emit(
        this.store.appendEvent(
          doneTask.id,
          runId,
          "main-thread",
          "absorb",
          `Memory absorption failed (work is already merged): ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
    this.store.updateTaskLoop(doneTask.id, {
      phase: "done",
      currentGate: "complete",
      nextAction: "Task is complete and absorbed into project memory.",
      needsInputPrompt: null,
    });
    this.recordGoalEvidenceGaps(doneTask, runId);
    return this.store.getTask(task.id);
  }

  private recordGoalEvidenceGaps(task: Task, runId: string): void {
    this.createMissingGoalEvidenceRepairTask(task.goalId, task, runId);
  }

  private createMissingGoalEvidenceRepairTasks(runId: string | null): boolean {
    const board = this.store.getBoard();
    let created = false;
    for (const goal of board.goals) {
      if (goal.status === "closed") {
        continue;
      }
      const sourceTask = [...board.tasks].reverse().find((task) =>
        task.goalId === goal.id && task.status === "done"
      ) ?? null;
      if (this.createMissingGoalEvidenceRepairTask(goal.id, sourceTask, runId)) {
        created = true;
      }
    }
    return created;
  }

  private createMissingGoalEvidenceRepairTask(
    goalId: string,
    sourceTask: Task | null,
    runId: string | null,
  ): boolean {
    const board = this.store.getBoard();
    const progress = summarizeGoalProgress(board, goalId);
    if (
      !progress?.evidenceGaps.length ||
      !progress.total ||
      progress.done !== progress.total
    ) {
      return false;
    }
    const contractOnly = progress.evidenceGaps.every((gap) => progress.contractGaps.includes(gap));
    const title = contractOnly ? "Prove Goal Contract Evidence" : "Repair Goal Evidence";
    const existingRepair = board.tasks.some((candidate) =>
      candidate.goalId === goalId && candidate.title === title
    );
    if (existingRepair) {
      return false;
    }
    const gaps = progress.evidenceGaps.slice(0, 6);
    const message = contractOnly
      ? `Goal contract still needs evidence: ${gaps.slice(0, 2).join(" ")}`
      : `Goal completion still needs evidence: ${gaps.slice(0, 2).join(" ")}`;
    if (sourceTask) {
      this.store.recordSupervisorDecision(sourceTask.id, message);
    }
    this.emit(
      this.store.appendEvent(
        sourceTask?.id ?? null,
        runId,
        "supervisor",
        contractOnly ? "contract-gap" : "evidence-gap",
        message,
      ),
    );
    const result = this.store.addTasksToGoal(goalId, [{
      title,
      description: repairTaskDescription(contractOnly, gaps),
      acceptanceCriteria: repairTaskAcceptanceCriteria(contractOnly),
      priority: sourceTask ? Math.max(1, sourceTask.priority - 1) : 50,
      riskLevel: "medium",
      verificationPlan: repairTaskVerificationPlan(contractOnly),
      workpad: [
        contractOnly
          ? "Automatically created by LoopForge because all current tasks finished but the goal completion contract still lacked proof."
          : "Automatically created by LoopForge because all current tasks finished but completion evidence was incomplete.",
        `Source task: ${sourceTask?.id ?? "queue preflight"}`,
      ].join("\n"),
    }]);
    const repairTask = result.tasks[0];
    this.emit(
      this.store.appendEvent(
        repairTask.id,
        runId,
        "supervisor",
        contractOnly ? "contract-repair-task" : "evidence-repair-task",
        contractOnly
          ? `Created ${repairTask.id} to collect missing goal contract evidence.`
          : `Created ${repairTask.id} to repair missing goal completion evidence.`,
      ),
    );
    return true;
  }

  // Merges and main-thread absorption mutate shared state (the root repo and
  // the single project memory thread); parallel agents take turns through one
  // chain so two finishing tasks never collide.
  private async runSerialized<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.mergeChain;
    let release = () => {};
    this.mergeChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }

  private async mergeBranch(branchName: string): Promise<string> {
    // runSerialized orders merges within this process; the lease inside
    // gitMergeBranchLeased orders them across separate LoopForge processes
    // sharing this root, so two workers never run `git merge` at once.
    return await this.runSerialized(() => gitMergeBranchLeased(this.store, this.root, branchName));
  }

  private async runHooks(
    workflow: WorkflowRuntime,
    stage: "after_create" | "before_run" | "after_run" | "before_remove",
    cwd: string,
    taskId: string,
    runId: string,
  ): Promise<void> {
    for (const message of await runWorkflowHooks(workflow, stage, cwd)) {
      this.emit(this.store.appendEvent(taskId, runId, "workflow", stage, message));
    }
  }
}

function repairTaskDescription(contractOnly: boolean, gaps: string[]): string {
  return [
    contractOnly
      ? "Collect or add the missing validation evidence required by the active goal completion contract."
      : "Collect or add the missing validation evidence required before LoopForge can close this goal.",
    "",
    contractOnly ? "Missing contract proof:" : "Missing completion evidence:",
    ...gaps.map((gap) => `- ${gap}`),
  ].join("\n");
}

function repairTaskAcceptanceCriteria(contractOnly: boolean): string {
  return [
    contractOnly
      ? "- Record concrete validation, smoke-test, handoff, or task-card evidence for every listed contract gap."
      : "- Record concrete validation, smoke-test, handoff, or task-card evidence for every listed evidence gap.",
    "- Quote each listed gap exactly next to the proof that clears it.",
    "- Do not change product behavior unless the missing proof reveals a real implementation defect.",
    contractOnly
      ? "- Leave the goal ready to close with zero contract gaps."
      : "- Leave the goal ready to close with zero completion evidence gaps.",
  ].join("\n");
}

function repairTaskVerificationPlan(contractOnly: boolean): string {
  return [
    contractOnly
      ? "- Inspect the goal completion contract and current evidence gaps."
      : "- Inspect current LoopForge validation evidence gaps for the completed goal.",
    contractOnly
      ? "- Run the cheapest reliable validation that proves the missing contract clause."
      : "- Run or inspect the cheapest reliable validation that proves the missing evidence entry.",
    contractOnly
      ? "- Update validation or handoff text with the exact proof terms needed by the contract."
      : "- Update validation or handoff text with the exact evidence gap text and proof that clears it.",
  ].join("\n");
}

function publishCommitMessage(task: Task): string {
  return shortName(task.title, 72) || `LoopForge publish for ${task.id}`;
}

function buildPublishValidation(result: PublishResult): string {
  return [
    "LoopForge publish action completed.",
    "Turn status: completed",
    "Test turn status: completed",
    "",
    "Discovered verification gates:",
    `- Remote sync check: git rev-list --left-right --count ${result.remote}/${result.branch}...HEAD must report 0 ahead after push.`,
    "",
    "Verification verdict:",
    "VERIFICATION_PASSED",
    result.committed
      ? `- Committed the root working tree as ${result.commit} and pushed ${result.branch} to ${result.remote}.`
      : `- Pushed existing commits on ${result.branch} to ${result.remote}; head is ${result.commit}.`,
    `- Remote sync after push: ${result.ahead} ahead / ${result.behind} behind ${result.remote}/${result.branch}.`,
    ...(result.pushOutput ? [`- Push output: ${shortName(result.pushOutput, 200)}`] : []),
    "",
    `Commit: ${result.commit}`,
    "",
    "Git status:",
    result.status || "clean",
    "",
    "LoopForge review: APPROVED",
    "- Deterministic publish verification: the remote head matches the local head after push.",
  ].join("\n");
}

function publishHandoff(task: Task, result: PublishResult): string {
  return [
    `Published ${result.branch} to ${result.remote} for ${task.id}: ${task.title}.`,
    result.committed
      ? `Committed the root working tree as ${result.commit} before pushing.`
      : `No new commit was needed; pushed existing commits at ${result.commit}.`,
    "Remote and local heads match after push.",
  ].join("\n");
}

function buildPullRequestBody(validation: string, workpad: string): string {
  return [
    "Created by LoopForge during automatic review.",
    "",
    "## Validation",
    validation || "No validation evidence recorded.",
    "",
    "## Workpad",
    workpad || "No workpad notes recorded.",
  ].join("\n");
}

function buildWorkerPrompt(
  root: string,
  task: Task,
  projectInstructions: string,
  workflowInstructions: string,
  projectMemory: string,
  queuedMessages: QueuedMessage[],
  repairEvidence = "",
  strategy = "",
  runMode: RunMode = "attended",
): string {
  const instructions = [
    ["autonomy.md", autonomyContract(runMode)],
    ["constitution.md", PROMPTS["constitution.md"]],
    ["project.md", PROMPTS["project.md"]],
    ["engineering.md", PROMPTS["engineering.md"]],
    ["workflow.md", PROMPTS["workflow.md"]],
    ["worker.md", PROMPTS["worker.md"]],
  ].map(([name, content]) => `## ${name}\n${content}`).join("\n\n");

  return `You are a LoopForge Codex worker.

LoopForge instructions:
${instructions}

Project AGENTS.md context from the original folder:
${projectInstructions}

Repo WORKFLOW.md instructions:
${workflowInstructions}

Current LoopForge board memory:
${projectMemory}

LoopForge context manifest:
${task.contextManifestPath ?? "No generated context manifest was assigned."}

Queued messages for this task:
${formatQueuedMessages(queuedMessages)}

${repairEvidence ? `Repair evidence from failed verification:\n${repairEvidence}\n` : ""}
${strategy ? `Repair strategy for this attempt (follow it):\n${strategy}\n` : ""}

Task:
- ID: ${task.id}
- Title: ${task.title}
- Description: ${task.description}
- Branch: ${task.branchName ?? "unassigned"}
- Worktree: ${task.worktreePath ?? "current workspace"}
- Risk: ${task.riskLevel}
- Dependencies: ${task.dependencyIds.length ? task.dependencyIds.join(", ") : "none"}
- Loop phase: ${task.loopPhase}
- Attempt: ${task.loopAttempt}

Acceptance criteria:
${task.acceptanceCriteria || "- Complete the task described above."}

Verification plan:
${task.verificationPlan || "- Run focused validation for the changed surface."}

Current workpad:
${task.workpad || "No workpad notes yet."}

Rules:
- Run as close as possible to normal Codex in this folder: respect the project AGENTS.md context above, local repo conventions, and the user's installed Codex environment and skills.
- Read the generated context manifest before editing when it is present.
- Subagents are for short, scoped investigation or review only. Never spawn autonomous sibling threads, background workers, or delegate implementation to other agents: LoopForge owns scheduling and concurrency, and uncontrolled fan-out burns the user's tokens.
- Work only in this assigned worktree.
- Do not inspect or modify ${root}/.loopforge/board.sqlite or any LoopForge runtime state. The LoopForge daemon records board, workpad, status, and validation updates after your turn completes.
- Make the implementation changes needed for this task.
- Do not create commits yourself. The LoopForge daemon will commit completed work after your turn.
- Work as a bounded loop: understand, plan briefly, edit, verify, repair if needed, then hand off exact evidence.
- Keep scope tight. If you discover unrelated or follow-up work, mention it in your final response instead of doing it silently.
- Run the exact validation needed for the files you touch.
- Do not wait for user input. Only an absolute blocker from autonomy.md may stop this task; for anything else decide, note it, and keep going. If an acceptance criterion needs the running app, manual QA, or visual review, complete the work and record "Needs manual verification: <what and how>" in your handoff.
- End with a compact LoopForge handoff containing changed files, validation commands/results, decisions, risks, and follow-ups.
`;
}

// Each repair attempt changes strategy instead of repeating the last one.
function repairStrategy(loopTurn: number): string {
  if (loopTurn <= 1) {
    return "";
  }
  if (loopTurn === 2) {
    return "- Make the smallest possible fix for the exact failure in the repair evidence. Do not refactor.";
  }
  if (loopTurn === 3) {
    return [
      "- Stop patching. Reproduce the failure first with the exact failing command.",
      "- Add temporary diagnostic output if needed, find the root cause, then fix it and remove the diagnostics.",
    ].join("\n");
  }
  return [
    "- Patching has failed repeatedly. Rewrite the failing function or file from scratch with the simplest approach that satisfies the acceptance criteria.",
    "- Re-run the exact failing command before handing off.",
  ].join("\n");
}

function buildMainThreadSeedPrompt(root: string): string {
  return `You are the persistent LoopForge main thread for ${root}.

Role:
- Keep project-level memory for LoopForge.
- Future task workers may fork from this thread into isolated worktrees.
- Completed task workers will report compact handoffs back here.

Rules:
- Do not edit files or run commands for this seed turn.
- Reply with one short sentence confirming the project memory thread is ready.
`;
}

function mainThreadName(root: string): string {
  return `LoopForge - ${projectName(root)} - main`;
}

function taskThreadName(root: string, task: Task): string {
  return `LoopForge - ${projectName(root)} - ${task.id} - ${shortName(task.title, 48)}`;
}

function taskThreadOptions(root: string, task: Task): CodexSessionOptions {
  return {
    name: taskThreadName(root, task),
    developerInstructions: [
      "You are a LoopForge task worker running as a child Codex thread.",
      "Work only in the assigned worktree.",
      "Do not spawn other threads, workers, or delegated agents; LoopForge owns scheduling.",
      "Read the generated context manifest and project AGENTS.md before editing.",
      "Do not mutate LoopForge runtime database or .loopforge state directly.",
      "End with a compact handoff containing changed files, validation, decisions, risks, and follow-ups.",
    ].join("\n"),
  };
}

function mainThreadDeveloperInstructions(root: string): string {
  return [
    `You are the persistent LoopForge main thread for ${root}.`,
    "Keep durable project memory, decisions, completed handoffs, conflicts, and follow-ups.",
    "Do not perform task implementation work in this thread unless LoopForge explicitly asks.",
    "Prefer compact factual summaries over raw logs.",
  ].join("\n");
}

function projectName(root: string): string {
  return root.split(/[\\/]/).filter(Boolean).at(-1) ?? "project";
}

// First substantive line of a verifier dump, skipping the verdict token itself.
function firstFailureLine(notes: string): string {
  const line = notes.split(/\r?\n/)
    .map((entry) => entry.replace(/^[-*\s]+/, "").trim())
    .find((entry) => entry && !/^VERIFICATION_(FAILED|PASSED)\b/i.test(entry) && entry.length > 8);
  return line ?? "see validation for details.";
}

function shortName(value: string, max: number): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 3)}...` : cleaned;
}

function formatQueuedMessages(messages: QueuedMessage[]): string {
  if (!messages.length) {
    return "No queued messages for this task.";
  }
  return messages.map((message) => `- ${message.createdAt} ${message.role}: ${message.message}`)
    .join("\n");
}

function buildWorkpad(task: Task, threadId: string, turnId: string): string {
  return [
    task.workpad,
    "",
    "Codex worker handoff:",
    `- Thread: ${threadId}`,
    `- Turn: ${turnId}`,
    "- Review the assigned worktree for the implementation diff and validation evidence.",
  ].filter(Boolean).join("\n");
}

function summarizeVerificationEvidence(input: {
  task: Task;
  turn: CodexTurnResult;
  testTurn: CodexTurnResult;
  touchedPaths: string[];
  preCommitStatus: string;
  preCommitDiff: string;
  verificationGates: string;
  verificationNotes: string;
}): string {
  const files = input.touchedPaths.length ? input.touchedPaths.join(", ") : "no tracked files yet";
  const status = input.preCommitStatus.trim() || "clean";
  const diff = input.preCommitDiff.trim() || "no diff stat";
  return [
    `Implementation turn ${input.turn.turnId} ${input.turn.status}.`,
    `Test turn ${input.testTurn.turnId} ${input.testTurn.status}.`,
    `Touched: ${shortName(files, 220)}.`,
    `Pre-commit status: ${shortName(status, 220)}.`,
    `Diff: ${shortName(diff, 220)}.`,
    `Plan: ${
      shortName(
        input.task.verificationPlan || "Run focused validation for the changed surface.",
        220,
      )
    }`,
    `Gates: ${shortName(input.verificationGates, 220)}`,
    `Verdict: ${shortName(input.verificationNotes, 220)}`,
  ].join("\n");
}

async function openTaskSession(
  codex: CodexClient,
  task: Task,
  worktreePath: string,
  parentThreadId: string | null,
  options: CodexSessionOptions,
): Promise<CodexSession> {
  const cwd = task.worktreePath ?? worktreePath;
  if (task.threadId) {
    // Threads are harness-specific: after a backend switch (or a pruned
    // session file) the stored thread cannot resume. The durable task state
    // lives on the board (card, workpad, validation), so fall back to a
    // fresh session instead of wedging the task.
    try {
      return await codex.resumeSession(cwd, task.threadId, options);
    } catch (error) {
      if (isMissingCodexThreadError(error)) {
        throw error; // The caller has dedicated recovery for this case.
      }
      // Fall through to fork/start below.
    }
  }
  if (parentThreadId && codex.forkSession) {
    try {
      return await codex.forkSession(cwd, parentThreadId, options);
    } catch (error) {
      if (isMissingCodexThreadError(error)) {
        throw error; // The caller has dedicated recovery for this case.
      }
      return await codex.startSession(cwd, options);
    }
  }
  return await codex.startSession(cwd, options);
}

function isMissingCodexThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("no rollout found for thread id") ||
    message.includes("no thread found") ||
    message.includes("thread not found");
}

async function safeGitStatus(cwd: string): Promise<string> {
  try {
    return await gitStatus(cwd);
  } catch (error) {
    return `Unable to read git status: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function safeGitDiffStat(cwd: string): Promise<string> {
  try {
    return await gitDiffStat(cwd);
  } catch (error) {
    return `Unable to read diff stat: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function safeGitChangedFiles(cwd: string): Promise<string[]> {
  try {
    return await gitChangedFiles(cwd);
  } catch {
    return [];
  }
}

async function safeGitCommit(cwd: string, message: string): Promise<string | null> {
  try {
    return await gitCommitAll(cwd, message);
  } catch (error) {
    return `commit failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function isCommitFailure(commit: string | null): boolean {
  return commit?.startsWith("commit failed:") ?? false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
