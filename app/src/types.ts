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

// A registered project as the /api/projects list reports it: registry root +
// name, the live server URL when open in this process (null otherwise), and
// whether it is the project whose server served this page.
export interface ProjectEntry {
  root: string;
  name: string;
  url: string | null;
  current: boolean;
}

// One child directory the server-backed folder picker lists: its name, absolute
// path, and whether a .git lives directly inside (a repo the user likely wants).
export interface DirEntry {
  name: string;
  path: string;
  hasGit: boolean;
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
  // Live SSE activity events carry the owning goal (goal_id column); the board
  // snapshot and lifecycle backlog omit it. The Thread view keys its debounced
  // live refresh off this.
  goalId?: string | null;
}

// The Thread view payload: GET /api/goals/:id/thread. A loop conversation
// grouped into turns (turn 0 = setup); mirrors the server's ThreadTurn shape.
export interface ThreadEntry {
  id: number;
  at: string;
  kind: string;
  role: string;
  text: string;
}

export interface ThreadTurn {
  index: number;
  startedAt: string | null;
  entries: ThreadEntry[];
}

export interface GoalThread {
  goalId: string;
  turns: ThreadTurn[];
  truncated: boolean;
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
  // Per-project codex power (from readConfig) and the machine-wide Claude model,
  // so the settings modal can seed its "Model power" controls.
  config?: { model: string; reasoningEffort: string; fastMode: boolean };
  claudeModel?: string;
  claudeEffort?: string;
  activeAgentStatuses?: AgentStatus[];
  externalAgents?: ExternalAgentStatus[];
}
