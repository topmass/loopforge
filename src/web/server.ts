import path from "node:path";
import {
  BoardStore,
  normalizeExternalAgentState,
  readConfig,
  ReasoningEffort,
  updateConfig,
} from "../board/store.ts";
import { ActivityEvent, ActivityEventInput, TaskStatus } from "../board/types.ts";
import { normalizeRoot, parseFolderInput } from "../paths.ts";
import {
  CLAUDE_EFFORT_LEVELS,
  describeBackend,
  normalizeBackend,
  readGlobalConfig,
  updateGlobalConfig,
} from "../board/global_config.ts";
import { listProjects, registerProject, removeProject } from "../board/projects.ts";
import { CodexClient } from "../workers/codex_app_server.ts";
import { piBinaryCommand } from "../workers/pi_rpc_client.ts";
import {
  gitDiffRange,
  gitMergeBranchLeased,
  gitMergeCommitFor,
  runCommand,
} from "../workers/git_utils.ts";
import { GoalPlanner } from "../workers/goal_planner.ts";
import { GoalPursuer } from "../workers/goal_pursuer.ts";
import { runScout } from "../workers/goal_scout.ts";
import { GoalLoopRunner } from "../workers/goal_loop.ts";
import { codexEventToLifecycle } from "../workers/codex_lifecycle_adapter.ts";
import { probeLights, runGoalProbes } from "../workers/goal_probes.ts";
import { GoalReviewer } from "../workers/goal_reviewer.ts";
import { LoopForgeWorker } from "../workers/loopforge_worker.ts";
import { buildProjectMemory } from "../workers/project_memory.ts";
import { buildTaskCard, ensureProjectKnowledgeFiles } from "../workers/task_memory.ts";
import {
  readWorkflow,
  setWorkflowMaxConcurrentAgents,
  setWorkflowUseWorktrees,
} from "../workflow/workflow.ts";

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

// Whether the pi coding agent binary (the "local" backend) is installed, probed
// once at startup and cached. /api/runtime awaits the same promise so the first
// request cannot read the default before the probe resolves.
type PiBinaryProbe = { found: boolean; version: string | null };
const piBinaryPromise: Promise<PiBinaryProbe> = probePiBinary();
async function probePiBinary(): Promise<PiBinaryProbe> {
  try {
    const command = piBinaryCommand();
    const output = await new Deno.Command(command[0], {
      args: [...command.slice(1), "--version"],
      stdout: "piped",
      stderr: "piped",
      // 3s ceiling so a hung binary cannot stall the probe.
      signal: AbortSignal.timeout(3_000),
    }).output();
    if (output.success) {
      // pi prints its version to stderr, not stdout - read both.
      const version = (new TextDecoder().decode(output.stdout).trim() ||
        new TextDecoder().decode(output.stderr).trim()).split("\n")[0];
      return { found: true, version: version || null };
    }
  } catch {
    // Missing binary, spawn failure, or timeout all read as "not installed".
  }
  return { found: false, version: null };
}

// One Deno process can host several projects at once - each open project is its
// own full startServer instance. This process-wide registry lets any instance
// answer "which projects are live here and at what URL" and hand a caller the
// URL of a sibling, spawning it on a free port if needed. Keyed by normalized
// root.
const openServers = new Map<string, { url: string; shutdown: () => void }>();

// Probe for a free port from `start` upward by opening then immediately closing
// a listener. ponytail: linear TOCTOU probe, fine for a localhost tool opening
// a handful of projects; swap for an ephemeral-port handoff if that ever bites.
function findFreePort(start = 4764): number {
  for (let port = start; port < start + 500; port++) {
    try {
      const listener = Deno.listen({ port });
      listener.close();
      return port;
    } catch {
      // Port in use; try the next one.
    }
  }
  throw new Error("No free port available for a child project server.");
}

function dirExists(target: string): boolean {
  try {
    return Deno.statSync(target).isDirectory;
  } catch {
    return false;
  }
}

// The project list shape the GUI consumes: registry entries, each with the live
// URL from openServers (null when not open in this process) and whether it is
// the instance answering the request.
function projectList(currentRoot: string) {
  return listProjects().map((entry) => ({
    root: entry.root,
    name: entry.name,
    url: openServers.get(entry.root)?.url ?? null,
    current: entry.root === currentRoot,
  }));
}

