import path from "node:path";
import {
  BoardStore,
  normalizeExternalAgentState,
  readConfig,
  ReasoningEffort,
  updateConfig,
} from "../board/store.ts";
import { ActivityEvent, ActivityEventInput, TaskStatus } from "../board/types.ts";
import { normalizeRoot, staticPath } from "../paths.ts";
import {
  describeBackend,
  normalizeBackend,
  readGlobalConfig,
  updateGlobalConfig,
} from "../board/global_config.ts";
import { CodexClient } from "../workers/codex_app_server.ts";
import { gitMergeBranch } from "../workers/git_utils.ts";
import { GoalPlanner } from "../workers/goal_planner.ts";
import { GoalPursuer } from "../workers/goal_pursuer.ts";
import { runScout } from "../workers/goal_scout.ts";
import { GoalLoopRunner } from "../workers/goal_loop.ts";
import { runGoalProbes } from "../workers/goal_probes.ts";
import { GoalReviewer } from "../workers/goal_reviewer.ts";
import { LoopForgeWorker } from "../workers/loopforge_worker.ts";
import { buildProjectMemory } from "../workers/project_memory.ts";
import { buildTaskCard, ensureProjectKnowledgeFiles } from "../workers/task_memory.ts";
import { readWorkflow, setWorkflowMaxConcurrentAgents } from "../workflow/workflow.ts";

export interface LoopForgeServer {
  url: string;
  shutdown: () => void;
  finished: Promise<void>;
}

type Client = ReadableStreamDefaultController<Uint8Array>;

export interface LoopForgeServerOptions {
  createCodexClient?: (
    onEvent: (
      event: ActivityEventInput,
    ) => void,
  ) => CodexClient;
  createScoutClient?: (
    onEvent: (
      event: ActivityEventInput,
    ) => void,
  ) => CodexClient;
}

const APP_ROOT = path.normalize(decodeURIComponent(new URL("../../", import.meta.url).pathname));

