// Observed mode: translate native Codex events (its own /goal, update_plan, and
// multi_agent tools, running OUTSIDE LoopForge's loop) into the canonical
// lifecycle vocabulary, so a native Codex run still populates the same board
// and dashboard. LoopForge observes here; it does not drive. Reached via the
// installed Codex hook forwarding events to POST /api/lifecycle/ingest.

import { LifecycleEvent, planStepsFromCodexRaw } from "../board/lifecycle.ts";

export interface CodexNativeEvent {
  kind: string;
  message?: string;
  raw?: unknown;
}

export function codexEventToLifecycle(
  goalId: string,
  event: CodexNativeEvent,
): LifecycleEvent | null {
  const kind = event.kind;

  // The model's own update_plan checklist -> canonical plan steps.
  if (/plan/i.test(kind)) {
    const steps = planStepsFromCodexRaw(event.raw);
    if (steps) {
      const done = steps.filter((s) => s.status === "done").length;
      return {
        kind: "plan.updated",
        goalId,
        taskId: null,
        summary: `Plan updated: ${done}/${steps.length} steps done.`,
        data: { steps },
      };
    }
  }

  // Native /goal state changes.
  if (/goal\/(updated|created)/i.test(kind)) {
    const objective = firstString(findKey(event.raw, "objective"), event.message);
    return {
      kind: "goal.planning",
      goalId,
      taskId: null,
      summary: objective || "Native goal updated.",
      data: { objective },
    };
  }
  if (/goal\/(cleared|completed|closed)/i.test(kind)) {
    return {
      kind: "goal.closed",
      goalId,
      taskId: null,
      summary: event.message || "Native goal finished.",
      data: {},
    };
  }

  // multi_agent spawn / completion.
  if (/spawn_agent|multi_agent.*spawn|agent.*spawned/i.test(kind)) {
    const nickname = firstString(findKey(event.raw, "nickname"), findKey(event.raw, "agent_id"));
    return {
      kind: "subagent.spawned",
      goalId,
      taskId: null,
      summary: nickname ? `Spawned sub-agent ${nickname}.` : "Spawned a sub-agent.",
      data: {
        nickname,
        agentId: findKey(event.raw, "agent_id"),
      },
    };
  }
  if (/wait_agent|agent.*(completed|finished|merged)/i.test(kind)) {
    return {
      kind: "subagent.merged",
      goalId,
      taskId: null,
      summary: event.message || "Sub-agent completed.",
      data: {},
    };
  }
  return null;
}

function findKey(value: unknown, key: string, depth = 0): string {
  if (depth > 6 || !value || typeof value !== "object") {
    return "";
  }
  const record = value as Record<string, unknown>;
  if (typeof record[key] === "string") {
    return record[key] as string;
  }
  for (const nested of Object.values(record)) {
    const found = findKey(nested, key, depth + 1);
    if (found) {
      return found;
    }
  }
  return "";
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}
