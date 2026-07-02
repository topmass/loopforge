// View helpers for the live "Active workers" strip. Both execution paths land
// here: dispatcher tasks (board AgentStatus, keyed by taskId) and goal-loop
// fan-out agents (ExternalAgentStatus, no taskId). They're normalized into one
// chip shape so the board shows all live work regardless of which engine ran.
import type { AgentRisk, AgentStatus, ExternalAgentStatus } from "./types";

type Tone = { label: string; className: string };

const RISK_TONES: Record<Exclude<AgentRisk, "none">, Tone> = {
  test_failed: { label: "tests failed", className: "border-danger bg-danger-soft text-danger-ink" },
  conflict: { label: "conflict", className: "border-warn bg-warn-soft text-warn-ink" },
  needs_user: { label: "needs you", className: "border-accent bg-accent-soft text-accent-ink" },
  stale: { label: "stale", className: "border-line-strong bg-surface-sunken text-ink-muted" },
  session: { label: "session", className: "border-line-strong bg-surface-sunken text-ink-muted" },
};

const BLOCKED_TONE: Tone = {
  label: "blocked",
  className: "border-warn bg-warn-soft text-warn-ink",
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
