import { assert, assertEquals, assertStringIncludes } from "@std/assert";
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

async function seedRepo(root: string): Promise<void> {
  await git(root, ["init", "-b", "main"]);
  await git(root, ["-c", "user.email=t@t", "-c", "user.name=T", "commit", "--allow-empty", "-m", "seed"]);
}

type TurnScript = (cwd: string, turn: number) => Promise<string>;

// A scripted loop owner: each runTurn invokes the script with the worktree and
// turn number; the returned text becomes the captured agent message.
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

Deno.test("goal loop plans, mirrors the checklist, passes probes, and merges unattended", async () => {
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
            await Deno.writeTextFile(
              `${cwd}/LOOP_PLAN.md`,
              "# Plan\n- [x] Create the widget -- wrote widget.txt\n- [ ] Document the widget\n",
            );
            await Deno.writeTextFile(`${cwd}/widget.txt`, "widget\n");
            return "Planned and created the widget.";
          }
          await Deno.writeTextFile(
            `${cwd}/LOOP_PLAN.md`,
            "# Plan\n- [x] Create the widget -- wrote widget.txt\n- [x] Document the widget -- wrote docs.md\n",
          );
          await Deno.writeTextFile(`${cwd}/docs.md`, "docs\n");
          return "All items finished.\nLOOP_COMPLETE";
        });
        return client;
      },
    });
    const report = await runner.run(goal.id);
    assertEquals(report.outcome, "merged");
    assertEquals(client!.turns, 2);
    assertStringIncludes(client!.prompts[0], "LOOP_PLAN.md");
    assertStringIncludes(client!.prompts[0], "widget exists");
    assertStringIncludes(client!.prompts[0], "Autonomous Operation");
    assertStringIncludes(client!.prompts[1], "Continue the loop");

    // Mirror tasks follow the checklist and never dispatch.
    const board = store.getBoard();
    const mirrors = board.tasks.filter((task) => task.kind === "loop");
    assertEquals(mirrors.length, 2);
    assert(mirrors.every((task) => task.status === "done"));
    assert(!store.listDispatchableTasks(20).some((task) => task.kind === "loop"));

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
    const runner = new GoalLoopRunner(root, store, {
      runMode: "attended",
      onEvent: () => {},
      createCodexClient: (onEvent) =>
        new ScriptedLoopClient(onEvent, async (cwd) => {
          await Deno.writeTextFile(
            `${cwd}/LOOP_PLAN.md`,
            "# Plan\n- [x] Build the dialog -- needs manual verification: confirm it renders in-app\n",
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
        new ScriptedLoopClient(onEvent, async (cwd) => {
          await Deno.writeTextFile(
            `${cwd}/LOOP_PLAN.md`,
            "# Plan\n- [~] Wire the provider\n",
          );
          return "LOOP_BLOCKED: need the provider test API key to continue";
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
        client = new ScriptedLoopClient(onEvent, async (cwd, turn) => {
          if (turn === 1) {
            await Deno.writeTextFile(`${cwd}/LOOP_PLAN.md`, "# Plan\n- [ ] Something hard\n");
          }
          return "Thinking about it.";
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