export function startServer(
  root = Deno.cwd(),
  port = 4733,
  options: LoopForgeServerOptions = {},
): LoopForgeServer {
  const normalizedRoot = normalizeRoot(root);
  const store = new BoardStore(normalizedRoot);
  store.initProject();
  store.recoverStaleRuns();
  // Best-effort registry write: a throwaway temp dir in tests must not crash
  // boot, so a failed register (or non-directory root) is swallowed.
  try {
    registerProject(normalizedRoot);
  } catch {
    // Registry is a convenience for the sidebar, not required to serve.
  }
  // Child project servers this instance spawned via /api/projects/open, so it
  // can tear only those down on shutdown (never a sibling it did not create),
  // and await their teardown so no store/listener leaks.
  const spawnedChildren = new Map<string, LoopForgeServer>();
  const clients = new Set<Client>();
  const encoder = new TextEncoder();
  let queueRunning = false;
  let pursueRunning = false;
  let scoutRunning = false;
  // Per-goal loop registry (thread-first step 5): one runner per goal and a
  // bounded total, instead of the old project-wide single-flow boolean. The
  // "planning" phase covers the kickoff window before the runner exists so a
  // duplicate POST cannot slip through while the planner works.
  const activeLoops = new Map<string, { startedAt: number; phase: "planning" | "running" }>();
  const loopCapacity = () => Math.max(1, readWorkflow(normalizedRoot).maxConcurrentAgents);
  const admitLoop = (goalId: string): string | null => {
    if (activeLoops.has(goalId)) {
      return `${goalId} already has a running loop.`;
    }
    if (activeLoops.size >= loopCapacity()) {
      return `Loop capacity reached (${activeLoops.size} running); wait for one to finish or raise agent.max_concurrent_agents in WORKFLOW.md.`;
    }
    return null;
  };

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
  // Every event id this process already sent to SSE clients, so the DB tail
  // below never re-broadcasts them. Pruned each tail tick: once the tail cursor
  // passes an id it can never be tailed again.
  const sentEventIds = new Set<number>();
  const broadcastActivity = (event: ActivityEvent) => {
    sentEventIds.add(event.id);
    broadcast("activity", event);
    broadcastBoard();
  };
  // Other processes (the lf-task CLI, a second LoopForge) append events to the
  // same SQLite DB, but only this process holds the SSE clients. Tail the events
  // table and broadcast whatever this process did not send itself, through the
  // same broadcastActivity path the GUI already parses (lifecycle included).
  // The cursor starts at the current max id so history never replays.
  let tailCursor = Number(
    (store.db.prepare("SELECT MAX(id) AS id FROM events").get() as { id: number | null }).id ?? 0,
  );
  const tailTimer = setInterval(() => {
    try {
      const rows = store.db.prepare(
        "SELECT * FROM events WHERE id > ? ORDER BY id ASC",
      ).all(tailCursor) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const event: ActivityEvent = {
          id: Number(row.id),
          taskId: row.task_id === null ? null : String(row.task_id),
          runId: row.run_id === null ? null : String(row.run_id),
          role: String(row.role),
          kind: String(row.kind),
          message: String(row.message),
          createdAt: String(row.created_at),
          rawJson: row.raw_json === null ? null : String(row.raw_json),
          goalId: row.goal_id === null || row.goal_id === undefined ? null : String(row.goal_id),
        };
        tailCursor = event.id;
        if (!sentEventIds.has(event.id)) {
          broadcastActivity(event);
        }
      }
      for (const id of sentEventIds) {
        if (id <= tailCursor) {
          sentEventIds.delete(id);
        }
      }
    } catch {
      // A tail tick must never take the server down; retry on the next tick.
    }
  }, 1_000);
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

  // Single place to launch a goal loop (start, resume, or steer-resume). Returns
  // false if one is already running.
  const launchGoalLoop = (
    goalId: string,
    opts: {
      hours?: number;
      tokenBudget?: number;
      maxIterations?: number;
      questionMode?: boolean;
    } = {},
    // The kickoff flow admits the goal before planning, so it asks to skip
    // admission rather than re-acquire it.
    alreadyAdmitted = false,
  ): boolean => {
    if (!alreadyAdmitted && admitLoop(goalId) !== null) {
      return false;
    }
    activeLoops.set(goalId, { startedAt: Date.now(), phase: "running" });
    queueMicrotask(() => {
      const runner = new GoalLoopRunner(normalizedRoot, store, {
        ...opts,
        onEvent: broadcastActivity,
        createCodexClient: options.createCodexClient,
      });
      runner.run(goalId).then(() => {
        activeLoops.delete(goalId);
        broadcastBoard();
      }).catch((error) => {
        activeLoops.delete(goalId);
        broadcast("error", { message: error instanceof Error ? error.message : String(error) });
      });
    });
    return true;
  };

  const abort = new AbortController();
  const server = Deno.serve(
    {
      port,
      hostname: "127.0.0.1",
      signal: abort.signal,
      onListen: ({ hostname, port }) => {
        console.log(`LoopForge listening at http://${hostname}:${port}`);
      },
    },
    async (request) => {
      const url = new URL(request.url);

      const json = (payload: unknown, status = 200) => jsonResponse(payload, status, request);

      // Localhost-only command center: the GUI is served from the primary
      // origin but fetches sibling project servers on other local ports.
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(request) });
      }

      try {
        if (url.pathname === "/api/projects" && request.method === "GET") {
          return json({ projects: projectList(normalizedRoot) });
        }

        if (url.pathname === "/api/projects" && request.method === "POST") {
          const body = await readJson<{ root?: string }>(request);
          // parseFolderInput handles pasted quotes, file:// links, ~, and
          // trailing separators, and rejects foreign-platform path shapes.
          try {
            registerProject(parseFolderInput(body.root ?? ""));
          } catch (error) {
            return json({ error: error instanceof Error ? error.message : String(error) }, 400);
          }
          return json({ projects: projectList(normalizedRoot) });
        }

        // Remove a project from the sidebar registry. Registry-only: this never
        // deletes the folder on disk. Any registered root may be removed,
        // including the one this server is viewing - serve re-registers its own
        // root on the next boot, so registry removal is self-healing.
        if (url.pathname === "/api/projects" && request.method === "DELETE") {
          const body = await readJson<{ root?: string }>(request);
          const target = body.root?.trim() ?? "";
          if (!target) {
            return json({ error: "root is required." }, 400);
          }
          removeProject(target);
          return json({ projects: projectList(normalizedRoot) });
        }

        // Hand back the URL of the project's own server, spawning one on a free
        // port (with the same options this instance received, so injected fake
        // codex clients reach child servers in tests) if it is not live yet.
        if (url.pathname === "/api/projects/open" && request.method === "POST") {
          const body = await readJson<{ root?: string }>(request);
          const raw = body.root?.trim() ?? "";
          if (!raw) {
            return json({ error: "root is required." }, 400);
          }
          const target = normalizeRoot(raw);
          const existing = openServers.get(target);
          if (existing) {
            return json({ url: existing.url });
          }
          const known = listProjects().some((entry) => entry.root === target);
          if (!known && !dirExists(target)) {
            return json({ error: `${target} is not a registered project.` }, 400);
          }
          const child = startServer(target, findFreePort(), options);
          spawnedChildren.set(target, child);
          return json({ url: child.url });
        }

        // Server-backed folder picker for adding a project: a browser file input
        // cannot expose an absolute path, so the GUI browses the localhost
        // filesystem through this read-only endpoint. Defaults to $HOME.
        if (url.pathname === "/api/fs/dirs" && request.method === "GET") {
          const raw = url.searchParams.get("path")?.trim();
          // Typed/pasted browse paths get the same tolerant parse as project
          // adds, so ~/code and file:// links work here too.
          let target: string;
          try {
            target = parseFolderInput(
              raw && raw.length
                ? raw
                : (Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "/"),
            );
          } catch (error) {
            return json({ error: error instanceof Error ? error.message : String(error) }, 400);
          }
          let entries: Deno.DirEntry[];
          try {
            entries = [...Deno.readDirSync(target)];
          } catch {
            return json({ error: `${target} is not a directory.` }, 400);
          }
          // Directories only, dot-dirs skipped, sorted by name, capped so a huge
          // folder cannot balloon the response; stat .git only on the survivors.
          const dirs = entries
            .filter((entry) => entry.isDirectory && !entry.name.startsWith("."))
            .map((entry) => entry.name)
            .sort()
            .slice(0, 200)
            .map((name) => {
              const full = path.join(target, name);
              let hasGit = false;
              try {
                Deno.statSync(path.join(full, ".git"));
                hasGit = true;
              } catch {
                // Best-effort: no .git (or unreadable) reads as a non-repo dir.
              }
              return { name, path: full, hasGit };
            });
          const parent = path.dirname(target);
          return json({ path: target, parent: parent === target ? null : parent, dirs });
        }

        // Create a brand-new project folder from the picker. Non-recursive under
        // an existing absolute parent; the name must be a single path segment.
        if (url.pathname === "/api/fs/mkdir" && request.method === "POST") {
          const body = await readJson<{ path?: string; name?: string }>(request);
          const parent = body.path?.trim() ?? "";
          const name = body.name?.trim() ?? "";
          if (!path.isAbsolute(parent) || !dirExists(parent)) {
            return json({ error: `${parent || "(empty)"} is not an existing directory.` }, 400);
          }
          if (
            !name || name === "." || name === ".." || name.includes("/") || name.includes("\\")
          ) {
            return json({ error: `${name || "(empty)"} is not a valid folder name.` }, 400);
          }
          const created = path.join(parent, name);
          try {
            // Non-recursive: throws if the target already exists, which we surface
            // as a 400 rather than silently reusing an existing directory.
            Deno.mkdirSync(created);
          } catch {
            return json({ error: `${created} already exists or could not be created.` }, 400);
          }
          return json({ path: created });
        }

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
                ...corsHeaders(request),
              },
            },
          );
        }

        if (url.pathname === "/api/board" && request.method === "GET") {
          return json(store.getBoard());
        }

        // ---- Front thread (thread-first migration, step 3) ----
        // Ledger-backed reads: deterministic project answers generated fresh
        // from the database and stamped with an event revision, so the future
        // front agent narrates current truth instead of recalling stale state.
        if (url.pathname === "/api/front/status" && request.method === "GET") {
          const board = store.getBoard();
          const probesByGoal = new Map<string, typeof board.probes>();
          for (const probe of board.probes) {
            probesByGoal.set(probe.goalId, [
              ...(probesByGoal.get(probe.goalId) ?? []),
              probe,
            ]);
          }
          const goals = board.goals.map((goal) => {
            const probes = probesByGoal.get(goal.id) ?? [];
            return {
              id: goal.id,
              text: goal.text,
              status: goal.status,
              closureSummary: goal.closureSummary ?? "",
              probes: {
                total: probes.length,
                passed: probes.filter((probe) => probe.lastStatus === "passed").length,
                lights: probeLights(probes),
              },
              loop: {
                running: activeLoops.has(goal.id) && goal.status === "open",
                worktree: goal.loopWorktree ?? null,
                branch: goal.loopBranch ?? null,
              },
            };
          });
          const blockers = board.tasks
            .filter((task) => task.status === "blocked")
            .map((task) => ({
              id: task.id,
              goalId: task.goalId ?? null,
              title: task.title,
              prompt: task.needsInputPrompt ?? "",
            }));
          const receipts = board.goals
            .filter((goal) => goal.status === "closed")
            .slice(-5)
            .map((goal) => ({ id: goal.id, closure: goal.closureSummary ?? "" }));
          return json({
            revision: store.eventRevision(),
            project: { name: path.basename(normalizedRoot) || "project", path: normalizedRoot },
            frontThreadId: store.getFrontThreadId(),
            goals,
            blockers,
            receipts,
            activeWorkers: board.agentStatuses.filter((status) =>
              board.runs.some((run) =>
                run.id === status.runId && run.status === "running"
              )
            ).length,
          });
        }

        if (url.pathname === "/api/front/messages" && request.method === "GET") {
          const after = url.searchParams.get("after");
          const messages = store.listFrontMessages(
            after !== null ? { afterId: Number(after) } : {},
          );
          return json({
            messages,
            frontThreadId: store.getFrontThreadId(),
            revision: store.eventRevision(),
          });
        }

        // Storage only for now: the conversational front runner is a later
        // migration step; persisting the transcript first makes it durable
        // and replayable before any model is wired up.
        if (url.pathname === "/api/front/messages" && request.method === "POST") {
          const body = await readJson<{ text?: string }>(request);
          const text = body.text?.trim() ?? "";
          if (!text) {
            return json({ error: "text is required." }, 400);
          }
          const message = store.appendFrontMessage("user", text);
          return json({ message, revision: store.eventRevision() }, 201);
        }

        // The canonical typed lifecycle feed - the dashboard/Kanban subscribes
        // here for plan steps, subagents, and goal state across all backends.
        if (url.pathname === "/api/lifecycle" && request.method === "GET") {
          const goalId = url.searchParams.get("goalId") ?? undefined;
          return json({ events: store.listLifecycleEvents(goalId) });
        }

        // Observed mode: a native Codex run (its own /goal or multi_agent,
        // forwarded by the installed hook) ingests here, translated into the
        // same lifecycle feed so it populates the board too.
        if (url.pathname === "/api/lifecycle/ingest" && request.method === "POST") {
          const body = await readJson<
            { goalId?: string; kind?: string; message?: string; raw?: unknown }
          >(request);
          const goalId = body.goalId?.trim();
          const kind = body.kind?.trim();
          if (!goalId || !kind) {
            return json({ error: "goalId and kind are required." }, 400);
          }
          const lifecycle = codexEventToLifecycle(goalId, {
            kind,
            message: body.message,
            raw: body.raw,
          });
          if (!lifecycle) {
            return json({ ok: true, ingested: false });
          }
          broadcastActivity(store.appendLifecycleEvent(lifecycle));
          return json({ ok: true, ingested: true, kind: lifecycle.kind });
        }

        if (url.pathname === "/api/config" && request.method === "GET") {
          return json(readConfig(normalizedRoot));
        }

        if (url.pathname === "/api/runtime" && request.method === "GET") {
          const board = store.getBoard();
          const piBinary = await piBinaryPromise;
          return json({
            queueRunning,
            project: { name: path.basename(normalizedRoot) || "project", path: normalizedRoot },
            config: readConfig(normalizedRoot),
            backend: describeBackend(readGlobalConfig()),
            backendRaw: readGlobalConfig().backend,
            claudeModel: readGlobalConfig().claude.model,
            claudeEffort: readGlobalConfig().claude.effort,
            localPiProvider: readGlobalConfig().local.piProvider,
            localPiModel: readGlobalConfig().local.piModel,
            piBinary,
            rescue: readGlobalConfig().rescue,
            planner: readGlobalConfig().planner,
            scout: readGlobalConfig().scout,
            search: readGlobalConfig().search,
            pushBranches: readGlobalConfig().pushBranches,
            maxParallelAgents: readGlobalConfig().maxParallelAgents,
            workflow: readWorkflow(normalizedRoot),
            projectState: board.projectState,
            runningRuns: board.runs.filter((run) => run.status === "running"),
            activeAgentStatuses: board.agentStatuses.filter((status) =>
              board.runs.some((run) => run.id === status.runId && run.status === "running")
            ),
            // Goal-loop fan-out agents report here; show the live ones (not
            // done, seen recently) so the board reflects both execution paths.
            externalAgents: board.externalAgents.filter((agent) =>
              agent.state !== "done" && Date.now() - Date.parse(agent.lastSeenAt) < 120_000
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

        // Toggle the push-sub-agent-branches workflow flag.
        if (url.pathname === "/api/pushbranches" && request.method === "PATCH") {
          const body = await readJson<{ enabled?: boolean }>(request);
          const updated = updateGlobalConfig({ pushBranches: body.enabled === true });
          broadcastActivity(
            store.appendEvent(
              null,
              null,
              "system",
              "config",
              updated.pushBranches
                ? "Sub-agents will push their branches to origin on completion."
                : "Sub-agent branch pushing off (local merge only).",
            ),
          );
          return json({ pushBranches: updated.pushBranches });
        }

        // Set the parallel sub-agent cap (clamped 1-12 in updateGlobalConfig).
        if (url.pathname === "/api/maxagents" && request.method === "PATCH") {
          const body = await readJson<{ value?: number }>(request);
          const updated = updateGlobalConfig({ maxParallelAgents: Number(body.value) });
          broadcastActivity(
            store.appendEvent(
              null,
              null,
              "system",
              "config",
              `Max parallel sub-agents set to ${updated.maxParallelAgents}.`,
            ),
          );
          return json({ maxParallelAgents: updated.maxParallelAgents });
        }

        // Change the main agent backend (the model the loop owner + workers run
        // on): codex / claude / local. Also carries the machine-wide Claude model
        // choice (global config claude.model) and the local backend's advanced pi
        // provider/model override, since those are the same backends surface the
        // settings modal edits. localPi* may be empty strings to clear.
        if (url.pathname === "/api/backend" && request.method === "PATCH") {
          const body = await readJson<
            {
              backend?: string;
              claudeModel?: string;
              claudeEffort?: string;
              localPiProvider?: string;
              localPiModel?: string;
            }
          >(request);
          const hasBackend = typeof body.backend === "string" && body.backend.trim().length > 0;
          const hasClaudeModel = typeof body.claudeModel === "string" &&
            body.claudeModel.trim().length > 0;
          const hasClaudeEffort = typeof body.claudeEffort === "string" &&
            body.claudeEffort.trim().length > 0;
          // Presence, not truthiness: an empty string is a valid "clear" value.
          const hasLocalPiProvider = typeof body.localPiProvider === "string";
          const hasLocalPiModel = typeof body.localPiModel === "string";
          if (
            !hasBackend && !hasClaudeModel && !hasClaudeEffort && !hasLocalPiProvider &&
            !hasLocalPiModel
          ) {
            return json({
              error:
                "backend, claudeModel, claudeEffort, localPiProvider, or localPiModel is required.",
            }, 400);
          }
          if (
            hasClaudeEffort &&
            !CLAUDE_EFFORT_LEVELS.includes(
              body.claudeEffort!.trim() as typeof CLAUDE_EFFORT_LEVELS[number],
            )
          ) {
            return json(
              { error: `claudeEffort must be one of: ${CLAUDE_EFFORT_LEVELS.join(", ")}.` },
              400,
            );
          }
          const updated = updateGlobalConfig({
            ...(hasBackend ? { backend: normalizeBackend(body.backend!.trim(), "codex") } : {}),
            ...(hasClaudeModel || hasClaudeEffort
              ? {
                claude: {
                  ...(hasClaudeModel ? { model: body.claudeModel!.trim() } : {}),
                  ...(hasClaudeEffort ? { effort: body.claudeEffort!.trim() } : {}),
                },
              }
              : {}),
            ...(hasLocalPiProvider || hasLocalPiModel
              ? {
                local: {
                  ...(hasLocalPiProvider ? { piProvider: body.localPiProvider!.trim() } : {}),
                  ...(hasLocalPiModel ? { piModel: body.localPiModel!.trim() } : {}),
                },
              }
              : {}),
          });
          broadcastActivity(
            store.appendEvent(
              null,
              null,
              "system",
              "config",
              hasBackend
                ? `Main backend set to ${updated.backend}.`
                : hasClaudeModel
                ? `Claude model set to ${updated.claude.model}.`
                : hasClaudeEffort
                ? `Claude effort set to ${updated.claude.effort}.`
                : `Local pi override set to ${updated.local.piProvider || "(off)"}.`,
            ),
          );
          return json({
            backend: describeBackend(updated),
            raw: updated.backend,
            claudeModel: updated.claude.model,
            claudeEffort: updated.claude.effort,
            localPiProvider: updated.local.piProvider,
            localPiModel: updated.local.piModel,
          });
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

        if (url.pathname === "/api/workflow/workspace" && request.method === "PATCH") {
          const body = await readJson<{ useWorktrees?: boolean }>(request);
          if (typeof body.useWorktrees !== "boolean") {
            return json({ error: "useWorktrees must be a boolean." }, 400);
          }
          const workflow = setWorkflowUseWorktrees(normalizedRoot, body.useWorktrees);
          broadcastActivity(
            store.appendEvent(
              null,
              null,
              "core",
              "config",
              workflow.useWorktrees
                ? "Isolated worktrees enabled."
                : "Isolated worktrees disabled - goal loops run in the project root.",
            ),
          );
          return json({ useWorktrees: workflow.useWorktrees });
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
          // This goal's own loop re-checks probes every turn; a concurrent
          // manual run of the SAME goal is redundant and can collide. Other
          // goals' checks are fine - the probe lease serializes actual runs.
          if (activeLoops.has(goalId)) {
            return json({
              error: `${goalId}'s loop is running; it re-checks win conditions every turn.`,
            }, 409);
          }
          // Probes must run where the work actually is: an unmerged loop's
          // worktree when one exists, the project root otherwise. Running a
          // blocked goal's probes in the root would show false reds.
          let cwd = normalizedRoot;
          const loopWorktree = store.getGoal(goalId).loopWorktree;
          if (loopWorktree && dirExists(loopWorktree)) {
            cwd = loopWorktree;
          }
          const summary = await runGoalProbes(normalizedRoot, store, goalId, cwd);
          broadcastBoard();
          return json({
            goalId,
            total: summary.total,
            passed: summary.passed,
            probes: store.listProbes(goalId),
          });
        }

        // Probe editing: the planner writes win conditions, but a broken probe
        // (bad quoting is the classic) must be repairable from the GUI without
        // touching the database by hand.
        const probesAddMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/probes$/);
        if (probesAddMatch && request.method === "POST") {
          const goalId = decodeURIComponent(probesAddMatch[1]);
          const body = await readJson<{ label?: string; command?: string }>(request);
          const label = body.label?.trim() ?? "";
          const command = body.command?.trim() ?? "";
          if (!label || !command) {
            return json({ error: "label and command are required." }, 400);
          }
          try {
            store.getGoal(goalId);
          } catch {
            return json({ error: `${goalId} not found.` }, 404);
          }
          store.addProbes(goalId, [{ label, command }]);
          broadcastActivity(
            store.appendEvent(null, null, "core", "probes", `${goalId}: probe added: ${label}`),
          );
          broadcastBoard();
          return json({ probes: store.listProbes(goalId) }, 201);
        }

        const probeMatch = url.pathname.match(/^\/api\/probes\/(\d+)$/);
        if (probeMatch && request.method === "PATCH") {
          const probeId = Number(probeMatch[1]);
          const body = await readJson<
            { label?: string; command?: string; expectContains?: string | null }
          >(request);
          try {
            const probe = store.updateProbe(probeId, body);
            broadcastActivity(
              store.appendEvent(
                null,
                null,
                "core",
                "probes",
                `${probe.goalId}: probe edited: ${probe.label}`,
              ),
            );
            broadcastBoard();
            return json({ probe });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return json({ error: message }, message.includes("not found") ? 404 : 400);
          }
        }
        if (probeMatch && request.method === "DELETE") {
          const probeId = Number(probeMatch[1]);
          const existing = store.getProbe(probeId);
          if (!existing) {
            return json({ error: `Probe ${probeId} not found.` }, 404);
          }
          store.deleteProbe(probeId);
          broadcastActivity(
            store.appendEvent(
              null,
              null,
              "core",
              "probes",
              `${existing.goalId}: probe deleted: ${existing.label}`,
            ),
          );
          broadcastBoard();
          return json({ ok: true });
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

        // The loop's conversation for a goal, turn-grouped, for the Thread view.
        const threadGoalMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/thread$/);
        if (threadGoalMatch && request.method === "GET") {
          const goalId = decodeURIComponent(threadGoalMatch[1]).toUpperCase();
          try {
            store.getGoal(goalId);
          } catch {
            return json({ error: `${goalId} was not found.` }, 404);
          }
          return json({ goalId, ...store.getGoalThread(goalId) });
        }

        // The per-loop diff for the Diff panel. An open goal with a live branch
        // diffs the branch against the root's current branch (three-dot); a
        // closed goal diffs the merge commit that landed its (reclaimed) branch.
        const diffGoalMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/diff$/);
        if (diffGoalMatch && request.method === "GET") {
          const goalId = decodeURIComponent(diffGoalMatch[1]).toUpperCase();
          let goal;
          try {
            goal = store.getGoal(goalId);
          } catch {
            return json({ error: `${goalId} was not found.` }, 404);
          }
          // LoopForge merges into whatever the root has checked out, so resolve
          // the base as that branch rather than assuming "main".
          const base =
            (await runCommand(normalizedRoot, ["git", "rev-parse", "--abbrev-ref", "HEAD"]))
              .trim();
          const branchLive = goal.loopBranch
            ? await runCommand(normalizedRoot, ["git", "rev-parse", "--verify", goal.loopBranch])
              .then(() => true).catch(() => false)
            : false;
          if (goal.status === "open" && goal.loopBranch && branchLive) {
            const result = await gitDiffRange(normalizedRoot, base, goal.loopBranch);
            return json({ goalId, files: result.files, truncated: result.truncated });
          }
          // Closed (or branch reclaimed): find the merge commit. loopBranch may be
          // null after reclaim, so reconstruct the branch name from the goal id.
          const branchName = goal.loopBranch ?? `loopforge/${goalId.toLowerCase()}`;
          const hash = await gitMergeCommitFor(normalizedRoot, branchName);
          if (!hash) {
            return json({ goalId, files: [], truncated: false, note: "no merged changes found" });
          }
          const result = await gitDiffRange(normalizedRoot, `${hash}^1`, hash, { threeDot: false });
          return json({ goalId, files: result.files, truncated: result.truncated });
        }

        const deleteGoalMatch = url.pathname.match(/^\/api\/goals\/([^/]+)$/);
        if (deleteGoalMatch && request.method === "DELETE") {
          const goalId = decodeURIComponent(deleteGoalMatch[1]).toUpperCase();
          const event = store.deleteGoal(goalId);
          broadcastActivity(event);
          broadcastBoard();
          return json({ ok: true, goalId });
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
          if (activeLoops.size >= loopCapacity()) {
            return json({
              error:
                `Loop capacity reached (${activeLoops.size} running); wait for one to finish or raise agent.max_concurrent_agents in WORKFLOW.md.`,
            }, 409);
          }
          const body = await readJson<
            {
              text?: string;
              hours?: number;
              tokens?: number;
              iterations?: number;
              questionMode?: boolean;
            }
          >(request);
          const text = body.text?.trim() ?? "";
          if (!text) {
            return json({ error: "Goal text is required." }, 400);
          }
          // Re-check capacity after the awaited body read - two POSTs can
          // interleave past the entry check. The goal is registered as
          // "planning" right after creation below, holding its slot across the
          // minutes-long planning turn.
          if (activeLoops.size >= loopCapacity()) {
            return json({
              error:
                `Loop capacity reached (${activeLoops.size} running); wait for one to finish or raise agent.max_concurrent_agents in WORKFLOW.md.`,
            }, 409);
          }
          const opts = {
            hours: typeof body.hours === "number" && body.hours > 0 ? body.hours : undefined,
            tokenBudget: typeof body.tokens === "number" && body.tokens > 0
              ? body.tokens
              : undefined,
            maxIterations: typeof body.iterations === "number" && body.iterations > 0
              ? Math.floor(body.iterations)
              : undefined,
            questionMode: body.questionMode === true,
          };
          // Create the goal first so the board shows it instantly, then plan and
          // start the loop after responding - the planning turn no longer blocks
          // the request.
          const goal = store.createBareGoal(text);
          activeLoops.set(goal.id, { startedAt: Date.now(), phase: "planning" });
          broadcastActivity(store.appendLifecycleEvent({
            kind: "goal.planning",
            goalId: goal.id,
            taskId: null,
            summary: "Planning the goal into tasks and win conditions...",
            data: {},
          }));
          queueMicrotask(async () => {
            const planner = new GoalPlanner(normalizedRoot, {
              projectMemory: buildProjectMemory(store),
              createCodexClient: options.createCodexClient,
              onEvent: (event) => {
                const activity = store.appendAgentEvent(event);
                broadcastActivity(activity);
              },
            });
            try {
              const plan = await planner.planGoal(text);
              store.attachPlanToGoal(goal.id, plan.tasks, {
                completionContract: plan.completionContract,
                probes: plan.probes,
              });
              broadcastBoard();
              launchGoalLoop(goal.id, opts, true);
            } catch (error) {
              activeLoops.delete(goal.id);
              const message = error instanceof Error ? error.message : String(error);
              broadcastActivity(store.appendLifecycleEvent({
                kind: "goal.blocked",
                goalId: goal.id,
                taskId: null,
                summary: `Planning failed: ${message}`,
                data: { error: message },
              }));
            }
          });
          return json({ ok: true, goalId: goal.id, planning: true }, 201);
        }

        // Add a task to a goal = steer it. The loop owner folds the task into
        // its plan on the next turn (running now, or when it next runs). One
        // gesture whether the loop is live or idle.
        const taskMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/task$/);
        if (taskMatch && request.method === "POST") {
          const goalId = decodeURIComponent(taskMatch[1]).toUpperCase();
          store.getGoal(goalId);
          const body = await readJson<{ text?: string }>(request);
          const text = body.text?.trim() ?? "";
          if (!text) {
            return json({ error: "Task text is required." }, 400);
          }
          store.enqueueGoalMessage(goalId, "user", text);
          broadcastActivity(store.appendLifecycleEvent({
            kind: "task.added",
            goalId,
            taskId: null,
            summary: text,
            data: { text },
          }));
          // If no loop is running (e.g. it stopped after asking questions, or a
          // prior run ended), adding a task resumes the loop so the answer/steer
          // is acted on. A live loop just picks it up on its next turn.
          const resumed = launchGoalLoop(goalId);
          broadcastBoard();
          return json({ ok: true, goalId, resumed });
        }

        // Edit a goal's objective; the loop injects an objective-updated steer.
        const objectiveMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/objective$/);
        if (objectiveMatch && request.method === "POST") {
          const goalId = decodeURIComponent(objectiveMatch[1]).toUpperCase();
          const body = await readJson<{ text?: string }>(request);
          const text = body.text?.trim() ?? "";
          if (!text) {
            return json({ error: "Objective text is required." }, 400);
          }
          const goal = store.setGoalText(goalId, text);
          broadcastBoard();
          return json({ ok: true, goal });
        }

        const loopMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/loop$/);
        if (loopMatch && request.method === "POST") {
          const goalId = decodeURIComponent(loopMatch[1]).toUpperCase();
          store.getGoal(goalId);
          const denied = admitLoop(goalId);
          if (denied) {
            return json({ error: denied }, 409);
          }
          const body = await readJson<
            { hours?: number; tokens?: number; iterations?: number; questionMode?: boolean }
          >(request);
          // launchGoalLoop re-checks admission synchronously: two POSTs that
          // interleaved across the awaited body read cannot both start.
          const launched = launchGoalLoop(goalId, {
            hours: typeof body.hours === "number" && body.hours > 0 ? body.hours : undefined,
            tokenBudget: typeof body.tokens === "number" && body.tokens > 0
              ? body.tokens
              : undefined,
            maxIterations: typeof body.iterations === "number" && body.iterations > 0
              ? Math.floor(body.iterations)
              : undefined,
            questionMode: body.questionMode === true,
          });
          if (!launched) {
            return json({ error: admitLoop(goalId) ?? "Loop admission failed." }, 409);
          }
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
          const event = store.requestTaskStop(taskId, "Stop requested from the LoopForge GUI.");
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
          const output = await gitMergeBranchLeased(store, normalizedRoot, task.branchName);
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
              return gitMergeBranchLeased(store, normalizedRoot, task.branchName).then((output) => {
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

        // The React GUI (app/dist) is served under /app; an SPA so unknown
        // /app/* routes fall back to its index.html.
        if (url.pathname === "/app" || url.pathname.startsWith("/app/")) {
          return await serveApp(url.pathname);
        }

        // The legacy server-rendered GUI is gone; the React app is the GUI.
        if (url.pathname === "/") {
          return new Response(null, { status: 302, headers: { location: "/app/" } });
        }
        return new Response("Not found", { status: 404 });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json({ error: message }, 500);
      }
    },
  );

  const instance: LoopForgeServer = {
    url: `http://127.0.0.1:${port}`,
    shutdown: () => {
      clearInterval(supervisorTimer);
      clearInterval(tailTimer);
      openServers.delete(normalizedRoot);
      // Tear down only the children this instance spawned, so shutting one hub
      // down does not kill a sibling opened by another instance.
      for (const child of spawnedChildren.values()) {
        child.shutdown();
      }
      abort.abort();
    },
    finished: server.finished.then(closeSelf).catch(closeSelf),
  };
  // Awaiting this instance's finished also awaits the children it spawned, so a
  // clean shutdown leaves no open stores or listeners.
  async function closeSelf() {
    clearInterval(supervisorTimer);
    clearInterval(tailTimer);
    openServers.delete(normalizedRoot);
    store.close();
    await Promise.all(
      [...spawnedChildren.values()].map((child) => child.finished.catch(() => {})),
    );
  }
  openServers.set(normalizedRoot, { url: instance.url, shutdown: instance.shutdown });
  return instance;
}

