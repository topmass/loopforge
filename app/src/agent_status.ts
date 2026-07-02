// View helpers for the live "Active workers" strip. Both execution paths land
// here: dispatcher tasks (board AgentStatus, keyed by taskId) and goal-loop
// fan-out agents (ExternalAgentStatus, no taskId). They're normalized into one
// chip shape so the board shows all live work regardless of which engine ran.
import type { AgentRisk, AgentStatus, ExternalAgentStatus } from "./types";
import { STATUS } from "./components/ui";

type Tone = { label: string; className: string };

// Risk badges reuse the shared STATUS vocabulary so a worker's "blocked"/"needs
// you"/"stale" reads identically to the same state on the board and sidebar.
// test_failed is the one danger tone STATUS has no key for, so it stays local.
const RISK_TONES: Record<Exclude<AgentRisk, "none">, Tone> = {
  test_failed: { label: "tests failed", className: "border-danger bg-danger-soft text-danger-ink" },
  conflict: { label: "conflict", className: STATUS.blocked.pill },
  needs_user: { label: "needs you", className: STATUS.live.pill },
  stale: { label: "stale", className: STATUS.idle.pill },
  session: { label: "session", className: STATUS.idle.pill },
};

const BLOCKED_TONE: Tone = {
  label: "blocked",
  className: STATUS.blocked.pill,
};

// A risk badge for a dispatcher task, or null when there's nothing to flag.
export function riskTone(risk: AgentRisk): Tone | null {
  return risk === "none" ? null : RISK_TONES[risk];
}

export interface WorkerChip {
  key: string;
  label: string;
  detail: string;
  tone: Tone | null;
  // Dispatcher tasks are board tasks and select-able; fan-out agents are not.
  taskId: string | null;
}

export function workerChips(
  agentStatuses: AgentStatus[] | undefined,
  externalAgents: ExternalAgentStatus[] | undefined,
): WorkerChip[] {
  const dispatcher = (agentStatuses ?? []).map((worker): WorkerChip => ({
    key: `task:${worker.taskId}`,
    label: worker.taskId,
    detail: worker.headline ? `${worker.phase} · ${worker.headline}` : worker.phase,
    tone: riskTone(worker.risk),
    taskId: worker.taskId,
  }));
  const external = (externalAgents ?? []).map((agent): WorkerChip => ({
    key: `ext:${agent.id}`,
    label: agent.agent || agent.id,
    detail: agent.headline || agent.state,
    tone: agent.state === "blocked" ? BLOCKED_TONE : null,
    taskId: null,
  }));
  return [...dispatcher, ...external];
}
