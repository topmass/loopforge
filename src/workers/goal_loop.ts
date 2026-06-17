// The LoopForge goal loop: one persistent agent session owns a whole goal in
// the goal's worktree, maintaining its own plan (LOOP_PLAN.md) that LoopForge
// mirrors live onto the board. The shell stays deterministic - it commits
// progress after every turn, injects queued messages and probe results,
// detects stalls, and gates completion behind the goal's win-condition probes.
// Identical control flow on every backend; this is the unified replacement for
// the per-task relay.

import path from "node:path";
import { BoardStore } from "../board/store.ts";
import { ActivityEvent, ActivityEventInput, Goal } from "../board/types.ts";
import { autonomyContract, RunMode } from "../board/prompts.ts";
import { planUpdated } from "../board/lifecycle.ts";
import { createAgentClient } from "./agent_backend.ts";
import { CodexClient, CodexSession } from "./codex_app_server.ts";
import { isMissingCodexThreadText } from "./codex_event_normalizer.ts";
import { collectAgentsInstructions } from "./project_context.ts";
import {
  ensureGitRepository,
  gitCommitAll,
  gitMergeBranch,
  prepareGoalWorktree,
  runCommand,
} from "./git_utils.ts";
import { probeLights, runGoalProbes } from "./goal_probes.ts";
import { readWorkflow } from "../workflow/workflow.ts";
import {
  FanoutRunner,
  findScopeConflict,
  LOOP_FANOUT_TOKEN,
  parseFanoutRequest,
  summarizeFanout,
} from "./fanout.ts";
import { shouldRecordActivity } from "./activity_filter.ts";
import {
  extractBlockedAsk,
  LOOP_PLAN_FILE,
  loopPlanComplete,
  loopPlanContract,
  loopPlanFingerprint,
  parseLoopPlan,
  signalsComplete,
} from "./loop_plan.ts";

export interface GoalLoopOptions {
  hours?: number;
  tokenBudget?: number;
  maxIterations?: number;
  runMode?: RunMode;
  // Ask clarifying questions before planning (Codex-style). One-shot: the very
  // first turn asks, the loop stops; answering in chat auto-resumes it and the
  // answers (now queued) make it plan instead of re-asking.
  questionMode?: boolean;
  onEvent?: (event: ActivityEvent) => void;
  createCodexClient?: (
    onEvent: (event: ActivityEventInput) => void,
  ) => CodexClient;
}

export interface GoalLoopReport {
  goalId: string;
  iterations: number;
  outcome: "complete" | "merged" | "held" | "blocked" | "budget" | "stalled" | "closed";
  detail: string;
}

const STALL_LIMIT = 2;

export class GoalLoopRunner {
  private readonly createCodexClient: (
    onEvent: (event: ActivityEventInput) => void,
  ) => CodexClient;
  private readonly runMode: RunMode;

  constructor(
    private readonly root: string,
    private readonly store: BoardStore,
    private readonly options: GoalLoopOptions = {},
  ) {
    this.createCodexClient = options.createCodexClient ??
      ((onEvent) => createAgentClient(this.root, onEvent));
    this.runMode = options.runMode ?? (options.hours ? "unattended" : "attended");
  }