export function startServer(
  root = Deno.cwd(),
  port = 4733,
  options: LoopForgeServerOptions = {},
): LoopForgeServer {
  const normalizedRoot = normalizeRoot(root);
  const store = new BoardStore(normalizedRoot);
  store.initProject();
  store.recoverStaleRuns();
  const clients = new Set<Client>();
  const encoder = new TextEncoder();
  let queueRunning = false;
  let pursueRunning = false;
  let scoutRunning = false;
  let goalLoopRunning = false;

  const send = (client: Client, type: string, payload: unknown) => {
    try {
      client.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`));
    } catch {
      clients.delete(client);
    }
  };
  const broadcast = (type: string, payload: unknown) => {
    for (const client of clients) {
      send(client, type, payload);
    }
  };
  const broadcastBoard = () => broadcast("board", store.getBoard());
  const broadcastActivity = (event: ActivityEvent) => {
    broadcast("activity", event);
    broadcastBoard();
  };
  const supervisorTimer = setInterval(() => {
    for (const event of store.markStaleAgentStatuses(120_000)) {
      broadcastActivity(event);
    }
    if (store.pruneExternalAgents(300_000) > 0) {
      broadcastBoard();
    }
  }, 15_000);
  const startQueue = () => {
    if (queueRunning) {
      return;
    }
    queueRunning = true;
    queueMicrotask(() => {
      const worker = new LoopForgeWorker(normalizedRoot, store, {
        onEvent: broadcastActivity,
        createCodexClient: options.createCodexClient,
      });
      worker.runQueue().then(() => {
        queueRunning = false;
        broadcastBoard();
      }).catch((error) => {
        queueRunning = false;
        const message = error instanceof Error ? error.message : String(error);
        broadcast("error", { message });
      });
    });
  };

  const abort = new AbortController();
  const server = Deno.serve(
    {
      port,
      signal: abort.signal,
      onListen: ({ hostname, port }) => {
        console.log(`LoopForge listening at http://${hostname}:${port}`);
      },
    },
    async (request) => {
      const url = new URL(request.url);

      try {
        if (url.pathname === "/api/events") {
          let streamController: Client | null = null;
          return new Response(
            new ReadableStream({
              start(controller) {
                streamController = controller;
                clients.add(controller);
                send(controller, "board", store.getBoard());
              },
              cancel() {
                if (streamController) {
                  clients.delete(streamController);
                }
              },
            }),
            {
              headers: {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
              },
            },
          );
        }

        if (url.pathname === "/api/board" && request.method === "GET") {
          return json(store.getBoard());
        }

        // The canonical typed lifecycle feed - the dashboard/Kanban subscribes
        // here for plan steps, subagents, and goal state across all backends.
        if (url.pathname === "/api/lifecycle" && request.method === "GET") {
          const goalId = url.searchParams.get("goalId") ?? undefined;
          return json({ events: store.listLifecycleEvents(goalId) });
        }

        if (url.pathname === "/api/config" && request.method === "GET") {
          return json(readConfig(normalizedRoot));
        }

        if (url.pathname === "/api/runtime" && request.method === "GET") {
          const board = store.getBoard();
          return json({
            queueRunning,
            config: readConfig(normalizedRoot),
            backend: describeBackend(readGlobalConfig()),
            rescue: readGlobalConfig().rescue,
            planner: readGlobalConfig().planner,
            scout: readGlobalConfig().scout,
            search: readGlobalConfig().search,
            workflow: readWorkflow(normalizedRoot),
            projectState: board.projectState,
            runningRuns: board.runs.filter((run) => run.status === "running"),
            activeAgentStatuses: board.agentStatuses.filter((status) =>
              board.runs.some((run) => run.id === status.runId && run.status === "running")
            ),
            dispatchableTasks: store.listDispatchableTasks(50),
            needsInputTasks: board.tasks.filter((task) => task.status === "blocked"),
          });
        }

        if (url.pathname === "/api/agents/report" && request.method === "POST") {
          const body = await readJson<{
            id?: string;
            agent?: string;
            state?: string;
            headline?: string;
            cwd?: string;
            sessionId?: string;
          }>(request);
          const agent = body.agent?.trim() ?? "";
          if (!agent) {
            return json({ error: "agent is required." }, 400);
          }
          const cwd = body.cwd?.trim() ?? "";
          if (
            cwd && path.resolve(cwd) !== normalizedRoot &&
            !path.resolve(cwd).startsWith(`${normalizedRoot}${path.sep}`)
          ) {
            return json({ ok: true, ignored: true, reason: "cwd outside project root" });
          }
          const id = body.id?.trim() || body.sessionId?.trim() || agent;
          const result = store.reportExternalAgent({
            id: `${agent}:${id}`,
            agent,
            state: normalizeExternalAgentState(body.state),
            headline: body.headline?.trim(),
            cwd,
            sessionId: body.sessionId?.trim() || undefined,
          });
          if (result.changed) {
            broadcastActivity(
              store.appendEvent(
                null,
                null,
                "external",
                "agent",
                `${agent} is ${result.status.state}${
                  result.status.headline ? `: ${result.status.headline}` : "."
                }`,
              ),
            );
          } else {
            broadcastBoard();
          }
          return json({ ok: true, status: result.status });
        }

        if (url.pathname === "/api/main" && request.method === "GET") {
          return json(store.getProjectState());
        }

        if (url.pathname === "/api/main/ensure" && request.method === "POST") {
          ensureProjectKnowledgeFiles(normalizedRoot);
          const worker = new LoopForgeWorker(normalizedRoot, store, {
            onEvent: broadcastActivity,
            createCodexClient: options.createCodexClient,
          });
          await worker.ensureMainThread();
          broadcastBoard();
          return json(store.getProjectState());
        }

        if (url.pathname === "/api/main/reset" && request.method === "POST") {
          ensureProjectKnowledgeFiles(normalizedRoot);
          const body = await readJson<{ threadId?: string; summary?: string }>(request);
          const state = store.resetMainThread(
            body.threadId?.trim() || `manual-main-${crypto.randomUUID()}`,
            body.summary?.trim() ||
              "Project main thread reset. Seed future child tasks from project docs and board memory.",
          );
          broadcastBoard();
          return json(state);
        }

        if (url.pathname === "/api/main/compact" && request.method === "POST") {
          const worker = new LoopForgeWorker(normalizedRoot, store, {
            onEvent: broadcastActivity,
            createCodexClient: options.createCodexClient,
          });
          await worker.compactMainThread();
          broadcastBoard();
          return json(store.getProjectState());
        }

        if (url.pathname === "/api/rescue" && request.method === "PATCH") {
          const body = await readJson<{
            enabled?: boolean;
            backend?: string;
            afterAttempts?: number;
          }>(request);
          const updated = updateGlobalConfig({
            rescue: {
              ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
              ...(typeof body.backend === "string" && body.backend.trim()
                ? { backend: normalizeBackend(body.backend.trim(), "codex") }
                : {}),
              ...(Number.isInteger(body.afterAttempts) && body.afterAttempts! > 0
                ? { afterAttempts: body.afterAttempts }
                : {}),
            },
          });
          broadcastActivity(
            store.appendEvent(
              null,
              null,
              "rescue",
              "config",
              updated.rescue.enabled
                ? `Rescue model armed: ${updated.rescue.backend} after ${updated.rescue.afterAttempts} failed attempts.`
                : "Rescue model disarmed.",
            ),
          );
          return json(updated.rescue);
        }

        if (url.pathname === "/api/planner" && request.method === "PATCH") {
          const body = await readJson<{ enabled?: boolean; backend?: string }>(request);
          const updated = updateGlobalConfig({
            planner: {
              ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
              ...(typeof body.backend === "string" && body.backend.trim()
                ? { backend: normalizeBackend(body.backend.trim(), "codex") }
                : {}),
            },
          });
          broadcastActivity(
            store.appendEvent(
              null,
              null,
              "planner",
              "config",
              updated.planner.enabled
                ? `Planner model routed: ${updated.planner.backend} compiles and replans goals.`
                : "Planner routing off; planning follows the main backend.",
            ),
          );
          return json(updated.planner);
        }

        if (url.pathname === "/api/workflow/agents" && request.method === "PATCH") {
          const body = await readJson<{ maxConcurrentAgents?: number }>(request);
          const count = body.maxConcurrentAgents;
          if (!Number.isInteger(count) || count! < 1 || count! > 16) {
            return json({ error: "maxConcurrentAgents must be an integer from 1 to 16." }, 400);
          }
          const workflow = setWorkflowMaxConcurrentAgents(normalizedRoot, count!);
          broadcastActivity(
            store.appendEvent(
              null,
              null,
              "core",
              "config",
              `Max concurrent agents set to ${workflow.maxConcurrentAgents}.`,
            ),
          );
          return json({ maxConcurrentAgents: workflow.maxConcurrentAgents });
        }

        if (url.pathname === "/api/config" && request.method === "PATCH") {
          const body = await readJson<Record<string, unknown>>(request);
          const config = updateConfig(normalizedRoot, {
            model: typeof body.model === "string" ? body.model : undefined,
            reasoningEffort: typeof body.reasoningEffort === "string"
              ? body.reasoningEffort as ReasoningEffort
              : undefined,
            fastMode: typeof body.fastMode === "boolean" ? body.fastMode : undefined,
            githubPrReview: typeof body.githubPrReview === "boolean"
              ? body.githubPrReview
              : undefined,
          });
          broadcastActivity(
            store.appendEvent(
              null,
              null,
              "settings",
              "config",
              `Model ${config.model}, reasoning ${config.reasoningEffort}, fast ${
                config.fastMode ? "on" : "off"
              }, GitHub PR gate ${config.githubPrReview ? "on" : "off"}.`,
            ),
          );
          return json(config);
        }

        if (url.pathname === "/api/goals" && request.method === "POST") {
          const body = await readJson<{ text?: string }>(request);
          const text = body.text?.trim() ?? "";
          if (!text) {
            return json({ error: "Goal text is required." }, 400);
          }
          const planner = new GoalPlanner(normalizedRoot, {
            projectMemory: buildProjectMemory(store),
            createCodexClient: options.createCodexClient,
            onEvent: (event) => {
              const activity = store.appendAgentEvent(event);
              broadcastActivity(activity);
            },
          });
          const plan = await planner.planGoal(text);
          const result = store.createGoalWithTasks(text, plan.tasks, {
            completionContract: plan.completionContract,
            probes: plan.probes,
          });
          broadcastBoard();
          return json(result, 201);
        }

        if (url.pathname === "/api/goals/build" && request.method === "POST") {
          const body = await readJson<{ text?: string }>(request);
          const text = body.text?.trim() ?? "";
          if (!text) {
            return json({ error: "Goal text is required." }, 400);
          }
          const planner = new GoalPlanner(normalizedRoot, {
            projectMemory: buildProjectMemory(store),
            createCodexClient: options.createCodexClient,
            onEvent: (event) => {
              const activity = store.appendAgentEvent(event);
              broadcastActivity(activity);
            },
          });
          const plan = await planner.planGoal(text);
          const result = store.createGoalWithTasks(text, plan.tasks, {
            completionContract: plan.completionContract,
            probes: plan.probes,
          });
          broadcastBoard();
          startQueue();
          return json({ ...result, running: queueRunning }, 201);
        }

        const checkMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/check$/);
        if (checkMatch && request.method === "POST") {
          const goalId = decodeURIComponent(checkMatch[1]);
          const summary = await runGoalProbes(normalizedRoot, store, goalId);
          broadcastBoard();
          return json({
            goalId,
            total: summary.total,
            passed: summary.passed,
            probes: store.listProbes(goalId),
          });
        }

        const pursueMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/pursue$/);
        if (pursueMatch && request.method === "POST") {
          const goalId = decodeURIComponent(pursueMatch[1]);
          const body = await readJson<{ hours?: number; escalate?: string }>(request);
          if (pursueRunning) {
            return json({ error: "A pursue loop is already running." }, 409);
          }
          pursueRunning = true;
          queueMicrotask(() => {
            const pursuer = new GoalPursuer(normalizedRoot, store, {
              hours: typeof body.hours === "number" && body.hours > 0 ? body.hours : 2,
              escalateBackend: typeof body.escalate === "string" && body.escalate.trim()
                ? body.escalate.trim()
                : undefined,
              onEvent: broadcastActivity,
              createCodexClient: options.createCodexClient,
            });
            pursuer.pursue(goalId).then((report) => {
              pursueRunning = false;
              broadcastActivity(
                store.appendEvent(
                  null,
                  null,
                  "pursuer",
                  "report",
                  `${report.goalId} ${
                    report.closed ? "closed" : "stopped"
                  } after ${report.iterations} iterations: ${report.reason}`,
                ),
              );
            }).catch((error) => {
              pursueRunning = false;
              const message = error instanceof Error ? error.message : String(error);
              broadcast("error", { message });
            });
          });
          return json({ ok: true, goalId, running: true });
        }

        const closeGoalMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/close$/);
        if (closeGoalMatch && request.method === "POST") {
          const goalId = decodeURIComponent(closeGoalMatch[1]);
          const body = await readJson<{ summary?: string }>(request);
          const result = store.closeGoal(goalId, body.summary ?? "");
          broadcastActivity(result.event);
          broadcastBoard();
          return json({ ok: true, ...result });
        }

        if (url.pathname === "/api/tasks" && request.method === "POST") {
          const body = await readJson<{
            title?: string;
            description?: string;
            acceptanceCriteria?: string;
            priority?: number;
          }>(request);
          const title = body.title?.trim() ?? "";
          if (!title) {
            return json({ error: "Task title is required." }, 400);
          }
          const result = store.createGoalWithTasks(title, [{
            title,
            description: body.description?.trim() || title,
            acceptanceCriteria: body.acceptanceCriteria?.trim() ||
              `Complete and validate: ${title}`,
            priority: Number.isInteger(body.priority) ? Number(body.priority) : 100,
          }]);
          broadcastBoard();
          return json(result, 201);
        }

        if (url.pathname === "/api/ideas" && request.method === "GET") {
          return json(store.listIdeas("proposed"));
        }

        const ideaAction = url.pathname.match(/^\/api\/ideas\/([^/]+)\/(approve|reject)$/);
        if (ideaAction && request.method === "POST") {
          const [, ideaId, action] = ideaAction;
          if (action === "reject") {
            const idea = store.setIdeaStatus(ideaId, "rejected");
            broadcastActivity(
              store.appendEvent(null, null, "scout", "idea", `${idea.id} rejected: ${idea.title}`),
            );
            broadcastBoard();
            return json(idea);
          }
          const idea = store.setIdeaStatus(ideaId, "approved");
          broadcastActivity(
            store.appendEvent(
              null,
              null,
              "scout",
              "idea",
              `${idea.id} approved: ${idea.title}. Compiling it into a goal.`,
            ),
          );
          const planner = new GoalPlanner(normalizedRoot, {
            createCodexClient: options.createCodexClient,
            onEvent: (event) => {
              const activity = store.appendAgentEvent(event);
              broadcastActivity(activity);
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
          broadcastActivity(
            store.appendEvent(
              null,
              null,
              "scout",
              "idea",
              `${idea.id} became ${result.goal.id} with ${result.tasks.length} task${
                result.tasks.length === 1 ? "" : "s"
              } in Ready.`,
            ),
          );
          broadcastBoard();
          return json({ idea, ...result }, 201);
        }

        if (url.pathname === "/api/goals/loop" && request.method === "POST") {
          if (goalLoopRunning) {
            return json({ error: "A goal loop is already running." }, 409);
          }
          const body = await readJson<{ text?: string; hours?: number; iterations?: number }>(
            request,
          );
          const text = body.text?.trim() ?? "";
          if (!text) {
            return json({ error: "Goal text is required." }, 400);
          }
          const planner = new GoalPlanner(normalizedRoot, {
            projectMemory: buildProjectMemory(store),
            createCodexClient: options.createCodexClient,
            onEvent: (event) => {
              const activity = store.appendAgentEvent(event);
              broadcastActivity(activity);
            },
          });
          const plan = await planner.planGoal(text);
          const created = store.createGoalWithTasks(text, plan.tasks, {
            completionContract: plan.completionContract,
            probes: plan.probes,
          });
          broadcastBoard();
          goalLoopRunning = true;
          queueMicrotask(() => {
            const runner = new GoalLoopRunner(normalizedRoot, store, {
              hours: typeof body.hours === "number" && body.hours > 0 ? body.hours : undefined,
              maxIterations: typeof body.iterations === "number" && body.iterations > 0
                ? Math.floor(body.iterations)
                : undefined,
              onEvent: broadcastActivity,
              createCodexClient: options.createCodexClient,
            });
            runner.run(created.goal.id).then(() => {
              goalLoopRunning = false;
              broadcastBoard();
            }).catch((error) => {
              goalLoopRunning = false;
              const message = error instanceof Error ? error.message : String(error);
              broadcast("error", { message });
            });
          });
          return json({ ok: true, goalId: created.goal.id, running: true }, 201);
        }

        const loopMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/loop$/);
        if (loopMatch && request.method === "POST") {
          if (goalLoopRunning) {
            return json({ error: "A goal loop is already running." }, 409);
          }
          const goalId = decodeURIComponent(loopMatch[1]).toUpperCase();
          store.getGoal(goalId);
          const body = await readJson<{ hours?: number; iterations?: number }>(request);
          goalLoopRunning = true;
          queueMicrotask(() => {
            const runner = new GoalLoopRunner(normalizedRoot, store, {
              hours: typeof body.hours === "number" && body.hours > 0 ? body.hours : undefined,
              maxIterations: typeof body.iterations === "number" && body.iterations > 0
                ? Math.floor(body.iterations)
                : undefined,
              onEvent: broadcastActivity,
              createCodexClient: options.createCodexClient,
            });
            runner.run(goalId).then(() => {
              goalLoopRunning = false;
              broadcastBoard();
            }).catch((error) => {
              goalLoopRunning = false;
              const message = error instanceof Error ? error.message : String(error);
              broadcast("error", { message });
            });
          });
          return json({ ok: true, goalId, running: true });
        }

        if (url.pathname === "/api/scout/run" && request.method === "POST") {
          if (scoutRunning) {
            return json({ error: "A scout pass is already running." }, 409);
          }
          scoutRunning = true;
          try {
            const report = await runScout(normalizedRoot, store, {
              onEvent: broadcastActivity,
              createScoutClient: options.createScoutClient,
            });
            broadcastBoard();
            return json(report);
          } finally {
            scoutRunning = false;
          }
        }

        if (url.pathname === "/api/scout" && request.method === "PATCH") {
          const body = await readJson<{ enabled?: boolean; backend?: string }>(request);
          const updated = updateGlobalConfig({
            scout: {
              ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
              ...(typeof body.backend === "string" && body.backend.trim()
                ? { backend: normalizeBackend(body.backend.trim(), "codex") }
                : {}),
            },
          });
          broadcastActivity(
            store.appendEvent(
              null,
              null,
              "scout",
              "config",
              updated.scout.enabled
                ? `Scout armed: ${updated.scout.backend} proposes ideas for review.`
                : "Scout off.",
            ),
          );
          return json(updated.scout);
        }

        if (url.pathname === "/api/goals/plan" && request.method === "POST") {
          const body = await readJson<{ text?: string }>(request);
          const text = body.text?.trim() ?? "";
          if (!text) {
            return json({ error: "Goal text is required." }, 400);
          }
          const planner = new GoalPlanner(normalizedRoot, {
            createCodexClient: options.createCodexClient,
            onEvent: (event) => {
              const activity = store.appendAgentEvent(event);
              broadcastActivity(activity);
            },
          });
          const plan = await planner.planGoal(text);
          const result = store.createGoalWithTasks(text, plan.tasks, {
            completionContract: plan.completionContract,
            probes: plan.probes,
          });
          broadcastBoard();
          return json(result, 201);
        }

        if (url.pathname === "/api/run" && request.method === "POST") {
          queueMicrotask(() => {
            const worker = new LoopForgeWorker(normalizedRoot, store, {
              onEvent: broadcastActivity,
              createCodexClient: options.createCodexClient,
            });
            worker.runNext().then(broadcastBoard).catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              broadcast("error", { message });
            });
          });
          return json({ ok: true });
        }

        if (url.pathname === "/api/run-queue" && request.method === "POST") {
          // When nothing is dispatchable, say WHY instead of silently idling:
          // the usual culprit is ready tasks gated behind a blocked dependency.
          let note = "";
          if (!store.listDispatchableTasks(1).length) {
            const board = store.getBoard();
            const blockedIds = new Set(
              board.tasks.filter((task) => task.status === "blocked").map((task) => task.id),
            );
            const gated = board.tasks.filter((task) =>
              (task.status === "ready" || task.status === "inbox") &&
              task.dependencyIds.some((id) => blockedIds.has(id))
            );
            note = gated.length
              ? `Nothing can start: ${gated.length} task${
                gated.length === 1 ? " is" : "s are"
              } waiting on ${
                [
                  ...new Set(
                    gated.flatMap((task) => task.dependencyIds.filter((id) => blockedIds.has(id))),
                  ),
                ]
                  .join(", ")
              } (Needs Input). Select it and Reply to unblock the chain.`
              : "Nothing is dispatchable: no ready tasks with satisfied dependencies.";
          }
          startQueue();
          return json({ ok: true, running: queueRunning, note });
        }

        if (url.pathname === "/api/tasks/done" && request.method === "DELETE") {
          const result = store.clearDoneTasks();
          broadcastActivity(result.event);
          return json({ ok: true, count: result.count, board: store.getBoard() });
        }

        const runMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/run$/);
        if (runMatch && request.method === "POST") {
          const taskId = decodeURIComponent(runMatch[1]);
          queueMicrotask(() => {
            const worker = new LoopForgeWorker(normalizedRoot, store, {
              onEvent: broadcastActivity,
              createCodexClient: options.createCodexClient,
            });
            worker.runTask(taskId).then(() => {
              broadcastBoard();
              // A finished task frees an agent slot; keep the board moving
              // while dispatchable work remains instead of idling silently.
              if (store.listDispatchableTasks(1).length) {
                startQueue();
              }
            }).catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              broadcast("error", { message });
            });
          });
          return json({ ok: true, taskId });
        }

        const stopMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/stop$/);
        if (stopMatch && request.method === "POST") {
          const taskId = decodeURIComponent(stopMatch[1]);
          const event = store.requestTaskStop(taskId, "Stop requested from the LoopForge TUI.");
          broadcastActivity(event);
          return json({ ok: true, taskId, event });
        }

        const deleteMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
        if (deleteMatch && request.method === "DELETE") {
          const taskId = decodeURIComponent(deleteMatch[1]);
          const event = store.deleteTask(taskId);
          broadcastActivity(event);
          return json({ ok: true, taskId, board: store.getBoard() });
        }

        const transitionMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/transition$/);
        if (transitionMatch && request.method === "POST") {
          const taskId = decodeURIComponent(transitionMatch[1]);
          const body = await readJson<{ status?: TaskStatus; actor?: string; reason?: string }>(
            request,
          );
          if (!body.status) {
            return json({ error: "status is required" }, 400);
          }
          const result = store.requestTransition(taskId, body.status, body.actor, body.reason);
          broadcastActivity(result.event);
          return json(result);
        }

        const messageMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/messages$/);
        if (messageMatch && request.method === "POST") {
          const taskId = decodeURIComponent(messageMatch[1]);
          const body = await readJson<{ message?: string; role?: string }>(request);
          const message = body.message?.trim() ?? "";
          if (!message) {
            return json({ error: "message is required" }, 400);
          }
          const event = store.enqueueMessage(taskId, body.role?.trim() || "user", message);
          broadcastActivity(event);
          return json({ ok: true, event });
        }

        const steerMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/steer$/);
        if (steerMatch && request.method === "POST") {
          const taskId = decodeURIComponent(steerMatch[1]);
          const body = await readJson<{ message?: string }>(request);
          const message = body.message?.trim() ?? "";
          if (!message) {
            return json({ error: "message is required" }, 400);
          }
          const worker = new LoopForgeWorker(normalizedRoot, store, {
            onEvent: broadcastActivity,
            createCodexClient: options.createCodexClient,
          });
          const event = await worker.steerTask(taskId, message);
          broadcastActivity(event);
          return json({ ok: true, event });
        }

        const cardMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/card$/);
        if (cardMatch && request.method === "POST") {
          const taskId = decodeURIComponent(cardMatch[1]);
          const task = store.getTask(taskId);
          const updated = store.updateTaskCard(task.id, buildTaskCard(task));
          broadcastBoard();
          return json({ task: updated, card: updated.taskCard });
        }

        const threadMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/thread$/);
        if (threadMatch && request.method === "GET") {
          const taskId = decodeURIComponent(threadMatch[1]);
          const worker = new LoopForgeWorker(normalizedRoot, store, {
            onEvent: broadcastActivity,
            createCodexClient: options.createCodexClient,
          });
          const thread = await worker.readTaskThread(taskId);
          return json({ taskId, thread });
        }

        const compactTaskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/compact-thread$/);
        if (compactTaskMatch && request.method === "POST") {
          const taskId = decodeURIComponent(compactTaskMatch[1]);
          const worker = new LoopForgeWorker(normalizedRoot, store, {
            onEvent: broadcastActivity,
            createCodexClient: options.createCodexClient,
          });
          await worker.compactTaskThread(taskId);
          broadcastBoard();
          return json({ ok: true, taskId });
        }

        const mergeMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/merge$/);
        if (mergeMatch && request.method === "POST") {
          const taskId = decodeURIComponent(mergeMatch[1]);
          const task = store.getTask(taskId);
          if (!task.branchName) {
            return json({ error: `${task.id} does not have an assigned branch.` }, 400);
          }
          if (task.status !== "review" && task.status !== "done") {
            return json({ error: `${task.id} must be in Review or Done before merge.` }, 400);
          }
          const output = await gitMergeBranch(normalizedRoot, task.branchName);
          const event = store.appendEvent(
            task.id,
            null,
            "merger",
            "merge",
            output.trim() || `Merged ${task.branchName}.`,
          );
          broadcastActivity(event);
          if (task.status === "review") {
            const result = store.requestTransition(
              task.id,
              "done",
              "merger",
              `Merged ${task.branchName}.`,
            );
            broadcastActivity(result.event);
          }
          return json({ ok: true });
        }

        const reviewMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/review$/);
        if (reviewMatch && request.method === "POST") {
          const taskId = decodeURIComponent(reviewMatch[1]);
          const task = store.getTask(taskId);
          if (task.status !== "review") {
            return json({ error: `${task.id} must be in Review before review.` }, 400);
          }
          queueMicrotask(() => {
            const reviewer = new GoalReviewer(normalizedRoot, {
              createCodexClient: options.createCodexClient,
              onEvent: (event) => {
                const activity = store.appendAgentEvent(event);
                broadcastActivity(activity);
              },
            });
            reviewer.review(task).then((result) => {
              const latest = store.getTask(task.id);
              const reviewText = [
                latest.validation,
                "",
                `LoopForge review: ${result.verdict.toUpperCase()}`,
                result.notes,
              ].filter(Boolean).join("\n");
              store.updateTaskValidation(task.id, reviewText);
              broadcastActivity(
                store.appendEvent(
                  task.id,
                  null,
                  "reviewer",
                  "review",
                  result.verdict === "approved"
                    ? "Review approved. Preparing merge."
                    : "Review requested changes. Waiting for user direction.",
                ),
              );
              if (result.verdict !== "approved") {
                broadcastActivity(
                  store.requestTransition(
                    task.id,
                    "blocked",
                    "reviewer",
                    "Review requested changes. Add a message to continue this task.",
                  ).event,
                );
                return;
              }
              if (!task.branchName) {
                broadcastActivity(
                  store.requestTransition(
                    task.id,
                    "blocked",
                    "merger",
                    "LoopForge cannot merge because this task has no assigned branch.",
                  ).event,
                );
                return;
              }
              broadcastActivity(
                store.requestTransition(
                  task.id,
                  "merging",
                  "merger",
                  "Review approved. Merging branch.",
                ).event,
              );
              return gitMergeBranch(normalizedRoot, task.branchName).then((output) => {
                broadcastActivity(
                  store.appendEvent(
                    task.id,
                    null,
                    "merger",
                    "merge",
                    output.trim() || `Merged ${task.branchName}.`,
                  ),
                );
                broadcastActivity(
                  store.requestTransition(
                    task.id,
                    "done",
                    "merger",
                    `Review approved and merged ${task.branchName}.`,
                  ).event,
                );
              });
            }).catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              try {
                broadcastActivity(
                  store.requestTransition(
                    taskId,
                    "blocked",
                    "reviewer",
                    `LoopForge needs input: ${message}`,
                  ).event,
                );
              } catch {
                // Preserve the original review failure if the task cannot move to Inbox.
              }
              broadcast("error", { message });
            });
          });
          return json({ ok: true });
        }

        return await serveStatic(url.pathname);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json({ error: message }, 500);
      }
    },
  );

  return {
    url: `http://127.0.0.1:${port}`,
    shutdown: () => {
      clearInterval(supervisorTimer);
      abort.abort();
    },
    finished: server.finished.then(() => {
      clearInterval(supervisorTimer);
      store.close();
    }).catch(() => {
      clearInterval(supervisorTimer);
      store.close();
    }),
  };
}

async function serveStatic(pathname: string): Promise<Response> {
  const file = pathname === "/" ? "index.html" : pathname.slice(1);
  const target = path.normalize(staticPath(APP_ROOT, file));
  const staticRoot = path.normalize(staticPath(APP_ROOT));
  if (!target.startsWith(staticRoot)) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const content = await Deno.readFile(target);
    return new Response(content, {
      headers: {
        "content-type": contentType(target),
        "cache-control": "no-store",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

function contentType(target: string): string {
  if (target.endsWith(".html")) return "text/html; charset=utf-8";
  if (target.endsWith(".css")) return "text/css; charset=utf-8";
  if (target.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

async function readJson<T>(request: Request): Promise<T> {
  return await request.json() as T;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
