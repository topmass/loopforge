import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { BoardStore } from "../src/board/store.ts";
import {
  FanoutRunner,
  type FanoutSubtask,
  findScopeConflict,
  parseFanoutRequest,
  scopeViolations,
  summarizeFanout,
} from "../src/workers/fanout.ts";
import type {
  CodexClient,
  CodexSession,
  CodexSessionOptions,
  CodexTurnInput,
  CodexTurnResult,
} from "../src/workers/codex_app_server.ts";

async function git(root: string, args: string[]): Promise<void> {
  const out = await new Deno.Command("git", { args, cwd: root, stdout: "piped", stderr: "piped" })
    .output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
}

Deno.test("parseFanoutRequest reads a LOOP_FANOUT JSON block, fails closed otherwise", () => {
  const text = `I'll split this.
LOOP_FANOUT
{"subtasks":[
  {"title":"API","instruction":"build the api","writeScope":["src/api/**"]},
  {"title":"UI","instruction":"build the ui","writeScope":["src/ui/**"]}
]}`;
  const subs = parseFanoutRequest(text);
  assert(subs);
  assertEquals(subs!.length, 2);
  assertEquals(subs![0].title, "API");
  assertEquals(subs![1].writeScope, ["src/ui/**"]);

  assertEquals(parseFanoutRequest("no marker here"), null);
  assertEquals(parseFanoutRequest("LOOP_FANOUT\n{not json}"), null);
  assertEquals(parseFanoutRequest('LOOP_FANOUT\n{"subtasks":[]}'), null);
  assertEquals(
    parseFanoutRequest('LOOP_FANOUT\n{"subtasks":[{"title":"x","instruction":"y"}]}'),
    null,
  );
});

Deno.test("findScopeConflict catches overlapping write scopes and allows disjoint ones", () => {
  assertEquals(
    findScopeConflict([
      { title: "A", instruction: "", writeScope: ["src/api/**"] },
      { title: "B", instruction: "", writeScope: ["src/ui/**", "static/app.js"] },
    ]),
    null,
  );
  assert(findScopeConflict([
    { title: "A", instruction: "", writeScope: ["src/api"] },
    { title: "B", instruction: "", writeScope: ["src/api/handlers.ts"] },
  ]));
  assert(findScopeConflict([
    { title: "A", instruction: "", writeScope: ["app.py"] },
    { title: "B", instruction: "", writeScope: ["app.py"] },
  ]));
});

// Writes the scoped file named in the turn title ("<goal>-<n>: <title>").
class TitleAwareSubClient implements CodexClient {
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
  ) {}
  startSession(cwd: string, _o: CodexSessionOptions = {}): Promise<CodexSession> {
    return Promise.resolve({ threadId: "t", cwd });
  }
  resumeSession(cwd: string, id: string): Promise<CodexSession> {
    return Promise.resolve({ threadId: id, cwd });
  }
  async runTurn(session: CodexSession, input: CodexTurnInput): Promise<CodexTurnResult> {
    const title = input.title.split(": ").pop() ?? "";
    const isApi = title.includes("api");
    await Deno.writeTextFile(
      `${session.cwd}/${isApi ? "api.txt" : "ui.txt"}`,
      isApi ? "api\n" : "ui\n",
    );
    this.onEvent({
      taskId: null,
      runId: null,
      role: "codex",
      kind: "agent",
      message: `${title} done`,
    });
    return { threadId: session.threadId, turnId: "t", status: "completed", completed: true };
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }
}

