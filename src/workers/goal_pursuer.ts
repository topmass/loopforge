// The pursue loop: keep working a goal until its win conditions pass, the
// budget runs out, or it genuinely needs the user. Each iteration runs the
// goal's dispatchable tasks, executes the win-condition probes, and when all
// tasks are done but probes still fail, asks the main agent to plan the next
// tasks from the failing probe output. Same-failure iterations escalate to a
// stronger backend once (when configured), then stop with a clear ask.

import { BoardStore } from "../board/store.ts";
import { summarizeGoalProgress } from "../board/goal_progress.ts";
import { ActivityEvent, ActivityEventInput, Goal } from "../board/types.ts";
import { readGlobalConfig } from "../board/global_config.ts";
import { createAgentClient, createPlannerClient } from "./agent_backend.ts";
import { fingerprintBlocker } from "./blocker_triage.ts";
import { CodexClient } from "./codex_app_server.ts";
import { parsePlannerResponse } from "./goal_planner.ts";
import { probeLights, runGoalProbes } from "./goal_probes.ts";
import { runScout } from "./goal_scout.ts";
import { LoopForgeWorker } from "./loopforge_worker.ts";
import { runCommand } from "./git_utils.ts";
import { buildProjectMemory } from "./project_memory.ts";
import { shouldRecordActivity } from "./activity_filter.ts";

export interface PursueOptions {
  hours?: number;
  maxIterations?: number;
  escalateBackend?: string;
  onEvent?: (event: ActivityEvent) => void;
  createCodexClient?: (onEvent: (event: ActivityEventInput) => void) => CodexClient;
}

export interface PursueReport {
  goalId: string;
  closed: boolean;
  iterations: number;
  reason: string;
  asks: string[];
}

export class GoalPursuer {
  constructor(
    private readonly root: string,
    private readonly store: BoardStore,
    private readonly options: PursueOptions = {},
  ) {}

  async pursueAll(): Promise<PursueReport[]> {
    const reports: PursueReport[] = [];
    for (const goal of this.openGoals()) {
      reports.push(await this.pursue(goal.id));
    }
    return reports;
  }

