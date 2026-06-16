import { BoardStore } from "./board/store.ts";
import { TASK_STATUS_LABELS } from "./board/types.ts";
import {
  formatGoalLines,
  formatHealthLines,
  formatStatusLines,
  listManualVerificationItems,
} from "./board/status_lines.ts";
import { summarizeGoalProgress } from "./board/goal_progress.ts";
import { normalizeRoot, runtimeDirName, workflowPath } from "./paths.ts";
import { startServer } from "./web/server.ts";
import { runCommandCenterTui } from "./tui/command_center.ts";
import { ensureGitRepository, gitMergeBranch } from "./workers/git_utils.ts";
import { GoalPlanner } from "./workers/goal_planner.ts";
import { runScout } from "./workers/goal_scout.ts";
import { GoalPursuer } from "./workers/goal_pursuer.ts";
import { GoalLoopRunner } from "./workers/goal_loop.ts";
import { formatProbeLines, probeLights, runGoalProbes } from "./workers/goal_probes.ts";
import { GoalReviewer } from "./workers/goal_reviewer.ts";
import { LoopForgeWorker } from "./workers/loopforge_worker.ts";
import { buildProjectMemory } from "./workers/project_memory.ts";
import { buildTaskCard, ensureProjectKnowledgeFiles } from "./workers/task_memory.ts";
import {
  CLAUDE_HOOK_EVENTS,
  CODEX_HOOK_EVENTS,
  hookCommand,
  mergeHookSettings,
} from "./workers/agent_hooks.ts";
import { readWorkflow } from "./workflow/workflow.ts";
import {
  AgentBackend,
  describeBackend,
  normalizeBackend,
  readGlobalConfig,
  updateGlobalConfig,
} from "./board/global_config.ts";

const dirFlag = applyDirFlag(Deno.args);
const root = normalizeRoot(dirFlag.root);
const [command, ...args] = normalizeArgs(applyBackendFlags(dirFlag.args));

try {
  switch (command) {
    case "init":
      await initCommand();
      break;
    case "goal":
      await goalCommand(args);
      break;
    case "build":
      await buildCommand(args);
      break;
    case "plan":
      await planCommand(args);
      break;
    case "run":
      await runCommand(args);
      break;
    case "serve":
    case "board":
      await serveCommand(args);
      break;
    case "gui":
      await guiCommand(args);
      break;
    case "tui":
      await tuiCommand(args);
      break;
    case "command-center":
    case "native-tui":
      await runCommandCenterTui(root, args);
      break;
    case "opentui":
      await openTuiCommand(args);
      break;
    case "status":
      statusCommand();
      break;
    case "health":
      healthCommand();
      break;
    case "doctor":
      doctorCommand();
      break;
    case "dogfood":
      await dogfoodCommand(args);
      break;
    case "goals":
      goalsCommand();
      break;
    case "workflow":
      workflowCommand();
      break;
    case "merge":
      await mergeCommand(args);
      break;
    case "review":
      await reviewCommand(args);
      break;
    case "delete":
    case "remove":
      deleteCommand(args);
      break;
    case "message":
      messageCommand(args);
      break;
    case "main":
      await mainCommand(args);
      break;
    case "task":
      taskCommand(args);
      break;
    case "steer":
      await steerCommand(args);
      break;
    case "compact":
      compactCommand(args);
      break;
    case "close-goal":
    case "close":
      closeGoalCommand(args);
      break;
    case "hooks":
      await hooksCommand(args);
      break;
    case "check":
      await checkCommand(args);
      break;
    case "loop":
      await loopCommand(args);
      break;
    case "pursue":
      await pursueCommand(args);
      break;
    case "lesson":
      lessonCommand(args);
      break;
    case "standup":
      standupCommand();
      break;
    case "scout":
      await scoutCommand();
      break;
    case "ideas":
      await ideasCommand(args);
      break;
    case undefined:
    case "-h":
    case "--help":
    case "help":
      printHelp();
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`loopforge: ${message}`);
  Deno.exit(1);
}

async function initCommand(): Promise<void> {
  const store = new BoardStore(root);
  try {
    store.initProject();
    const actions = await ensureGitRepository(root);
    console.log(`LoopForge initialized at ${root}/${runtimeDirName(root)}`);
    console.log(`Workflow ${workflowPath(root)}`);
    for (const action of actions) {
      console.log(action);
    }
  } finally {
    store.close();
  }
}

function workflowCommand(): void {
  const workflow = readWorkflow(root);
  console.log(`Workflow: ${workflowPath(root)}`);
  console.log(`Tracker: ${workflow.trackerKind}`);
  console.log(`Max agents: ${workflow.maxConcurrentAgents}`);
  console.log(`Max turns: ${workflow.maxTurns}`);
  console.log(`Max retries: ${workflow.maxRetries}`);
  console.log(`Retry backoff: ${workflow.retryBackoffMs}ms`);
  console.log(`Codex: ${workflow.model} ${workflow.reasoningEffort} fast=${workflow.fastMode}`);
  console.log(`GitHub PR review: ${workflow.githubPrReview ? "on" : "off"}`);
}

async function goalCommand(args: string[]): Promise<void> {
  const text = args.join(" ").trim();
  if (!text) {
    throw new Error("Goal text is required.");
  }

  const store = new BoardStore(root);
  try {
    store.initProject();
    await ensureGitRepository(root);
    const planner = new GoalPlanner(root, {
      projectMemory: buildProjectMemory(store),
      onEvent: (event) => {
        if (event.message.trim()) {
          console.log(`[compiler] ${event.kind} ${event.message}`);
        }
      },
    });
    const plan = await planner.planGoal(text);
    const { goal, tasks } = store.createGoalWithTasks(text, plan.tasks, {
      completionContract: plan.completionContract,
      probes: plan.probes,
    });
    console.log(`${goal.id} compiled.`);
    for (const task of tasks) {
      console.log(`${task.id} P${task.priority} ${TASK_STATUS_LABELS[task.status]} ${task.title}`);
    }
  } finally {
    store.close();
  }
}

async function planCommand(args: string[]): Promise<void> {
  await goalCommand(args);
}

