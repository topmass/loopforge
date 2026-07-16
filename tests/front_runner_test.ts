import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { BoardStore } from "../src/board/store.ts";
import { FrontRunner } from "../src/workers/front_runner.ts";
import { contextPath } from "../src/paths.ts";
import type {
  CodexClient,
  CodexSession,
  CodexTurnInput,
  CodexTurnResult,
} from "../src/workers/codex_app_server.ts";

// Minimal front backend: replies "ok" to every turn and counts compactions.
class ScriptedFrontClient implements CodexClient {
  static compactions = 0;
  constructor(
    private readonly onEvent: (event: {
      taskId: string | null;
      runId: string | null;
      role: string;
      kind: string;
      message: string;
    }) => void,
  ) {}
  startSession(cwd: string): Promise<CodexSession> {
    return Promise.resolve({ threadId: "front-thread-test", cwd });
  }
  resumeSession(cwd: string, threadId: string): Promise<CodexSession> {
    return Promise.resolve({ threadId, cwd });
  }
  runTurn(session: CodexSession, _input: CodexTurnInput): Promise<CodexTurnResult> {
    this.onEvent({ taskId: null, runId: null, role: "codex", kind: "agent", message: "ok" });
    return Promise.resolve({
      threadId: session.threadId,
      turnId: "turn-front-test",
      status: "completed",
      completed: true,
    });
  }
  compactThread(_session: CodexSession): Promise<void> {
    ScriptedFrontClient.compactions++;
    return Promise.resolve();
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }
}

Deno.test("front compaction regenerates the resume capsule and advances the cursor", async () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  ScriptedFrontClient.compactions = 0;
  try {
    store.initProject();
    store.createGoal("Capsule context goal");
    const runner = new FrontRunner(root, store, {
      createCodexClient: (onEvent) => new ScriptedFrontClient(onEvent),
      listActiveLoops: () => [],
    });

    // Six turns = 12 front messages (6 user + 6 replies): crosses the
    // compaction threshold on the sixth turn.
    for (let index = 0; index < 6; index++) {
      store.appendFrontMessage("user", `message ${index}`);
      await runner.handle(`message ${index}`);
    }

    const capsule = await Deno.readTextFile(contextPath(root, "current-state.md"));
    assertStringIncludes(capsule, "LoopForge resume capsule");
    assertStringIncludes(capsule, "Capsule context goal");
    assertStringIncludes(capsule, "Recent conversation tail");
    assert(store.getFrontCompactCursor() > 0);
    assertEquals(ScriptedFrontClient.compactions, 1);

    // The cursor prevents immediate re-compaction on the next turn.
    store.appendFrontMessage("user", "one more");
    await runner.handle("one more");
    assertEquals(ScriptedFrontClient.compactions, 1);
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});
