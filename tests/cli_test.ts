import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { BoardStore } from "../src/board/store.ts";

Deno.test("CLI close-goal closes the active proven goal", async () => {
  const root = Deno.makeTempDirSync({ prefix: "loopforge-cli-" });
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal, task } = store.createGoal("Close from CLI");
    store.requestTransition(task.id, "in_progress");
    store.updateTaskValidation(
      task.id,
      [
        "Turn status: completed",
        "Test turn status: completed",
        "Discovered verification gates:",
        "- Diff inspection: git diff --stat && git diff --check - Every task needs a basic changed-file and whitespace sanity check.",
        "",
        "Verification verdict:",
        "VERIFICATION_PASSED",
        "- Focused validation passed with recorded proof.",
        "Commit: abc123",
        "Git status:",
        "clean",
        "LoopForge review: APPROVED",
      ].join("\n"),
    );
    store.updateTaskCard(task.id, "TASK-1 complete.");
    store.updateTaskHandoff(task.id, "Validated and absorbed.");
    store.requestTransition(task.id, "review");
    store.requestTransition(task.id, "done");
    store.close();

    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-run",
        new URL("../src/cli.ts", import.meta.url).pathname,
        "close-goal",
        goal.id,
      ],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).output();

    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
    const stdout = new TextDecoder().decode(output.stdout);
    assertStringIncludes(stdout, "GOAL-1 closed.");
    assertStringIncludes(stdout, "1/1 tasks done.");

    const reopened = new BoardStore(root);
    try {
      assertEquals(reopened.getGoal(goal.id).status, "closed");
    } finally {
      reopened.close();
    }
  } finally {
    try {
      store.close();
    } catch {
      // The store is already closed on the success path.
    }
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("CLI goals lists open and closed goals", async () => {
  const root = Deno.makeTempDirSync({ prefix: "loopforge-cli-" });
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal, task } = store.createGoal("Closed CLI listing");
    store.requestTransition(task.id, "in_progress");
    store.updateTaskValidation(
      task.id,
      [
        "Turn status: completed",
        "Test turn status: completed",
        "Discovered verification gates:",
        "- Diff inspection: git diff --stat && git diff --check - Every task needs a basic changed-file and whitespace sanity check.",
        "",
        "Verification verdict:",
        "VERIFICATION_PASSED",
        "- Focused validation passed with recorded proof.",
        "Commit: abc123",
        "Git status:",
        "clean",
        "LoopForge review: APPROVED",
      ].join("\n"),
    );
    store.updateTaskCard(task.id, "TASK-1 complete.");
    store.updateTaskHandoff(task.id, "Validated and absorbed.");
    store.requestTransition(task.id, "review");
    store.requestTransition(task.id, "done");
    store.closeGoal(goal.id, "Closed before listing.");
    store.createGoal("Open CLI listing");
    store.close();

    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-run",
        new URL("../src/cli.ts", import.meta.url).pathname,
        "goals",
      ],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).output();

    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
    const stdout = new TextDecoder().decode(output.stdout);
    assertStringIncludes(stdout, "GOAL-1 closed");
    assertStringIncludes(stdout, "Closed CLI listing");
    assertStringIncludes(stdout, "GOAL-2 open: Open CLI listing");
  } finally {
    try {
      store.close();
    } catch {
      // The store is already closed on the success path.
    }
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("CLI health prints project readiness", async () => {
  const root = Deno.makeTempDirSync({ prefix: "loopforge-cli-" });
  const store = new BoardStore(root);
  try {
    store.initProject();
    store.setMainThread("thread-main", "Project memory ready.");
    store.createGoal("Health CLI listing");
    store.close();

    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-run",
        new URL("../src/cli.ts", import.meta.url).pathname,
        "health",
      ],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).output();

    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
    const stdout = new TextDecoder().decode(output.stdout);
    assertStringIncludes(stdout, "Project health: Ready To Run");
    assertStringIncludes(stdout, "Main memory: ready thread-main");
    assertStringIncludes(stdout, "Next: TASK-1: start the task or run ready tasks.");
  } finally {
    try {
      store.close();
    } catch {
      // The store is already closed on the success path.
    }
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("CLI help documents main ensure", async () => {
  const root = Deno.makeTempDirSync({ prefix: "loopforge-cli-" });
  try {
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-run",
        new URL("../src/cli.ts", import.meta.url).pathname,
        "help",
      ],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).output();

    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
    const stdout = new TextDecoder().decode(output.stdout);
    assertStringIncludes(stdout, 'loopforge build "<goal text>"');
    assertStringIncludes(stdout, "loopforge main status|ensure|reset|absorb");
    assertStringIncludes(stdout, "loopforge dogfood [--keep]");
    assertStringIncludes(stdout, "loopforge gui [--port 4733] [--no-open]");
    assertStringIncludes(
      stdout,
      "Running loopforge with no command serves the GUI and opens your browser.",
    );
    assertStringIncludes(stdout, "loopforge doctor");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("CLI main status includes project health guidance", async () => {
  const root = Deno.makeTempDirSync({ prefix: "loopforge-cli-" });
  const store = new BoardStore(root);
  try {
    store.initProject();
    store.createGoal("Main status guidance");
    store.close();

    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-run",
        new URL("../src/cli.ts", import.meta.url).pathname,
        "main",
        "status",
      ],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).output();

    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
    const stdout = new TextDecoder().decode(output.stdout);
    assertStringIncludes(stdout, "Main thread: none");
    assertStringIncludes(stdout, "Project health: Needs Project Memory");
    assertStringIncludes(
      stdout,
      "Next: Open the GUI or run `loopforge main ensure` to create project memory.",
    );
  } finally {
    try {
      store.close();
    } catch {
      // The store is already closed on the success path.
    }
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("CLI doctor reports local prerequisites", async () => {
  const root = Deno.makeTempDirSync({ prefix: "loopforge-cli-" });
  try {
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-run",
        new URL("../src/cli.ts", import.meta.url).pathname,
        "doctor",
      ],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).output();

    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
    const stdout = new TextDecoder().decode(output.stdout);
    assertStringIncludes(stdout, "Deno runtime");
    assertStringIncludes(stdout, "Git");
    assertStringIncludes(stdout, "uv");
    assertStringIncludes(stdout, "Python 3");
    assertStringIncludes(stdout, "Doctor:");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("CLI backend flags persist to the global config and warn for claude", async () => {
  const root = Deno.makeTempDirSync({ prefix: "loopforge-cli-backend-" });
  const home = Deno.makeTempDirSync({ prefix: "loopforge-home-" });
  const run = (...flags: string[]) =>
    new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-run",
        "--allow-net",
        new URL("../src/cli.ts", import.meta.url).pathname,
        ...flags,
        "help",
      ],
      cwd: root,
      env: { LOOPFORGE_HOME: home },
      stdout: "piped",
      stderr: "piped",
    }).output();
  try {
    const local = await run(
      "--local",
      "--endpoint",
      "http://100.64.0.7:8080/v1",
      "--agent-model",
      "qwen3-coder",
    );
    assertEquals(local.code, 0, new TextDecoder().decode(local.stderr));
    const localNotice = new TextDecoder().decode(local.stderr);
    assertStringIncludes(localNotice, "pi agent, local model qwen3-coder");
    assertStringIncludes(localNotice, "saved for next time");
    const saved = JSON.parse(await Deno.readTextFile(`${home}/config.json`));
    assertEquals(saved.backend, "local");
    assertEquals(saved.local.endpoint, "http://100.64.0.7:8080/v1");
    assertEquals(saved.local.model, "qwen3-coder");

    const claude = await run("--claude");
    const claudeNotice = new TextDecoder().decode(claude.stderr);
    assertStringIncludes(claudeNotice, "extra usage");

    const codex = await run("--codex");
    assertEquals(codex.code, 0);
    const final = JSON.parse(await Deno.readTextFile(`${home}/config.json`));
    assertEquals(final.backend, "codex");
    assertEquals(final.local.endpoint, "http://100.64.0.7:8080/v1");

    const planner = await run("--planner", "claude");
    assertEquals(planner.code, 0, new TextDecoder().decode(planner.stderr));
    assertStringIncludes(
      new TextDecoder().decode(planner.stderr),
      "LoopForge planner model: claude",
    );
    const routed = JSON.parse(await Deno.readTextFile(`${home}/config.json`));
    assertEquals(routed.planner, { enabled: true, backend: "claude" });
    assertEquals(routed.backend, "codex");

    const plannerOff = await run("--planner", "off");
    assertStringIncludes(new TextDecoder().decode(plannerOff.stderr), "planner model: off");
    const off = JSON.parse(await Deno.readTextFile(`${home}/config.json`));
    assertEquals(off.planner.enabled, false);
    assertEquals(off.planner.backend, "claude");

    const scout = await run("--scout", "local", "--search", "http://127.0.0.1:8888");
    assertEquals(scout.code, 0, new TextDecoder().decode(scout.stderr));
    const scoutNotice = new TextDecoder().decode(scout.stderr);
    assertStringIncludes(scoutNotice, "LoopForge scout: local");
    assertStringIncludes(scoutNotice, "web search endpoint: http://127.0.0.1:8888");
    const scouted = JSON.parse(await Deno.readTextFile(`${home}/config.json`));
    assertEquals(scouted.scout, { enabled: true, backend: "local" });
    assertEquals(scouted.search.endpoint, "http://127.0.0.1:8888");

    const scoutOff = await run("--scout", "off", "--search", "off");
    assertStringIncludes(new TextDecoder().decode(scoutOff.stderr), "scout: off");
    const cleared = JSON.parse(await Deno.readTextFile(`${home}/config.json`));
    assertEquals(cleared.scout.enabled, false);
    assertEquals(cleared.search.endpoint, "");
  } finally {
    Deno.removeSync(root, { recursive: true });
    Deno.removeSync(home, { recursive: true });
  }
});

Deno.test("CLI -C targets another project directory", async () => {
  const project = Deno.makeTempDirSync({ prefix: "loopforge-cli-dir-" });
  const elsewhere = Deno.makeTempDirSync({ prefix: "loopforge-cli-cwd-" });
  const home = Deno.makeTempDirSync({ prefix: "loopforge-home-" });
  try {
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-run",
        "--allow-net",
        new URL("../src/cli.ts", import.meta.url).pathname,
        "-C",
        project,
        "status",
      ],
      cwd: elsewhere,
      env: { LOOPFORGE_HOME: home },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
    assertStringIncludes(new TextDecoder().decode(output.stdout), "Active goal:");
    const stat = await Deno.stat(`${project}/.loopforge`);
    assertEquals(stat.isDirectory, true);
    let elsewhereHasBoard = true;
    try {
      await Deno.stat(`${elsewhere}/.loopforge`);
    } catch {
      elsewhereHasBoard = false;
    }
    assertEquals(elsewhereHasBoard, false);
  } finally {
    Deno.removeSync(project, { recursive: true });
    Deno.removeSync(elsewhere, { recursive: true });
    Deno.removeSync(home, { recursive: true });
  }
});

Deno.test("serving from the home directory redirects to a ~/LoopForge workspace", async () => {
  const home = Deno.makeTempDirSync({ prefix: "loopforge-home-" });
  const port = 54633 + Math.floor(Math.random() * 300);
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      "--allow-net",
      new URL("../src/cli.ts", import.meta.url).pathname,
      "serve",
      "--port",
      String(port),
    ],
    cwd: home,
    env: { HOME: home },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  try {
    let project: { path?: string } = {};
    for (let index = 0; index < 100; index++) {
      try {
        const runtime = await fetch(`http://127.0.0.1:${port}/api/runtime`)
          .then((r) => r.json());
        project = runtime.project;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    // The served project is the dedicated workspace, not the home folder.
    assertEquals(project.path, `${home}/LoopForge`);
    // The workspace was scaffolded; the home folder itself was left alone.
    assert(await Deno.stat(`${home}/LoopForge/.loopforge`).then(() => true).catch(() => false));
    assert(!(await Deno.stat(`${home}/WORKFLOW.md`).then(() => true).catch(() => false)));
    assert(!(await Deno.stat(`${home}/AGENTS.md`).then(() => true).catch(() => false)));
  } finally {
    child.kill("SIGTERM");
    await child.status;
    await child.stdout.cancel();
    await child.stderr.cancel();
    await Deno.remove(home, { recursive: true }).catch(() => {});
  }
});