Deno.test("FanoutRunner runs disjoint subtasks in parallel worktrees and merges them", async () => {
  const root = Deno.makeTempDirSync();
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
  const store = new BoardStore(root);
  const events: string[] = [];
  try {
    store.initProject();
    const { goal } = store.createGoal("Build both halves");
    // The loop branch the sub-worktrees fork from (root is checked out on main,
    // which we treat as the loop branch for this test).
    const subtasks: FanoutSubtask[] = [
      { title: "api", instruction: "write api.txt", writeScope: ["api.txt"] },
      { title: "ui", instruction: "write ui.txt", writeScope: ["ui.txt"] },
    ];
    const runner = new FanoutRunner(root, store, {
      maxConcurrency: 2,
      projectInstructions: "none",
      onEvent: (e) => events.push(`${e.role}/${e.kind}`),
      createCodexClient: (onEvent) => new TitleAwareSubClient(onEvent),
    });
    const result = await runner.run(goal.id, "main", root, subtasks);
    assertEquals(result.failed.length, 0, JSON.stringify(result.failed));
    assertEquals(result.merged.length, 2);
    assertEquals(await Deno.readTextFile(`${root}/api.txt`), "api\n");
    assertEquals(await Deno.readTextFile(`${root}/ui.txt`), "ui\n");
    assert(events.some((e) => e.includes("subagent.spawned")));
    assert(events.some((e) => e.includes("subagent.merged")));
    assertStringIncludes(summarizeFanout(result), "merged 2 subtask");

    // Each fan-out agent mirrored its lifecycle onto the board, ending merged,
    // so the goal-loop path shows up on the Kanban like dispatcher tasks.
    const external = store.listExternalAgents();
    assertEquals(external.length, 2);
    assert(external.every((agent) => agent.state === "done"), JSON.stringify(external));
    assert(external.some((agent) => agent.agent === "api"));
    assert(external.some((agent) => agent.agent === "ui"));
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("FanoutRunner pushes sub-agent branches to origin when enabled", async () => {
  const root = Deno.makeTempDirSync();
  const remote = Deno.makeTempDirSync();
  await git(remote, ["init", "--bare"]);
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
  await git(root, ["remote", "add", "origin", remote]);
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal } = store.createGoal("Build it");
    const runner = new FanoutRunner(root, store, {
      maxConcurrency: 1,
      projectInstructions: "none",
      pushBranches: true,
      onEvent: () => {},
      createCodexClient: (onEvent) => new TitleAwareSubClient(onEvent),
    });
    const result = await runner.run(goal.id, "main", root, [
      { title: "api", instruction: "write api.txt", writeScope: ["api.txt"] },
    ]);
    assertEquals(result.failed.length, 0, JSON.stringify(result.failed));
    // The sub-agent's branch landed on the remote.
    const ls = await new Deno.Command("git", {
      args: ["ls-remote", "--heads", remote],
      stdout: "piped",
    }).output();
    assertStringIncludes(new TextDecoder().decode(ls.stdout), "loopforge/fanout-");
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
    await Deno.remove(remote, { recursive: true });
  }
});

Deno.test("scopeViolations returns only files no scope covers", () => {
  // In-scope under a prefix glob, and a file equal to the prefix itself.
  assertEquals(
    scopeViolations(["src/api/handlers.ts", "app.py"], ["src/api/**", "app.py"]),
    [],
  );
  // Out-of-scope file is flagged; the in-scope sibling is kept out of the list.
  assertEquals(
    scopeViolations(["src/api/x.ts", "src/ui/y.ts"], ["src/api/**"]),
    ["src/ui/y.ts"],
  );
  // A bare "**" scope reduces to an empty prefix that covers everything.
  assertEquals(scopeViolations(["anything/at/all.ts"], ["**"]), []);
});

// Writes "<title>.txt" into its worktree, where <title> is the sub-agent title.
class NamedFileSubClient implements CodexClient {
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
  ) {}
  startSession(cwd: string, _o: CodexSessionOptions = {}): Promise<CodexSession> {
    return Promise.resolve({ threadId: "t", cwd });
  }
  resumeSession(cwd: string, id: string): Promise<CodexSession> {
    return Promise.resolve({ threadId: id, cwd });
  }
  async runTurn(session: CodexSession, input: CodexTurnInput): Promise<CodexTurnResult> {
    const title = input.title.split(": ").pop() ?? "";
    await Deno.writeTextFile(`${session.cwd}/${title}.txt`, `${title}\n`);
    this.onEvent({
      taskId: null,
      runId: null,
      role: "codex",
      kind: "agent",
      message: `${title} done`,
    });
    return { threadId: session.threadId, turnId: "t", status: "completed", completed: true };
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }
}

