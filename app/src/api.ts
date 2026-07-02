// REST + SSE client for the LoopForge server. The GUI is a pure client of the
// API built in phases 1-5; nothing here is LoopForge-specific logic, just
// transport.

import type {
  ActivityEvent,
  BoardSnapshot,
  DirEntry,
  GoalThread,
  LifecycleEvent,
  ProjectEntry,
  Runtime,
} from "./types";
import { useStore } from "./store";

const LIFECYCLE_ROLE = "lifecycle";

// The origin the client talks to lives in the store (apiBase): "" = the primary
// origin that served the page, a child project's absolute origin when switched.
// setApiBase writes it (the Tauri shell still calls this to point at its spawned
// server); an App effect keyed on the store value reconnects the SSE stream.
export function setApiBase(base: string): void {
  useStore.getState().setApiBase(base.replace(/\/$/, ""));
}
export function apiUrl(path: string): string {
  return `${useStore.getState().apiBase}${path}`;
}

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${path} -> ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

// The project registry is owned by the server that served the page (the primary
// origin), so these always fetch relative to it - never the switched apiBase.
async function primaryFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${path} -> ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  board: () => jsonFetch<BoardSnapshot>("/api/board"),
  runtime: () => jsonFetch<Runtime>("/api/runtime"),
  // Projects: registry read/add and "open" (get the project server's URL,
  // spawning it if needed). All three hit the primary origin.
  listProjects: () => primaryFetch<{ projects: ProjectEntry[] }>("/api/projects"),
  addProject: (root: string) =>
    primaryFetch<{ projects: ProjectEntry[] }>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ root }),
    }),
  openProject: (root: string) =>
    primaryFetch<{ url: string }>("/api/projects/open", {
      method: "POST",
      body: JSON.stringify({ root }),
    }),
  // Server-backed folder picker: browsers cannot hand back an absolute path, so
  // the add-project picker lists directories from the server (localhost tool).
  // Hits the primary origin like the rest of the project-registry flow.
  listDirs: (path?: string) =>
    primaryFetch<{ path: string; parent: string | null; dirs: DirEntry[] }>(
      `/api/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    ),
  lifecycle: (goalId?: string) =>
    jsonFetch<{ events: LifecycleEvent[] }>(
      `/api/lifecycle${goalId ? `?goalId=${encodeURIComponent(goalId)}` : ""}`,
    ),
  // A goal's loop conversation grouped into turns, for the Thread view.
  getGoalThread: (goalId: string) =>
    jsonFetch<GoalThread>(`/api/goals/${encodeURIComponent(goalId)}/thread`),
  // Start a fresh goal-loop from plain text (no active goal yet). The goal is
  // created immediately (planning: true) and the plan streams in afterwards.
  startGoalLoop: (text: string, opts?: { hours?: number; questionMode?: boolean }) =>
    jsonFetch<{ goalId: string; planning: boolean }>("/api/goals/loop", {
      method: "POST",
      body: JSON.stringify({ text, ...opts }),
    }),
  // Add a task to a goal = steer it.
  addTask: (goalId: string, text: string) =>
    jsonFetch<{ ok: boolean }>(`/api/goals/${encodeURIComponent(goalId)}/task`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  editObjective: (goalId: string, text: string) =>
    jsonFetch<{ ok: boolean }>(`/api/goals/${encodeURIComponent(goalId)}/objective`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  loopExistingGoal: (goalId: string, opts?: { hours?: number }) =>
    jsonFetch<{ ok: boolean }>(`/api/goals/${encodeURIComponent(goalId)}/loop`, {
      method: "POST",
      body: JSON.stringify({ ...opts }),
    }),
  // Restart a task - used to confirm a manual-verification hold (restart =
  // verified-by-hand, the worker resumes straight to merge).
  runTask: (taskId: string) =>
    jsonFetch<{ ok: boolean }>(`/api/tasks/${encodeURIComponent(taskId)}/run`, {
      method: "POST",
    }),
  deleteGoal: (goalId: string) =>
    jsonFetch<{ ok: boolean }>(`/api/goals/${encodeURIComponent(goalId)}`, {
      method: "DELETE",
    }),
  // Settings: the model routing the TUI exposed (main backend + rescue/planner/scout).
  setBackend: (backend: string) =>
    jsonFetch<{ backend: string }>("/api/backend", {
      method: "PATCH",
      body: JSON.stringify({ backend }),
    }),
  setRescue: (patch: { enabled?: boolean; backend?: string; afterAttempts?: number }) =>
    jsonFetch<unknown>("/api/rescue", { method: "PATCH", body: JSON.stringify(patch) }),
  setPlanner: (patch: { enabled?: boolean; backend?: string }) =>
    jsonFetch<unknown>("/api/planner", { method: "PATCH", body: JSON.stringify(patch) }),
  setScout: (patch: { enabled?: boolean; backend?: string }) =>
    jsonFetch<unknown>("/api/scout", { method: "PATCH", body: JSON.stringify(patch) }),
  setPushBranches: (enabled: boolean) =>
    jsonFetch<unknown>("/api/pushbranches", { method: "PATCH", body: JSON.stringify({ enabled }) }),
  setMaxAgents: (value: number) =>
    jsonFetch<{ maxParallelAgents: number }>("/api/maxagents", {
      method: "PATCH",
      body: JSON.stringify({ value }),
    }),
  // Per-project codex power knobs: model, reasoning effort, fast mode. The
  // runtime line picks the new values up on the modal's refresh.
  setConfig: (patch: { model?: string; reasoningEffort?: string; fastMode?: boolean }) =>
    jsonFetch<{ model: string; reasoningEffort: string; fastMode: boolean }>("/api/config", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  // Machine-wide Claude model, patched through the same backends endpoint.
  setClaudeModel: (model: string) =>
    jsonFetch<{ claudeModel: string }>("/api/backend", {
      method: "PATCH",
      body: JSON.stringify({ claudeModel: model }),
    }),
  // Machine-wide Claude Code effort level (claude --effort), same backends endpoint.
  setClaudeEffort: (effort: string) =>
    jsonFetch<{ claudeEffort: string }>("/api/backend", {
      method: "PATCH",
      body: JSON.stringify({ claudeEffort: effort }),
    }),
  // Create a new folder inside `path` (the picker's current dir); returns the
  // created absolute path so the picker can navigate straight into it.
  makeDir: (path: string, name: string) =>
    primaryFetch<{ path: string }>("/api/fs/mkdir", {
      method: "POST",
      body: JSON.stringify({ path, name }),
    }),
  // Remove a project from the registry (registry-only; never touches disk).
  removeProject: (root: string) =>
    primaryFetch<{ projects: ProjectEntry[] }>("/api/projects", {
      method: "DELETE",
      body: JSON.stringify({ root }),
    }),
};

// Reconstruct a typed LifecycleEvent from a stored ActivityEvent (role=lifecycle,
// canonical kind, payload {goalId, data} in rawJson). The board snapshot strips
// rawJson, so the SSE "activity" events (which keep it) are the source.
export function parseLifecycle(event: ActivityEvent & { rawJson?: string | null }): LifecycleEvent | null {
  if (event.role !== LIFECYCLE_ROLE) {
    return null;
  }
  let goalId: string | null = null;
  let data: Record<string, unknown> = {};
  const raw = (event as { rawJson?: string | null }).rawJson;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { goalId?: string; taskRef?: string; data?: Record<string, unknown> };
      goalId = typeof parsed.goalId === "string" ? parsed.goalId : null;
      if (typeof parsed.taskRef === "string") {
        event = { ...event, taskId: parsed.taskRef };
      }
      data = parsed.data ?? {};
    } catch {
      // keep summary-only
    }
  }
  return {
    kind: event.kind as LifecycleEvent["kind"],
    goalId,
    taskId: event.taskId,
    summary: event.message,
    data,
  };
}

// Only one live SSE connection at a time: a new subscribe (initial connect or a
// project switch) closes the previous stream first, so reconnecting can never
// leave two open against different origins.
let activeSource: EventSource | null = null;

// Subscribe to the server-sent event stream. Returns a cleanup function.
export function subscribe(handlers: {
  onBoard: (b: BoardSnapshot) => void;
  onActivity: (e: ActivityEvent & { rawJson?: string | null }) => void;
  onOpen: () => void;
  onError: () => void;
}): () => void {
  activeSource?.close();
  const source = new EventSource(apiUrl("/api/events"));
  activeSource = source;
  source.addEventListener("open", handlers.onOpen);
  source.addEventListener("error", handlers.onError);
  source.addEventListener("board", (e) => {
    try {
      handlers.onBoard(JSON.parse((e as MessageEvent).data));
    } catch {
      // ignore malformed frames
    }
  });
  source.addEventListener("activity", (e) => {
    try {
      handlers.onActivity(JSON.parse((e as MessageEvent).data));
    } catch {
      // ignore
    }
  });
  return () => {
    source.close();
    if (activeSource === source) {
      activeSource = null;
    }
  };
}
