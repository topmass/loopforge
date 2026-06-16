// The canonical orchestration event vocabulary - LoopForge's backend-independent
// observability contract. Every engine (the goal loop, the relay worker, the
// fan-out pool, and adapters that ingest native Codex/Claude runs) emits these
// same typed events, so one model feeds the TUI today and a web Kanban later.
//
// Lifecycle events ride the existing ActivityEvent stream: role is always
// LIFECYCLE_ROLE, kind is the canonical LifecycleKind, message is the human
// one-liner, and the structured payload travels in raw/rawJson. This is additive
// - free-text activity events keep working untouched; subscribers that want the
// typed feed filter to LIFECYCLE_ROLE and read the payload.

import { ActivityEvent } from "./types.ts";

export const LIFECYCLE_ROLE = "lifecycle";

export type LifecycleKind =
  | "goal.created"
  | "goal.planning"
  | "goal.blocked"
  | "goal.closed"
  | "plan.updated"
  | "step.started"
  | "step.completed"
  | "task.added"
  | "subagent.spawned"
  | "subagent.progress"
  | "subagent.merged"
  | "verified";

export type PlanStepStatus = "todo" | "doing" | "done";

export interface PlanStep {
  title: string;
  status: PlanStepStatus;
  note: string;
}

export interface LifecycleEvent {
  kind: LifecycleKind;
  goalId: string | null;
  taskId: string | null;
  summary: string;
  data: Record<string, unknown>;
}

interface LifecyclePayload {
  goalId: string | null;
  taskRef: string | null;
  data: Record<string, unknown>;
}

// Convert a lifecycle event into the (role, kind, message, raw) shape that
// store.appendEvent already persists and broadcasts. goalId rides in the
// payload because the events table only has a single task_id column.
export function lifecycleToActivity(event: LifecycleEvent): {
  taskId: string | null;
  runId: string | null;
  role: string;
  kind: string;
  message: string;
  raw: LifecyclePayload;
} {
  return {
    // Lifecycle taskId references plan steps / sub-agents that are not rows in
    // the tasks table, so it must NOT go in the FK'd events.task_id column - it
    // rides in the payload instead. The column stays null.
    taskId: null,
    runId: null,
    role: LIFECYCLE_ROLE,
    kind: event.kind,
    message: event.summary,
    raw: { goalId: event.goalId, taskRef: event.taskId, data: event.data },
  };
}

export function isLifecycleEvent(event: ActivityEvent): boolean {
  return event.role === LIFECYCLE_ROLE;
}

// Read a stored ActivityEvent back as a typed LifecycleEvent (or null if it is
// not one). Subscribers use this to reconstruct the typed feed from the stream.
export function parseLifecycleEvent(event: ActivityEvent): LifecycleEvent | null {
  if (!isLifecycleEvent(event)) {
    return null;
  }
  let goalId: string | null = null;
  let taskRef: string | null = null;
  let data: Record<string, unknown> = {};
  if (event.rawJson) {
    try {
      const parsed = JSON.parse(event.rawJson) as Partial<LifecyclePayload>;
      goalId = typeof parsed.goalId === "string" ? parsed.goalId : null;
      taskRef = typeof parsed.taskRef === "string" ? parsed.taskRef : null;
      data = parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)
        ? parsed.data as Record<string, unknown>
        : {};
    } catch {
      // A malformed payload still yields a typed event with the summary.
    }
  }
  return {
    kind: event.kind as LifecycleKind,
    goalId,
    taskId: taskRef ?? event.taskId,
    summary: event.message,
    data,
  };
}

export function planUpdated(
  goalId: string,
  steps: PlanStep[],
): LifecycleEvent {
  const done = steps.filter((step) => step.status === "done").length;
  return {
    kind: "plan.updated",
    goalId,
    taskId: null,
    summary: `Plan updated: ${done}/${steps.length} steps done.`,
    data: { steps },
  };
}

// Best-effort extraction of an update_plan / turn-plan payload from a Codex
// raw event into canonical PlanSteps. Codex sends a plan array of
// { step|content, status } items; statuses map onto todo/doing/done.
export function planStepsFromCodexRaw(raw: unknown): PlanStep[] | null {
  const planArray = findPlanArray(raw);
  if (!planArray) {
    return null;
  }
  const steps: PlanStep[] = [];
  for (const item of planArray) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const title = firstString(record.step, record.content, record.title, record.text);
    if (!title) {
      continue;
    }
    steps.push({ title, status: normalizeCodexStatus(record.status), note: "" });
  }
  return steps.length ? steps : null;
}

function findPlanArray(value: unknown, depth = 0): unknown[] | null {
  if (depth > 6 || !value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.plan)) {
    return record.plan as unknown[];
  }
  for (const key of ["params", "turn", "item", "update", "arguments", "input"]) {
    const nested = findPlanArray(record[key], depth + 1);
    if (nested) {
      return nested;
    }
  }
  return null;
}

function normalizeCodexStatus(status: unknown): PlanStepStatus {
  const text = typeof status === "string" ? status.toLowerCase() : "";
  if (text === "completed" || text === "done") {
    return "done";
  }
  if (text === "in_progress" || text === "in-progress" || text === "doing") {
    return "doing";
  }
  return "todo";
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}