async function worktreeList(root: string): Promise<string> {
  const out = await new Deno.Command("git", {
    args: ["worktree", "list"],
    cwd: root,
    stdout: "piped",
  })
    .output();
  return new TextDecoder().decode(out.stdout);
}

Deno.test("FanoutRunner survives a second round on the same goal and reclaims worktrees", async () => {
  const root = Deno.makeTempDirSync();
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
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal } = store.createGoal("Two rounds");
    const runner = new FanoutRunner(root, store, {
      maxConcurrency: 1,
      projectInstructions: "none",
      onEvent: () => {},
      createCodexClient: (onEvent) => new NamedFileSubClient(onEvent),
    });

    const round1 = await runner.run(goal.id, "main", root, [
      { title: "round1", instruction: "write round1.txt", writeScope: ["round1.txt"] },
    ]);
    assertEquals(round1.failed.length, 0, JSON.stringify(round1.failed));
    assertEquals(round1.merged.length, 1);
    assertEquals(await Deno.readTextFile(`${root}/round1.txt`), "round1\n");
    // The merged sub-worktree was reclaimed, so none linger for the next round.
    assert(!(await worktreeList(root)).includes("fanout-"), await worktreeList(root));

    // Second round, SAME goalId: the old bug reused subId "goal-0" and died with
    // "cannot force update the branch". Unique per-run tags must let it pass.
    const round2 = await runner.run(goal.id, "main", root, [
      { title: "round2", instruction: "write round2.txt", writeScope: ["round2.txt"] },
    ]);
    assertEquals(round2.failed.length, 0, JSON.stringify(round2.failed));
    assertEquals(round2.merged.length, 1);
    assertEquals(await Deno.readTextFile(`${root}/round2.txt`), "round2\n");
    assertEquals(await Deno.readTextFile(`${root}/round1.txt`), "round1\n");
    assert(!(await worktreeList(root)).includes("fanout-"), await worktreeList(root));
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

// Writes one in-scope file (keep.txt) and one out-of-scope file (sneak.txt).
class OutOfScopeSubClient implements CodexClient {
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
  ) {}
  startSession(cwd: string, _o: CodexSessionOptions = {}): Promise<CodexSession> {
    return Promise.resolve({ threadId: "t", cwd });
  }
  resumeSession(cwd: string, id: string): Promise<CodexSession> {
    return Promise.resolve({ threadId: id, cwd });
  }
  async runTurn(session: CodexSession, input: CodexTurnInput): Promise<CodexTurnResult> {
    await Deno.writeTextFile(`${session.cwd}/keep.txt`, "keep\n");
    await Deno.writeTextFile(`${session.cwd}/sneak.txt`, "sneak\n");
    // Porcelain reports a fully-untracked directory as one "sneakdir/" entry;
    // reverting it exercises the recursive remove path.
    await Deno.mkdir(`${session.cwd}/sneakdir`);
    await Deno.writeTextFile(`${session.cwd}/sneakdir/inner.txt`, "sneak\n");
    this.onEvent({ taskId: null, runId: null, role: "codex", kind: "agent", message: "did work" });
    return { threadId: session.threadId, turnId: "t", status: "completed", completed: true };
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }
}

