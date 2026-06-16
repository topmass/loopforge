import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { BoardStore } from "../src/board/store.ts";
import {
  FanoutRunner,
  findScopeConflict,
  type FanoutSubtask,
  parseFanoutRequest,
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
    await Deno.writeTextFile(`${session.cwd}/${isApi ? "api.txt" : "ui.txt"}`, isApi ? "api\n" : "ui\n");
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
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});
