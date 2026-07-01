// Mirrors of the LoopForge board + lifecycle shapes the GUI consumes. Kept
// minimal - only the fields the UI reads.

export type PlanStepStatus = "todo" | "doing" | "done";

export interface PlanStep {
  title: string;
  status: PlanStepStatus;
  note: string;
}

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

export interface LifecycleEvent {
  kind: LifecycleKind;
  goalId: string | null;
  taskId: string | null;
  summary: string;
  data: Record<string, unknown>;
}

export interface Goal {
  id: string;
  text: string;
  status: "open" | "closed";
  closureSummary: string;
}

export interface Task {
  id: string;
  goalId: string;
  title: string;
  status: string;
  kind?: string;
  description?: string;
  needsInputPrompt?: string | null;
  currentGate?: string;
}

export interface Probe {
  id: string;
  goalId: string;
  label: string;
  lastStatus: string;
}

export interface ActivityEvent {
  id: number;
  taskId: string | null;
  role: string;
  kind: string;
  message: string;
  createdAt: string;
}

export interface BoardSnapshot {
  goals: Goal[];
  tasks: Task[];
  probes: Probe[];
  events: ActivityEvent[];
}

export type AgentPhase =
  | "starting"
  | "planning"
  | "reading"
  | "editing"
  | "running"
  | "testing"
  | "reviewing"
  | "merging"
  | "blocked"
  | "done";

export type AgentRisk =
  | "none"
  | "test_failed"
  | "conflict"
  | "stale"
  | "needs_user"
  | "session";

// Serialized subset of the board's AgentStatus the strip reads to show what a
// worker is doing right now.
export interface AgentStatus {
  taskId: string;
  phase: AgentPhase;
  headline: string;
  detail: string;
  risk: AgentRisk;
}

export type ExternalAgentState = "working" | "blocked" | "done" | "idle";

// A goal-loop fan-out agent reporting onto the board (no dispatcher taskId).
export interface ExternalAgentStatus {
  id: string;
  agent: string;
  state: ExternalAgentState;
  headline: string;
}

export interface Runtime {
  project?: { name: string; path: string };
  backend?: string;
  backendRaw?: string;
  rescue?: { enabled: boolean; backend: string; afterAttempts: number };
  planner?: { enabled: boolean; backend: string };
  scout?: { enabled: boolean; backend: string };
  pushBranches?: boolean;
  maxParallelAgents?: number;
  activeAgentStatuses?: AgentStatus[];
  externalAgents?: ExternalAgentStatus[];
}
