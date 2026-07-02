export const TASK_STATUSES = [
  "inbox",
  "ready",
  "in_progress",
  "review",
  "merging",
  "blocked",
  "done",
] as const;

export type TaskStatus = typeof TASK_STATUSES[number];

export const TASK_LOOP_PHASES = [
  "queued",
  "planning",
  "working",
  "testing",
  "repairing",
  "reviewing",
  "remembering",
  "done",
  "blocked",
] as const;

export type TaskLoopPhase = typeof TASK_LOOP_PHASES[number];

export type TaskRiskLevel = "low" | "medium" | "high";

export type TaskKind = "code" | "ops" | "loop";

export const OPS_ACTIONS = ["publish"] as const;

export type OpsAction = typeof OPS_ACTIONS[number];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  inbox: "Inbox",
  ready: "Ready",
  in_progress: "Started",
  review: "Review",
  merging: "Merging",
  blocked: "Inbox",
  done: "Done",
};

export interface Goal {
  id: string;
  text: string;
  completionContract: string;
  status: "open" | "closed";
  closedAt: string | null;
  closureSummary: string;
  loopThreadId: string | null;
  loopBranch: string | null;
  loopWorktree: string | null;
  createdAt: string;
}

export interface Task {
  id: string;
  goalId: string;
  title: string;
  description: string;
  status: TaskStatus;
  kind: TaskKind;
  opsAction: OpsAction | null;
  priority: number;
  branchName: string | null;
  worktreePath: string | null;
  parentThreadId: string | null;
  threadId: string | null;
  activeTurnId: string | null;
  contextManifestPath: string | null;
  dependencyIds: string[];
  riskLevel: TaskRiskLevel;
  verificationPlan: string;
  loopPhase: TaskLoopPhase;
  loopAttempt: number;
  currentGate: string;
  verificationSummary: string;
  nextAction: string;
  needsInputPrompt: string | null;
  supervisorDecision: string;
  taskCard: string;
  handoffSummary: string;
  touchedPaths: string[];
  conflictSignals: string[];
  workpad: string;
  acceptanceCriteria: string;
  validation: string;
  blockedReason: string | null;
  triageAttempts: number;
  blockedFingerprint: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDraft {
  title: string;
  description: string;
  acceptanceCriteria: string;
  priority: number;
  workpad?: string;
  dependsOn?: string[];
  riskLevel?: TaskRiskLevel;
  verificationPlan?: string;
  kind?: TaskKind;
  opsAction?: OpsAction;
}

export interface Run {
  id: string;
  taskId: string;
  role: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt: string | null;
  stopRequestedAt: string | null;
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

export interface AgentStatus {
  taskId: string;
  runId: string;
  threadId: string | null;
  turnId: string | null;
  phase: AgentPhase;
  headline: string;
  detail: string;
  risk: AgentRisk;
  lastSeenAt: string;
  lastSupervisorAction: string | null;
  needsInputPrompt: string | null;
  interruptible: boolean;
}

export type GoalProbeStatus = "pending" | "passed" | "failed";

export interface GoalProbe {
  id: number;
  goalId: string;
  label: string;
  command: string;
  expectContains: string | null;
  timeoutMs: number;
  lastStatus: GoalProbeStatus;
  lastOutput: string;
  lastRunAt: string | null;
}

export interface GoalProbeDraft {
  label: string;
  command: string;
  expectContains?: string;
  timeoutMs?: number;
}

export interface Lesson {
  id: number;
  text: string;
  source: string;
  createdAt: string;
}

export type IdeaStatus = "proposed" | "approved" | "rejected";

export interface Idea {
  id: string;
  title: string;
  pitch: string;
  sources: string[];
  buildsOn: string;
  rank: number;
  status: IdeaStatus;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
}

export interface IdeaDraft {
  title: string;
  pitch: string;
  sources?: string[];
  buildsOn?: string;
}

export const EXTERNAL_AGENT_STATES = ["working", "blocked", "done", "idle"] as const;

export type ExternalAgentState = typeof EXTERNAL_AGENT_STATES[number];

export interface ExternalAgentStatus {
  id: string;
  agent: string;
  state: ExternalAgentState;
  headline: string;
  cwd: string;
  sessionId: string | null;
  startedAt: string;
  lastSeenAt: string;
}

export interface QueuedMessage {
  id: number;
  taskId: string;
  role: string;
  message: string;
  processed: boolean;
  createdAt: string;
}

export interface ActivityEvent {
  id: number;
  taskId: string | null;
  runId: string | null;
  role: string;
  kind: string;
  message: string;
  createdAt: string;
  rawJson: string | null;
  // Optional goal tag so SQL can filter a goal's loop conversation (Wave A).
  goalId?: string | null;
}

export type ActivityEventInput = Omit<ActivityEvent, "id" | "createdAt" | "rawJson"> & {
  raw?: unknown;
};

export interface ProjectState {
  mainThreadId: string | null;
  mainThreadCreatedAt: string | null;
  mainThreadResetAt: string | null;
  mainThreadSummary: string;
}

export interface BoardSnapshot {
  goals: Goal[];
  tasks: Task[];
  runs: Run[];
  agentStatuses: AgentStatus[];
  externalAgents: ExternalAgentStatus[];
  probes: GoalProbe[];
  lessons: Lesson[];
  ideas: Idea[];
  messages: QueuedMessage[];
  events: ActivityEvent[];
  statuses: { id: TaskStatus; label: string }[];
  projectState: ProjectState;
}

export interface TransitionResult {
  task: Task;
  event: ActivityEvent;
}