  async run(goalId: string): Promise<GoalLoopReport> {
    const goal = this.store.getGoal(goalId);
    if (goal.status === "closed") {
      return { goalId, iterations: 0, outcome: "closed", detail: "Goal is already closed." };
    }
    const deadline = Date.now() + (this.options.hours ?? 2) * 3_600_000;
    const maxIterations = this.options.maxIterations ?? 48;
    // Lazily ensure the project is its own git repo with a baseline commit -
    // deferred here (not at GUI launch) so opening the dashboard is instant.
    for (const action of await ensureGitRepository(this.root)) {
      this.emitEvent(goalId, "git", action);
    }
    const assignment = await prepareGoalWorktree(this.root, goalId);
    this.store.setGoalLoopState(goalId, {
      branch: assignment.branchName,
      worktree: assignment.worktreePath,
    });
    const projectInstructions = await collectAgentsInstructions(this.root);

    let responseText = "";
    let tokensUsed = 0;
    const codex = this.createCodexClient((event) => {
      if (event.role === "codex" && event.kind === "agent") {
        responseText += event.message;
      }
      const total = extractTokenTotal(event);
      if (total !== null && total > tokensUsed) {
        tokensUsed = total;
      }
      const activity = { ...event, taskId: event.taskId ?? null, runId: event.runId ?? null };
      if (shouldRecordActivity(activity)) {
        this.emit(this.store.appendAgentEvent({ ...activity, role: "loop" }));
      }
    });

    try {
      let session = await this.openLoopSession(codex, goalId, assignment.worktreePath);
      let lastFingerprint = "";
      let stalls = 0;
      let probeFeedback = "";
      let lastObjective = goal.text;
      for (let iteration = 1; iteration <= maxIterations; iteration++) {
        // Soft-stop: when the time or token budget is spent (or this is the
        // last allowed iteration), do ONE graceful wrap-up turn - commit what
        // exists and record remaining work - instead of cutting hard.
        const budget = this.options.tokenBudget;
        const wrapUp: "time" | "tokens" | "iterations" | null =
          budget && tokensUsed >= budget
            ? "tokens"
            : Date.now() >= deadline
            ? "time"
            : iteration === maxIterations
            ? "iterations"
            : null;
        // objective-updated: if the goal text changed mid-run, tell the agent.
        const currentObjective = this.store.getGoal(goalId).text;
        const objectiveChanged = currentObjective !== lastObjective;
        lastObjective = currentObjective;
        const queued = this.store.listPendingGoalMessages(goalId);
        this.emitEvent(
          goalId,
          "iteration",
          `Loop iteration ${iteration}/${maxIterations} started.${wrapUp ? ` (wrap-up: ${wrapUp})` : ""}`,
        );
        responseText = "";
        const planExists = await this.planFileExists(assignment.worktreePath);
        // Clarify-first: only on the very first turn, before any plan, and only
        // until the user has answered (queued answers turn it into planning).
        const doClarify = Boolean(this.options.questionMode) && iteration === 1 &&
          !planExists && queued.length === 0;
        const prompt = doClarify
          ? this.buildClarifyPrompt(goal, projectInstructions)
          : iteration === 1 && !planExists
          ? this.buildFirstPrompt(goal, projectInstructions, queued.map((m) => m.message))
          : this.buildContinuationPrompt(queued.map((m) => m.message), probeFeedback, {
            wrapUp,
            objectiveChanged,
            objective: currentObjective,
          });
        probeFeedback = "";
        try {
          await codex.runTurn(session, {
            title: `${goalId}: loop ${iteration}`,
            prompt,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (isMissingCodexThreadText(message)) {
            // The plan and the repo are the memory; a lost thread is a speed
            // bump, not a failure. Reopen fresh and continue.
            this.emitEvent(goalId, "session", "Loop session was lost; reopening from disk state.");
            this.store.setGoalLoopState(goalId, { threadId: null });
            session = await this.openLoopSession(codex, goalId, assignment.worktreePath);
            continue;
          }
          throw error;
        }
        // Clarify turn: surface the agent's questions and stop. Answering in
        // chat re-runs the loop with the answers queued, so it plans next time.
        if (doClarify) {
          const questions = extractQuestions(responseText);
          this.emit(this.store.appendLifecycleEvent({
            kind: "goal.blocked",
            goalId,
            taskId: null,
            summary: questions,
            data: { questions: true },
          }));
          this.emitEvent(goalId, "questions", questions);
          return this.finish(goalId, iteration, "blocked", questions);
        }
        if (queued.length) {
          this.store.markGoalMessagesProcessed(queued.map((message) => message.id));
        }

        const commit = await gitCommitAll(
          assignment.worktreePath,
          `${goalId} loop iteration ${iteration}`,
        );
        const items = parseLoopPlan(await this.readPlanFile(assignment.worktreePath));
        for (const event of this.store.syncLoopPlanTasks(goalId, items)) {
          this.emit(event);
        }
        if (items.length) {
          this.emit(this.store.appendLifecycleEvent(planUpdated(goalId, items)));
        }

        if (wrapUp) {
          const reason = wrapUp === "tokens"
            ? "Token budget reached; wrapped up and committed in-progress work."
            : wrapUp === "time"
            ? "Time budget reached; wrapped up and committed in-progress work."
            : "Iteration budget reached; wrapped up and committed in-progress work.";
          return this.finish(goalId, iteration, "budget", reason);
        }

        const ask = extractBlockedAsk(responseText);
        if (ask) {
          this.emitEvent(goalId, "blocked", `Loop blocked: ${ask}`);
          this.emit(this.store.appendLifecycleEvent({
            kind: "goal.blocked",
            goalId,
            taskId: null,
            summary: ask,
            data: { ask, iteration },
          }));
          return this.finish(goalId, iteration, "blocked", ask);
        }

        // The owner can delegate independent subtasks to parallel sub-agents.
        // Disjoint write scopes are enforced; the summary feeds the next turn.
        const fanout = parseFanoutRequest(responseText);
        if (fanout) {
          const conflict = findScopeConflict(fanout);
          if (conflict) {
            probeFeedback =
              `Fan-out rejected: write scopes overlap (${conflict}). Re-issue ${LOOP_FANOUT_TOKEN} ` +
              "with disjoint write scopes, or do the work inline.";
            continue;
          }
          const runner = new FanoutRunner(this.root, this.store, {
            createCodexClient: this.createCodexClient,
            onEvent: (event) => this.emit(event),
            maxConcurrency: readWorkflow(this.root).maxConcurrentAgents,
            projectInstructions,
          });
          const fanoutResult = await runner.run(
            goalId,
            assignment.branchName,
            assignment.worktreePath,
            fanout,
          );
          probeFeedback = summarizeFanout(fanoutResult);
          continue;
        }

        if (signalsComplete(responseText) || loopPlanComplete(items)) {
          const summary = await runGoalProbes(
            this.root,
            this.store,
            goalId,
            assignment.worktreePath,
          );
          if (!summary.total || summary.passed === summary.total) {
            return await this.completeGoal(goalId, iteration, assignment.branchName, summary);
          }
          const failing = summary.results.filter((result) => !result.passed);
          probeFeedback = [
            `Win conditions are not green yet (${summary.passed}/${summary.total} ${
              probeLights(this.store.listProbes(goalId))
            }). Failing probes:`,
            ...failing.map((result) =>
              `- ${result.probe.label}: ${result.output.slice(0, 300)}`
            ),
            "Add plan items for these failures and keep working; do not declare " +
            "completion until they pass.",
          ].join("\n");
          this.emitEvent(
            goalId,
            "probes",
            `Completion claimed but win conditions ${summary.passed}/${summary.total}; continuing.`,
          );
          continue;
        }

        const head = commit ??
          (await runCommand(assignment.worktreePath, ["git", "rev-parse", "HEAD"])).trim();
        const fingerprint = loopPlanFingerprint(items, head);
        if (fingerprint === lastFingerprint) {
          stalls++;
          if (stalls === 1) {
            probeFeedback =
              "The last iteration produced no plan progress and no file changes. Re-read " +
              `${LOOP_PLAN_FILE}, pick the smallest next step on the next unchecked item, and act.`;
          }
          if (stalls > STALL_LIMIT) {
            this.emitEvent(goalId, "stalled", "No progress across consecutive iterations.");
            return this.finish(
              goalId,
              iteration,
              "stalled",
              "The loop made no progress across consecutive iterations. Review the plan and restart.",
            );
          }
        } else {
          stalls = 0;
          lastFingerprint = fingerprint;
        }
      }
      return this.finish(goalId, maxIterations, "budget", "Iteration budget exhausted.");
    } finally {
      await codex.stop().catch(() => {});
    }
  }

  private async completeGoal(
    goalId: string,
    iterations: number,
    branchName: string,
    summary: { total: number; passed: number },
  ): Promise<GoalLoopReport> {
    const evidence = summary.total
      ? `Win conditions ${summary.passed}/${summary.total} passed in the loop worktree.`
      : "No probes recorded; loop plan fully checked with evidence notes.";
    this.emit(this.store.appendLifecycleEvent({
      kind: "verified",
      goalId,
      taskId: null,
      summary: evidence,
      data: { total: summary.total, passed: summary.passed },
    }));
    const plan = parseLoopPlan(
      await this.readPlanFile(this.store.getGoal(goalId).loopWorktree ?? this.root),
    );
    const manualNotes = plan
      .map((item) => `${item.title}: ${item.note}`)
      .filter((line) => /needs manual verification/i.test(line));
    if (this.runMode === "attended" && manualNotes.length) {
      const prompt = [
        "Loop complete and win conditions pass. Merge is held until you verify by hand:",
        ...manualNotes.map((note) => `- ${note}`),
        "When verified, restart this task and LoopForge merges the goal branch immediately.",
      ].join("\n");
      const holdTask = this.store.createLoopMergeHoldTask(goalId, branchName, prompt, evidence);
      this.emitEvent(
        goalId,
        "hold",
        `Loop work held in Review as ${holdTask.id} until manual verification.`,
      );
      return this.finish(goalId, iterations, "held", prompt);
    }
    let output: string;
    try {
      output = await gitMergeBranch(this.root, branchName);
    } catch (error) {
      // The work is done and proven; a merge conflict parks it instead of
      // crashing the loop. Restarting the hold task retries the merge.
      const message = error instanceof Error ? error.message : String(error);
      const prompt = [
        `Loop work is complete and win conditions pass, but merging ${branchName} failed:`,
        message.slice(0, 400),
        "Resolve the project root (the loop branch is intact), then restart this task to merge.",
      ].join("\n");
      const holdTask = this.store.createLoopMergeHoldTask(goalId, branchName, prompt, evidence);
      this.emitEvent(
        goalId,
        "hold",
        `Merge failed; parked as ${holdTask.id}. ${message.slice(0, 160)}`,
      );
      return this.finish(goalId, iterations, "held", prompt);
    }
    this.emitEvent(goalId, "merge", output.trim() || `Merged ${branchName}.`);
    // Settle any relay-intake tasks the goal carried; the loop's merge did the
    // work, and a closed goal must not leave dispatchable strays behind.
    for (
      const event of this.store.settleGoalTasksForLoop(
        goalId,
        "Superseded by the goal loop; the loop merged this goal's work.",
      )
    ) {
      this.emit(event);
    }
    const result = this.store.closeGoal(goalId, `${evidence} Merged ${branchName}.`, {
      force: true,
    });
    this.emit(result.event);
    this.emit(this.store.appendLifecycleEvent({
      kind: "goal.closed",
      goalId,
      taskId: null,
      summary: `${evidence} Merged ${branchName}.`,
      data: { branch: branchName, iterations },
    }));
    return this.finish(goalId, iterations, "merged", `${evidence} Merged ${branchName}.`);
  }

  private async openLoopSession(
    codex: CodexClient,
    goalId: string,
    worktreePath: string,
  ): Promise<CodexSession> {
    const goal = this.store.getGoal(goalId);
    if (goal.loopThreadId) {
      try {
        return await codex.resumeSession(worktreePath, goal.loopThreadId);
      } catch {
        // Disk state carries the loop; fall through to a fresh session.
      }
    }
    const session = await codex.startSession(worktreePath, {
      name: `LoopForge - ${goalId} - loop`,
    });
    this.store.setGoalLoopState(goalId, { threadId: session.threadId });
    return session;
  }

  private buildClarifyPrompt(goal: Goal, projectInstructions: string): string {
    return `You are the LoopForge goal loop owner for ${goal.id}. The user wants to clarify scope BEFORE you plan or build.

Goal:
${goal.text}

Project context from the original folder:
${projectInstructions}

Ask 2-4 specific, high-value clarifying questions whose answers would change how you build this
(stack/library choices, scope boundaries, must-haves vs nice-to-haves, success criteria,
constraints). Be concise - a short numbered list. Do NOT create or edit any files, and do NOT
plan yet. End your reply with a line containing only: LOOP_QUESTIONS`;
  }

  private buildFirstPrompt(goal: Goal, projectInstructions: string, addedTasks: string[] = []): string {
    const probes = this.store.listProbes(goal.id);
    const addedBlock = addedTasks.length
      ? `\nAdditional tasks the user attached to this goal - include each as a plan item:\n${
        addedTasks.map((t) => `- ${t}`).join("\n")
      }\n`
      : "";
    return `You are the LoopForge goal loop owner for ${goal.id}, working in this dedicated worktree until the goal is genuinely done.

${autonomyContract(this.runMode)}
Goal:
${goal.text}
${addedBlock}

Win conditions (LoopForge runs these for real; the goal only closes when they pass):
${probes.length ? probes.map((probe) => `- ${probe.label}: ${probe.command}`).join("\n") : "- none recorded; your evidence notes carry the proof."}

Project context from the original folder:
${projectInstructions}

${loopPlanContract()}

Begin now: create ${LOOP_PLAN_FILE}, then start the first item.`;
  }

  private buildContinuationPrompt(
    queuedMessages: string[],
    probeFeedback: string,
    steer: {
      wrapUp?: "time" | "tokens" | "iterations" | null;
      objectiveChanged?: boolean;
      objective?: string;
    } = {},
  ): string {
    // New user messages are treated as added tasks: the agent folds each into
    // LOOP_PLAN.md as a real plan item WITH a one-line spec, so the Kanban card
    // is populated inline - no separate spec-writer agent (which would burn a
    // slot a local model may not have).
    const tasksBlock = queuedMessages.length
      ? `\nNew tasks/direction from the user - fold EACH into ${LOOP_PLAN_FILE} as a new unchecked item, and on the line below it record a one-line spec (what / why / acceptance) so it is fully described, then work the plan:\n${
        queuedMessages.map((m) => `- ${m}`).join("\n")
      }\n`
      : "";
    const objectiveBlock = steer.objectiveChanged
      ? `\nThe goal objective was edited. Re-read it and reconcile ${LOOP_PLAN_FILE} with the new objective:\n${steer.objective ?? ""}\n`
      : "";
    if (steer.wrapUp) {
      return `The ${steer.wrapUp} budget for this run is spent. This is your final turn.
Do NOT start new work. Finish the smallest safe stopping point for the in-progress item, make sure the worktree is in a consistent state, and update ${LOOP_PLAN_FILE}: mark done what is genuinely done and leave the rest unchecked with a short note on what remains.
${tasksBlock}${objectiveBlock}Do not output LOOP_COMPLETE unless every item is genuinely finished.`;
    }
    return `Continue the loop. Read ${LOOP_PLAN_FILE}, work the next item, verify it with real commands, and update the file.
${tasksBlock}${objectiveBlock}${probeFeedback ? `\n${probeFeedback}\n` : ""}
End with LOOP_COMPLETE only when every item is checked, or LOOP_BLOCKED: <ask> only for a true absolute blocker.`;
  }

  private async planFileExists(worktreePath: string): Promise<boolean> {
    try {
      await Deno.stat(path.join(worktreePath, LOOP_PLAN_FILE));
      return true;
    } catch {
      return false;
    }
  }

  private async readPlanFile(worktreePath: string): Promise<string> {
    try {
      return await Deno.readTextFile(path.join(worktreePath, LOOP_PLAN_FILE));
    } catch {
      return "";
    }
  }

  private finish(
    goalId: string,
    iterations: number,
    outcome: GoalLoopReport["outcome"],
    detail: string,
  ): GoalLoopReport {
    this.emitEvent(goalId, "finished", `Loop finished (${outcome}): ${detail.slice(0, 200)}`);
    return { goalId, iterations, outcome, detail };
  }

  private emitEvent(goalId: string, kind: string, message: string): void {
    this.emit(this.store.appendEvent(null, null, "loop", kind, `${goalId}: ${message}`));
  }

  private emit(event: ActivityEvent): void {
    this.options.onEvent?.(event);
  }
}

// The clarify turn's questions are everything before the LOOP_QUESTIONS marker.
function extractQuestions(responseText: string): string {
  const text = responseText.trim();
  const idx = text.indexOf("LOOP_QUESTIONS");
  const body = (idx >= 0 ? text.slice(0, idx) : text).trim();
  return body || "The agent has clarifying questions before planning - reply to continue.";
}

// Best-effort cumulative token total from a backend event (codex reports it on
// token-usage events; local/pi may not report it, in which case token budgets
// simply never trigger and time/iteration budgets still bound the run).
function extractTokenTotal(event: { kind: string; raw?: unknown }): number | null {
  if (!/token/i.test(event.kind)) {
    return null;
  }
  return findTokenTotal(event.raw, 0);
}

function findTokenTotal(value: unknown, depth: number): number | null {
  if (depth > 6 || !value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["total_tokens", "totalTokens", "total", "tokens_used", "tokensUsed"]) {
    const candidate = record[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  for (const nested of Object.values(record)) {
    const found = findTokenTotal(nested, depth + 1);
    if (found !== null) {
      return found;
    }
  }
  return null;
}
