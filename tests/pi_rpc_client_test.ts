import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import { BoardStore } from "../src/board/store.ts";
import { ActivityEventInput } from "../src/board/types.ts";
import { LoopForgeWorker } from "../src/workers/loopforge_worker.ts";
import { piRpcArgs, PiRpcClient } from "../src/workers/pi_rpc_client.ts";

Deno.test("piRpcArgs appends provider, model, and thinking flags only when set", () => {
  const args = piRpcArgs({ provider: "anthropic", model: "claude-sonnet-4-6", thinking: "high" });
  assertEquals(args[args.indexOf("--provider") + 1], "anthropic");
  assertEquals(args[args.indexOf("--model") + 1], "claude-sonnet-4-6");
  assertEquals(args[args.indexOf("--thinking") + 1], "high");

  // Omitted options add no flag; the rpc-mode base args survive.
  const bare = piRpcArgs({});
  assert(bare.includes("--mode"));
  assert(bare.includes("rpc"));
  assert(!bare.includes("--thinking"));
  assert(!bare.includes("--provider"));
});

function fakePiCommand(): string[] {
  return [
    Deno.execPath(),
    "run",
    "--allow-read",
    "--allow-write",
    new URL("./helpers/fake_pi_rpc.ts", import.meta.url).pathname,
  ];
}

Deno.test("pi rpc client maps sessions, turns, and events onto the agent interface", async () => {
  const cwd = Deno.makeTempDirSync();
  const events: ActivityEventInput[] = [];
  const client = new PiRpcClient((event) => events.push(event), {
    command: fakePiCommand(),
  });
  try {
    const session = await client.startSession(cwd, { name: "LoopForge - test - main" });
    assert(session.threadId.endsWith(".jsonl"));

    const turn = await client.runTurn(session, {
      title: "TASK-1: implement",
      prompt: "You are a LoopForge Codex worker.\nImplement the fixture change.",
    });
    assertEquals(turn.status, "completed");
    assertEquals(turn.completed, true);
    assertStringIncludes(turn.turnId, "pi-turn-");

    const kinds = events.map((event) => event.kind);
    assert(kinds.includes("turn/started"));
    assert(kinds.includes("turn/completed"));
    assert(kinds.includes("item/fileChange/patchUpdated"));
    assert(kinds.includes("item/commandExecution/outputDelta"));
    const agentText = events
      .filter((event) => event.role === "codex" && event.kind === "agent")
      .map((event) => event.message)
      .join("");
    assertStringIncludes(agentText, "Implemented the task");
    assertEquals(await Deno.readTextFile(`${cwd}/fake-pi-output.txt`), "fake pi implementation\n");

    await client.steerTurn(session, "Focus on the failing check.");
    await client.interruptTurn(session);
    await client.compactThread(session);
    await client.setThreadName(session, "renamed");

    const thread = await client.readThread(session);
    assertEquals(thread.threadId, session.threadId);
    assertEquals(thread.name, "renamed");
    assert(thread.turnCount >= 1);

    const fork = await client.forkSession(cwd, session.threadId, { name: "child" });
    assertNotEquals(fork.threadId, session.threadId);
    assertStringIncludes(fork.threadId, "clone");
  } finally {
    await client.stop();
    Deno.removeSync(cwd, { recursive: true });
  }
});

Deno.test("pi rpc client keeps a turn open across an overflow compaction retry", async () => {
  const cwd = Deno.makeTempDirSync();
  const events: ActivityEventInput[] = [];
  const client = new PiRpcClient((event) => events.push(event), {
    command: fakePiCommand(),
  });
  try {
    const session = await client.startSession(cwd);
    const turn = await client.runTurn(session, {
      title: "TASK-1: test-engineer",
      prompt: "OVERFLOW_RETRY scenario prompt",
    });
    assertEquals(turn.status, "completed");
    const agentText = events
      .filter((event) => event.role === "codex" && event.kind === "agent")
      .map((event) => event.message)
      .join("");
    assertStringIncludes(agentText, "VERIFICATION_PASSED - proof recorded after compaction");
    assertEquals(
      events.filter((event) => event.kind === "turn/completed").length,
      1,
    );
  } finally {
    await client.stop();
    Deno.removeSync(cwd, { recursive: true });
  }
});

Deno.test("worker completes a full task loop through the pi backend", async () => {
  const root = Deno.makeTempDirSync();
  await git(root, ["init", "-b", "main"]);
  await git(root, [
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "commit",
    "--allow-empty",
    "-m",
    "seed",
  ]);
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { task } = store.createGoal("Exercise the pi worker backend");
    const worker = new LoopForgeWorker(root, store, {
      createCodexClient: (onEvent) => new PiRpcClient(onEvent, { command: fakePiCommand() }),
    });
    const updated = await worker.runTask(task.id);
    assertEquals(updated.status, "done");
    assertStringIncludes(updated.validation, "VERIFICATION_PASSED");
    assertStringIncludes(updated.validation, "LoopForge review: APPROVED");
    assertStringIncludes(updated.touchedPaths.join("\n"), "fake-pi-output.txt");
    assert(updated.threadId?.endsWith(".jsonl"));
    assertEquals(store.getGoal(updated.goalId).status, "closed");
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

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