// Serve the built React GUI from app/dist under /app, SPA-style.
async function serveApp(pathname: string): Promise<Response> {
  const appRoot = path.normalize(path.join(APP_ROOT, "app", "dist"));
  const rel = pathname === "/app" || pathname === "/app/"
    ? "index.html"
    : pathname.slice("/app/".length);
  const target = path.normalize(path.join(appRoot, rel));
  if (!target.startsWith(appRoot)) {
    return new Response("Not found", { status: 404 });
  }
  try {
    const content = await Deno.readFile(target);
    return new Response(content, {
      headers: { "content-type": contentType(target), "cache-control": "no-store" },
    });
  } catch {
    // SPA fallback: serve index.html for client-side routes / missing assets.
    try {
      const content = await Deno.readFile(path.join(appRoot, "index.html"));
      return new Response(content, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    } catch {
      return new Response(
        "LoopForge GUI is not built. Run: cd app && pnpm install && pnpm build",
        { status: 503 },
      );
    }
  }
}

function contentType(target: string): string {
  if (target.endsWith(".html")) return "text/html; charset=utf-8";
  if (target.endsWith(".css")) return "text/css; charset=utf-8";
  if (target.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (target.endsWith(".svg")) return "image/svg+xml";
  if (target.endsWith(".json")) return "application/json; charset=utf-8";
  if (target.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

async function readJson<T>(request: Request): Promise<T> {
  return await request.json() as T;
}

function jsonResponse(payload: unknown, status: number, request: Request): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders(request) },
  });
}

// Reflect only local browser origins so the primary GUI can fetch sibling
// project servers without letting arbitrary websites drive this local tool.
function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin") ?? "";
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
    return {};
  }
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "Content-Type",
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "vary": "Origin",
  };
}
