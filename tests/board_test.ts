import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { BoardStore, readConfig, updateConfig } from "../src/board/store.ts";
import { summarizeGoalProgress } from "../src/board/goal_progress.ts";

Deno.test("init creates local runtime files and prompt templates", () => {
  const root = Deno.makeTempDirSync();
  new Deno.Command("git", { args: ["init", "-b", "main"], cwd: root }).outputSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    assertEquals(Deno.statSync(`${root}/.loopforge/board.sqlite`).isFile, true);
    assertEquals(Deno.statSync(`${root}/.loopforge/config.json`).isFile, true);
    assertEquals(Deno.statSync(`${root}/.loopforge/prompts/constitution.md`).isFile, true);
    assertEquals(Deno.statSync(`${root}/WORKFLOW.md`).isFile, true);
    // Runtime excludes live in .git/info/exclude; an untracked LoopForge
    // .gitignore at the root would block merges of branches that add one.
    const excludes = Deno.readTextFileSync(`${root}/.git/info/exclude`);
    assertStringIncludes(excludes, "/.loopforge/");
    assertStringIncludes(excludes, "/.omx/");
    assertThrows(() => Deno.statSync(`${root}/.gitignore`));
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("goal creates an initial ready task", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal, task } = store.createGoal("Ship the kanban command center");
    assertEquals(goal.id, "GOAL-1");
    assertEquals(task.id, "TASK-1");
    assertEquals(task.status, "ready");
    assertStringIncludes(task.acceptanceCriteria, "validation evidence");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("config stores model, reasoning, and fast mode", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    assertEquals(readConfig(root).model, "gpt-5.5");
    const config = updateConfig(root, {
      model: "gpt-5.4",
      reasoningEffort: "medium",
      fastMode: false,
      githubPrReview: true,
    });
    assertEquals(config.model, "gpt-5.4");
    assertEquals(config.reasoningEffort, "medium");
    assertEquals(config.fastMode, false);
    assertEquals(config.githubPrReview, true);
    assertEquals(readConfig(root).reasoningEffort, "medium");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("planned goals create multiple prioritized tasks", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal, tasks } = store.createGoalWithTasks("Plan a project", [
      {
        title: "Build the first slice",
        description: "Implement the first slice.",
        acceptanceCriteria: "- Slice works.",
        priority: 300,
      },
      {
        title: "Verify the slice",
        description: "Test the first slice.",
        acceptanceCriteria: "- Tests pass.",
        priority: 200,
      },
    ]);
    assertEquals(goal.id, "GOAL-1");
    assertEquals(tasks.length, 2);
    assertEquals(tasks[0].priority, 300);
    assertEquals(tasks[1].title, "Verify the slice");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("planned goals store a completion contract", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal } = store.createGoalWithTasks("Build reliable automation", [
      {
        title: "Add control plane",
        description: "Implement the control plane.",
        acceptanceCriteria: "- Control plane works.",
        priority: 300,
      },
    ], {
      completionContract: "- Control plane works.\n- Full verification passes.",
    });

    assertStringIncludes(goal.completionContract, "Full verification passes.");
    assertStringIncludes(store.getGoal(goal.id).completionContract, "Control plane works.");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("tasks can be added to an existing open goal", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal, task } = store.createGoal("Build repairable goal");
    const added = store.addTasksToGoal(goal.id, [{
      title: "Collect missing proof",
      description: "Collect evidence.",
      acceptanceCriteria: "- Evidence recorded.",
      priority: 50,
      dependsOn: [task.id],
    }]);

    assertEquals(added.goal.id, goal.id);
    assertEquals(added.tasks[0].id, "TASK-2");
    assertEquals(added.tasks[0].goalId, goal.id);
    assertEquals(added.tasks[0].dependencyIds, [task.id]);
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("goals close only after completion evidence is ready", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal, task } = store.createGoal("Close proven goal");

    assertThrows(
      () => store.closeGoal(goal.id),
      Error,
      "not ready to close",
    );

    store.requestTransition(task.id, "in_progress");
    store.updateTaskValidation(
      task.id,
      [
        "Turn status: completed",
        "Test turn status: completed",
        "Discovered verification gates:",
        "- Diff inspection: git diff --stat && git diff --check - Every task needs a basic changed-file and whitespace sanity check.",
        "",
        "Verification verdict:",
        "VERIFICATION_PASSED",
        "- Focused validation passed with recorded proof.",
        "Commit: abc123",
        "Git status:",
        "clean",
        "LoopForge review: APPROVED",
      ].join("\n"),
    );
    store.updateTaskCard(task.id, "TASK-1 complete.");
    store.updateTaskHandoff(task.id, "Validated and absorbed.");
    store.requestTransition(task.id, "review");
    store.requestTransition(task.id, "done");

    const closed = store.closeGoal(goal.id, "All proof present.");

    assertEquals(closed.goal.status, "closed");
    assertEquals(closed.goal.closureSummary, "All proof present.");
    assertEquals(summarizeGoalProgress(store.getBoard()), null);
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("task dependencies block dispatch until upstream work is done", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { tasks } = store.createGoalWithTasks("Plan dependent work", [
      {
        title: "Build model",
        description: "Implement the model.",
        acceptanceCriteria: "- Model works.",
        priority: 100,
        verificationPlan: "- Run model tests.",
      },
      {
        title: "Build UI",
        description: "Implement the UI.",
        acceptanceCriteria: "- UI works.",
        priority: 300,
        dependsOn: ["Build model"],
        riskLevel: "high",
        verificationPlan: "- Run UI smoke test.",
      },
    ]);

    assertEquals(tasks[1].dependencyIds, ["TASK-1"]);
    assertEquals(tasks[1].riskLevel, "high");
    assertEquals(store.findDispatchableTask()?.id, "TASK-1");
    store.updateTaskValidation(tasks[0].id, "Validation evidence.");
    store.requestTransition(tasks[0].id, "in_progress", "test", "claim");
    store.requestTransition(tasks[0].id, "review", "test", "proof");
    store.requestTransition(tasks[0].id, "done", "test", "complete");
    assertEquals(store.findDispatchableTask()?.id, "TASK-2");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("unresolved conflict signals block dispatch until source task is done", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { tasks } = store.createGoalWithTasks("Plan conflicting work", [
      {
        title: "Edit shared API",
        description: "Change shared API.",
        acceptanceCriteria: "- API works.",
        priority: 100,
      },
      {
        title: "Edit shared UI",
        description: "Change shared UI.",
        acceptanceCriteria: "- UI works.",
        priority: 300,
      },
    ]);
    store.addConflictSignal(tasks[1].id, "TASK-1 also touches src/shared.ts.");
    store.recordSupervisorDecision(tasks[1].id, "Paused because TASK-1 owns src/shared.ts.");
    assertEquals(store.findDispatchableTask()?.id, "TASK-1");
    assertStringIncludes(store.getTask(tasks[1].id).supervisorDecision, "Paused because TASK-1");

    store.updateTaskValidation(tasks[0].id, "Validation evidence.");
    store.requestTransition(tasks[0].id, "in_progress", "test", "claim");
    store.requestTransition(tasks[0].id, "review", "test", "proof");
    store.requestTransition(tasks[0].id, "done", "test", "complete");
    assertEquals(store.findDispatchableTask()?.id, "TASK-2");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("transition validation prevents review without evidence", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { task } = store.createGoal("Protect review gates");
    store.requestTransition(task.id, "in_progress", "test", "claim");
    assertThrows(
      () => {
        store.requestTransition(task.id, "review", "test", "missing proof");
      },
      Error,
      "Validation evidence is required",
    );
    store.updateTaskValidation(task.id, "Unit test evidence");
    const result = store.requestTransition(task.id, "review", "test", "proof attached");
    assertEquals(result.task.status, "review");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("reviewed tasks move through merging before done", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { task } = store.createGoal("Show merge progress");
    store.requestTransition(task.id, "in_progress", "test", "claim");
    store.updateTaskValidation(task.id, "Unit test evidence");
    store.requestTransition(task.id, "review", "test", "proof attached");
    assertEquals(
      store.requestTransition(task.id, "merging", "test", "review approved").task.status,
      "merging",
    );
    assertEquals(
      store.requestTransition(task.id, "done", "test", "merged").task.status,
      "done",
    );
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("running runs prevent duplicate task claims", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { task } = store.createGoal("Protect worker claims");
    store.createRun(task.id, "worker");
    assertThrows(
      () => {
        store.createRun(task.id, "worker");
      },
      Error,
      "already has a running agent",
    );
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("running task can receive a durable stop request", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { task } = store.createGoal("Stop a running task");
    const run = store.createRun(task.id, "worker");
    const event = store.requestTaskStop(task.id, "User stopped the task.");
    const stoppedRun = store.getRun(run.id);
    const status = store.getAgentStatus(run.id);

    assertEquals(event.kind, "stop");
    assertEquals(store.isRunStopRequested(run.id), true);
    assertEquals(Boolean(stoppedRun.stopRequestedAt), true);
    assertEquals(status?.headline, "Stop requested.");
    assertStringIncludes(store.getTask(task.id).nextAction, "stopping");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("agent status tracks live worker phase and summary", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { task } = store.createGoal("Track live agent state");
    const run = store.createRun(task.id, "worker");
    let status = store.getAgentStatus(run.id);
    assertEquals(status?.phase, "starting");
    assertEquals(status?.interruptible, false);

    status = store.upsertAgentStatus({
      taskId: task.id,
      runId: run.id,
      threadId: "thread-task",
      turnId: "turn-1",
      phase: "testing",
      headline: "Running validation.",
      detail: "deno task test is running.",
      risk: "none",
      interruptible: true,
    });
    assertEquals(status.threadId, "thread-task");
    assertEquals(status.turnId, "turn-1");
    assertEquals(status.phase, "testing");
    assertEquals(status.interruptible, true);
    assertEquals(store.getBoard().agentStatuses.length, 1);
    assertEquals(store.listActiveAgentStatuses()[0].headline, "Running validation.");

    store.finishRun(run.id, "completed");
    status = store.getAgentStatus(run.id);
    assertEquals(status?.phase, "done");
    assertEquals(status?.interruptible, false);
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("agent status marks stale active workers", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { task } = store.createGoal("Mark stale workers");
    const run = store.createRun(task.id, "worker");
    store.upsertAgentStatus({
      taskId: task.id,
      runId: run.id,
      phase: "running",
      headline: "Working.",
      detail: "Codex is active.",
      risk: "none",
      interruptible: true,
    });
    store.db.prepare("UPDATE agent_status SET last_seen_at = ? WHERE run_id = ?").run(
      new Date(Date.now() - 10_000).toISOString(),
      run.id,
    );
    const events = store.markStaleAgentStatuses(1);
    assertEquals(events.length, 1);
    const status = store.getAgentStatus(run.id);
    assertEquals(status?.risk, "stale");
    assertStringIncludes(events[0].message, "No recent Codex activity");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("startup recovery blocks stale started tasks", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { task } = store.createGoal("Recover stale started task");
    store.requestTransition(task.id, "in_progress", "test", "claim");
    store.createRun(task.id, "worker");
    const events = store.recoverStaleRuns();
    assertEquals(events.length, 2);
    assertEquals(store.getTask(task.id).status, "blocked");
    assertEquals(store.getBoard().runs[0].status, "failed");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("startup recovery blocks stale merging tasks", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { task } = store.createGoal("Recover stale merging task");
    store.requestTransition(task.id, "in_progress", "test", "claim");
    store.updateTaskValidation(task.id, "Unit test evidence");
    store.requestTransition(task.id, "review", "test", "proof attached");
    store.requestTransition(task.id, "merging", "test", "review approved");
    store.createRun(task.id, "worker");
    const events = store.recoverStaleRuns();
    assertEquals(events.length, 2);
    assertEquals(store.getTask(task.id).status, "blocked");
    assertEquals(store.getBoard().runs[0].status, "failed");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("queued tasks can be deleted before they start", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { task } = store.createGoal("Remove this queued goal");
    store.deleteTask(task.id);
    assertEquals(store.getBoard().tasks.length, 0);
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("started stuck tasks can be deleted from the board", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { task } = store.createGoal("Remove this stuck goal");
    store.assignWorktree(task.id, "loopforge/task-1", `${root}/.loopforge/worktrees/TASK-1`);
    store.requestTransition(task.id, "in_progress", "test", "claim");
    store.createRun(task.id, "worker");
    store.deleteTask(task.id);
    assertEquals(store.getBoard().tasks.length, 0);
    assertThrows(
      () => {
        store.getTask(task.id);
      },
      Error,
      "Task not found",
    );
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("done tasks can be removed from the board", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { task } = store.createGoal("Remove this completed goal");
    store.updateTaskValidation(task.id, "Validated.");
    store.requestTransition(task.id, "in_progress", "test", "started");
    store.requestTransition(task.id, "review", "test", "ready");
    store.requestTransition(task.id, "done", "test", "complete");
    store.deleteTask(task.id);
    assertEquals(store.getBoard().tasks.length, 0);
    assertThrows(
      () => {
        store.getTask(task.id);
      },
      Error,
      "Task not found",
    );
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("completed tasks can be cleared in bulk", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { tasks } = store.createGoalWithTasks("Clean completed work", [
      {
        title: "Completed item",
        description: "Complete this item.",
        acceptanceCriteria: "Done.",
        priority: 100,
      },
      {
        title: "Ready item",
        description: "Leave this item ready.",
        acceptanceCriteria: "Still ready.",
        priority: 90,
      },
    ]);
    store.updateTaskValidation(tasks[0].id, "Validated.");
    store.requestTransition(tasks[0].id, "in_progress", "test", "started");
    store.requestTransition(tasks[0].id, "review", "test", "ready");
    store.requestTransition(tasks[0].id, "done", "test", "complete");

    const result = store.clearDoneTasks();
    const board = store.getBoard();
    assertEquals(result.count, 1);
    assertEquals(board.tasks.length, 1);
    assertEquals(board.tasks[0].id, tasks[1].id);
    assertStringIncludes(result.event.message, "Cleared 1 completed task");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("events keep readable activity and raw protocol payloads", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    store.appendEvent(null, null, "codex", "turn", "Started turn.", { turn: { id: "turn-1" } });
    const event = store.getBoard().events.at(-1);
    assertEquals(event?.message, "Started turn.");
    assertStringIncludes(event?.rawJson ?? "", "turn-1");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("queued messages appear on the board and can be processed", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { task } = store.createGoal("Receive queued instructions");
    store.enqueueMessage(task.id, "user", "Please keep the scope tight.");
    assertEquals(store.getBoard().messages.length, 1);
    const pending = store.listPendingMessages(task.id);
    assertEquals(pending.length, 1);
    store.markMessagesProcessed(pending.map((message) => message.id));
    assertEquals(store.listPendingMessages(task.id).length, 0);
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("project main thread state is stored on the board", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    assertEquals(store.getProjectState().mainThreadId, null);
    store.setMainThread("thread-main", "Project context lives here.");
    const state = store.getBoard().projectState;
    assertEquals(state.mainThreadId, "thread-main");
    assertStringIncludes(state.mainThreadSummary, "Project context");
    store.resetMainThread("thread-reset", "Fresh compact context.");
    assertEquals(store.getProjectState().mainThreadId, "thread-reset");
    assertEquals(typeof store.getProjectState().mainThreadResetAt, "string");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("tasks store thread lineage, compact cards, handoffs, and conflict signals", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { task } = store.createGoal("Track child task memory");
    store.assignThreadLineage(task.id, "thread-main", "thread-child");
    store.updateTaskActiveTurn(task.id, "implementation");
    store.updateTaskContextManifest(
      task.id,
      `${root}/.loopforge/tasks/TASK-1/context-manifest.json`,
    );
    store.updateTaskTouchedPaths(task.id, ["src/a.ts", "src/a.ts", "src/b.ts"]);
    store.updateTaskCard(task.id, "TASK-1 status: in_progress");
    store.updateTaskHandoff(task.id, "TASK-1 done.");
    store.addConflictSignal(task.id, "TASK-2 also touches src/a.ts.");

    const updated = store.getTask(task.id);
    assertEquals(updated.parentThreadId, "thread-main");
    assertEquals(updated.threadId, "thread-child");
    assertEquals(updated.activeTurnId, "implementation");
    assertEquals(updated.touchedPaths, ["src/a.ts", "src/b.ts"]);
    assertEquals(updated.conflictSignals, ["TASK-2 also touches src/a.ts."]);
    assertStringIncludes(updated.taskCard, "TASK-1");
    assertStringIncludes(updated.handoffSummary, "done");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("loop plan items track status and emit plan.updated on every mutation", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal } = store.createGoal("Track loop plan work");

    const item = store.addLoopPlanItem(goal.id, "Wire the store", "one line spec");
    assertEquals(item.kind, "loop");
    assertEquals(item.status, "ready");
    let items = store.listLoopPlanItems(goal.id);
    assertEquals(items.length, 1);
    assertEquals(items[0].status, "todo");
    assertEquals(items[0].note, "one line spec");

    store.setLoopPlanItemStatus(goal.id, item.id, "doing");
    assertEquals(store.listLoopPlanItems(goal.id)[0].status, "doing");

    store.appendLoopPlanNote(goal.id, item.id, "made progress");
    assertStringIncludes(store.listLoopPlanItems(goal.id)[0].note, "made progress");

    // Done is the evidence gate.
    assertThrows(
      () => store.setLoopPlanItemStatus(goal.id, item.id, "done"),
      Error,
      "Evidence is required",
    );

    store.setLoopPlanItemStatus(goal.id, item.id, "done", "all checks pass");
    const done = store.listLoopPlanItems(goal.id)[0];
    assertEquals(done.status, "done");
    assertEquals(done.note, "all checks pass");

    // One plan.updated per successful mutation (add, start, note, done = 4).
    const planEvents = store.listLifecycleEvents(goal.id).filter((event) =>
      event.kind === "plan.updated"
    );
    assertEquals(planEvents.length, 4);
    const finalSteps = planEvents.at(-1)?.data.steps as Array<
      { title: string; status: string; note: string }
    >;
    assertEquals(finalSteps.length, 1);
    assertEquals(finalSteps[0].status, "done");
    assertEquals(finalSteps[0].note, "all checks pass");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("task and goal ids never collide after deletions", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const first = store.createGoal("First goal");
    const second = store.createGoal("Second goal");
    store.deleteTask(first.task.id);
    const third = store.createGoal("Third goal");
    assertEquals(third.task.id, "TASK-3");
    const followUp = store.addTasksToGoal(second.goal.id, [{
      title: "Follow up",
      description: "d",
      acceptanceCriteria: "- done",
      priority: 50,
    }]);
    assertEquals(followUp.tasks[0].id, "TASK-4");
    assertEquals(third.goal.id, "GOAL-3");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("appendEvent and appendLifecycleEvent write the goal_id column", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal } = store.createGoal("Tag events");
    const tagged = store.appendEvent(
      null,
      null,
      "loop",
      "iteration",
      `${goal.id}: Loop iteration 1/2 started.`,
      undefined,
      goal.id,
    );
    assertEquals(tagged.goalId, goal.id);
    const agent = store.appendAgentEvent(
      { taskId: null, runId: null, role: "loop", kind: "agent", message: "working" },
      goal.id,
    );
    assertEquals(agent.goalId, goal.id);
    store.appendLifecycleEvent({
      kind: "verified",
      goalId: goal.id,
      taskId: null,
      summary: "ok",
      data: {},
    });
    const rows = store.db.prepare("SELECT goal_id FROM events WHERE goal_id = ?").all(goal.id);
    assertEquals(rows.length, 3);
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("getGoalThread groups loop events into turns and merges steers", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal } = store.createGoal("Thread me");
    store.appendEvent(
      null,
      null,
      "loop",
      "iteration",
      `${goal.id}: Loop iteration 1/3 started.`,
      undefined,
      goal.id,
    );
    store.appendAgentEvent(
      { taskId: null, runId: null, role: "loop", kind: "agent", message: "working on it" },
      goal.id,
    );
    store.appendEvent(
      null,
      null,
      "loop",
      "iteration",
      `${goal.id}: Loop iteration 2/3 started.`,
      undefined,
      goal.id,
    );
    store.appendAgentEvent(
      { taskId: null, runId: null, role: "loop", kind: "agent", message: "done" },
      goal.id,
    );
    store.enqueueGoalMessage(goal.id, "user", "please also add tests");

    const thread = store.getGoalThread(goal.id);
    assertEquals(thread.truncated, false);
    // The empty setup turn is dropped; two iteration turns remain.
    assertEquals(thread.turns.length, 2);
    assertEquals(thread.turns[0].index, 1);
    assertEquals(thread.turns[1].index, 2);
    const entries = thread.turns.flatMap((turn) => turn.entries);
    const steer = entries.find((entry) => entry.kind === "steer");
    assert(steer, "expected a steer entry");
    assertEquals(steer!.role, "user");
    assertStringIncludes(steer!.text, "add tests");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("getGoalThread falls back to the message marker for untagged boards", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal } = store.createGoal("Legacy thread");
    // Legacy rows: goal_id column is NULL, the goal id only rides in the prefix.
    store.appendEvent(null, null, "loop", "iteration", `${goal.id}: Loop iteration 1/2 started.`);
    store.appendEvent(null, null, "loop", "agent", `${goal.id}: did the work`);
    // A legacy lifecycle row: column NULL, goalId only in the raw_json payload.
    store.appendEvent(null, null, "lifecycle", "verified", "verified it", {
      goalId: goal.id,
      taskRef: null,
      data: {},
    });

    const thread = store.getGoalThread(goal.id);
    const entries = thread.turns.flatMap((turn) => turn.entries);
    assert(entries.some((entry) => entry.kind === "iteration"), "marker scan should find the turn");
    assert(entries.some((entry) => entry.text.includes("did the work")));
    assert(entries.some((entry) => entry.kind === "verified"), "lifecycle row should be recovered");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("deleteGoal removes a goal with tasks, runs, probes, and messages", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal, tasks } = store.createGoalWithTasks("Full goal", [
      { title: "one", description: "d", acceptanceCriteria: "a", priority: 100 },
      { title: "two", description: "d", acceptanceCriteria: "a", priority: 100 },
    ], { probes: [{ label: "check", command: "true" }] });
    store.enqueueGoalMessage(goal.id, "user", "steer text");
    const run = store.createRun(tasks[0].id, "worker");
    store.appendEvent(tasks[0].id, run.id, "loop", "note", "child event");
    const event = store.deleteGoal(goal.id);
    assertStringIncludes(event.message, goal.id);
    assertEquals(store.getBoard().goals.length, 0);
    assertEquals(store.getBoard().tasks.length, 0);
    assertEquals(store.listProbes(goal.id).length, 0);
    // Events survive with their task/run refs cleared, so history stays intact.
    assertEquals(store.getBoard().events.some((e) => e.message === "child event"), true);
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});