async function buildCommand(args: string[]): Promise<void> {
  const text = args.join(" ").trim();
  if (!text) {
    throw new Error("Goal text is required.");
  }

  const store = new BoardStore(root);
  try {
    store.initProject();
    await ensureGitRepository(root);
    const planner = new GoalPlanner(root, {
      projectMemory: buildProjectMemory(store),
      onEvent: (event) => {
        if (event.message.trim()) {
          console.log(`[compiler] ${event.kind} ${event.message}`);
        }
      },
    });
    const plan = await planner.planGoal(text);
    const { goal, tasks } = store.createGoalWithTasks(text, plan.tasks, {
      completionContract: plan.completionContract,
      probes: plan.probes,
    });
    console.log(
      `${goal.id} compiled. Running ${tasks.length} task${tasks.length === 1 ? "" : "s"}.`,
    );
    const worker = new LoopForgeWorker(root, store, {
      onEvent: (event) => {
        const task = event.taskId ?? "system";
        console.log(`[${event.role}:${task}] ${event.kind} ${event.message}`);
      },
    });
    const completed = await worker.runQueue();
    console.log(`Processed ${completed.length} task${completed.length === 1 ? "" : "s"}.`);
    const progress = summarizeGoalProgress(store.getBoard(), goal.id);
    if (store.getGoal(goal.id).status === "closed") {
      console.log(`${goal.id} closed.`);
    } else if (progress?.completionReady) {
      const result = store.closeGoal(
        progress.goal.id,
        `${progress.done}/${progress.total} tasks done. ${progress.completionReason}`,
      );
      console.log(`${result.goal.id} closed.`);
    } else if (progress) {
      console.log(`${progress.goal.id} is not closed: ${progress.completionReason}`);
    }
  } finally {
    store.close();
  }
}

async function runCommand(args: string[]): Promise<void> {
  const runAll = args.includes("--all") || args.includes("-a");
  const limitIndex = args.findIndex((arg) => arg === "--limit");
  const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : Number.POSITIVE_INFINITY;
  if (limitIndex >= 0 && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error("A valid --limit value is required.");
  }
  const positional = args.filter((arg, index) =>
    !arg.startsWith("-") && args[index - 1] !== "--limit"
  );
  const taskId = positional[0];
  if (runAll && taskId) {
    throw new Error("Use either loopforge run TASK-ID or loopforge run --all, not both.");
  }

  const store = new BoardStore(root);
  store.initProject();
  await ensureGitRepository(root);
  const worker = new LoopForgeWorker(root, store, {
    onEvent: (event) => {
      const task = event.taskId ?? "system";
      console.log(`[${event.role}:${task}] ${event.kind} ${event.message}`);
    },
  });
  try {
    if (runAll || !taskId) {
      const tasks = await worker.runQueue(limit);
      console.log(`Processed ${tasks.length} task${tasks.length === 1 ? "" : "s"}.`);
      return;
    }

    const task = await worker.runTask(taskId);
    console.log(`${task.id} is now ${TASK_STATUS_LABELS[task.status]}.`);
  } finally {
    store.close();
  }
}

// Find the first free port at or after `start`, so the GUI launcher never dies
// on a leftover server holding the default port.
function findFreePort(start: number): number {
  for (let candidate = start; candidate < start + 100; candidate++) {
    try {
      const listener = Deno.listen({ port: candidate });
      listener.close();
      return candidate;
    } catch (error) {
      if (error instanceof Deno.errors.AddrInUse) {
        continue;
      }
      throw error;
    }
  }
  throw new Error(`No free port found in ${start}-${start + 100}.`);
}

// One-command launcher for the web GUI: start the server and open the browser
// at /app. The Tauri desktop wrapper (app/src-tauri) is the native upgrade.
async function guiCommand(args: string[]): Promise<void> {
  const portArgIndex = args.findIndex((arg) => arg === "--port" || arg === "-p");
  const requested = portArgIndex >= 0 ? Number(args[portArgIndex + 1]) : 4733;
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error("A valid --port value is required.");
  }
  // Each GUI run serves THIS project; if the port is taken (another LoopForge
  // server, a leftover), pick the next free one instead of crashing.
  const port = findFreePort(requested);
  if (port !== requested) {
    console.log(`Port ${requested} was busy; using ${port}.`);
  }
  const store = new BoardStore(root);
  try {
    store.initProject();
    await ensureGitRepository(root);
  } finally {
    store.close();
  }
  const server = startServer(root, port);
  const appUrl = `${server.url}/app/`;
  console.log(`LoopForge GUI: ${appUrl}`);
  if (!args.includes("--no-open")) {
    const opener = Deno.build.os === "darwin"
      ? "open"
      : Deno.build.os === "windows"
      ? "explorer"
      : "xdg-open";
    try {
      await new Deno.Command(opener, { args: [appUrl], stdout: "null", stderr: "null" })
        .spawn().status;
    } catch {
      console.log("Open the URL above in your browser.");
    }
  }
  await server.finished;
}

async function serveCommand(args: string[]): Promise<void> {
  const portArgIndex = args.findIndex((arg) => arg === "--port" || arg === "-p");
  const port = portArgIndex >= 0 ? Number(args[portArgIndex + 1]) : 4733;
  if (!Number.isInteger(port) || port < 1) {
    throw new Error("A valid --port value is required.");
  }
  const store = new BoardStore(root);
  try {
    store.initProject();
    await ensureGitRepository(root);
  } finally {
    store.close();
  }
  const server = startServer(root, port);
  console.log(`Open ${server.url}`);
  await server.finished;
}

