import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import path from "node:path";
import {
  CodexClient,
  CodexSession,
  CodexThreadReadResult,
  CodexTurnInput,
  CodexTurnResult,
} from "../src/workers/codex_app_server.ts";
import { startServer } from "../src/web/server.ts";
import { BoardStore } from "../src/board/store.ts";

Deno.test("server exposes board, creates goals, and runs Codex worker", async () => {
  const root = Deno.makeTempDirSync();
  await git(root, ["init", "-b", "main"]);
  await git(root, ["commit", "--allow-empty", "-m", "seed"]);
  const port = 48733 + Math.floor(Math.random() * 300);
  const server = startServer(root, port, {
    createCodexClient: (onEvent) => new TestCodexClient(onEvent),
  });
  try {
    const html = await fetch(`${server.url}/`).then((response) => response.text());
    assertStringIncludes(html, "LoopForge");

    const configResponse = await fetch(`${server.url}/api/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4",
        reasoningEffort: "medium",
        fastMode: false,
        githubPrReview: true,
      }),
    });
    assertEquals(configResponse.ok, true);
    const config = await configResponse.json();
    assertEquals(config.model, "gpt-5.4");
    assertEquals(config.reasoningEffort, "medium");
    assertEquals(config.fastMode, false);
    assertEquals(config.githubPrReview, true);

    const runtime = await fetch(`${server.url}/api/runtime`).then((response) => response.json());
    assertEquals(runtime.queueRunning, false);
    assertEquals(runtime.workflow.trackerKind, "loopforge-local");
    assertEquals(runtime.runningRuns.length, 0);

    await fetch(`${server.url}/api/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ githubPrReview: false }),
    });

    const create = await fetch(`${server.url}/api/goals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Run through the GUI path" }),
    }).then((response) => response.json());
    assertEquals(create.tasks.length, 1);
    assertEquals(create.tasks[0].id, "TASK-1");

    const runResponse = await fetch(`${server.url}/api/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assertEquals(runResponse.ok, true);
    await runResponse.json();

    const board = await waitForDone(server.url);
    assertEquals(board.tasks[0].status, "done");
    assertStringIncludes(board.tasks[0].validation, "Codex App Server turn completed");
    assertStringIncludes(board.tasks[0].validation, "Commit:");
    assertStringIncludes(board.tasks[0].validation, "Test turn:");
    assertStringIncludes(board.tasks[0].validation, "LoopForge review: APPROVED");
    assertEquals(await Deno.readTextFile(`${root}/server-test.txt`), "server worker output\n");
    assert(board.agentStatuses.some((status) => status.phase === "done"));

    const threadRead = await fetch(`${server.url}/api/tasks/TASK-1/thread`).then((response) =>
      response.json()
    );
    assertEquals(threadRead.thread.threadId, "thread-server-test");
    assertEquals(threadRead.thread.turnCount, 1);

    const compactTask = await fetch(`${server.url}/api/tasks/TASK-1/compact-thread`, {
      method: "POST",
    });
    assertEquals(compactTask.ok, true);

    const compactMain = await fetch(`${server.url}/api/main/compact`, {
      method: "POST",
    });
    assertEquals(compactMain.ok, true);

    const planned = await fetch(`${server.url}/api/goals/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Plan through the GUI path" }),
    }).then((response) => response.json());
    assertEquals(planned.tasks.length, 1);
    assertStringIncludes(planned.goal.completionContract, "Complete every planned task.");

    const deleteResponse = await fetch(`${server.url}/api/tasks/${planned.tasks[0].id}`, {
      method: "DELETE",
    });
    assertEquals(deleteResponse.ok, true);
    await deleteResponse.json();
  } finally {
    server.shutdown();
    await server.finished.catch(() => {});
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("server deletes a started task with a stale running run", async () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { task } = store.createGoal("Delete stuck started task");
    store.assignWorktree(task.id, "loopforge/task-1", `${root}/.loopforge/worktrees/TASK-1`);
    store.requestTransition(task.id, "in_progress", "test", "claim");
    store.createRun(task.id, "worker");
  } finally {
    store.close();
  }

  const port = 49033 + Math.floor(Math.random() * 300);
  const server = startServer(root, port, {
    createCodexClient: (onEvent) => new TestCodexClient(onEvent),
  });
  try {
    const deleteResponse = await fetch(`${server.url}/api/tasks/TASK-1`, {
      method: "DELETE",
    });
    assertEquals(deleteResponse.ok, true);
    await deleteResponse.json();
    const board = await fetch(`${server.url}/api/board`).then((response) => response.json());
    assertEquals(board.tasks.length, 0);
    assertEquals(board.runs.length, 0);
  } finally {
    server.shutdown();
    await server.finished.catch(() => {});
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("server runtime exposes active worker status for the live strip", async () => {
  const root = Deno.makeTempDirSync();
  const boot = new BoardStore(root);
  boot.initProject();
  boot.close();

  const port = 49433 + Math.floor(Math.random() * 300);
  const server = startServer(root, port, {
    createCodexClient: (onEvent) => new TestCodexClient(onEvent),
  });
  try {
    // Seed a running worker AFTER boot: startServer's recoverStaleRuns fails any
    // pre-existing running run on startup (it assumes a crash), so seeding
    // earlier would be wiped before the first read.
    const store = new BoardStore(root);
    let taskId = "";
    try {
      const { task } = store.createGoal("Surface active workers");
      taskId = task.id;
      const run = store.createRun(task.id, "worker");
      store.upsertAgentStatus({
        taskId: task.id,
        runId: run.id,
        phase: "editing",
        headline: "Editing handler.ts",
        detail: "Applying the patch.",
        risk: "test_failed",
      });
    } finally {
      store.close();
    }

    const runtime = await fetch(`${server.url}/api/runtime`).then((response) => response.json());
    // The web "Active workers" strip renders exactly these fields.
    assertEquals(runtime.activeAgentStatuses.length, 1);
    const worker = runtime.activeAgentStatuses[0];
    assertEquals(worker.taskId, taskId);
    assertEquals(worker.phase, "editing");
    assertEquals(worker.headline, "Editing handler.ts");
    assertEquals(worker.risk, "test_failed");
  } finally {
    server.shutdown();
    await server.finished.catch(() => {});
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("server runtime exposes live fan-out agents and hides finished ones", async () => {
  const root = Deno.makeTempDirSync();
  const boot = new BoardStore(root);
  boot.initProject();
  boot.close();

  const port = 49533 + Math.floor(Math.random() * 300);
  const server = startServer(root, port, {
    createCodexClient: (onEvent) => new TestCodexClient(onEvent),
  });
  try {
    const store = new BoardStore(root);
    try {
      // A goal-loop fan-out agent reports onto the board the same way the
      // dispatcher tasks do, so the Kanban shows both paths.
      store.reportExternalAgent({
        id: "GOAL-1-0",
        agent: "Repair merge race",
        state: "working",
        headline: "Working: repair merge race",
      });
      store.reportExternalAgent({
        id: "GOAL-1-1",
        agent: "Finished subtask",
        state: "done",
        headline: "merged",
      });
    } finally {
      store.close();
    }

    const runtime = await fetch(`${server.url}/api/runtime`).then((response) => response.json());
    // Only the live agent is surfaced; the done one is filtered out.
    assertEquals(runtime.externalAgents.length, 1);
    assertEquals(runtime.externalAgents[0].id, "GOAL-1-0");
    assertEquals(runtime.externalAgents[0].agent, "Repair merge race");
    assertEquals(runtime.externalAgents[0].state, "working");
  } finally {
    server.shutdown();
    await server.finished.catch(() => {});
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("server requests a running task stop", async () => {
  const root = Deno.makeTempDirSync();
  const port = 49133 + Math.floor(Math.random() * 300);
  const server = startServer(root, port, {
    createCodexClient: (onEvent) => new TestCodexClient(onEvent),
  });
  try {
    const store = new BoardStore(root);
    try {
      const { task } = store.createGoal("Stop from the TUI");
      store.createRun(task.id, "worker");
    } finally {
      store.close();
    }

    const stopResponse = await fetch(`${server.url}/api/tasks/TASK-1/stop`, {
      method: "POST",
    });
    assertEquals(stopResponse.ok, true);
    await stopResponse.json();
    const board = await fetch(`${server.url}/api/board`).then((response) => response.json());
    assertEquals(Boolean(board.runs[0].stopRequestedAt), true);
    assertStringIncludes(board.tasks[0].nextAction, "stopping");
  } finally {
    server.shutdown();
    await server.finished.catch(() => {});
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("server clears completed tasks from the board", async () => {
  const root = Deno.makeTempDirSync();
  const port = 49203 + Math.floor(Math.random() * 300);
  const server = startServer(root, port, {
    createCodexClient: (onEvent) => new TestCodexClient(onEvent),
  });
  try {
    const store = new BoardStore(root);
    try {
      const { tasks } = store.createGoalWithTasks("Clear finished cards", [
        {
          title: "Done card",
          description: "Finish this card.",
          acceptanceCriteria: "Done.",
          priority: 100,
        },
        {
          title: "Ready card",
          description: "Keep this card.",
          acceptanceCriteria: "Still ready.",
          priority: 90,
        },
      ]);
      store.updateTaskValidation(tasks[0].id, "Validated.");
      store.requestTransition(tasks[0].id, "in_progress", "test", "started");
      store.requestTransition(tasks[0].id, "review", "test", "ready");
      store.requestTransition(tasks[0].id, "done", "test", "complete");
    } finally {
      store.close();
    }

    const response = await fetch(`${server.url}/api/tasks/done`, { method: "DELETE" });
    assertEquals(response.ok, true);
    const cleared = await response.json();
    assertEquals(cleared.count, 1);
    const board = await fetch(`${server.url}/api/board`).then((item) => item.json());
    assertEquals(board.tasks.length, 1);
    assertEquals(board.tasks[0].title, "Ready card");
  } finally {
    server.shutdown();
    await server.finished.catch(() => {});
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("server creates a manual task without Codex planning", async () => {
  const root = Deno.makeTempDirSync();
  const port = 49233 + Math.floor(Math.random() * 300);
  const server = startServer(root, port, {
    createCodexClient: (onEvent) => new TestCodexClient(onEvent),
  });
  try {
    const response = await fetch(`${server.url}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Click-created task",
        description: "Created from the command center.",
        acceptanceCriteria: "Visible on the board.",
      }),
    });
    assertEquals(response.ok, true);
    const created = await response.json();
    assertEquals(created.tasks.length, 1);
    assertEquals(created.tasks[0].title, "Click-created task");
    assertEquals(created.tasks[0].acceptanceCriteria, "Visible on the board.");

    const board = await fetch(`${server.url}/api/board`).then((item) => item.json());
    assertEquals(board.tasks.length, 1);
    assertEquals(board.tasks[0].title, "Click-created task");
  } finally {
    server.shutdown();
    await server.finished.catch(() => {});
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("server builds a goal by planning tasks and starting the queue", async () => {
  const root = Deno.makeTempDirSync();
  await git(root, ["init", "-b", "main"]);
  await git(root, ["commit", "--allow-empty", "-m", "seed"]);
  const port = 49333 + Math.floor(Math.random() * 300);
  const server = startServer(root, port, {
    createCodexClient: (onEvent) => new TestCodexClient(onEvent),
  });
  try {
    const response = await fetch(`${server.url}/api/goals/build`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Build the requested feature completely" }),
    });
    assertEquals(response.ok, true);
    const created = await response.json();
    assertEquals(created.tasks.length, 1);
    assertEquals(created.running, true);
    assertEquals(created.tasks[0].id, "TASK-1");

    const board = await waitForClosedGoal(server.url);
    assertEquals(board.tasks[0].status, "done");
    assertEquals(board.goals[0].status, "closed");
    assertStringIncludes(board.goals[0].closureSummary, "1/1 tasks done.");
    assertStringIncludes(board.tasks[0].validation, "Codex App Server turn completed");
    assertEquals(await Deno.readTextFile(`${root}/server-test.txt`), "server worker output\n");
  } finally {
    server.shutdown();
    await server.finished.catch(() => {});
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("server ensures and reuses the persistent main Codex thread", async () => {
  const root = Deno.makeTempDirSync();
  let starts = 0;
  const port = 49533 + Math.floor(Math.random() * 300);
  const server = startServer(root, port, {
    createCodexClient: (onEvent) => new TestCodexClient(onEvent, () => starts++),
  });
  try {
    const first = await fetch(`${server.url}/api/main/ensure`, { method: "POST" }).then((item) =>
      item.json()
    );
    assertEquals(first.mainThreadId, "thread-server-test");
    assertEquals(starts, 1);

    const second = await fetch(`${server.url}/api/main/ensure`, { method: "POST" }).then((item) =>
      item.json()
    );
    assertEquals(second.mainThreadId, "thread-server-test");
    assertEquals(starts, 1);
  } finally {
    server.shutdown();
    await server.finished.catch(() => {});
  }

  const reopened = startServer(root, port + 1000, {
    createCodexClient: (onEvent) => new TestCodexClient(onEvent, () => starts++),
  });
  try {
    const state = await fetch(`${reopened.url}/api/main/ensure`, { method: "POST" }).then((item) =>
      item.json()
    );
    assertEquals(state.mainThreadId, "thread-server-test");
    assertEquals(starts, 1);
  } finally {
    reopened.shutdown();
    await reopened.finished.catch(() => {});
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("server updates planner routing and max concurrent agents", async () => {
  const root = Deno.makeTempDirSync();
  const port = 50133 + Math.floor(Math.random() * 300);
  const server = startServer(root, port, {
    createCodexClient: (onEvent) => new TestCodexClient(onEvent),
  });
  const patchJson = (path: string, body: unknown) =>
    fetch(`${server.url}${path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const planner = await patchJson("/api/planner", { enabled: true, backend: "claude" })
      .then((response) => response.json());
    assertEquals(planner, { enabled: true, backend: "claude" });

    const agents = await patchJson("/api/workflow/agents", { maxConcurrentAgents: 4 })
      .then((response) => response.json());
    assertEquals(agents.maxConcurrentAgents, 4);
    assertStringIncludes(
      await Deno.readTextFile(`${root}/WORKFLOW.md`),
      "max_concurrent_agents: 4",
    );

    const runtime = await fetch(`${server.url}/api/runtime`).then((response) => response.json());
    assertEquals(runtime.planner, { enabled: true, backend: "claude" });
    assertEquals(runtime.workflow.maxConcurrentAgents, 4);

    const rejected = await patchJson("/api/workflow/agents", { maxConcurrentAgents: 0 });
    assertEquals(rejected.status, 400);
    await rejected.json();
  } finally {
    await patchJson("/api/planner", { enabled: false }).then((response) => response.json());
    server.shutdown();
    await server.finished.catch(() => {});
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("server runs the scout and gatekeeps ideas through approve and reject", async () => {
  const root = Deno.makeTempDirSync();
  const port = 50533 + Math.floor(Math.random() * 300);
  const scoutJson = JSON.stringify({
    ideas: [
      {
        title: "Add a changelog page",
        pitch: "**What:** changelog. **Why it's cool:** visibility. **Why now:** momentum.",
        sources: [],
        buildsOn: "",
      },
      {
        title: "Add release tagging",
        pitch: "**What:** tags. **Why it's cool:** traceability. **Why now:** pairs.",
        sources: [],
        buildsOn: "Add a changelog page",
      },
    ],
    order: ["Add a changelog page", "Add release tagging"],
  });
  const server = startServer(root, port, {
    createCodexClient: (onEvent) => new TestCodexClient(onEvent),
    createScoutClient: (onEvent) => new ScoutStubClient(onEvent, scoutJson),
  });
  try {
    const scoutPatch = await fetch(`${server.url}/api/scout`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, backend: "codex" }),
    }).then((response) => response.json());
    assertEquals(scoutPatch, { enabled: true, backend: "codex" });

    const report = await fetch(`${server.url}/api/scout/run`, { method: "POST" })
      .then((response) => response.json());
    assertEquals(report.ran, true);
    assertEquals(report.added.length, 2);

    const ideas = await fetch(`${server.url}/api/ideas`).then((response) => response.json());
    assertEquals(ideas.length, 2);
    assertEquals(ideas[0].title, "Add a changelog page");

    const rejected = await fetch(`${server.url}/api/ideas/${ideas[1].id}/reject`, {
      method: "POST",
    }).then((response) => response.json());
    assertEquals(rejected.status, "rejected");

    const approved = await fetch(`${server.url}/api/ideas/${ideas[0].id}/approve`, {
      method: "POST",
    }).then((response) => response.json());
    assertEquals(approved.idea.status, "approved");
    assert(approved.goal.id.startsWith("GOAL-"));
    assert(approved.tasks.length >= 1);

    const board = await fetch(`${server.url}/api/board`).then((response) => response.json());
    assertEquals(board.ideas.length, 0);
    assert(board.goals.some((goal: { text: string }) => goal.text.includes("changelog")));
  } finally {
    await fetch(`${server.url}/api/scout`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    }).then((response) => response.json());
    server.shutdown();
    await server.finished.catch(() => {});
    await Deno.remove(root, { recursive: true });
  }
});

class ScoutStubClient implements CodexClient {
  constructor(
    private readonly onEvent: (event: {
      taskId: string | null;
      runId: string | null;
      role: string;
      kind: string;
      message: string;
    }) => void,
    private readonly response: string,
  ) {}

  startSession(cwd: string): Promise<CodexSession> {
    return Promise.resolve({ threadId: "thread-scout-stub", cwd });
  }

  resumeSession(cwd: string, threadId: string): Promise<CodexSession> {
    return Promise.resolve({ threadId, cwd });
  }

  readThread(session: CodexSession): Promise<CodexThreadReadResult> {
    return Promise.resolve({
      threadId: session.threadId,
      name: "scout",
      status: "idle",
      turnCount: 0,
      raw: {},
    });
  }

  compactThread(_session: CodexSession): Promise<void> {
    return Promise.resolve();
  }

  runTurn(session: CodexSession, _input: CodexTurnInput): Promise<CodexTurnResult> {
    this.onEvent({
      taskId: null,
      runId: null,
      role: "codex",
      kind: "agent",
      message: this.response,
    });
    return Promise.resolve({
      threadId: session.threadId,
      turnId: "turn-scout-stub",
      status: "completed",
      completed: true,
    });
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}

interface BoardResponse {
  goals: Array<{ id: string; status: string; closureSummary: string; completionContract: string }>;
  tasks: Array<{ status: string; validation: string }>;
  events: Array<{ message: string }>;
  agentStatuses: Array<{ phase: string }>;
}

class TestCodexClient implements CodexClient {
  constructor(
    protected readonly onEvent: (
      event: {
        taskId: string | null;
        runId: string | null;
        role: string;
        kind: string;
        message: string;
      },
    ) => void,
    private readonly onStartSession: () => void = () => {},
  ) {}

  startSession(cwd: string): Promise<CodexSession> {
    this.onStartSession();
    return Promise.resolve({ threadId: "thread-server-test", cwd });
  }

  resumeSession(cwd: string, threadId: string): Promise<CodexSession> {
    return Promise.resolve({ threadId, cwd });
  }

  readThread(session: CodexSession, includeTurns = false): Promise<CodexThreadReadResult> {
    return Promise.resolve({
      threadId: session.threadId,
      name: "LoopForge test thread",
      status: "idle",
      turnCount: includeTurns ? 1 : 0,
      raw: { id: session.threadId, name: "LoopForge test thread" },
    });
  }

  compactThread(_session: CodexSession): Promise<void> {
    return Promise.resolve();
  }

  async runTurn(session: CodexSession, _input: CodexTurnInput): Promise<CodexTurnResult> {
    if (_input.title === "LoopForge main thread seed") {
      assertStringIncludes(_input.prompt, "persistent LoopForge main thread");
      this.onEvent({
        taskId: null,
        runId: null,
        role: "codex",
        kind: "agent",
        message: "main thread seed acknowledged",
      });
      return {
        threadId: session.threadId,
        turnId: "turn-main-seed",
        status: "completed",
        completed: true,
      };
    }

    if (_input.title === "LoopForge goal compiler") {
      assertStringIncludes(_input.prompt, "Current LoopForge board memory");
      this.onEvent({
        taskId: null,
        runId: null,
        role: "codex",
        kind: "agent",
        message: JSON.stringify({
          title: "Implement compiled goal",
          prompt: "Inspect the project, implement the requested goal, and validate the result.",
          acceptanceCriteria: "- Implementation is validated.",
          priority: 200,
          workpad: "Compiled prompt task.",
        }),
      });
      return {
        threadId: session.threadId,
        turnId: "turn-planner-test",
        status: "completed",
        completed: true,
      };
    }

    if (_input.title.endsWith(": review")) {
      assertStringIncludes(_input.prompt, "Current LoopForge board memory");
      this.onEvent({
        taskId: null,
        runId: null,
        role: "codex",
        kind: "agent",
        message: "APPROVED\n- Validation covers the task.",
      });
      return {
        threadId: session.threadId,
        turnId: "turn-review-test",
        status: "completed",
        completed: true,
      };
    }

    if (_input.title.endsWith(": absorb")) {
      assertStringIncludes(_input.prompt, "Absorb this completed LoopForge task");
      this.onEvent({
        taskId: null,
        runId: null,
        role: "codex",
        kind: "agent",
        message: "absorbed task memory",
      });
      return {
        threadId: session.threadId,
        turnId: "turn-absorb-test",
        status: "completed",
        completed: true,
      };
    }

    if (_input.title === "LoopForge scheduler") {
      assertStringIncludes(_input.prompt, "Current LoopForge board memory");
      this.onEvent({
        taskId: null,
        runId: null,
        role: "codex",
        kind: "agent",
        message: JSON.stringify({
          taskIds: ["TASK-3"],
          notes: "Run the next independent planned task.",
        }),
      });
      return {
        threadId: session.threadId,
        turnId: "turn-scheduler-test",
        status: "completed",
        completed: true,
      };
    }

    if (_input.title.endsWith(": test-engineer")) {
      assertStringIncludes(_input.prompt, "Current LoopForge board memory");
      this.onEvent({
        taskId: null,
        runId: null,
        role: "codex",
        kind: "agent",
        message: "VERIFICATION_PASSED\n- Test engineer validation output.",
      });
      return {
        threadId: session.threadId,
        turnId: "turn-test-engineer",
        status: "completed",
        completed: true,
      };
    }

    assertStringIncludes(_input.prompt, "Current LoopForge board memory");
    await Deno.writeTextFile(`${session.cwd}/server-test.txt`, "server worker output\n");
    this.onEvent({
      taskId: null,
      runId: null,
      role: "codex",
      kind: "output",
      message: "server worker output",
    });
    return {
      threadId: session.threadId,
      turnId: "turn-server-test",
      status: "completed",
      completed: true,
    };
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}

async function git(root: string, args: string[]): Promise<void> {
  const output = await new Deno.Command("git", {
    args: [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      ...args,
    ],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(new TextDecoder().decode(output.stderr));
  }
}

async function waitForDone(url: string): Promise<BoardResponse> {
  for (let index = 0; index < 80; index++) {
    const board = await fetch(`${url}/api/board`).then((response) => response.json());
    if (board.tasks[0]?.status === "done") {
      return board;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Task did not reach Done.");
}

async function waitForClosedGoal(url: string): Promise<BoardResponse> {
  for (let index = 0; index < 80; index++) {
    const board = await fetch(`${url}/api/board`).then((response) => response.json());
    if (board.tasks[0]?.status === "done" && board.goals[0]?.status === "closed") {
      return board;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Goal did not close after Build Goal completed.");
}

Deno.test("finishing one task auto-continues the queue while work remains", async () => {
  const root = Deno.makeTempDirSync();
  await git(root, ["init", "-b", "main"]);
  await git(root, ["commit", "--allow-empty", "-m", "seed"]);
  const seed = new BoardStore(root);
  seed.initProject();
  seed.createGoalWithTasks("Two independent fixes", [
    { title: "Fix A", description: "Touch a.txt.", acceptanceCriteria: "- done", priority: 100 },
    { title: "Fix B", description: "Touch b.txt.", acceptanceCriteria: "- done", priority: 90 },
  ]);
  seed.close();
  const port = 49233 + Math.floor(Math.random() * 300);
  const server = startServer(root, port, {
    createCodexClient: (onEvent) => new TestCodexClient(onEvent),
  });
  try {
    const run = await fetch(`${server.url}/api/tasks/TASK-1/run`, { method: "POST" });
    assertEquals(run.ok, true);
    for (let index = 0; index < 120; index++) {
      const board = await fetch(`${server.url}/api/board`).then((response) => response.json());
      const a = board.tasks.find((task: { id: string }) => task.id === "TASK-1");
      const b = board.tasks.find((task: { id: string }) => task.id === "TASK-2");
      if (a?.status === "done" && b?.status === "done") {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Queue did not auto-continue to TASK-2 after TASK-1 finished.");
  } finally {
    server.shutdown();
    await server.finished.catch(() => {});
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

class LoopStubClient implements CodexClient {
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
    private readonly root: string,
  ) {}

  startSession(cwd: string): Promise<CodexSession> {
    return Promise.resolve({ threadId: "loop-thread", cwd });
  }

  resumeSession(cwd: string, threadId: string): Promise<CodexSession> {
    return Promise.resolve({ threadId, cwd });
  }

  async runTurn(session: CodexSession, input: CodexTurnInput): Promise<CodexTurnResult> {
    // Simulate the model's ./lf-task calls with a second store connection (the
    // real CLI is a separate process writing to the same DB).
    const goalId = input.title.split(":")[0];
    const store = new BoardStore(this.root);
    try {
      const item = store.addLoopPlanItem(goalId, "Ship the gadget");
      store.setLoopPlanItemStatus(goalId, item.id, "done", "wrote gadget.txt");
    } finally {
      store.close();
    }
    await Deno.writeTextFile(`${session.cwd}/gadget.txt`, "gadget\n");
    this.onEvent({
      taskId: null,
      runId: null,
      role: "codex",
      kind: "agent",
      message: "LOOP_COMPLETE",
    });
    return {
      threadId: session.threadId,
      turnId: "loop-turn",
      status: "completed",
      completed: true,
    };
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}

Deno.test("server runs a goal loop in the background until the goal closes", async () => {
  const root = Deno.makeTempDirSync();
  await git(root, ["init", "-b", "main"]);
  await git(root, ["commit", "--allow-empty", "-m", "seed"]);
  const seed = new BoardStore(root);
  seed.initProject();
  const { goal } = seed.createGoal("Ship the gadget");
  seed.close();
  const port = 49633 + Math.floor(Math.random() * 300);
  const server = startServer(root, port, {
    createCodexClient: (onEvent) => new LoopStubClient(onEvent, root),
  });
  try {
    const start = await fetch(`${server.url}/api/goals/${goal.id}/loop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hours: 1 }),
    });
    assertEquals(start.ok, true);
    for (let index = 0; index < 120; index++) {
      const board = await fetch(`${server.url}/api/board`).then((response) => response.json());
      const closed = board.goals.find((g: { id: string }) => g.id === goal.id)?.status === "closed";
      const mirrored = board.tasks.some((task: { kind?: string; status: string }) =>
        task.kind === "loop" && task.status === "done"
      );
      if (closed && mirrored) {
        assertEquals(await Deno.readTextFile(`${root}/gadget.txt`), "gadget\n");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Goal loop did not close the goal through the server endpoint.");
  } finally {
    server.shutdown();
    await server.finished.catch(() => {});
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

class OneStepLoopStubClient extends TestCodexClient {
  override async runTurn(session: CodexSession, input: CodexTurnInput): Promise<CodexTurnResult> {
    if (/: loop \d+$/.test(input.title)) {
      await Deno.writeTextFile(`${session.cwd}/gizmo.txt`, "gizmo\n");
      this.onEvent({
        taskId: null,
        runId: null,
        role: "codex",
        kind: "agent",
        message: "LOOP_COMPLETE",
      });
      return {
        threadId: session.threadId,
        turnId: "loop-turn",
        status: "completed",
        completed: true,
      };
    }
    return await super.runTurn(session, input);
  }
}

Deno.test("one-step goal loop plans from text and loops it to a merged close", async () => {
  const root = Deno.makeTempDirSync();
  await git(root, ["init", "-b", "main"]);
  await git(root, ["commit", "--allow-empty", "-m", "seed"]);
  const port = 49933 + Math.floor(Math.random() * 300);
  const server = startServer(root, port, {
    createCodexClient: (onEvent) => new OneStepLoopStubClient(onEvent),
  });
  try {
    const start = await fetch(`${server.url}/api/goals/loop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Ship the gizmo", hours: 1 }),
    });
    assertEquals(start.status, 201);
    const { goalId } = await start.json();
    for (let index = 0; index < 120; index++) {
      const board = await fetch(`${server.url}/api/board`).then((response) => response.json());
      if (board.goals.find((g: { id: string }) => g.id === goalId)?.status === "closed") {
        assertEquals(await Deno.readTextFile(`${root}/gizmo.txt`), "gizmo\n");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("One-step goal loop did not close the goal.");
  } finally {
    server.shutdown();
    await server.finished.catch(() => {});
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

// Holds the planner turn open on a deferred promise so the test can observe the
// goal (and its goal.planning lifecycle event) BEFORE planning resolves, then
// lands a plan with tasks + probes that the loop drives to a merged close.
class DeferredPlanLoopClient extends TestCodexClient {
  constructor(
    onEvent: (event: {
      taskId: string | null;
      runId: string | null;
      role: string;
      kind: string;
      message: string;
    }) => void,
    private readonly planGate: Promise<void>,
  ) {
    super(onEvent);
  }

  override async runTurn(session: CodexSession, input: CodexTurnInput): Promise<CodexTurnResult> {
    if (input.title === "LoopForge goal compiler") {
      await this.planGate;
      this.onEvent({
        taskId: null,
        runId: null,
        role: "codex",
        kind: "agent",
        message: JSON.stringify({
          completionContract: "- Ship the widget.",
          probes: [{ label: "widget file exists", command: "test -f widget.txt" }],
          tasks: [{
            title: "Ship the widget",
            prompt: "Implement and verify the widget.",
            acceptanceCriteria: "- widget.txt exists.",
            priority: 200,
            workpad: "Compiled task.",
          }],
        }),
      });
      return {
        threadId: session.threadId,
        turnId: "turn-deferred-plan",
        status: "completed",
        completed: true,
      };
    }
    if (/: loop \d+$/.test(input.title)) {
      await Deno.writeTextFile(`${session.cwd}/widget.txt`, "widget\n");
      this.onEvent({
        taskId: null,
        runId: null,
        role: "codex",
        kind: "agent",
        message: "LOOP_COMPLETE",
      });
      return {
        threadId: session.threadId,
        turnId: "loop-turn",
        status: "completed",
        completed: true,
      };
    }
    return await super.runTurn(session, input);
  }
}

Deno.test("goal loop kickoff creates the goal before planning and rejects a second start", async () => {
  const root = Deno.makeTempDirSync();
  await git(root, ["init", "-b", "main"]);
  await git(root, ["commit", "--allow-empty", "-m", "seed"]);
  const port = 50933 + Math.floor(Math.random() * 300);
  let releasePlan: () => void = () => {};
  const planGate = new Promise<void>((resolve) => {
    releasePlan = resolve;
  });
  const server = startServer(root, port, {
    createCodexClient: (onEvent) => new DeferredPlanLoopClient(onEvent, planGate),
  });
  try {
    const start = await fetch(`${server.url}/api/goals/loop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Ship the widget", hours: 1 }),
    });
    assertEquals(start.status, 201);
    const body = await start.json();
    assertEquals(body.planning, true);
    assert(String(body.goalId).startsWith("GOAL-"));

    // The goal already exists on the board before the planner resolves.
    const board = await fetch(`${server.url}/api/board`).then((r) => r.json());
    assert(board.goals.some((g: { id: string }) => g.id === body.goalId));

    // A goal.planning lifecycle event was emitted at kickoff.
    const feed = await fetch(`${server.url}/api/lifecycle?goalId=${body.goalId}`).then((r) =>
      r.json()
    );
    assert(feed.events.some((e: { kind: string }) => e.kind === "goal.planning"));

    // A second POST while the first flow is still planning is rejected.
    const second = await fetch(`${server.url}/api/goals/loop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Another goal" }),
    });
    assertEquals(second.status, 409);
    await second.json();

    // Release planning: the plan attaches tasks + probes and the loop closes it.
    releasePlan();
    for (let index = 0; index < 120; index++) {
      const b = await fetch(`${server.url}/api/board`).then((r) => r.json());
      const goal = b.goals.find((g: { id: string }) => g.id === body.goalId);
      const tasks = b.tasks.filter((t: { goalId: string; kind?: string }) =>
        t.goalId === body.goalId && t.kind !== "loop"
      );
      const probes = b.probes.filter((p: { goalId: string }) => p.goalId === body.goalId);
      if (goal?.status === "closed" && tasks.length >= 1 && probes.length >= 1) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Goal loop kickoff did not attach the plan and close the goal.");
  } finally {
    server.shutdown();
    await server.finished.catch(() => {});
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("adding a task to a goal steers it and emits task.added", async () => {
  const root = Deno.makeTempDirSync();
  await git(root, ["init", "-b", "main"]);
  await git(root, ["commit", "--allow-empty", "-m", "seed"]);
  const seed = new BoardStore(root);
  seed.initProject();
  const { goal } = seed.createGoal("Ship the feature");
  seed.close();
  const port = 50233 + Math.floor(Math.random() * 300);
  const server = startServer(root, port, {
    createCodexClient: (onEvent) => new TestCodexClient(onEvent),
  });
  try {
    const res = await fetch(`${server.url}/api/goals/${goal.id}/task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "also wire the settings page" }),
    });
    assertEquals(res.ok, true);
    const lifecycle = await fetch(`${server.url}/api/lifecycle?goalId=${goal.id}`)
      .then((r) => r.json());
    const added = lifecycle.events.find((e: { kind: string }) => e.kind === "task.added");
    assert(added, "expected a task.added lifecycle event");
    assertEquals(added.data.text, "also wire the settings page");
    // The steer is queued for the loop to pick up.
    const board = await fetch(`${server.url}/api/board`).then((r) => r.json());
    void board;
  } finally {
    server.shutdown();
    await server.finished.catch(() => {});
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("server tails DB events from other processes onto SSE exactly once", async () => {
  const root = Deno.makeTempDirSync();
  const boot = new BoardStore(root);
  boot.initProject();
  boot.close();
  const port = 51233 + Math.floor(Math.random() * 300);
  const server = startServer(root, port, {
    createCodexClient: (onEvent) => new TestCodexClient(onEvent),
  });
  const received: Array<{ message: string }> = [];
  const sse = await fetch(`${server.url}/api/events`);
  const reader = sse.body!.getReader();
  const decoder = new TextDecoder();
  // Collect only the "activity" SSE frames; board frames also carry the event
  // text, so counting raw substrings would overcount.
  const pump = (async () => {
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let split;
        while ((split = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          if (frame.startsWith("event: activity\n")) {
            received.push(JSON.parse(frame.slice(frame.indexOf("data: ") + 6)));
          }
        }
      }
    } catch {
      // The stream ends when the server shuts down.
    }
  })();
  try {
    // A server-originated event: broadcast in-process, and it must NOT be
    // re-broadcast by the tail.
    const patched = await fetch(`${server.url}/api/pushbranches`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assertEquals(patched.ok, true);
    await patched.json();
    // Another process (the lf-task CLI) appends to the same DB; the tail must
    // deliver it to SSE clients.
    const cli = new BoardStore(root);
    cli.appendEvent(null, null, "plan", "task", "tail-probe from another process");
    cli.close();
    // The tail polls every 1s; 1.5s covers a full tick with margin.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const tailed = received.filter((e) => e.message === "tail-probe from another process");
    assertEquals(tailed.length, 1);
    const local = received.filter((e) => e.message.includes("branch pushing off"));
    assertEquals(local.length, 1);
  } finally {
    await reader.cancel().catch(() => {});
    await pump;
    server.shutdown();
    await server.finished.catch(() => {});
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("server hosts the project registry, CORS, and opens sibling servers", async () => {
  const root = Deno.makeTempDirSync();
  const second = Deno.makeTempDirSync();
  const port = 51533 + Math.floor(Math.random() * 300);
  const server = startServer(root, port, {
    createCodexClient: (onEvent) => new TestCodexClient(onEvent),
  });
  try {
    // The instance registers itself: its own root is current, with a live URL.
    const listed = await fetch(`${server.url}/api/projects`).then((r) => r.json());
    const self = listed.projects.find((p: { root: string }) => p.root === root);
    assert(self, "expected the server's own root in the registry");
    assertEquals(self.current, true);
    assertEquals(self.url, server.url);

    // CORS headers on a normal /api response.
    const projectsRes = await fetch(`${server.url}/api/projects`);
    assertEquals(projectsRes.headers.get("access-control-allow-origin"), "*");
    await projectsRes.json();

    // OPTIONS preflight is answered 204 with the CORS headers before routing.
    const preflight = await fetch(`${server.url}/api/projects`, { method: "OPTIONS" });
    assertEquals(preflight.status, 204);
    assertEquals(preflight.headers.get("access-control-allow-origin"), "*");
    assert(preflight.headers.get("access-control-allow-methods")?.includes("POST"));
    await preflight.body?.cancel();

    // Registering a nonexistent path is a 400.
    const badAdd = await fetch(`${server.url}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: `${root}/nope-not-here` }),
    });
    assertEquals(badAdd.status, 400);
    await badAdd.json();

    // Registering a real second temp dir adds it to the list.
    const added = await fetch(`${server.url}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: second }),
    }).then((r) => r.json());
    assert(added.projects.some((p: { root: string }) => p.root === second));

    // Opening the second root spawns its own full server on a DIFFERENT port.
    const opened = await fetch(`${server.url}/api/projects/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: second }),
    }).then((r) => r.json());
    assertEquals(typeof opened.url, "string");
    assert(opened.url !== server.url, "child server must run on a different port");

    // The child server responds with its own project name/path.
    const childRuntime = await fetch(`${opened.url}/api/runtime`).then((r) => r.json());
    assertEquals(childRuntime.project.name, path.basename(second));
    assertEquals(childRuntime.project.path, second);
  } finally {
    // Parent shutdown tears down the child it spawned; finished awaits both so
    // no store or listener leaks.
    server.shutdown();
    await server.finished.catch(() => {});
    await Deno.remove(root, { recursive: true }).catch(() => {});
    await Deno.remove(second, { recursive: true }).catch(() => {});
  }
});

Deno.test("native codex events ingest into the lifecycle feed", async () => {
  const root = Deno.makeTempDirSync();
  await git(root, ["init", "-b", "main"]);
  await git(root, ["commit", "--allow-empty", "-m", "seed"]);
  const seed = new BoardStore(root);
  seed.initProject();
  const { goal } = seed.createGoal("Native run");
  seed.close();
  const port = 50633 + Math.floor(Math.random() * 300);
  const server = startServer(root, port, {
    createCodexClient: (onEvent) => new TestCodexClient(onEvent),
  });
  try {
    const res = await fetch(`${server.url}/api/lifecycle/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goalId: goal.id,
        kind: "turn/plan/updated",
        raw: { params: { plan: [{ step: "do it", status: "in_progress" }] } },
      }),
    });
    const out = await res.json();
    assertEquals(out.ingested, true);
    assertEquals(out.kind, "plan.updated");

    const feed = await fetch(`${server.url}/api/lifecycle?goalId=${goal.id}`).then((r) => r.json());
    const plan = feed.events.find((e: { kind: string }) => e.kind === "plan.updated");
    assert(plan, "expected an ingested plan.updated event");

    // Unrecognized native events are accepted but not ingested.
    const noop = await fetch(`${server.url}/api/lifecycle/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goalId: goal.id, kind: "item/commandExecution/outputDelta" }),
    }).then((r) => r.json());
    assertEquals(noop.ingested, false);
  } finally {
    server.shutdown();
    await server.finished.catch(() => {});
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("server folder picker lists directories for add-project browsing", async () => {
  const root = Deno.makeTempDirSync();
  const port = 51833 + Math.floor(Math.random() * 300);
  const server = startServer(root, port, {
    createCodexClient: (onEvent) => new TestCodexClient(onEvent),
  });
  // A tree with two real dirs, a dot-dir, a plain file, and a .git inside one
  // child - so the picker skips dot-dirs + files and flags the repo.
  const tree = Deno.makeTempDirSync();
  Deno.mkdirSync(`${tree}/alpha`);
  Deno.mkdirSync(`${tree}/beta`);
  Deno.mkdirSync(`${tree}/beta/.git`);
  Deno.mkdirSync(`${tree}/.hidden`);
  Deno.writeTextFileSync(`${tree}/notes.txt`, "x");
  try {
    const listed = await fetch(`${server.url}/api/fs/dirs?path=${encodeURIComponent(tree)}`)
      .then((r) => r.json());
    // Directories only, dot-dir skipped, sorted by name.
    assertEquals(listed.dirs.map((d: { name: string }) => d.name), ["alpha", "beta"]);
    const alpha = listed.dirs.find((d: { name: string }) => d.name === "alpha");
    const beta = listed.dirs.find((d: { name: string }) => d.name === "beta");
    assertEquals(alpha.hasGit, false);
    assertEquals(beta.hasGit, true);
    assertEquals(listed.path, tree);
    assertEquals(listed.parent, path.dirname(tree));

    // Navigating into a child returns that dir with its parent set back to tree.
    const child = await fetch(
      `${server.url}/api/fs/dirs?path=${encodeURIComponent(`${tree}/beta`)}`,
    ).then((r) => r.json());
    assertEquals(child.path, `${tree}/beta`);
    assertEquals(child.parent, tree);

    // A file path is rejected.
    const fileRes = await fetch(
      `${server.url}/api/fs/dirs?path=${encodeURIComponent(`${tree}/notes.txt`)}`,
    );
    assertEquals(fileRes.status, 400);
    await fileRes.json();

    // A relative path is rejected.
    const relRes = await fetch(
      `${server.url}/api/fs/dirs?path=${encodeURIComponent("relative/dir")}`,
    );
    assertEquals(relRes.status, 400);
    await relRes.json();
  } finally {
    server.shutdown();
    await server.finished.catch(() => {});
    await Deno.remove(root, { recursive: true }).catch(() => {});
    await Deno.remove(tree, { recursive: true }).catch(() => {});
  }
});

Deno.test("server patches the machine-wide Claude model through the backends endpoint", async () => {
  const root = Deno.makeTempDirSync();
  const port = 52133 + Math.floor(Math.random() * 300);
  const server = startServer(root, port, {
    createCodexClient: (onEvent) => new TestCodexClient(onEvent),
  });
  try {
    const patched = await fetch(`${server.url}/api/backend`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ claudeModel: "claude-opus-4-8" }),
    }).then((r) => r.json());
    assertEquals(patched.claudeModel, "claude-opus-4-8");

    // The runtime surface exposes it so the settings modal can seed the picker.
    const runtime = await fetch(`${server.url}/api/runtime`).then((r) => r.json());
    assertEquals(runtime.claudeModel, "claude-opus-4-8");

    // The Claude effort level round-trips through the same endpoint.
    const effort = await fetch(`${server.url}/api/backend`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ claudeEffort: "low" }),
    }).then((r) => r.json());
    assertEquals(effort.claudeEffort, "low");
    const runtime2 = await fetch(`${server.url}/api/runtime`).then((r) => r.json());
    assertEquals(runtime2.claudeEffort, "low");

    // An unknown effort level is a 400.
    const badEffort = await fetch(`${server.url}/api/backend`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ claudeEffort: "turbo" }),
    });
    assertEquals(badEffort.status, 400);
    await badEffort.json();

    // Neither field present is a 400.
    const empty = await fetch(`${server.url}/api/backend`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assertEquals(empty.status, 400);
    await empty.json();
  } finally {
    server.shutdown();
    await server.finished.catch(() => {});
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("server creates a new folder from the picker and rejects bad requests", async () => {
  const root = Deno.makeTempDirSync();
  const port = 52333 + Math.floor(Math.random() * 300);
  const server = startServer(root, port, {
    createCodexClient: (onEvent) => new TestCodexClient(onEvent),
  });
  const tree = Deno.makeTempDirSync();
  try {
    // Happy path: creates tree/fresh and returns its absolute path.
    const made = await fetch(`${server.url}/api/fs/mkdir`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: tree, name: "fresh" }),
    }).then((r) => r.json());
    assertEquals(made.path, path.join(tree, "fresh"));
    assertEquals(Deno.statSync(made.path).isDirectory, true);

    // Re-creating the same folder is a 400 (target already exists).
    const dup = await fetch(`${server.url}/api/fs/mkdir`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: tree, name: "fresh" }),
    });
    assertEquals(dup.status, 400);
    await dup.json();

    // A name containing a path separator is a 400.
    const slash = await fetch(`${server.url}/api/fs/mkdir`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: tree, name: "a/b" }),
    });
    assertEquals(slash.status, 400);
    await slash.json();

    // A relative parent is a 400.
    const rel = await fetch(`${server.url}/api/fs/mkdir`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "relative/dir", name: "x" }),
    });
    assertEquals(rel.status, 400);
    await rel.json();
  } finally {
    server.shutdown();
    await server.finished.catch(() => {});
    await Deno.remove(root, { recursive: true }).catch(() => {});
    await Deno.remove(tree, { recursive: true }).catch(() => {});
  }
});

Deno.test("server removes a registered project and refuses to remove its own root", async () => {
  const root = Deno.makeTempDirSync();
  const other = Deno.makeTempDirSync();
  const port = 52533 + Math.floor(Math.random() * 300);
  const server = startServer(root, port, {
    createCodexClient: (onEvent) => new TestCodexClient(onEvent),
  });
  try {
    // Register a second project, then remove it via DELETE.
    await fetch(`${server.url}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: other }),
    }).then((r) => r.json());
    const removed = await fetch(`${server.url}/api/projects`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: other }),
    }).then((r) => r.json());
    assert(!removed.projects.some((p: { root: string }) => p.root === other));

    // Removing the server's own root is a 400 and leaves it registered.
    const self = await fetch(`${server.url}/api/projects`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root }),
    });
    assertEquals(self.status, 400);
    await self.json();
    const listed = await fetch(`${server.url}/api/projects`).then((r) => r.json());
    assert(listed.projects.some((p: { root: string }) => p.root === root));
  } finally {
    server.shutdown();
    await server.finished.catch(() => {});
    await Deno.remove(root, { recursive: true }).catch(() => {});
    await Deno.remove(other, { recursive: true }).catch(() => {});
  }
});