  async pursue(goalId: string): Promise<PursueReport> {
    const deadline = Date.now() + (this.options.hours ?? 2) * 3_600_000;
    await this.ensureRunBaseline(goalId);
    const maxIterations = this.options.maxIterations ?? 24;
    let lastFailureFingerprint = "";
    let escalated = false;
    let replanned = false;
    let lastScoutAt = Date.now();

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      if (Date.now() >= deadline) {
        return this.finish(goalId, iteration, "Time budget exhausted.");
      }
      const goal = this.store.getGoal(goalId);
      if (goal.status === "closed") {
        return { goalId, closed: true, iterations: iteration, reason: "Goal is closed.", asks: [] };
      }
      this.emit(goalId, "iteration", `Pursue iteration ${iteration}/${maxIterations} started.`);

      await this.runGoalTasks(goalId, escalated, deadline);
      escalated = false;

      // Long runs feed the idea list too: one scout pass per hour, never fatal.
      if (Date.now() - lastScoutAt >= 3_600_000) {
        lastScoutAt = Date.now();
        try {
          await runScout(this.root, this.store, { onEvent: this.options.onEvent });
        } catch (error) {
          this.emit(
            goalId,
            "scout",
            `Scout pass failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      const probeSummary = await runGoalProbes(this.root, this.store, goalId);
      if (probeSummary.total) {
        this.emit(
          goalId,
          "probes",
          `Win conditions ${probeSummary.passed}/${probeSummary.total} ${
            probeLights(this.store.listProbes(goalId))
          }`,
        );
      }

      const progress = summarizeGoalProgress(this.store.getBoard(), goalId);
      if (progress?.completionReady) {
        const result = this.store.closeGoal(
          goalId,
          `${progress.done}/${progress.total} tasks done. ${progress.completionReason}`,
        );
        this.options.onEvent?.(result.event);
        return {
          goalId,
          closed: true,
          iterations: iteration,
          reason: "All win conditions passed.",
          asks: [],
        };
      }

      const asks = this.blockedAsks(goalId);
      const hasRunnable = this.store.getBoard().tasks.some((task) =>
        task.goalId === goalId && (task.status === "ready" || task.status === "inbox")
      );
      if (hasRunnable) {
        continue;
      }

      const failing = probeSummary.results.filter((result) => !result.passed);
      if (!failing.length && asks.length) {
        return this.finish(goalId, iteration, "Every remaining task needs user input.", asks);
      }

      const fingerprint = fingerprintBlocker(
        failing.map((result) => `${result.probe.label} ${result.output}`).join("\n") ||
          asks.join("\n"),
      );
      if (fingerprint && fingerprint === lastFailureFingerprint && replanned) {
        if (this.options.escalateBackend && !escalated) {
          escalated = true;
          replanned = false;
          this.emit(
            goalId,
            "escalate",
            `Same failure twice; escalating the next pass to the ${this.options.escalateBackend} backend.`,
          );
        } else {
          return this.finish(
            goalId,
            iteration,
            "The same win conditions kept failing after a replan; LoopForge needs direction.",
            asks.length
              ? asks
              : failing.map((result) =>
                `${result.probe.label} still failing: ${result.output.slice(0, 160)}`
              ),
          );
        }
      }
      lastFailureFingerprint = fingerprint;

      if (failing.length || asks.length) {
        const planned = await this.replan(goalId, failing, asks);
        replanned = true;
        if (!planned) {
          return this.finish(
            goalId,
            iteration,
            "LoopForge could not plan further tasks for the failing win conditions.",
            asks,
          );
        }
        continue;
      }
      // No probes, nothing runnable, not closeable: rely on evidence-repair
      // machinery via one more queue pass, then stop if nothing changed.
      const repaired = await this.runGoalTasks(goalId, false, deadline);
      if (!repaired) {
        return this.finish(goalId, iteration, "Nothing left to run and the goal is not closeable.");
      }
    }
    return this.finish(goalId, maxIterations, "Iteration budget exhausted.");
  }

  private async runGoalTasks(
    goalId: string,
    escalate: boolean,
    deadline: number,
  ): Promise<boolean> {
    const factory = escalate && this.options.escalateBackend
      ? (onEvent: (event: ActivityEventInput) => void) =>
        createAgentClient(this.root, onEvent, {
          ...readGlobalConfig(),
          backend: normalizeEscalation(this.options.escalateBackend!),
        })
      : this.options.createCodexClient;
    const worker = new LoopForgeWorker(this.root, this.store, {
      onEvent: this.options.onEvent,
      createCodexClient: factory,
      runMode: "unattended",
    });
    // Slot-based queue scoped to this goal: parallel agents, refilled as they
    // free up, with the pursue deadline halting new dispatches.
    try {
      const completed = await worker.runQueue(Number.POSITIVE_INFINITY, undefined, {
        filter: (task) => task.goalId === goalId,
        shouldStop: () => Date.now() >= deadline,
      });
      return completed.length > 0;
    } catch (error) {
      this.emit(
        goalId,
        "task-error",
        `Goal task run failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private async replan(
    goalId: string,
    failing: Array<{ probe: { label: string; command: string }; output: string }>,
    asks: string[],
  ): Promise<boolean> {
    const plannerRouted = readGlobalConfig().planner.enabled && !this.options.createCodexClient;
    const mainThreadId = this.store.getProjectState().mainThreadId;
    if (!mainThreadId && !plannerRouted) {
      return false;
    }
    let responseText = "";
    const factory = this.options.createCodexClient ??
      ((onEvent: (event: ActivityEventInput) => void) => createPlannerClient(this.root, onEvent));
    const codex = factory((event) => {
      if (event.role === "codex" && event.kind === "agent") {
        responseText += event.message;
      }
      if (shouldRecordActivity({ ...event, role: "pursuer" })) {
        this.options.onEvent?.(this.store.appendAgentEvent({ ...event, role: "pursuer" }));
      }
    });
    try {
      // A routed planner backend cannot resume the main thread's session, so it
      // starts fresh; the replan prompt already carries the project memory.
      const session = plannerRouted || !mainThreadId
        ? await codex.startSession(this.root)
        : await codex.resumeSession(this.root, mainThreadId);
      const goal = this.store.getGoal(goalId);
      await codex.runTurn(session, {
        title: `${goalId}: replan`,
        prompt: buildReplanPrompt(goal, failing, asks, buildProjectMemory(this.store)),
      });
      const drafts = parsePlannerResponse(responseText);
      if (!drafts.length) {
        return false;
      }
      const result = this.store.addTasksToGoal(goalId, drafts.slice(0, 3));
      this.emit(
        goalId,
        "replan",
        `Planned ${result.tasks.length} follow-up task${
          result.tasks.length === 1 ? "" : "s"
        } from failing win conditions: ${result.tasks.map((task) => task.title).join("; ")}`,
      );
      return true;
    } catch (error) {
      this.emit(
        goalId,
        "replan",
        `Replanning failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    } finally {
      await codex.stop().catch(() => {});
    }
  }

  // One tag per pursue invocation marks the pre-run commit, so a whole
  // unattended night of auto-merges can be discarded with a single reset.
  private baselineTag: string | null = null;

  private async ensureRunBaseline(goalId: string): Promise<void> {
    if (this.baselineTag !== null) {
      return;
    }
    this.baselineTag = "";
    try {
      const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
      const tag = `loopforge/run-${stamp.slice(0, 8)}-${stamp.slice(8, 14)}`;
      await runCommand(this.root, ["git", "tag", tag]);
      this.baselineTag = tag;
      this.emit(
        goalId,
        "baseline",
        `Tagged run baseline ${tag}. Discard everything from this run with: git reset --hard ${tag}`,
      );
    } catch {
      // Baselines are best effort; a non-repo or tag clash never blocks the run.
    }
  }

  private blockedAsks(goalId: string): string[] {
    return this.store.getBoard().tasks
      .filter((task) => task.goalId === goalId && task.status === "blocked")
      .map((task) => `${task.id}: ${task.needsInputPrompt ?? task.blockedReason ?? "needs input"}`);
  }

  private finish(
    goalId: string,
    iterations: number,
    reason: string,
    asks: string[] = [],
  ): PursueReport {
    this.emit(goalId, "stopped", `Pursue stopped: ${reason}`);
    return { goalId, closed: false, iterations, reason, asks };
  }

  private openGoals(): Goal[] {
    return this.store.getBoard().goals.filter((goal) => goal.status === "open");
  }

  private emit(goalId: string, kind: string, message: string): void {
    this.options.onEvent?.(
      this.store.appendEvent(null, null, "pursuer", kind, `${goalId}: ${message}`),
    );
  }
}

function normalizeEscalation(value: string): "codex" | "claude" | "local" {
  // "pi" merged into "local": a legacy escalation target resolves to local.
  if (value === "pi") {
    return "local";
  }
  return value === "claude" || value === "local" ? value : "codex";
}

function buildReplanPrompt(
  goal: Goal,
  failing: Array<{ probe: { label: string; command: string }; output: string }>,
  asks: string[],
  projectMemory: string,
): string {
  return `You are the LoopForge main agent replanning an open goal during a pursue loop.

Goal ${goal.id}: ${goal.text}

Completion contract:
${goal.completionContract}

Failing win-condition probes (command, then last output):
${
    failing.length
      ? failing.map((result) =>
        `- ${result.probe.label}\n  command: ${result.probe.command}\n  output: ${
          result.output.slice(0, 400)
        }`
      ).join("\n")
      : "- none failing; tasks are blocked instead"
  }

Blocked task asks:
${asks.length ? asks.map((ask) => `- ${ask}`).join("\n") : "- none"}

Current LoopForge board memory:
${projectMemory}

Rules:
- Output only a JSON array of 1 to 3 task objects: title, prompt, acceptanceCriteria,
  priority, workpad, dependsOn, riskLevel, verificationPlan.
- Plan the smallest tasks that will make the failing probes pass. Use the probe output
  as the ground truth for what is broken.
- Do not repeat work that is already done; build on it.
- If a previous attempt failed the same way, choose a DIFFERENT strategy this time:
  reproduce and diagnose first, or rewrite the failing surface, instead of patching again.
- Do not ask the user questions. If the blocker truly needs the user, return [].
`;
}
