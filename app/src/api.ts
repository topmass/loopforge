// REST + SSE client for the LoopForge server. The GUI is a pure client of the
// API built in phases 1-5; nothing here is LoopForge-specific logic, just
// transport.

import type { ActivityEvent, BoardSnapshot, LifecycleEvent, Runtime } from "./types";

const LIFECYCLE_ROLE = "lifecycle";

// In the browser the GUI is served by the LoopForge server, so API paths are
// relative. In the Tauri native window there is no origin server, so the Rust
// shell spawns one and we point at it on localhost. setApiBase wires that.
let API_BASE = "";
export function setApiBase(base: string): void {
  API_BASE = base.replace(/\/$/, "");
}
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
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

export const api = {
  board: () => jsonFetch<BoardSnapshot>("/api/board"),
  runtime: () => jsonFetch<Runtime>("/api/runtime"),
  lifecycle: (goalId?: string) =>
    jsonFetch<{ events: LifecycleEvent[] }>(
      `/api/lifecycle${goalId ? `?goalId=${encodeURIComponent(goalId)}` : ""}`,
    ),
  // Start a fresh goal-loop from plain text (no active goal yet).
  startGoalLoop: (text: string, opts?: { hours?: number; questionMode?: boolean }) =>
    jsonFetch<{ goalId: string }>("/api/goals/loop", {
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

// Subscribe to the server-sent event stream. Returns a cleanup function.
export function subscribe(handlers: {
  onBoard: (b: BoardSnapshot) => void;
  onActivity: (e: ActivityEvent & { rawJson?: string | null }) => void;
  onOpen: () => void;
  onError: () => void;
}): () => void {
  const source = new EventSource(apiUrl("/api/events"));
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
  return () => source.close();
}