async function openTuiCommand(args: string[]): Promise<void> {
  const portArgIndex = args.findIndex((arg) => arg === "--port" || arg === "-p");
  const port = portArgIndex >= 0 ? Number(args[portArgIndex + 1]) : 4733;
  if (!Number.isInteger(port) || port < 1) {
    throw new Error("A valid --port value is required.");
  }
  const bun = resolveExecutable("bun", [homePath(".bun/bin/bun")]);
  if (!bun) {
    console.error("loopforge: Bun was not found. Falling back to native TUI.");
    await runCommandCenterTui(root, stripPortArgs(args, portArgIndex));
    return;
  }
  const store = new BoardStore(root);
  try {
    store.initProject();
    await ensureGitRepository(root);
  } finally {
    store.close();
  }
  const server = startServer(root, port);
  const forwardedArgs = stripPortArgs(args, portArgIndex);
  const status = await new Deno.Command(bun, {
    args: [
      new URL("./tui/opentui_client.ts", import.meta.url).pathname,
      "--url",
      server.url,
      ...forwardedArgs,
    ],
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  server.shutdown();
  await server.finished.catch(() => {});
  if (!status.success) {
    throw new Error(`OpenTUI exited with code ${status.code}.`);
  }
}

async function tuiCommand(args: string[]): Promise<void> {
  if (args.includes("--native")) {
    await runCommandCenterTui(root, args.filter((arg) => arg !== "--native"));
    return;
  }
  await openTuiCommand(args);
}

async function hooksCommand(args: string[]): Promise<void> {
  const scriptPath = new URL("../scripts/hooks/loopforge_agent_hook.py", import.meta.url).pathname;
  const [action, target] = args.filter((arg) => !arg.startsWith("--"));
  const settingsArgIndex = args.indexOf("--settings");
  const settingsOverride = settingsArgIndex >= 0 ? args[settingsArgIndex + 1] : null;
  if (action === "print" || action === undefined) {
    console.log(`LoopForge agent status hook script:\n  ${scriptPath}`);
    console.log("\nInstall automatically:");
    console.log("  loopforge hooks install claude   # merges into ~/.claude/settings.json");
    console.log("  loopforge hooks install codex    # merges into ~/.codex/hooks.json");
    console.log("\nManual hook command (register for lifecycle events):");
    console.log(`  ${hookCommand(scriptPath, "<agent-name>")}`);
    console.log(
      "\nReports go to http://127.0.0.1:4733 (override with LOOPFORGE_URL or LOOPFORGE_PORT).",
    );
    console.log("Reports from directories outside the project the server runs in are ignored.");
    return;
  }
  if (action !== "install" || (target !== "claude" && target !== "codex")) {
    throw new Error("Usage: loopforge hooks [print | install claude | install codex]");
  }
  const home = Deno.env.get("HOME") ?? "";
  const settingsPath = settingsOverride ??
    (target === "claude" ? `${home}/.claude/settings.json` : `${home}/.codex/hooks.json`);
  const command = hookCommand(scriptPath, target === "claude" ? "claude-code" : "codex");
  const events = target === "claude" ? CLAUDE_HOOK_EVENTS : CODEX_HOOK_EVENTS;
  let existing: unknown = {};
  try {
    existing = JSON.parse(await Deno.readTextFile(settingsPath));
  } catch {
    // Missing or invalid file starts from an empty settings object.
  }
  const result = mergeHookSettings(existing, events, command);
  await Deno.mkdir(settingsPath.split("/").slice(0, -1).join("/"), { recursive: true });
  await Deno.writeTextFile(settingsPath, `${JSON.stringify(result.settings, null, 2)}\n`);
  if (result.added.length) {
    console.log(`Added LoopForge status hook to ${settingsPath} for: ${result.added.join(", ")}`);
  } else {
    console.log(`LoopForge status hook already present in ${settingsPath}.`);
  }
  if (target === "codex") {
    console.log("Codex CLI loads hooks when [features] hooks = true in ~/.codex/config.toml.");
  }
}

async function checkCommand(args: string[]): Promise<void> {
  const store = new BoardStore(root);
  try {
    const goalId = args[0]?.trim() ||
      summarizeGoalProgress(store.getBoard())?.goal.id;
    if (!goalId) {
      throw new Error("No open goal to check. Pass a GOAL-ID.");
    }
    const summary = await runGoalProbes(root, store, goalId);
    if (!summary.total) {
      console.log(`${goalId} has no win-condition probes recorded.`);
      return;
    }
    for (const line of formatProbeLines(store.listProbes(goalId))) {
      console.log(line);
    }
    console.log(
      `${goalId} win conditions: ${summary.passed}/${summary.total} ${
        probeLights(store.listProbes(goalId))
      }`,
    );
  } finally {
    store.close();
  }
}

async function loopCommand(args: string[]): Promise<void> {
  const hoursIndex = args.indexOf("--hours");
  const hours = hoursIndex >= 0 ? Number(args[hoursIndex + 1]) : undefined;
  if (hoursIndex >= 0 && (!Number.isFinite(hours) || hours! <= 0)) {
    throw new Error("A valid --hours value is required.");
  }
  const iterIndex = args.indexOf("--iterations");
  const maxIterations = iterIndex >= 0 ? Number(args[iterIndex + 1]) : undefined;
  const tokensIndex = args.indexOf("--tokens");
  const tokenBudget = tokensIndex >= 0 ? Number(args[tokensIndex + 1]) : undefined;
  const positional = args.filter((arg, index) =>
    !arg.startsWith("-") &&
    (hoursIndex < 0 || index !== hoursIndex + 1) &&
    (iterIndex < 0 || index !== iterIndex + 1) &&
    (tokensIndex < 0 || index !== tokensIndex + 1)
  );
  if (!positional.length) {
    throw new Error(
      'Usage: loopforge loop <GOAL-N | "goal text"> [--hours H] [--tokens N] [--iterations N]',
    );
  }
  const store = new BoardStore(root);
  try {
    store.initProject();
    await ensureGitRepository(root);
    let goalId: string;
    if (positional.length === 1 && /^goal-\d+$/i.test(positional[0])) {
      goalId = positional[0].toUpperCase();
    } else {
      // One step: plain text plans the goal, then the loop starts on it.
      const text = positional.join(" ").trim();
      const planner = new GoalPlanner(root, {
        projectMemory: buildProjectMemory(store),
        onEvent: (event) => {
          if (event.message.trim()) {
            console.log(`[compiler] ${event.kind} ${event.message}`);
          }
        },
      });
      const plan = await planner.planGoal(text);
      const created = store.createGoalWithTasks(text, plan.tasks, {
        completionContract: plan.completionContract,
        probes: plan.probes,
      });
      goalId = created.goal.id;
      console.log(`${goalId} compiled; starting the goal loop.`);
    }
    const runner = new GoalLoopRunner(root, store, {
      hours,
      tokenBudget: tokenBudget && Number.isFinite(tokenBudget) && tokenBudget > 0
        ? tokenBudget
        : undefined,
      maxIterations: maxIterations && Number.isInteger(maxIterations) && maxIterations > 0
        ? maxIterations
        : undefined,
      onEvent: (event) => {
        const task = event.taskId ?? "system";
        console.log(`[${event.role}:${task}] ${event.kind} ${event.message}`);
      },
    });
    const report = await runner.run(goalId);
    console.log("");
    console.log(
      `Loop ${report.outcome} after ${report.iterations} iteration${
        report.iterations === 1 ? "" : "s"
      }.`,
    );
    console.log(report.detail);
  } finally {
    store.close();
  }
}

async function pursueCommand(args: string[]): Promise<void> {
  const hoursIndex = args.indexOf("--hours");
  const hours = hoursIndex >= 0 ? Number(args[hoursIndex + 1]) : 2;
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error("A valid --hours value is required.");
  }
  const iterIndex = args.indexOf("--iterations");
  const maxIterations = iterIndex >= 0 ? Number(args[iterIndex + 1]) : 24;
  const escalateIndex = args.indexOf("--escalate");
  const rescueConfig = readGlobalConfig().rescue;
  const escalateBackend = escalateIndex >= 0
    ? args[escalateIndex + 1]
    : rescueConfig.enabled
    ? rescueConfig.backend
    : undefined;
  const all = args.includes("--all");
  const goalId = args.find((arg, index) =>
    !arg.startsWith("-") &&
    (hoursIndex < 0 || index !== hoursIndex + 1) &&
    (iterIndex < 0 || index !== iterIndex + 1) &&
    (escalateIndex < 0 || index !== escalateIndex + 1)
  );
  const store = new BoardStore(root);
  try {
    store.initProject();
    await ensureGitRepository(root);
    const pursuer = new GoalPursuer(root, store, {
      hours,
      maxIterations: Number.isInteger(maxIterations) && maxIterations > 0 ? maxIterations : 24,
      escalateBackend,
      onEvent: (event) => {
        const task = event.taskId ?? "system";
        console.log(`[${event.role}:${task}] ${event.kind} ${event.message}`);
      },
    });
    const reports = all || !goalId ? await pursuer.pursueAll() : [await pursuer.pursue(goalId)];
    for (const report of reports) {
      console.log(
        `${report.goalId}: ${
          report.closed ? "CLOSED" : "stopped"
        } after ${report.iterations} iteration${
          report.iterations === 1 ? "" : "s"
        }. ${report.reason}`,
      );
      for (const ask of report.asks) {
        console.log(`  needs you: ${ask}`);
      }
    }
  } finally {
    store.close();
  }
}

function lessonCommand(args: string[]): void {
  const text = args.join(" ").trim();
  usingStore((store) => {
    if (!text) {
      for (const lesson of store.listLessons(30)) {
        console.log(`- ${lesson.text}${lesson.source ? ` (${lesson.source})` : ""}`);
      }
      return;
    }
    store.addLesson(text, "user");
    console.log("Lesson recorded.");
  });
}

async function scoutCommand(): Promise<void> {
  const store = new BoardStore(root);
  try {
    store.initProject();
    const report = await runScout(root, store, {
      onEvent: (event) => console.error(`[${event.role}] ${event.message.slice(0, 160)}`),
    });
    if (!report.ran) {
      console.log(`Scout did not run: ${report.reason}`);
      if (!readGlobalConfig().scout.enabled) {
        console.log("Arm it with: loopforge --scout codex (or claude, local, pi)");
      }
      return;
    }
    console.log(
      report.added.length
        ? `Scout proposed ${report.added.length} idea${report.added.length === 1 ? "" : "s"}:`
        : "Scout proposed nothing new this pass.",
    );
    for (const idea of report.added) {
      console.log(`- ${idea.id}: ${idea.title}`);
    }
    if (report.added.length) {
      console.log("Review with: loopforge ideas");
    }
  } finally {
    store.close();
  }
}

async function ideasCommand(commandArgs: string[]): Promise<void> {
  const [action, ideaId] = commandArgs;
  if (action === "approve" && ideaId) {
    const store = new BoardStore(root);
    try {
      store.initProject();
      const idea = store.setIdeaStatus(ideaId, "approved");
      console.log(`${idea.id} approved: ${idea.title}`);
      console.log("Compiling it into a goal...");
      const planner = new GoalPlanner(root, {
        projectMemory: buildProjectMemory(store),
        onEvent: (event) => {
          store.appendAgentEvent(event);
        },
      });
      const ideaText = `${idea.title}\n\n${idea.pitch}${
        idea.sources.length ? `\n\nReference links:\n${idea.sources.join("\n")}` : ""
      }`;
      const plan = await planner.planGoal(ideaText);
      const result = store.createGoalWithTasks(ideaText, plan.tasks, {
        completionContract: plan.completionContract,
        probes: plan.probes,
      });
      console.log(
        `${idea.id} became ${result.goal.id} with ${result.tasks.length} task${
          result.tasks.length === 1 ? "" : "s"
        } in Ready. Run them with: loopforge run`,
      );
    } finally {
      store.close();
    }
    return;
  }
  usingStore((store) => {
    if (action === "reject" && ideaId) {
      const idea = store.setIdeaStatus(ideaId, "rejected");
      console.log(`${idea.id} rejected and remembered; the scout will not re-pitch it.`);
      return;
    }
    if (action === "show" && ideaId) {
      const idea = store.getIdea(ideaId);
      console.log(`${idea.id}: ${idea.title} [${idea.status}]`);
      if (idea.buildsOn) {
        console.log(`Builds on: ${idea.buildsOn}`);
      }
      console.log("");
      console.log(idea.pitch);
      if (idea.sources.length) {
        console.log("");
        console.log("Sources:");
        for (const source of idea.sources) {
          console.log(`- ${source}`);
        }
      }
      return;
    }
    if (action && action !== "list") {
      throw new Error("Usage: loopforge ideas [list | show <id> | approve <id> | reject <id>]");
    }
    const ideas = store.listIdeas("proposed");
    if (!ideas.length) {
      console.log("No ideas awaiting review. Run the scout with: loopforge scout");
      return;
    }
    console.log("Ideas awaiting review (in recommended build order):");
    for (const idea of ideas) {
      console.log(`${idea.rank}. ${idea.id}: ${idea.title}`);
    }
    console.log("");
    console.log("loopforge ideas show <id> | approve <id> | reject <id>");
  });
}

function standupCommand(): void {
  usingStore((store) => {
    const board = store.getBoard();
    console.log("LoopForge standup");
    console.log("");
    const closed = board.goals.filter((goal) => goal.status === "closed").slice(-5);
    console.log("Recently shipped:");
    if (closed.length) {
      for (const goal of closed) {
        console.log(`- ${goal.id} ${goal.closedAt ?? ""}: ${goal.text.slice(0, 90)}`);
      }
    } else {
      console.log("- nothing closed yet");
    }
    console.log("");
    console.log("Needs you:");
    const blocked = board.tasks.filter((task) => task.status === "blocked");
    if (blocked.length) {
      for (const task of blocked) {
        console.log(
          `- ${task.id}: ${
            (task.needsInputPrompt ?? task.blockedReason ?? "needs input").slice(0, 110)
          }`,
        );
      }
    } else {
      console.log("- nothing");
    }
    console.log("");
    console.log("Needs manual verification:");
    const manual = listManualVerificationItems(board);
    if (manual.length) {
      for (const item of manual) {
        console.log(`- ${item.taskId} ${item.title.slice(0, 60)}`);
        for (const note of item.notes) {
          console.log(`    ${note.slice(0, 110)}`);
        }
      }
    } else {
      console.log("- none");
    }
    const baseline = board.events.find((event) => event.kind === "baseline");
    if (baseline) {
      console.log("");
      console.log(`Run baseline: ${baseline.message.replace(/^GOAL-\d+:\s*/, "")}`);
    }
    console.log("");
    console.log("Scout ideas awaiting review:");
    if (board.ideas.length) {
      for (const idea of board.ideas) {
        console.log(`- ${idea.id}: ${idea.title}`);
      }
      console.log("  (loopforge ideas show <id> | approve <id> | reject <id>)");
    } else {
      console.log("- none");
    }
    console.log("");
    console.log("Win conditions:");
    const open = board.goals.filter((goal) => goal.status === "open");
    let printed = false;
    for (const goal of open) {
      const probes = board.probes.filter((probe) => probe.goalId === goal.id);
      if (probes.length) {
        printed = true;
        const passed = probes.filter((probe) => probe.lastStatus === "passed").length;
        console.log(`- ${goal.id} ${passed}/${probes.length} ${probeLights(probes)}`);
      }
    }
    if (!printed) {
      console.log("- no probes recorded");
    }
    console.log("");
    for (const line of formatHealthLines(board).slice(-1)) {
      console.log(line);
    }
  });
}

function applyDirFlag(rawArgs: string[]): { root: string; args: string[] } {
  const remaining: string[] = [];
  let dir: string | null = null;
  for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index];
    if (arg === "-C" || arg === "--dir") {
      dir = rawArgs[++index] ?? null;
    } else {
      remaining.push(arg);
    }
  }
  if (dir) {
    try {
      Deno.chdir(dir);
    } catch {
      console.error(`loopforge: cannot use directory: ${dir}`);
      Deno.exit(1);
    }
  }
  return { root: Deno.cwd(), args: remaining };
}