Deno.test("server returns a goal's turn-grouped thread and 404s unknown goals", async () => {
  const root = Deno.makeTempDirSync();
  await git(root, ["init", "-b", "main"]);
  await git(root, ["commit", "--allow-empty", "-m", "seed"]);
  const seed = new BoardStore(root);
  seed.initProject();
  const { goal } = seed.createGoal("Thread through the GUI");
  seed.appendEvent(
    null,
    null,
    "loop",
    "iteration",
    `${goal.id}: Loop iteration 1/2 started.`,
    undefined,
    goal.id,
  );
  seed.appendAgentEvent(
    { taskId: null, runId: null, role: "loop", kind: "agent", message: "did work" },
    goal.id,
  );
  seed.enqueueGoalMessage(goal.id, "user", "add a footer");
  seed.close();

  const port = 52733 + Math.floor(Math.random() * 300);
  const server = startServer(root, port, {
    createCodexClient: (onEvent) => new TestCodexClient(onEvent),
  });
  try {
    const thread = await fetch(`${server.url}/api/goals/${goal.id}/thread`).then((r) => r.json());
    assertEquals(thread.goalId, goal.id);
    assertEquals(thread.turns.length, 1);
    assertEquals(thread.turns[0].index, 1);
    const entries = thread.turns.flatMap(
      (turn: { entries: Array<{ kind: string; role: string; text: string }> }) => turn.entries,
    );
    assert(entries.some((entry: { kind: string }) => entry.kind === "iteration"));
    assert(
      entries.some((entry: { role: string; kind: string }) =>
        entry.role === "user" && entry.kind === "steer"
      ),
      "expected the steer merged into the thread",
    );

    const missing = await fetch(`${server.url}/api/goals/GOAL-999/thread`);
    assertEquals(missing.status, 404);
    await missing.json();
  } finally {
    server.shutdown();
    await server.finished.catch(() => {});
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("server returns a goal's per-loop diff for a live branch", async () => {
  const root = Deno.makeTempDirSync();
  await git(root, ["init", "-b", "main"]);
  await git(root, ["commit", "--allow-empty", "-m", "seed"]);
  const seed = new BoardStore(root);
  seed.initProject();
  const { goal } = seed.createGoal("Diff through the GUI");
  const branch = `loopforge/${goal.id.toLowerCase()}`;
  seed.setGoalLoopState(goal.id, { branch });
  seed.close();
  // A live loop branch carrying one commit off main.
  await git(root, ["checkout", "-b", branch]);
  await Deno.writeTextFile(`${root}/feature.txt`, "hello\nworld\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "loop work"]);
  await git(root, ["checkout", "main"]);

  const port = 53033 + Math.floor(Math.random() * 300);
  const server = startServer(root, port, {
    createCodexClient: (onEvent) => new TestCodexClient(onEvent),
  });
  try {
    const diff = await fetch(`${server.url}/api/goals/${goal.id}/diff`).then((r) => r.json());
    assertEquals(diff.goalId, goal.id);
    assertEquals(diff.truncated, false);
    const file = diff.files.find((f: { path: string }) => f.path === "feature.txt");
    assert(file, "expected feature.txt in the diff");
    assertEquals(file.additions, 2);
    assertStringIncludes(file.patch, "diff --git a/feature.txt b/feature.txt");

    const missing = await fetch(`${server.url}/api/goals/GOAL-999/diff`);
    assertEquals(missing.status, 404);
    await missing.json();
  } finally {
    server.shutdown();
    await server.finished.catch(() => {});
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});
