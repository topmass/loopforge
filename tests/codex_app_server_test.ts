import { assertEquals, assertRejects } from "@std/assert";
import {
  type BridgeProcess,
  type BridgeSpawn,
  CodexAppServerClient,
  isCrashLooping,
} from "../src/workers/codex_app_server.ts";
import { parsePlannerPlanResponse } from "../src/workers/goal_planner.ts";

const SETTINGS = { model: "m", reasoningEffort: "high", fastMode: true } as const;

// A controllable in-memory stand-in for the spawned bridge process. Closing the
// stdout/stderr controllers ends the client's read loops, so no streams leak.
class FakeBridge implements BridgeProcess {
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly status: Promise<{ success: boolean; code: number }>;
  killed = false;
  private stdoutCtl!: ReadableStreamDefaultController<Uint8Array>;
  private stderrCtl!: ReadableStreamDefaultController<Uint8Array>;
  private resolveStatus!: (s: { success: boolean; code: number }) => void;
  private settled = false;

  constructor() {
    this.stdout = new ReadableStream({ start: (c) => (this.stdoutCtl = c) });
    this.stderr = new ReadableStream({ start: (c) => (this.stderrCtl = c) });
    const decoder = new TextDecoder();
    this.stdin = new WritableStream({
      write: (chunk) => {
        const line = decoder.decode(chunk).trim();
        try {
          const msg = JSON.parse(line) as { id?: number; op?: string };
          // Acknowledge stop so client.stop() resolves during teardown.
          if (msg.op === "stop" && typeof msg.id === "number") {
            this.emit(JSON.stringify({ id: msg.id, result: {} }));
          }
        } catch {
          // Ignore non-JSON writes.
        }
      },
    });
    this.status = new Promise((res) => (this.resolveStatus = res));
  }

  emit(line: string): void {
    this.stdoutCtl.enqueue(new TextEncoder().encode(`${line}\n`));
  }

  crash(code = 1): void {
    this.settle({ success: false, code });
  }

  kill(): void {
    this.killed = true;
    this.settle({ success: false, code: 143 });
  }

  private settle(status: { success: boolean; code: number }): void {
    if (this.settled) return;
    this.settled = true;
    this.stdoutCtl.close();
    this.stderrCtl.close();
    this.resolveStatus(status);
  }
}

Deno.test("isCrashLooping trips only after enough recent exits", () => {
  assertEquals(isCrashLooping([], 1000, 10_000, 3), false);
  assertEquals(isCrashLooping([100, 200], 1000, 10_000, 3), false);
  assertEquals(isCrashLooping([100, 200, 300], 1000, 10_000, 3), true);
  // Exits older than the window do not count.
  assertEquals(isCrashLooping([0, 1, 2], 100_000, 10_000, 3), false);
  assertEquals(isCrashLooping([91_000, 92_000, 99_000], 100_000, 10_000, 3), true);
});

Deno.test("a crashed bridge respawns on the next request instead of wedging", async () => {
  const bridges: FakeBridge[] = [];
  const spawn: BridgeSpawn = () => {
    const bridge = new FakeBridge();
    bridges.push(bridge);
    return bridge;
  };
  const client = new CodexAppServerClient(() => {}, SETTINGS, spawn);

  const first = client.startSession("/tmp");
  bridges[0].crash();
  await assertRejects(() => first, Error, "outcome is unknown");
  assertEquals(bridges.length, 1);

  // The fix: the dead handle was cleared, so this request spawns a fresh bridge
  // rather than early-returning on the stale child.
  const second = client.startSession("/tmp");
  bridges[1].crash();
  await assertRejects(() => second, Error, "outcome is unknown");
  assertEquals(bridges.length, 2);

  await client.stop();
});

Deno.test("a crash-looping bridge stops restarting", async () => {
  const bridges: FakeBridge[] = [];
  const spawn: BridgeSpawn = () => {
    const bridge = new FakeBridge();
    bridges.push(bridge);
    return bridge;
  };
  const client = new CodexAppServerClient(() => {}, SETTINGS, spawn);

  for (let attempt = 0; attempt < 3; attempt++) {
    const pending = client.startSession("/tmp");
    bridges[attempt].crash();
    await assertRejects(() => pending);
  }
  assertEquals(bridges.length, 3);

  // The fourth attempt refuses to spawn rather than fork-bombing uv.
  await assertRejects(() => client.startSession("/tmp"), Error, "crash-looped");
  assertEquals(bridges.length, 3);

  await client.stop();
});

Deno.test("a healthy bridge resolves a request from its response", async () => {
  const bridges: FakeBridge[] = [];
  const spawn: BridgeSpawn = () => {
    const bridge = new FakeBridge();
    bridges.push(bridge);
    return bridge;
  };
  const client = new CodexAppServerClient(() => {}, SETTINGS, spawn);

  const session = client.startSession("/tmp");
  bridges[0].emit(JSON.stringify({ id: 1, result: { threadId: "thread-1" } }));
  assertEquals((await session).threadId, "thread-1");

  await client.stop();
});

Deno.test("planner agent deltas preserve whitespace-only chunks before digits", async () => {
  const bridges: FakeBridge[] = [];
  const events: string[] = [];
  const spawn: BridgeSpawn = () => {
    const bridge = new FakeBridge();
    bridges.push(bridge);
    return bridge;
  };
  const client = new CodexAppServerClient((event) => {
    if (event.role === "codex" && event.kind === "agent") {
      events.push(event.message);
    }
  }, SETTINGS, spawn);

  const session = client.startSession("/tmp");
  bridges[0].emit(JSON.stringify({ id: 1, result: { threadId: "thread-1" } }));
  const turn = client.runTurn(await session, { title: "plan", prompt: "plan" });
  for (const message of [
    '{"completionContract":"- done","probes":[{"label":"server","command":"python -m http.server',
    " ",
    '4173 --bind',
    " ",
    '127.0.0.1"}],"tasks":[{"title":"Serve","prompt":"Serve it.","acceptanceCriteria":"- It serves.","priority":100,"workpad":"Independent.","dependsOn":[],"riskLevel":"low","verificationPlan":"- Curl it."}]}',
  ]) {
    bridges[0].emit(JSON.stringify({
      event: {
        role: "codex",
        kind: "agent",
        message,
        raw: { method: "item/agentMessage/delta" },
      },
    }));
  }
  bridges[0].emit(JSON.stringify({
    id: 2,
    result: { threadId: "thread-1", turnId: "turn-1", status: "completed", completed: true },
  }));

  await turn;
  assertEquals(
    parsePlannerPlanResponse(events.join("")).probes[0].command,
    "python -m http.server 4173 --bind 127.0.0.1",
  );

  await client.stop();
});
