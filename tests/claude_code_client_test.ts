import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { ClaudeCodeClient, ClaudeSpawn } from "../src/workers/claude_code_client.ts";
import { BridgeProcess } from "../src/workers/codex_app_server.ts";
import { ActivityEventInput } from "../src/board/types.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";

interface FakeScript {
  stdout?: string[];
  stderr?: string;
  code?: number;
  // hold leaves the process running (never settles) so stop() can kill it.
  hold?: boolean;
}

// In-memory stand-in for a spawned `claude` process: replays canned stream-json
// lines on stdout, then closes and resolves its exit status. Never touches the
// real CLI (which would spend the user's account).
class FakeClaude implements BridgeProcess {
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly status: Promise<{ success: boolean; code: number }>;
  killed = false;
  private stdoutCtl!: ReadableStreamDefaultController<Uint8Array>;
  private stderrCtl!: ReadableStreamDefaultController<Uint8Array>;
  private resolveStatus!: (s: { success: boolean; code: number }) => void;
  private settled = false;

  constructor(script: FakeScript) {
    // start runs synchronously during construction, so the controllers are set
    // before we enqueue below (same pattern as the codex bridge fake).
    this.stdout = new ReadableStream({ start: (c) => (this.stdoutCtl = c) });
    this.stderr = new ReadableStream({ start: (c) => (this.stderrCtl = c) });
    this.stdin = new WritableStream();
    this.status = new Promise((res) => (this.resolveStatus = res));
    const encoder = new TextEncoder();
    for (const line of script.stdout ?? []) {
      this.stdoutCtl.enqueue(encoder.encode(`${line}\n`));
    }
    if (script.stderr) {
      this.stderrCtl.enqueue(encoder.encode(script.stderr));
    }
    if (!script.hold) {
      const code = script.code ?? 0;
      this.settle({ success: code === 0, code });
    }
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

// Realistic stream-json fixtures modeled on what the Claude Code CLI emits with
// `--output-format stream-json --verbose` (init carries session_id; assistant
// messages carry content blocks; result carries usage). Shapes cross-checked
// against T3 Code's ClaudeAdapter.
function initLine(): string {
  return JSON.stringify({
    type: "system",
    subtype: "init",
    cwd: "/repo",
    session_id: SESSION,
    tools: ["Bash", "Edit"],
    model: "claude-sonnet-4-6",
    permissionMode: "bypassPermissions",
  });
}
function assistantTextLine(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_01",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text }],
      stop_reason: null,
    },
    parent_tool_use_id: null,
    session_id: SESSION,
  });
}
function assistantToolLine(): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_02",
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "ls -la" } }],
    },
    session_id: SESSION,
  });
}
function resultLine(): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1200,
    num_turns: 1,
    result: "Done.",
    session_id: SESSION,
    total_cost_usd: 0.0123,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 5,
    },
  });
}

function collector(): { events: ActivityEventInput[]; onEvent: (e: ActivityEventInput) => void } {
  const events: ActivityEventInput[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

Deno.test("claude client maps a turn's stream-json and resumes with the captured session id", async () => {
  const recordedArgs: string[][] = [];
  const scripts: FakeScript[] = [
    {
      stdout: [initLine(), assistantTextLine("Working on it."), assistantToolLine(), resultLine()],
    },
    { stdout: [assistantTextLine("More."), resultLine()] },
  ];
  let call = 0;
  const spawn: ClaudeSpawn = (args) => {
    recordedArgs.push(args);
    return new FakeClaude(scripts[call++]);
  };
  const { events, onEvent } = collector();
  const client = new ClaudeCodeClient(
    onEvent,
    { model: "claude-sonnet-4-6", effort: "high" },
    spawn,
  );

  const session = await client.startSession("/repo");
  assertEquals(session.threadId, "claude-pending");

  // Turn 1: no --resume yet; the init message hands us the durable id.
  const turn1 = await client.runTurn(session, { title: "t1", prompt: "hello" });
  assert(!recordedArgs[0].includes("--resume"));
  assertStringIncludes(recordedArgs[0].join(" "), "--effort high");
  assertEquals(session.threadId, SESSION);
  assertEquals(turn1.completed, true);

  // Response text arrives as role codex / kind agent (goal_loop accumulates it).
  const agentText = events.filter((e) => e.role === "codex" && e.kind === "agent").map((e) =>
    e.message
  );
  assertEquals(agentText, ["Working on it."]);

  // tool_use surfaces as a one-line tool event.
  const tools = events.filter((e) => e.kind === "tool").map((e) => e.message);
  assertEquals(tools, ["Bash: ls -la"]);

  // The result carries a token-bearing event goal_loop's budget tracker reads.
  const tokenEvents = events.filter((e) => /token/i.test(e.kind));
  assertEquals(tokenEvents.length, 1);
  assertEquals((tokenEvents[0].raw as { total_tokens: number }).total_tokens, 165);

  // Turn 2: the captured id is passed back as --resume.
  await client.runTurn(session, { title: "t2", prompt: "continue" });
  const resumeIdx = recordedArgs[1].indexOf("--resume");
  assert(resumeIdx >= 0);
  assertEquals(recordedArgs[1][resumeIdx + 1], SESSION);

  await client.stop();
});

Deno.test("claude client throws with the stderr tail on a non-zero exit", async () => {
  const spawn: ClaudeSpawn = () =>
    new FakeClaude({ stderr: "fatal: model overloaded, try again", code: 1 });
  const { onEvent } = collector();
  const client = new ClaudeCodeClient(onEvent, { model: "m", effort: "high" }, spawn);
  const session = await client.startSession("/repo");
  await assertRejects(
    () => client.runTurn(session, { title: "t", prompt: "x" }),
    Error,
    "model overloaded",
  );
  await client.stop();
});

Deno.test("stop() kills an in-flight child without error", async () => {
  let fake: FakeClaude | undefined;
  const spawn: ClaudeSpawn = () => {
    fake = new FakeClaude({ hold: true });
    return fake;
  };
  const { onEvent } = collector();
  const client = new ClaudeCodeClient(onEvent, { model: "m", effort: "high" }, spawn);
  const session = await client.startSession("/repo");
  // Do not await: the process holds open. The spawn happens synchronously before
  // runTurn's first await, so the child exists by the time stop() runs. The turn
  // rejects once stop() kills it (non-zero exit); swallow that here.
  const pending = client.runTurn(session, { title: "t", prompt: "x" }).catch(() => {});
  await client.stop();
  assertEquals(fake?.killed, true);
  await pending;
  // Idempotent: a second stop() with nothing in flight is a no-op.
  await client.stop();
});
