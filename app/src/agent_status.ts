// View helpers for the live "Active workers" strip. Both execution paths land
// here: dispatcher tasks (board AgentStatus, keyed by taskId) and goal-loop
// fan-out agents (ExternalAgentStatus, no taskId). They're normalized into one
// chip shape so the board shows all live work regardless of which engine ran.
import type { AgentRisk, AgentStatus, ExternalAgentStatus } from "./types";

type Tone = { label: string; className: string };

const RISK_TONES: Record<Exclude<AgentRisk, "none">, Tone> = {
  test_failed: { label: "tests failed", className: "border-red-300 bg-red-50 text-red-700" },
  conflict: { label: "conflict", className: "border-amber-300 bg-amber-50 text-amber-700" },
  needs_user: { label: "needs you", className: "border-orange-300 bg-orange-50 text-orange-700" },
  stale: { label: "stale", className: "border-slate-300 bg-slate-50 text-slate-600" },
  session: { label: "session", className: "border-slate-300 bg-slate-50 text-slate-600" },
};

const BLOCKED_TONE: Tone = {
  label: "blocked",
  className: "border-amber-300 bg-amber-50 text-amber-700",
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