function applyBackendFlags(rawArgs: string[]): string[] {
  const remaining: string[] = [];
  let backend: AgentBackend | null = null;
  let endpoint: string | null = null;
  let model: string | null = null;
  let rescue: string | null = null;
  let rescueAfter: number | null = null;
  let planner: string | null = null;
  let scout: string | null = null;
  let search: string | null = null;
  for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index];
    if (arg === "--codex" || arg === "--pi" || arg === "--claude" || arg === "--local") {
      backend = arg.slice(2) as AgentBackend;
    } else if (arg === "--endpoint") {
      endpoint = rawArgs[++index] ?? null;
    } else if (arg === "--agent-model") {
      model = rawArgs[++index] ?? null;
    } else if (arg === "--rescue") {
      rescue = rawArgs[++index] ?? null;
    } else if (arg === "--rescue-after") {
      rescueAfter = Number(rawArgs[++index]);
    } else if (arg === "--planner") {
      planner = rawArgs[++index] ?? null;
    } else if (arg === "--scout") {
      scout = rawArgs[++index] ?? null;
    } else if (arg === "--search") {
      search = rawArgs[++index] ?? null;
    } else {
      remaining.push(arg);
    }
  }
  if (rescue || Number.isInteger(rescueAfter)) {
    const config = updateGlobalConfig({
      rescue: {
        ...(rescue === "off"
          ? { enabled: false }
          : rescue
          ? { enabled: true, backend: normalizeBackend(rescue, "codex") }
          : {}),
        ...(Number.isInteger(rescueAfter) && rescueAfter! > 0
          ? { afterAttempts: rescueAfter! }
          : {}),
      },
    });
    console.error(
      config.rescue.enabled
        ? `LoopForge rescue model: ${config.rescue.backend} after ${config.rescue.afterAttempts} failed attempts (saved)`
        : "LoopForge rescue model: off (saved)",
    );
  }
  if (planner) {
    const config = updateGlobalConfig({
      planner: planner === "off"
        ? { enabled: false }
        : { enabled: true, backend: normalizeBackend(planner, "codex") },
    });
    console.error(
      config.planner.enabled
        ? `LoopForge planner model: ${config.planner.backend} compiles and replans goals (saved)`
        : "LoopForge planner model: off; planning follows the main backend (saved)",
    );
  }
  if (scout) {
    const config = updateGlobalConfig({
      scout: scout === "off"
        ? { enabled: false }
        : { enabled: true, backend: normalizeBackend(scout, "codex") },
    });
    console.error(
      config.scout.enabled
        ? `LoopForge scout: ${config.scout.backend} proposes ideas for you to approve or reject (saved)`
        : "LoopForge scout: off (saved)",
    );
  }
  if (search) {
    const config = updateGlobalConfig({
      search: { endpoint: search === "off" ? "" : search },
    });
    console.error(
      config.search.endpoint
        ? `LoopForge web search endpoint: ${config.search.endpoint} (saved; agents search via curl)`
        : "LoopForge web search: off (saved)",
    );
  }
  if (!backend && !endpoint && !model) {
    return remaining;
  }
  if (!backend && (endpoint || model)) {
    backend = endpoint ? "local" : readGlobalConfig().backend;
  }
  const localPatch: { endpoint?: string; model?: string } = {};
  if (endpoint) {
    localPatch.endpoint = endpoint;
  }
  if (model && backend === "local") {
    localPatch.model = model;
  }
  const config = updateGlobalConfig({
    ...(backend ? { backend } : {}),
    ...(Object.keys(localPatch).length ? { local: localPatch } : {}),
    ...(model && backend === "claude" ? { claude: { model } } : {}),
    ...(model && backend === "pi" ? { pi: { model } } : {}),
  });
  console.error(`LoopForge agent backend: ${describeBackend(config)} (saved for next time)`);
  if (config.backend === "claude") {
    console.error(
      "Note: the claude backend runs through your Anthropic account (claude.ai subscription " +
        "extra usage or API credits). LoopForge worker runs will consume that budget.",
    );
  }
  if (config.backend === "pi" || config.backend === "claude" || config.backend === "local") {
    console.error(
      "Backend runs through pi (pi.dev). Install with: pnpm add -g @earendil-works/pi-coding-agent",
    );
  }
  return remaining;
}