Deno.test("FanoutRunner reverts out-of-scope writes and notes them in the summary", async () => {
  const root = Deno.makeTempDirSync();
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
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal } = store.createGoal("Scoped work");
    const runner = new FanoutRunner(root, store, {
      maxConcurrency: 1,
      projectInstructions: "none",
      onEvent: () => {},
      createCodexClient: (onEvent) => new OutOfScopeSubClient(onEvent),
    });
    const result = await runner.run(goal.id, "main", root, [
      { title: "scoped", instruction: "only touch keep.txt", writeScope: ["keep.txt"] },
    ]);
    assertEquals(result.failed.length, 0, JSON.stringify(result.failed));
    assertEquals(result.merged.length, 1);
    assertEquals(await Deno.readTextFile(`${root}/keep.txt`), "keep\n");
    // The out-of-scope file never reached the merged loop branch.
    const sneakExists = await Deno.stat(`${root}/sneak.txt`).then(() => true).catch(() => false);
    assert(!sneakExists);
    const sneakDirExists = await Deno.stat(`${root}/sneakdir`).then(() => true).catch(() => false);
    assert(!sneakDirExists);
    assertStringIncludes(result.merged[0].summary, "reverted out-of-scope changes: sneak.txt");
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

// Produces no file changes at all.
class NoopSubClient implements CodexClient {
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
  ) {}
  startSession(cwd: string, _o: CodexSessionOptions = {}): Promise<CodexSession> {
    return Promise.resolve({ threadId: "t", cwd });
  }
  resumeSession(cwd: string, id: string): Promise<CodexSession> {
    return Promise.resolve({ threadId: id, cwd });
  }
  runTurn(session: CodexSession, _input: CodexTurnInput): Promise<CodexTurnResult> {
    this.onEvent({
      taskId: null,
      runId: null,
      role: "codex",
      kind: "agent",
      message: "nothing to do",
    });
    return Promise.resolve({
      threadId: session.threadId,
      turnId: "t",
      status: "completed",
      completed: true,
    });
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }
}

Deno.test("FanoutRunner fails a zero-change subtask instead of merging it", async () => {
  const root = Deno.makeTempDirSync();
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
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal } = store.createGoal("No work");
    const runner = new FanoutRunner(root, store, {
      maxConcurrency: 1,
      projectInstructions: "none",
      onEvent: () => {},
      createCodexClient: (onEvent) => new NoopSubClient(onEvent),
    });
    const result = await runner.run(goal.id, "main", root, [
      { title: "idle", instruction: "do nothing", writeScope: ["idle.txt"] },
    ]);
    assertEquals(result.merged.length, 0);
    assertEquals(result.failed.length, 1);
    assertEquals(result.failed[0].title, "idle");
    assertStringIncludes(result.failed[0].error, "produced no file changes");
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

// Writes an in-scope file whose parent directories are entirely new - the
// exact shape a live run tripped on: porcelain without -uall collapses it to
// "sites/" and scope enforcement falsely reverts the work.
class NestedNewDirSubClient implements CodexClient {
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
  ) {}
  startSession(cwd: string, _o: CodexSessionOptions = {}): Promise<CodexSession> {
    return Promise.resolve({ threadId: "t", cwd });
  }
  resumeSession(cwd: string, id: string): Promise<CodexSession> {
    return Promise.resolve({ threadId: id, cwd });
  }
  async runTurn(session: CodexSession, _input: CodexTurnInput): Promise<CodexTurnResult> {
    await Deno.mkdir(`${session.cwd}/sites/welcome`, { recursive: true });
    await Deno.writeTextFile(`${session.cwd}/sites/welcome/index.html`, "<h1>OpenQuick</h1>\n");
    this.onEvent({ taskId: null, runId: null, role: "codex", kind: "agent", message: "built" });
    return { threadId: session.threadId, turnId: "t", status: "completed", completed: true };
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }
}

Deno.test("FanoutRunner keeps in-scope work inside a brand-new parent directory", async () => {
  const root = Deno.makeTempDirSync();
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
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal } = store.createGoal("Nested scope work");
    const runner = new FanoutRunner(root, store, {
      maxConcurrency: 1,
      projectInstructions: "none",
      onEvent: () => {},
      createCodexClient: (onEvent) => new NestedNewDirSubClient(onEvent),
    });
    const result = await runner.run(goal.id, "main", root, [
      {
        title: "build welcome",
        instruction: "write the page",
        writeScope: ["sites/welcome/**"],
      },
    ]);
    assertEquals(result.failed.length, 0, JSON.stringify(result.failed));
    assertEquals(result.merged.length, 1);
    assertEquals(
      await Deno.readTextFile(`${root}/sites/welcome/index.html`),
      "<h1>OpenQuick</h1>\n",
    );
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});
