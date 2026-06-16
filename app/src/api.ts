// REST + SSE client for the LoopForge server. The GUI is a pure client of the
// API built in phases 1-5; nothing here is LoopForge-specific logic, just
// transport.

import type { ActivityEvent, BoardSnapshot, LifecycleEvent, Runtime } from "./types";

const LIFECYCLE_ROLE = "lifecycle";

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
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
  lifecycle: (goalId?: string) =>
    jsonFetch<{ events: LifecycleEvent[] }>(
      `/api/lifecycle${goalId ? `?goalId=${encodeURIComponent(goalId)}` : ""}`,
    ),
  // Start a fresh goal-loop from plain text (no active goal yet).
  startGoalLoop: (text: string, opts?: { hours?: number }) =>
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
  const source = new EventSource("/api/events");
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