function stripPortArgs(args: string[], portArgIndex: number): string[] {
  return portArgIndex >= 0
    ? args.filter((_, index) => index !== portArgIndex && index !== portArgIndex + 1)
    : args;
}

function normalizeArgs(args: string[]): [string | undefined, ...string[]] {
  const first = args[0];
  if (first === undefined) {
    return ["tui"];
  }
  if (first.startsWith("-") && first !== "-h" && first !== "--help") {
    return ["tui", ...args];
  }
  return [first, ...args.slice(1)];
}

function resolveExecutable(name: string, fallbacks: string[]): string | null {
  for (const directory of (Deno.env.get("PATH") ?? "").split(":")) {
    if (!directory) {
      continue;
    }
    const candidate = `${directory}/${name}`;
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  for (const fallback of fallbacks) {
    if (isExecutable(fallback)) {
      return fallback;
    }
  }
  return null;
}

function homePath(relativePath: string): string {
  const home = Deno.env.get("HOME");
  return home ? `${home}/${relativePath}` : relativePath;
}

function isExecutable(target: string): boolean {
  try {
    const stat = Deno.statSync(target);
    return stat.isFile;
  } catch {
    return false;
  }
}

async function mergeCommand(args: string[]): Promise<void> {
  const taskId = args[0];
  if (!taskId) {
    throw new Error("Task id is required.");
  }

  const store = new BoardStore(root);
  try {
    const task = store.getTask(taskId);
    if (!task.branchName) {
      throw new Error(`${task.id} does not have an assigned branch.`);
    }
    if (task.status !== "review" && task.status !== "merging" && task.status !== "done") {
      throw new Error(`${task.id} must be in Review, Merging, or Done before merge.`);
    }
    if (task.status === "review") {
      store.requestTransition(task.id, "merging", "merger", "Manual merge started.");
    }
    const output = await gitMergeBranch(root, task.branchName);
    const event = store.appendEvent(
      task.id,
      null,
      "merger",
      "merge",
      output.trim() || `Merged ${task.branchName}.`,
    );
    console.log(event.message);
    if (task.status === "review" || task.status === "merging") {
      store.requestTransition(task.id, "done", "merger", `Merged ${task.branchName}.`);
    }
    console.log(`${task.id} is now Done.`);
  } finally {
    store.close();
  }
}

async function reviewCommand(args: string[]): Promise<void> {
  const taskId = args[0];
  if (!taskId) {
    throw new Error("Task id is required.");
  }

  const store = new BoardStore(root);
  try {
    const task = store.getTask(taskId);
    if (task.status !== "review") {
      throw new Error(`${task.id} must be in Review before review.`);
    }
    const reviewer = new GoalReviewer(root, {
      onEvent: (event) => {
        if (event.message.trim()) {
          console.log(`[reviewer] ${event.kind} ${event.message}`);
        }
      },
    });
    const result = await reviewer.review(task);
    const reviewText = [
      task.validation,
      "",
      `LoopForge review: ${result.verdict.toUpperCase()}`,
      result.notes,
    ].filter(Boolean).join("\n");
    store.updateTaskValidation(task.id, reviewText);
    store.appendEvent(
      task.id,
      null,
      "reviewer",
      "review",
      result.verdict === "approved"
        ? "Review approved. Preparing merge."
        : "Review requested changes. Waiting for user direction.",
    );
    if (result.verdict !== "approved") {
      store.requestTransition(
        task.id,
        "blocked",
        "reviewer",
        "Review requested changes. Add a message to continue this task.",
      );
      console.log(`${task.id} review requested changes. Moved to Inbox.`);
      return;
    }
    if (!task.branchName) {
      store.requestTransition(
        task.id,
        "blocked",
        "merger",
        "LoopForge cannot merge because this task has no assigned branch.",
      );
      console.log(`${task.id} has no branch to merge. Moved to Inbox.`);
      return;
    }
    store.requestTransition(
      task.id,
      "merging",
      "merger",
      "Review approved. Merging branch.",
    );
    const output = await gitMergeBranch(root, task.branchName);
    store.appendEvent(
      task.id,
      null,
      "merger",
      "merge",
      output.trim() || `Merged ${task.branchName}.`,
    );
    store.requestTransition(
      task.id,
      "done",
      "merger",
      `Review approved and merged ${task.branchName}.`,
    );
    console.log(`${task.id} review ${result.verdict}.`);
  } finally {
    store.close();
  }
}

function deleteCommand(args: string[]): void {
  const taskId = args[0];
  if (!taskId) {
    throw new Error("Task id is required.");
  }

  usingStore((store) => {
    const event = store.deleteTask(taskId);
    console.log(event.message);
  });
}

function messageCommand(args: string[]): void {
  const taskId = args[0];
  const message = args.slice(1).join(" ").trim();
  if (!taskId || !message) {
    throw new Error('Usage: loopforge message TASK-ID "message"');
  }

  usingStore((store) => {
    const event = store.enqueueMessage(taskId, "user", message);
    console.log(event.message);
  });
}

async function mainCommand(args: string[]): Promise<void> {
  const action = args[0] ?? "status";
  const store = new BoardStore(root);
  try {
    store.initProject();
    ensureProjectKnowledgeFiles(root);
    if (action === "status") {
      const state = store.getProjectState();
      console.log(`Main thread: ${state.mainThreadId ?? "none"}`);
      console.log(`Created: ${state.mainThreadCreatedAt ?? "none"}`);
      console.log(`Reset: ${state.mainThreadResetAt ?? "none"}`);
      console.log(state.mainThreadSummary || "No main-thread summary recorded.");
      console.log("");
      for (const line of formatHealthLines(store.getBoard())) {
        console.log(line);
      }
      return;
    }
    if (action === "ensure") {
      const worker = new LoopForgeWorker(root, store);
      const threadId = await worker.ensureMainThread();
      const state = store.getProjectState();
      console.log(`Main thread: ${threadId ?? state.mainThreadId ?? "none"}`);
      console.log(state.mainThreadSummary || "No main-thread summary recorded.");
      return;
    }
    if (action === "reset") {
      const threadId = args[1] ?? `manual-main-${crypto.randomUUID()}`;
      const state = store.resetMainThread(
        threadId,
        "Project main thread reset. Seed future child tasks from project docs and board memory.",
      );
      console.log(`Main thread reset to ${state.mainThreadId}.`);
      return;
    }
    if (action === "absorb") {
      const taskId = args[1];
      if (!taskId) {
        throw new Error("Usage: loopforge main absorb TASK-ID");
      }
      const task = store.getTask(taskId);
      const summary = [
        store.getProjectState().mainThreadSummary,
        `${task.id} absorbed manually: ${task.title}`,
      ].filter(Boolean).join("\n");
      store.updateMainThreadSummary(summary);
      console.log(`${task.id} absorbed into main-thread summary.`);
      return;
    }
    throw new Error(`Unknown main command: ${action}`);
  } finally {
    store.close();
  }
}

function taskCommand(args: string[]): void {
  const taskId = args[0];
  const action = args[1] ?? "card";
  if (!taskId) {
    throw new Error("Usage: loopforge task TASK-ID [card|threads]");
  }
  usingStore((store) => {
    const task = store.getTask(taskId);
    if (action === "card") {
      console.log(task.taskCard || buildTaskCard(task));
      return;
    }
    if (action === "threads") {
      console.log(`Parent: ${task.parentThreadId ?? "none"}`);
      console.log(`Child: ${task.threadId ?? "none"}`);
      console.log(`Active turn: ${task.activeTurnId ?? "none"}`);
      console.log(`Manifest: ${task.contextManifestPath ?? "none"}`);
      return;
    }
    throw new Error(`Unknown task command: ${action}`);
  });
}

async function steerCommand(args: string[]): Promise<void> {
  const taskId = args[0];
  const message = args.slice(1).join(" ").trim();
  if (!taskId || !message) {
    throw new Error('Usage: loopforge steer TASK-ID "message"');
  }
  const store = new BoardStore(root);
  try {
    const worker = new LoopForgeWorker(root, store);
    const event = await worker.steerTask(taskId, message);
    console.log(event.message);
  } finally {
    store.close();
  }
}

function compactCommand(args: string[]): void {
  const taskId = args[0];
  if (!taskId) {
    throw new Error("Usage: loopforge compact TASK-ID");
  }
  usingStore((store) => {
    const task = store.getTask(taskId);
    const updated = store.updateTaskCard(task.id, buildTaskCard(task));
    console.log(updated.taskCard);
  });
}

function closeGoalCommand(args: string[]): void {
  const goalId = args[0];
  usingStore((store) => {
    const board = store.getBoard();
    const progress = goalId ? summarizeGoalProgress(board, goalId) : summarizeGoalProgress(board);
    if (!progress) {
      throw new Error(goalId ? `Goal not found: ${goalId}` : "No open goal is ready to close.");
    }
    const result = store.closeGoal(
      progress.goal.id,
      `${progress.done}/${progress.total} tasks done. ${progress.completionReason}`,
    );
    console.log(`${result.goal.id} closed.`);
    console.log(result.goal.closureSummary);
  });
}

function statusCommand(): void {
  usingStore((store) => {
    for (const line of formatStatusLines(store.getBoard())) {
      console.log(line);
    }
  });
}

function healthCommand(): void {
  usingStore((store) => {
    for (const line of formatHealthLines(store.getBoard())) {
      console.log(line);
    }
  });
}

async function dogfoodCommand(args: string[]): Promise<void> {
  if (args.includes("--live")) {
    await liveDogfoodCommand(args);
    return;
  }
  const python = resolveExecutable("python3", []);
  if (!python) {
    throw new Error("python3 is required to run the LoopForge dogfood gate.");
  }
  const script = new URL("../scripts/smoke_opentui_tui.py", import.meta.url).pathname;
  const loopforgeBin = new URL("../loopforge", import.meta.url).pathname;
  const repo = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
  console.log("Running LoopForge dogfood readiness gate...");
  const status = await new Deno.Command(python, {
    args: [script, "--dogfood-only"],
    cwd: repo,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      LOOPFORGE_REPO: repo,
      LOOPFORGE_BIN: loopforgeBin,
    },
  }).spawn().status;
  if (!status.success) {
    throw new Error(`LoopForge dogfood gate failed with code ${status.code}.`);
  }
  console.log("LoopForge dogfood readiness gate passed.");
}

