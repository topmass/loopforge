// Compatibility freeze for the thread-first migration. These tests pin the
// wire shapes the GUI, CLI, and external automation consume TODAY. Later
// migration steps must be additive: if one of these fails, a contract broke.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { startServer } from "../src/web/server.ts";
import { BoardStore } from "../src/board/store.ts";

// -- Frozen shapes ------------------------------------------------------------

const BOARD_KEYS = [
  "goals",
  "tasks",
  "runs",
  "agentStatuses",
  "externalAgents",
  "probes",
  "lessons",
  "ideas",
  "events",
  "statuses",
  "projectState",
];

const GOAL_KEYS = [
  "id",
  "text",
  "status",
  "completionContract",
  "closureSummary",
  "loopThreadId",
  "loopBranch",
  "loopWorktree",
];

const TASK_KEYS = ["id", "goalId", "title", "status", "kind", "priority"];

const PROBE_KEYS = [
  "id",
  "goalId",
  "label",
  "command",
  "expectContains",
  "timeoutMs",
  "lastStatus",
  "lastOutput",
  "lastRunAt",
];

const RUNTIME_KEYS = [
  "project",
  "config",
  "backend",
  "backendRaw",
  "rescue",
  "planner",
  "scout",
  "pushBranches",
  "maxParallelAgents",
  "workflow",
  "projectState",
];

const PROJECT_STATE_KEYS = [
  "mainThreadId",
  "mainThreadCreatedAt",
  "mainThreadResetAt",
  "mainThreadSummary",
];

function assertHasKeys(actual: Record<string, unknown>, keys: string[], label: string): void {
  for (const key of keys) {
    assert(key in actual, `${label} lost frozen key "${key}"`);
  }
}

Deno.test("contract: board snapshot and runtime keep their frozen keys", async () => {
  const root = Deno.makeTempDirSync();
  const boot = new BoardStore(root);
  try {
    boot.initProject();
    const { goal, task } = boot.createGoal("Contract goal");
    boot.addProbes(goal.id, [{ label: "check", command: "true" }]);
    assert(task.id.startsWith("TASK-"));
  } finally {
    boot.close();
  }

  const port = 52933 + Math.floor(Math.random() * 300);
  const server = startServer(root, port);
  try {
    const board = await fetch(`${server.url}/api/board`).then((r) => r.json());
    assertHasKeys(board, BOARD_KEYS, "board snapshot");
    assertHasKeys(board.goals[0], GOAL_KEYS, "goal");
    assertHasKeys(board.tasks[0], TASK_KEYS, "task");
    assertHasKeys(board.probes[0], PROBE_KEYS, "probe");
    assertHasKeys(board.projectState, PROJECT_STATE_KEYS, "projectState");

    const runtime = await fetch(`${server.url}/api/runtime`).then((r) => r.json());
    assertHasKeys(runtime, RUNTIME_KEYS, "runtime");
    assert("useWorktrees" in runtime.workflow, "runtime.workflow lost useWorktrees");
    assert("maxConcurrentAgents" in runtime.workflow, "runtime.workflow lost maxConcurrentAgents");
  } finally {
    server.shutdown();
    await server.finished.catch(() => {});
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("contract: lifecycle events keep role, canonical kind, and rawJson payload", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal } = store.createGoal("Lifecycle contract");
    const event = store.appendLifecycleEvent({
      kind: "plan.updated",
      goalId: goal.id,
      taskId: null,
      summary: "steps landed",
      data: { steps: [{ title: "one", status: "todo" }] },
    });
    // The GUI's parseLifecycle depends on exactly this shape.
    assertEquals(event.role, "lifecycle");
    assertEquals(event.kind, "plan.updated");
    const raw = JSON.parse(
      (event as unknown as { rawJson?: string }).rawJson ?? "{}",
    );
    assertEquals(raw.goalId, goal.id);
    assertEquals(raw.data.steps[0].title, "one");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("contract: the loop merge-hold task keeps its restart-to-merge semantics", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal } = store.createGoal("Hold contract");
    const hold = store.createLoopMergeHoldTask(
      goal.id,
      "loopforge/goal-hold",
      "Verify by hand, then restart this task to merge.",
      "evidence line",
    );
    // The attended approval flow: a Review-status task whose restart merges.
    // The future goal-level "Approve merge" action must map onto this task.
    assertEquals(hold.status, "review");
    assertEquals(hold.goalId, goal.id);
    assertStringIncludes(hold.needsInputPrompt ?? "", "restart this task");
    assertEquals(hold.branchName, "loopforge/goal-hold");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

// -- Front thread additions (steps 2-3) are additive --------------------------

Deno.test("front thread: identity is separate from the main thread", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    store.setMainThread("main-thread-1");
    assertEquals(store.getFrontThreadId(), null);
    store.setFrontThreadId("front-thread-1");
    assertEquals(store.getFrontThreadId(), "front-thread-1");
    // Setting the front thread never touches main-thread lineage.
    assertEquals(store.getProjectState().mainThreadId, "main-thread-1");
    store.setFrontThreadId(null);
    assertEquals(store.getFrontThreadId(), null);
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("front thread: messages persist, page by afterId, and stamp revisions", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const first = store.appendFrontMessage("user", "hello chief");
    const reply = store.appendFrontMessage("front", "hello back", "turn-1");
    assertEquals(first.role, "user");
    assertEquals(reply.turnRef, "turn-1");

    const all = store.listFrontMessages();
    assertEquals(all.map((m) => m.message), ["hello chief", "hello back"]);
    const afterFirst = store.listFrontMessages({ afterId: first.id });
    assertEquals(afterFirst.map((m) => m.id), [reply.id]);

    const before = store.eventRevision();
    store.appendEvent(null, null, "core", "test", "bump revision");
    assert(store.eventRevision() > before);
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("front thread: status and message endpoints answer from the ledger", async () => {
  const root = Deno.makeTempDirSync();
  const boot = new BoardStore(root);
  let goalId = "";
  try {
    boot.initProject();
    const { goal } = boot.createGoal("Front reads");
    goalId = goal.id;
    boot.addProbes(goal.id, [{ label: "always green", command: "true" }]);
  } finally {
    boot.close();
  }

  const port = 53233 + Math.floor(Math.random() * 300);
  const server = startServer(root, port);
  try {
    const status = await fetch(`${server.url}/api/front/status`).then((r) => r.json());
    assert(typeof status.revision === "number");
    assertEquals(status.goals[0].id, goalId);
    assertEquals(status.goals[0].probes.total, 1);
    assertEquals(status.frontThreadId, null);

    const posted = await fetch(`${server.url}/api/front/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "status?" }),
    });
    assertEquals(posted.status, 201);
    const { message } = await posted.json();
    assertEquals(message.role, "user");

    const listed = await fetch(`${server.url}/api/front/messages`).then((r) => r.json());
    assertEquals(listed.messages.length, 1);
    assertEquals(listed.messages[0].message, "status?");

    const empty = await fetch(`${server.url}/api/front/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "  " }),
    });
    assertEquals(empty.status, 400);
    await empty.json();
  } finally {
    server.shutdown();
    await server.finished.catch(() => {});
    await Deno.remove(root, { recursive: true });
  }
});
