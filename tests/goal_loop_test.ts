import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { BoardStore } from "../src/board/store.ts";
import { GoalLoopRunner } from "../src/workers/goal_loop.ts";
import { LoopForgeWorker } from "../src/workers/loopforge_worker.ts";
import type {
  CodexClient,
  CodexSession,
  CodexSessionOptions,
  CodexTurnInput,
  CodexTurnResult,
} from "../src/workers/codex_app_server.ts";

async function git(root: string, args: string[]): Promise<void> {
  const output = await new Deno.Command("git", {
    args,
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(new TextDecoder().decode(output.stderr));
  }
}

async function gitOutput(root: string, args: string[]): Promise<string> {
  const output = await new Deno.Command("git", {
    args,
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(new TextDecoder().decode(output.stderr));
  }
  return new TextDecoder().decode(output.stdout);
}

async function seedRepo(root: string): Promise<void> {
  await git(root, ["init", "-b", "main"]);
  await git(root, [
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=T",
    "commit",
    "--allow-empty",
    "-m",
    "seed",
  ]);
}

type TurnScript = (cwd: string, turn: number) => Promise<string>;

// A scripted loop owner: each runTurn invokes the script with the worktree and
// turn number; the returned text becomes the captured agent message. Scripts
// simulate the model's ./lf-task calls by mutating the store directly (same
// process, same DB the real CLI writes to).
class ScriptedLoopClient implements CodexClient {
  turns = 0;
  readonly prompts: string[] = [];

  constructor(
    private readonly onEvent: (
      event: {
        taskId: string | null;
        runId: string | null;
        role: string;
        kind: string;
        message: string;
      },
    ) => void,
    private readonly script: TurnScript,
  ) {}

  startSession(cwd: string, _options: CodexSessionOptions = {}): Promise<CodexSession> {
    return Promise.resolve({ threadId: "loop-thread", cwd });
  }

  resumeSession(cwd: string, threadId: string): Promise<CodexSession> {
    return Promise.resolve({ threadId, cwd });
  }

  async runTurn(session: CodexSession, input: CodexTurnInput): Promise<CodexTurnResult> {
    this.turns++;
    this.prompts.push(input.prompt);
    const reply = await this.script(session.cwd, this.turns);
    this.onEvent({ taskId: null, runId: null, role: "codex", kind: "agent", message: reply });
    return {
      threadId: session.threadId,
      turnId: `loop-turn-${this.turns}`,
      status: "completed",
      completed: true,
    };
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}

Deno.test("goal loop plans, tracks DB plan items, passes probes, and merges unattended", async () => {
  const root = Deno.makeTempDirSync();
  await seedRepo(root);
  const store = new BoardStore(root);
  const events: string[] = [];
  let client: ScriptedLoopClient | null = null;
  try {
    store.initProject();
    const { goal } = store.createGoal("Ship the widget");
    store.addProbes(goal.id, [{ label: "widget exists", command: "test -f widget.txt" }]);
    const runner = new GoalLoopRunner(root, store, {
      runMode: "unattended",
      onEvent: (event) => events.push(`${event.role}/${event.kind}: ${event.message}`),
      createCodexClient: (onEvent) => {
        client = new ScriptedLoopClient(onEvent, async (cwd, turn) => {
          if (turn === 1) {
            const create = store.addLoopPlanItem(goal.id, "Create the widget");
            store.addLoopPlanItem(goal.id, "Document the widget");
            store.setLoopPlanItemStatus(goal.id, create.id, "done", "wrote widget.txt");
            await Deno.writeTextFile(`${cwd}/widget.txt`, "widget\n");
            return "Planned and created the widget.";
          }
          const doc = store.listLoopPlanItems(goal.id)[1];
          store.setLoopPlanItemStatus(goal.id, doc.id, "done", "wrote docs.md");
          await Deno.writeTextFile(`${cwd}/docs.md`, "docs\n");
          return "All items finished.\nLOOP_COMPLETE";
        });
        return client;
      },
    });
    const report = await runner.run(goal.id);
    assertEquals(report.outcome, "merged");
    assertEquals(client!.turns, 2);
    assertStringIncludes(client!.prompts[0], "./lf-task add");
    assertStringIncludes(client!.prompts[0], "widget exists");
    assertStringIncludes(client!.prompts[0], "Autonomous Operation");
    assertStringIncludes(client!.prompts[1], "./lf-task list");

    // Plan items land on the board as loop tasks and never dispatch.
    const board = store.getBoard();
    const mirrors = board.tasks.filter((task) => task.kind === "loop");
    assertEquals(mirrors.length, 2);
    assert(mirrors.every((task) => task.status === "done"));
    assert(!store.listDispatchableTasks(20).some((task) => task.kind === "loop"));

    // The lf-task shim workspace was planted in the goal worktree. The worktree
    // is reclaimed after the merge, so check the shim files never got committed.
    assert(!(await Deno.stat(`${root}/lf-task`).then(() => true).catch(() => false)));
    assert(!(await Deno.stat(`${root}/.loopforge-goal.json`).then(() => true).catch(() => false)));

    // The work merged into the root repo and the goal closed with evidence.
    assertEquals(await Deno.readTextFile(`${root}/widget.txt`), "widget\n");
    assertEquals(store.getGoal(goal.id).status, "closed");
    assertStringIncludes(store.getGoal(goal.id).closureSummary, "1/1");
    // The relay intake task is settled, never left dispatchable under a closed goal.
    assertEquals(store.getTask("TASK-1").status, "done");
    assert(events.some((line) => line.includes("loop/merge")));

    // The canonical lifecycle feed captured the run for the dashboard.
    const feed = store.listLifecycleEvents(goal.id);
    const kinds = feed.map((e) => e.kind);
    assert(kinds.includes("plan.updated"), `expected plan.updated, got ${kinds.join(",")}`);
    assert(kinds.includes("verified"));
    assert(kinds.includes("goal.closed"));
    const lastPlan = [...feed].reverse().find((e) => e.kind === "plan.updated");
    const steps = lastPlan!.data.steps as Array<{ status: string }>;
    assert(steps.every((s) => s.status === "done"));
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("goal loop holds the merge in attended mode and restart lands it", async () => {
  const root = Deno.makeTempDirSync();
  await seedRepo(root);
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal } = store.createGoal("Ship the dialog");
    // A real red-at-start probe (dialog.txt is absent at baseline) keeps this a
    // strong gate, so completion routes through the manual-verification hold.
    store.addProbes(goal.id, [{ label: "dialog exists", command: "test -f dialog.txt" }]);
    const runner = new GoalLoopRunner(root, store, {
      runMode: "attended",
      onEvent: () => {},
      createCodexClient: (onEvent) =>
        new ScriptedLoopClient(onEvent, async (cwd) => {
          const item = store.addLoopPlanItem(goal.id, "Build the dialog");
          store.setLoopPlanItemStatus(
            goal.id,
            item.id,
            "done",
            "needs manual verification: confirm it renders in-app",
          );
          await Deno.writeTextFile(`${cwd}/dialog.txt`, "dialog\n");
          return "LOOP_COMPLETE";
        }),
    });
    const report = await runner.run(goal.id);
    assertEquals(report.outcome, "held");

    const hold = store.getBoard().tasks.find((task) =>
      task.currentGate === "manual-verification" && task.kind === "code"
    );
    assert(hold, "expected a parked merge-hold task");
    assertEquals(hold!.status, "review");
    assertStringIncludes(hold!.needsInputPrompt ?? "", "needs manual verification");
    assertEquals(store.getGoal(goal.id).status, "open");

    // Restarting the hold task reuses the parked-merge shortcut and lands the branch.
    const worker = new LoopForgeWorker(root, store, {
      createCodexClient: (onEvent) =>
        new ScriptedLoopClient(onEvent, () => Promise.resolve("unused")),
    });
    const merged = await worker.runTask(hold!.id);
    assertEquals(merged.status, "done");
    assertEquals(await Deno.readTextFile(`${root}/dialog.txt`), "dialog\n");
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("goal loop surfaces a blocked ask and stops", async () => {
  const root = Deno.makeTempDirSync();
  await seedRepo(root);
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal } = store.createGoal("Integrate the payment provider");
    const runner = new GoalLoopRunner(root, store, {
      runMode: "unattended",
      onEvent: () => {},
      createCodexClient: (onEvent) =>
        new ScriptedLoopClient(onEvent, (_cwd) => {
          const item = store.addLoopPlanItem(goal.id, "Wire the provider");
          store.setLoopPlanItemStatus(goal.id, item.id, "doing");
          return Promise.resolve("LOOP_BLOCKED: need the provider test API key to continue");
        }),
    });
    const report = await runner.run(goal.id);
    assertEquals(report.outcome, "blocked");
    assertStringIncludes(report.detail, "provider test API key");
    assertEquals(store.getGoal(goal.id).status, "open");
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("goal loop nudges once on a stall then stops cleanly", async () => {
  const root = Deno.makeTempDirSync();
  await seedRepo(root);
  const store = new BoardStore(root);
  let client: ScriptedLoopClient | null = null;
  try {
    store.initProject();
    const { goal } = store.createGoal("Spin forever");
    const runner = new GoalLoopRunner(root, store, {
      runMode: "unattended",
      maxIterations: 10,
      onEvent: () => {},
      createCodexClient: (onEvent) => {
        client = new ScriptedLoopClient(onEvent, (_cwd, turn) => {
          if (turn === 1) {
            store.addLoopPlanItem(goal.id, "Something hard");
          }
          return Promise.resolve("Thinking about it.");
        });
        return client;
      },
    });
    const report = await runner.run(goal.id);
    assertEquals(report.outcome, "stalled");
    assert(client!.turns <= 5, `expected an early stop, ran ${client!.turns} turns`);
    assert(client!.prompts.some((prompt) => prompt.includes("no plan progress")));
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("goal loop nudges the owner to fan out independent plan items once", async () => {
  const root = Deno.makeTempDirSync();
  await seedRepo(root);
  const store = new BoardStore(root);
  let client: ScriptedLoopClient | null = null;
  try {
    store.initProject();
    const { goal } = store.createGoal("Build three independent parts");
    const runner = new GoalLoopRunner(root, store, {
      runMode: "unattended",
      maxIterations: 4,
      onEvent: () => {},
      createCodexClient: (onEvent) => {
        client = new ScriptedLoopClient(onEvent, async (cwd, turn) => {
          // Three todo items from turn 1, and no fan-out request.
          if (turn === 1) {
            store.addLoopPlanItem(goal.id, "Build the API");
            store.addLoopPlanItem(goal.id, "Build the UI");
            store.addLoopPlanItem(goal.id, "Write the docs");
          }
          // A distinct file each turn keeps the loop progressing (no stall) so it
          // runs long enough to prove the nudge is one-shot.
          await Deno.writeTextFile(`${cwd}/step-${turn}.txt`, `${turn}\n`);
          return "Working the first item.";
        });
        return client;
      },
    });
    await runner.run(goal.id);
    assert(client!.turns >= 3, `expected 3+ turns, ran ${client!.turns}`);
    // Turn 1 requested no fan-out, so turn 2 carries the deterministic nudge.
    assertStringIncludes(client!.prompts[1], "delegate them NOW");
    // One-shot: exactly one prompt across the run carries the nudge.
    const nudged = client!.prompts.filter((prompt) => prompt.includes("delegate them NOW"));
    assertEquals(nudged.length, 1);
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("goal loop nudges when files change without recorded task progress", async () => {
  const root = Deno.makeTempDirSync();
  await seedRepo(root);
  const store = new BoardStore(root);
  let client: ScriptedLoopClient | null = null;
  try {
    store.initProject();
    const { goal } = store.createGoal("Work without tracking");
    const runner = new GoalLoopRunner(root, store, {
      runMode: "unattended",
      maxIterations: 3,
      onEvent: () => {},
      createCodexClient: (onEvent) => {
        client = new ScriptedLoopClient(onEvent, async (cwd, turn) => {
          // Turn 1 changes a file but never touches the task list.
          if (turn === 1) {
            await Deno.writeTextFile(`${cwd}/work.txt`, "work\n");
          }
          return "Did some work.";
        });
        return client;
      },
    });
    await runner.run(goal.id);
    assert(client!.turns >= 2, `expected 2+ turns, ran ${client!.turns}`);
    assertStringIncludes(client!.prompts[1], "recorded no task progress");
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("goal loop reclaims its worktree and branch after a merged completion", async () => {
  const root = Deno.makeTempDirSync();
  await seedRepo(root);
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal } = store.createGoal("Ship and reclaim");
    const worktreePath = `${root}/.loopforge/worktrees/${goal.id}`;
    const branch = `loopforge/${goal.id.toLowerCase()}`;
    const runner = new GoalLoopRunner(root, store, {
      runMode: "unattended",
      onEvent: () => {},
      createCodexClient: (onEvent) =>
        new ScriptedLoopClient(onEvent, async (cwd) => {
          const item = store.addLoopPlanItem(goal.id, "Ship it");
          store.setLoopPlanItemStatus(goal.id, item.id, "done", "wrote ship.txt");
          await Deno.writeTextFile(`${cwd}/ship.txt`, "ship\n");
          return "LOOP_COMPLETE";
        }),
    });
    const report = await runner.run(goal.id);
    assertEquals(report.outcome, "merged");
    // The goal's own loop worktree and branch are reclaimed after the merge.
    await assertRejects(() => Deno.stat(worktreePath));
    assertEquals((await gitOutput(root, ["branch", "--list", branch])).trim(), "");
    // The stored loop state was cleared so the GUI never points at a deleted path.
    assertEquals(store.getGoal(goal.id).loopWorktree, null);
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("goal loop does a graceful wrap-up turn on the iteration budget", async () => {
  const root = Deno.makeTempDirSync();
  await seedRepo(root);
  const store = new BoardStore(root);
  let client: ScriptedLoopClient | null = null;
  try {
    store.initProject();
    const { goal } = store.createGoal("Long job");
    const runner = new GoalLoopRunner(root, store, {
      runMode: "unattended",
      maxIterations: 2,
      onEvent: () => {},
      createCodexClient: (onEvent) => {
        client = new ScriptedLoopClient(onEvent, (_cwd, turn) => {
          if (turn === 1) {
            store.addLoopPlanItem(goal.id, "Big item");
          }
          return Promise.resolve("Working on it.");
        });
        return client;
      },
    });
    const report = await runner.run(goal.id);
    assertEquals(report.outcome, "budget");
    assertEquals(client!.turns, 2);
    // The final turn was a wrap-up, not another work turn.
    assertStringIncludes(client!.prompts[1], "final turn");
    assertStringIncludes(client!.prompts[1], "budget for this run is spent");
    assertStringIncludes(client!.prompts[1], "--evidence");
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("goal loop folds an added task into the plan as a steer", async () => {
  const root = Deno.makeTempDirSync();
  await seedRepo(root);
  const store = new BoardStore(root);
  let client: ScriptedLoopClient | null = null;
  try {
    store.initProject();
    const { goal } = store.createGoal("Build the page");
    // Add a task before the loop runs; it must reach the agent.
    store.enqueueGoalMessage(goal.id, "user", "also add a footer");
    const runner = new GoalLoopRunner(root, store, {
      runMode: "unattended",
      maxIterations: 1,
      onEvent: () => {},
      createCodexClient: (onEvent) => {
        client = new ScriptedLoopClient(onEvent, (_cwd) => {
          store.addLoopPlanItem(goal.id, "Build page");
          return Promise.resolve("ok");
        });
        return client;
      },
    });
    await runner.run(goal.id);
    // The first planning prompt incorporated the pre-added task.
    assertStringIncludes(client!.prompts[0], "also add a footer");
    // The task.added path is exercised via the store message; it was consumed.
    assertEquals(store.listPendingGoalMessages(goal.id).length, 0);
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("goal loop injects an objective-updated steer when the goal text changes", async () => {
  const root = Deno.makeTempDirSync();
  await seedRepo(root);
  const store = new BoardStore(root);
  let client: ScriptedLoopClient | null = null;
  try {
    store.initProject();
    const { goal } = store.createGoal("Original objective");
    const runner = new GoalLoopRunner(root, store, {
      runMode: "unattended",
      maxIterations: 3,
      onEvent: () => {},
      createCodexClient: (onEvent) => {
        client = new ScriptedLoopClient(onEvent, (_cwd, turn) => {
          if (turn === 1) {
            store.addLoopPlanItem(goal.id, "Work");
            store.setGoalText(goal.id, "Revised objective with a new requirement");
          }
          return Promise.resolve("working");
        });
        return client;
      },
    });
    await runner.run(goal.id);
    // Turn 2's continuation prompt reflects the edited objective.
    assertStringIncludes(client!.prompts[1], "objective was edited");
    assertStringIncludes(client!.prompts[1], "Revised objective");
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

// A loop owner that fans out on turn 1, then completes after seeing the summary.
// Sub-agent turns (title "<goal>-<n>: <name>") write their scoped file.
class FanoutLoopClient implements CodexClient {
  ownerTurns = 0;
  constructor(
    private readonly onEvent: (
      e: {
        taskId: string | null;
        runId: string | null;
        role: string;
        kind: string;
        message: string;
      },
    ) => void,
    private readonly store: BoardStore,
    private readonly goalId: string,
  ) {}
  startSession(cwd: string, _o: CodexSessionOptions = {}): Promise<CodexSession> {
    return Promise.resolve({ threadId: "t", cwd });
  }
  resumeSession(cwd: string, id: string): Promise<CodexSession> {
    return Promise.resolve({ threadId: id, cwd });
  }
  async runTurn(session: CodexSession, input: CodexTurnInput): Promise<CodexTurnResult> {
    const isOwner = / loop \d+$/.test(input.title);
    let reply = "";
    if (isOwner) {
      this.ownerTurns++;
      if (this.ownerTurns === 1) {
        const item = this.store.addLoopPlanItem(this.goalId, "Build both halves");
        this.store.setLoopPlanItemStatus(this.goalId, item.id, "doing");
        reply = `Splitting the work.
LOOP_FANOUT
{"subtasks":[
  {"title":"api","instruction":"write api.txt","writeScope":["api.txt"]},
  {"title":"ui","instruction":"write ui.txt","writeScope":["ui.txt"]}
]}`;
      } else {
        const item = this.store.listLoopPlanItems(this.goalId)[0];
        this.store.setLoopPlanItemStatus(this.goalId, item.id, "done", "both subagents merged");
        reply = "Integrated both halves.\nLOOP_COMPLETE";
      }
    } else {
      const title = input.title.split(": ").pop() ?? "";
      const isApi = title.includes("api");
      await Deno.writeTextFile(
        `${session.cwd}/${isApi ? "api.txt" : "ui.txt"}`,
        isApi ? "api\n" : "ui\n",
      );
      reply = `${title} done`;
    }
    this.onEvent({ taskId: null, runId: null, role: "codex", kind: "agent", message: reply });
    return { threadId: session.threadId, turnId: "t", status: "completed", completed: true };
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }
}

Deno.test("goal loop delegates a fan-out, merges sub-agents, then completes", async () => {
  const root = Deno.makeTempDirSync();
  await seedRepo(root);
  const store = new BoardStore(root);
  const events: string[] = [];
  try {
    store.initProject();
    const { goal } = store.createGoal("Build both halves in parallel");
    const runner = new GoalLoopRunner(root, store, {
      runMode: "unattended",
      maxIterations: 5,
      onEvent: (e) => events.push(`${e.role}/${e.kind}`),
      createCodexClient: (onEvent) => new FanoutLoopClient(onEvent, store, goal.id),
    });
    const report = await runner.run(goal.id);
    assertEquals(report.outcome, "merged");
    // Both sub-agents' files were merged through the loop branch into the repo.
    assertEquals(await Deno.readTextFile(`${root}/api.txt`), "api\n");
    assertEquals(await Deno.readTextFile(`${root}/ui.txt`), "ui\n");
    const feed = store.listLifecycleEvents(goal.id).map((e) => e.kind);
    assert(feed.includes("subagent.spawned"));
    assert(feed.includes("subagent.merged"));
    assert(feed.includes("goal.closed"));
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("question mode asks first, then plans after the answer is queued", async () => {
  const root = Deno.makeTempDirSync();
  await seedRepo(root);
  const store = new BoardStore(root);
  let client: ScriptedLoopClient | null = null;
  try {
    store.initProject();
    const { goal } = store.createGoal("Build something");
    const runner = new GoalLoopRunner(root, store, {
      runMode: "unattended",
      questionMode: true,
      maxIterations: 3,
      onEvent: () => {},
      createCodexClient: (onEvent) => {
        // The clarify turn: ask questions, do NOT touch the task list.
        client = new ScriptedLoopClient(
          onEvent,
          (_cwd) => Promise.resolve("1. Which framework?\n2. Auth needed?\nLOOP_QUESTIONS"),
        );
        return client;
      },
    });
    const first = await runner.run(goal.id);
    assertEquals(first.outcome, "blocked");
    assertStringIncludes(first.detail, "Which framework");
    // No plan mutation happened during the clarify turn.
    const feed1 = store.listLifecycleEvents(goal.id).map((e) => e.kind);
    assert(feed1.includes("goal.blocked"));
    assert(!feed1.includes("plan.updated"));

    // The user answers; a fresh run (auto-resume in the server) now plans.
    store.enqueueGoalMessage(goal.id, "user", "React, no auth");
    const runner2 = new GoalLoopRunner(root, store, {
      runMode: "unattended",
      questionMode: true,
      maxIterations: 3,
      onEvent: () => {},
      createCodexClient: (onEvent) =>
        new ScriptedLoopClient(onEvent, (_cwd) => {
          const item = store.addLoopPlanItem(goal.id, "Done");
          store.setLoopPlanItemStatus(goal.id, item.id, "done", "built it");
          return Promise.resolve("LOOP_COMPLETE");
        }),
    });
    const second = await runner2.run(goal.id);
    assertEquals(second.outcome, "merged");
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("goal loop holds an attended merge when every probe was green at baseline", async () => {
  const root = Deno.makeTempDirSync();
  await seedRepo(root);
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal } = store.createGoal("Do the thing");
    // `true` passes at baseline, so the probe cannot prove any new work.
    store.addProbes(goal.id, [{ label: "always green", command: "true" }]);
    const runner = new GoalLoopRunner(root, store, {
      runMode: "attended",
      onEvent: () => {},
      createCodexClient: (onEvent) =>
        new ScriptedLoopClient(onEvent, (_cwd) => {
          const item = store.addLoopPlanItem(goal.id, "Do the thing");
          store.setLoopPlanItemStatus(goal.id, item.id, "done", "done");
          return Promise.resolve("LOOP_COMPLETE");
        }),
    });
    const report = await runner.run(goal.id);
    assertEquals(report.outcome, "held");
    assertEquals(store.getGoal(goal.id).status, "open");
    const hold = store.getBoard().tasks.find((task) =>
      task.currentGate === "manual-verification" && task.kind === "code"
    );
    assert(hold, "expected a parked merge-hold task");
    assertStringIncludes(hold!.needsInputPrompt ?? "", "already green");
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("goal loop merges an unattended weak gate but flags the closure with a caution", async () => {
  const root = Deno.makeTempDirSync();
  await seedRepo(root);
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal } = store.createGoal("Do the thing");
    store.addProbes(goal.id, [{ label: "always green", command: "true" }]);
    const runner = new GoalLoopRunner(root, store, {
      runMode: "unattended",
      onEvent: () => {},
      createCodexClient: (onEvent) =>
        new ScriptedLoopClient(onEvent, (_cwd) => {
          const item = store.addLoopPlanItem(goal.id, "Do the thing");
          store.setLoopPlanItemStatus(goal.id, item.id, "done", "done");
          return Promise.resolve("LOOP_COMPLETE");
        }),
    });
    const report = await runner.run(goal.id);
    assertEquals(report.outcome, "merged");
    assertStringIncludes(store.getGoal(goal.id).closureSummary, "CAUTION");
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("goal loop still merges a real red-to-green gate and reports the diffstat", async () => {
  const root = Deno.makeTempDirSync();
  await seedRepo(root);
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal } = store.createGoal("Build the file");
    // Fails at baseline (built.txt is absent), passes once the loop writes it.
    store.addProbes(goal.id, [{ label: "built exists", command: "test -f built.txt" }]);
    const runner = new GoalLoopRunner(root, store, {
      runMode: "unattended",
      onEvent: () => {},
      createCodexClient: (onEvent) =>
        new ScriptedLoopClient(onEvent, async (cwd) => {
          const item = store.addLoopPlanItem(goal.id, "Build it");
          store.setLoopPlanItemStatus(goal.id, item.id, "done", "wrote built.txt");
          await Deno.writeTextFile(`${cwd}/built.txt`, "built\n");
          return "LOOP_COMPLETE";
        }),
    });
    const report = await runner.run(goal.id);
    assertEquals(report.outcome, "merged");
    const summary = store.getGoal(goal.id).closureSummary;
    assert(/files? changed/.test(summary), `expected a diffstat in the closure, got: ${summary}`);
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("plan mutations emit plan.updated mid-turn, before the turn resolves", async () => {
  const root = Deno.makeTempDirSync();
  await seedRepo(root);
  const store = new BoardStore(root);
  let doingMidTurn = false;
  try {
    store.initProject();
    const { goal } = store.createGoal("Ship live tracking");
    const runner = new GoalLoopRunner(root, store, {
      runMode: "unattended",
      maxIterations: 1,
      onEvent: () => {},
      createCodexClient: (onEvent) =>
        new ScriptedLoopClient(onEvent, (_cwd) => {
          // Simulated ./lf-task calls mid-turn: the store emits plan.updated
          // synchronously, so the doing step is already on the feed BEFORE this
          // script (the turn) returns - ordering, no timers needed.
          const item = store.addLoopPlanItem(goal.id, "Build the widget");
          store.setLoopPlanItemStatus(goal.id, item.id, "doing");
          doingMidTurn = store.listLifecycleEvents(goal.id).some((event) =>
            event.kind === "plan.updated" &&
            (event.data.steps as Array<{ status: string }>).some((s) => s.status === "doing")
          );
          return Promise.resolve("Made progress.");
        }),
    });
    await runner.run(goal.id);
    assert(doingMidTurn, "expected a doing plan.updated before the turn resolved");
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("goal loop marks a pre-green probe in the first prompt", async () => {
  const root = Deno.makeTempDirSync();
  await seedRepo(root);
  const store = new BoardStore(root);
  let client: ScriptedLoopClient | null = null;
  try {
    store.initProject();
    const { goal } = store.createGoal("Something");
    store.addProbes(goal.id, [{ label: "always green", command: "true" }]);
    const runner = new GoalLoopRunner(root, store, {
      runMode: "unattended",
      maxIterations: 1,
      onEvent: () => {},
      createCodexClient: (onEvent) => {
        client = new ScriptedLoopClient(onEvent, (_cwd) => {
          store.addLoopPlanItem(goal.id, "Work");
          return Promise.resolve("working");
        });
        return client;
      },
    });
    await runner.run(goal.id);
    assertStringIncludes(client!.prompts[0], "ALREADY PASSING");
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a new goal never inherits a previous goal's LOOP_PLAN.md", async () => {
  const root = Deno.makeTempDirSync();
  await seedRepo(root);
  // A prior goal's finished plan was merged into main (the pre-exclude era).
  await Deno.writeTextFile(
    `${root}/LOOP_PLAN.md`,
    "# Plan\n- [x] Old goal item one -- done long ago\n- [x] Old goal item two -- done long ago\n",
  );
  await git(root, ["add", "LOOP_PLAN.md"]);
  await git(root, ["-c", "user.email=t@t", "-c", "user.name=T", "commit", "-m", "old plan"]);
  const store = new BoardStore(root);
  let client: ScriptedLoopClient | null = null;
  try {
    store.initProject();
    const { goal } = store.createGoal("Fresh goal");
    store.addProbes(goal.id, [{ label: "fresh exists", command: "test -f fresh.txt" }]);
    const runner = new GoalLoopRunner(root, store, {
      runMode: "unattended",
      onEvent: () => {},
      createCodexClient: (onEvent) => {
        client = new ScriptedLoopClient(onEvent, async (cwd) => {
          const item = store.addLoopPlanItem(goal.id, "Build fresh thing");
          store.setLoopPlanItemStatus(goal.id, item.id, "done", "wrote fresh.txt");
          await Deno.writeTextFile(`${cwd}/fresh.txt`, "fresh\n");
          return "Done.\nLOOP_COMPLETE";
        });
        return client;
      },
    });
    const report = await runner.run(goal.id);
    assertEquals(report.outcome, "merged");
    // The stale file never seeded this goal: turn one got the full first prompt
    // (win conditions + contract), not a continuation prompt.
    assertStringIncludes(client!.prompts[0], "Win conditions");
    assertStringIncludes(client!.prompts[0], "fresh exists");
    // No stale step ever reached this goal's board.
    const feed = store.listLifecycleEvents(goal.id);
    for (const event of feed.filter((e) => e.kind === "plan.updated")) {
      const steps = event.data.steps as Array<{ title: string }>;
      assert(
        steps.every((s) => !s.title.includes("Old goal item")),
        `stale step leaked: ${JSON.stringify(steps)}`,
      );
    }
    // The stale tracked file is deleted from main by the merge, so the next
    // goal starts clean too.
    const planExists = await Deno.stat(`${root}/LOOP_PLAN.md`).then(() => true).catch(() => false);
    assert(!planExists, "LOOP_PLAN.md should be gone from the merged root");
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("goal loop re-persists a session id minted during the first turn", async () => {
  const root = Deno.makeTempDirSync();
  await seedRepo(root);
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal } = store.createGoal("Late session id");
    const runner = new GoalLoopRunner(root, store, {
      runMode: "unattended",
      onEvent: () => {},
      createCodexClient: (onEvent) => {
        // Blocked outcome keeps the goal open with loop state intact, so the
        // persisted thread id is observable after the run (a merged close
        // clears loop state during reclaim).
        const client = new ScriptedLoopClient(
          onEvent,
          () => Promise.resolve("LOOP_BLOCKED: which flavor?"),
        );
        // Claude Code style: startSession hands out a placeholder and the real
        // id only appears while the first turn runs.
        client.startSession = (cwd: string) => Promise.resolve({ threadId: "claude-pending", cwd });
        const originalRunTurn = client.runTurn.bind(client);
        client.runTurn = (session, input) => {
          session.threadId = "real-session-id";
          return originalRunTurn(session, input);
        };
        return client;
      },
    });
    const report = await runner.run(goal.id);
    assertEquals(report.outcome, "blocked");
    // The durable id minted mid-turn was written back over the placeholder.
    assertEquals(store.getGoal(goal.id).loopThreadId, "real-session-id");
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});