async function liveDogfoodCommand(args: string[]): Promise<void> {
  const forwarded = args.filter((arg) => arg !== "--live");
  const script = new URL("../scripts/live_dogfood.ts", import.meta.url).pathname;
  console.log("Running LoopForge live dogfood readiness gate...");
  const status = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-net",
      "--allow-env",
      script,
      ...forwarded,
    ],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!status.success) {
    throw new Error(`LoopForge live dogfood gate failed with code ${status.code}.`);
  }
  console.log("LoopForge live dogfood readiness gate passed.");
}

function doctorCommand(): void {
  const checks = [
    {
      label: "Deno runtime",
      path: Deno.execPath(),
      ok: true,
      note: "running this CLI",
    },
    {
      label: "Git",
      path: resolveExecutable("git", []),
      okNote: "worktrees, commits, and merges enabled",
      missingNote: "install git before running task worktrees",
    },
    {
      label: "Bun",
      path: resolveExecutable("bun", [homePath(".bun/bin/bun")]),
      okNote: "OpenTUI command center enabled",
      missingNote: "native fallback TUI will be used",
    },
    {
      label: "uv",
      path: resolveExecutable("uv", [homePath(".local/bin/uv"), homePath(".cargo/bin/uv")]),
      okNote: "Codex Python bridge can launch",
      missingNote: "install uv for Codex SDK-backed workers",
    },
    {
      label: "Python 3",
      path: resolveExecutable("python3", []),
      okNote: "smoke tests and bridge scripts can run",
      missingNote: "install python3 for smoke tests and bridge scripts",
    },
    {
      label: "pi",
      path: resolveExecutable("pi", [homePath(".local/share/pnpm/pi"), homePath(".bun/bin/pi")]),
      okNote: "pi, claude, and local backends can launch",
      missingNote: "install for non-codex backends: pnpm add -g @earendil-works/pi-coding-agent",
    },
  ];
  const config = readGlobalConfig();
  console.log(`backend: ${describeBackend(config)}`);
  console.log(
    config.rescue.enabled
      ? `rescue: ${config.rescue.backend} reviews stuck tasks after ${config.rescue.afterAttempts} failed attempts`
      : "rescue: off (arm with --rescue codex or the TUI Rescue button)",
  );
  console.log(
    config.planner.enabled
      ? `planner: ${config.planner.backend} compiles and replans goals`
      : "planner: off (route with --planner codex or the TUI Planner button)",
  );
  console.log(
    config.scout.enabled
      ? `scout: ${config.scout.backend} proposes ideas (you approve or reject them)`
      : "scout: off (arm with --scout codex or the TUI Scout button)",
  );
  console.log(
    config.search.endpoint
      ? `search: ${config.search.endpoint} (SearXNG-style JSON endpoint for agent web searches)`
      : "search: not configured (set with --search http://127.0.0.1:8888 for local-model web search)",
  );
  const missingRequired = checks.filter((check) => check.label === "Git" && !check.path);
  for (const check of checks) {
    const ok = check.ok ?? Boolean(check.path);
    const status = ok ? "ok" : check.label === "Bun" ? "fallback" : "missing";
    const detail = ok
      ? `${check.path ?? "available"} - ${check.note ?? check.okNote}`
      : check.missingNote;
    console.log(`${status}: ${check.label}: ${detail}`);
  }
  if (missingRequired.length) {
    console.log("Doctor: action needed before running task agents.");
    return;
  }
  console.log("Doctor: LoopForge can start. Check `loopforge health` for project state.");
}

