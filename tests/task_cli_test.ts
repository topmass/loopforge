import { assertEquals, assertStringIncludes } from "@std/assert";
import { BoardStore } from "../src/board/store.ts";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Drive the real CLI as a subprocess so the test exercises arg parsing, target
// resolution, and the store write end to end - the same path the model hits.
async function runTask(cwd: string, args: string[]): Promise<CliResult> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      "--allow-net",
      CLI,
      "task",
      ...args,
    ],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

async function git(root: string, args: string[]): Promise<void> {
  await new Deno.Command("git", { args, cwd: root, stdout: "null", stderr: "null" }).output();
}

Deno.test("task CLI adds, starts, and completes a loop plan item with --root/--goal", async () => {
  const root = Deno.makeTempDirSync({ prefix: "loopforge-task-cli-" });
  const store = new BoardStore(root);
  let goalId: string;
  try {
    await git(root, ["init", "-b", "main"]);
    store.initProject();
    goalId = store.createGoal("Task CLI goal").goal.id;
  } finally {
    store.close();
  }

  try {
    const flags = ["--root", root, "--goal", goalId];

    const added = await runTask(root, [...flags, "add", "Do the thing", "--spec", "one line spec"]);
    assertEquals(added.code, 0, added.stderr);
    assertStringIncludes(added.stdout, "added ");
    assertStringIncludes(added.stdout, "Do the thing");

    const listed = await runTask(root, [...flags, "list"]);
    assertEquals(listed.code, 0, listed.stderr);
    assertStringIncludes(listed.stdout, "todo");
    assertStringIncludes(listed.stdout, "Do the thing");
    assertStringIncludes(listed.stdout, "note: one line spec");
    const id = listed.stdout.match(/TASK-\d+/)?.[0];
    assertEquals(typeof id, "string");

    const started = await runTask(root, [...flags, "start", id!]);
    assertEquals(started.code, 0, started.stderr);
    assertStringIncludes(started.stdout, `started ${id}`);
    assertStringIncludes((await runTask(root, [...flags, "list"])).stdout, "doing");

    // Done refuses without evidence.
    const badDone = await runTask(root, [...flags, "done", id!]);
    assertEquals(badDone.code, 1);
    assertStringIncludes(badDone.stderr, 'done requires --evidence "<proof>"');

    const done = await runTask(root, [...flags, "done", id!, "--evidence", "tests pass"]);
    assertEquals(done.code, 0, done.stderr);
    assertStringIncludes(done.stdout, `done ${id}`);

    // The evidence lands in the item note, and the final plan.updated lifecycle
    // event mirrors the final state so the GUI/TUI need no CLI-specific logic.
    const reopened = new BoardStore(root);
    try {
      const items = reopened.listLoopPlanItems(goalId);
      assertEquals(items.at(-1)?.status, "done");
      assertEquals(items.at(-1)?.note, "tests pass");
      const lastPlan = reopened.listLifecycleEvents(goalId).filter((event) =>
        event.kind === "plan.updated"
      ).at(-1);
      const steps = lastPlan?.data.steps as Array<{ status: string; note: string }>;
      assertEquals(steps.at(-1)?.status, "done");
      assertEquals(steps.at(-1)?.note, "tests pass");
    } finally {
      reopened.close();
    }
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("task CLI resolves the target from a .loopforge-goal.json pointer", async () => {
  const root = Deno.makeTempDirSync({ prefix: "loopforge-task-cli-ptr-" });
  const store = new BoardStore(root);
  let goalId: string;
  try {
    await git(root, ["init", "-b", "main"]);
    store.initProject();
    goalId = store.createGoal("Pointer goal").goal.id;
  } finally {
    store.close();
  }

  try {
    await Deno.writeTextFile(
      `${root}/.loopforge-goal.json`,
      `${JSON.stringify({ root, goalId })}\n`,
    );
    const subdir = `${root}/nested/deep`;
    await Deno.mkdir(subdir, { recursive: true });

    // No flags: resolution walks up from the subdir to the pointer at root.
    const added = await runTask(subdir, ["add", "Pointer item"]);
    assertEquals(added.code, 0, added.stderr);
    assertStringIncludes(added.stdout, "Pointer item");

    const listed = await runTask(subdir, ["list"]);
    assertEquals(listed.code, 0, listed.stderr);
    assertStringIncludes(listed.stdout, "Pointer item");
    assertStringIncludes(listed.stdout, "todo");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});