function goalsCommand(): void {
  usingStore((store) => {
    for (const line of formatGoalLines(store.getBoard())) {
      console.log(line);
    }
  });
}

function usingStore<T>(fn: (store: BoardStore) => T): T {
  const store = new BoardStore(root);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function printHelp(): void {
  console.log(`LoopForge

Usage:
  loopforge
  loopforge init
  loopforge goal "<goal text>"
  loopforge build "<goal text>"
  loopforge run [TASK-ID]
  loopforge run --all [--limit N]
  loopforge review TASK-ID
  loopforge delete TASK-ID
  loopforge message TASK-ID "<message>"
  loopforge serve [--port 4733]
  loopforge tui [--native]
  loopforge opentui [--port 4733]
  loopforge board [--port 4733]
  loopforge merge TASK-ID
  loopforge main status|ensure|reset|absorb
  loopforge task TASK-ID [card|threads]
  loopforge steer TASK-ID "<message>"
  loopforge compact TASK-ID
  loopforge close-goal [GOAL-ID]
  loopforge goals
  loopforge health
  loopforge dogfood [--live] [--keep]
  loopforge doctor
  loopforge status
  loopforge hooks [print | install claude | install codex]
  loopforge check [GOAL-ID]
  loopforge loop <GOAL-ID | "text"> [--hours N] [--tokens N] [--iterations N]   # one agent owns the goal
  loopforge pursue [GOAL-ID | --all] [--hours N] [--iterations N] [--escalate codex]
  loopforge lesson ["text to remember"]
  loopforge scout                            # one scout pass: propose ideas now
  loopforge ideas [show|approve|reject <id>] # review the idea list (you gatekeep)
  loopforge standup

Target directory (any command):
  -C, --dir <path>            Run LoopForge in that project folder instead of the
                              current directory

Agent backend (any command, saved to ~/.loopforge/config.json):
  --codex                     Native Codex app-server (default)
  --pi [--agent-model M]      pi (pi.dev) with its configured or given model
  --claude [--agent-model M]  Claude via pi (uses your Anthropic extra usage budget)
  --local [--endpoint URL] [--agent-model M]
                              Any OpenAI-compatible endpoint via pi
                              (llama.cpp, LM Studio, vLLM, Ollama; remembers URL)

Rescue model (saved; also a toggle button in the TUI footer):
  --rescue <codex|claude|local|pi|off>   Stronger model reviews stuck tasks and
                                         tells the worker how to fix them
  --rescue-after N                       Failed attempts before it chimes in (default 2)

Planner model (saved; also a toggle button in the TUI footer):
  --planner <codex|claude|local|pi|off>  Route goal planning and pursue replans to a
                                         stronger model while workers stay on the
                                         main backend

Scout (saved; proposes ideas, you stay the gatekeeper):
  --scout <codex|claude|local|pi|off>    A scout studies the project and proposes
                                         next ideas; nothing runs until you approve
  --search <url|off>                     SearXNG-style endpoint agents use for web
                                         searches via curl (works on every backend)

Running loopforge with no command opens the TUI.
`);
}
