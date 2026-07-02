import {
  Box,
  createCliRenderer,
  FrameBuffer,
  type FrameBufferRenderable,
  RGBA,
  Text,
} from "@opentui/core";
import { summarizeClosedGoals, summarizeGoalProgress } from "../board/goal_progress.ts";
import { emptyFlowScene, pulseTargetForEvent, updateFlowScene } from "./choreography.ts";
import { FlowField } from "./flow_field.ts";
import { formatHealthLines } from "../board/status_lines.ts";
import { parseValidationEvidence } from "../board/validation_evidence.ts";
import { listManualVerificationItems } from "../board/status_lines.ts";
import { activityLine, displayEvents } from "./activity.ts";
import { decodeControlKey, decodePromptInput, normalizePromptText } from "./input.ts";
import { parseResetMemoryConfirmation } from "./memory_controls.ts";
import { blockedExplanation, taskRecommendation } from "./task_recommendation.ts";

type TaskStatus = "inbox" | "ready" | "in_progress" | "review" | "merging" | "blocked" | "done";

interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: number;
  branchName: string | null;
  worktreePath: string | null;
  parentThreadId: string | null;
  threadId: string | null;
  activeTurnId: string | null;
  contextManifestPath: string | null;
  dependencyIds: string[];
  riskLevel: string;
  verificationPlan: string;
  loopPhase: string;
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
  acceptanceCriteria: string;
  validation: string;
  blockedReason: string | null;
}

interface ActivityEvent {
  taskId: string | null;
  runId: string | null;
  role: string;
  kind: string;
  message: string;
  createdAt: string;
}

interface AgentStatus {
  taskId: string;
  runId: string;
  threadId: string | null;
  turnId: string | null;
  phase: string;
  headline: string;
  detail: string;
  risk: string;
  lastSeenAt: string;
  lastSupervisorAction: string | null;
  needsInputPrompt: string | null;
  interruptible: boolean;
}

interface QueuedMessage {
  taskId: string;
  role: string;
  message: string;
  processed: boolean;
  createdAt: string;
}

interface ExternalAgentStatus {
  id: string;
  agent: string;
  state: "working" | "blocked" | "done" | "idle";
  headline: string;
  cwd: string;
  sessionId: string | null;
  startedAt: string;
  lastSeenAt: string;
}

interface Goal {
  id: string;
  text: string;
  completionContract: string;
  status: "open" | "closed";
  closedAt: string | null;
  closureSummary: string;
  createdAt: string;
}

interface IdeaLite {
  id: string;
  title: string;
  pitch: string;
  sources: string[];
  buildsOn: string;
  rank: number;
  status: string;
}

interface BoardSnapshot {
  goals: Goal[];
  tasks: Task[];
  ideas: IdeaLite[];
  runs: Array<{ id: string; taskId: string; status: "running" | "completed" | "failed" }>;
  agentStatuses: AgentStatus[];
  externalAgents: ExternalAgentStatus[];
  probes: Array<{ goalId: string; label: string; lastStatus: string }>;
  lessons: Array<{ text: string }>;
  messages: QueuedMessage[];
  events: ActivityEvent[];
  statuses: Array<{ id: TaskStatus; label: string }>;
  projectState: {
    mainThreadId: string | null;
    mainThreadCreatedAt: string | null;
    mainThreadResetAt: string | null;
    mainThreadSummary: string;
  };
}

interface GoalMutationResult {
  tasks: Task[];
}

interface RuntimeSnapshot {
  queueRunning: boolean;
  workflow: { maxConcurrentAgents: number };
  backend?: string;
  config: { model: string; reasoningEffort: string; fastMode: boolean };
  rescue?: { enabled: boolean; backend: string; afterAttempts: number };
  planner?: { enabled: boolean; backend: string };
  scout?: { enabled: boolean; backend: string };
  search?: { endpoint: string };
  activeAgentStatuses: AgentStatus[];
  needsInputTasks: Task[];
  dispatchableTasks: Task[];
}

interface AppState {
  board: BoardSnapshot;
  runtime: RuntimeSnapshot | null;
  selectedTaskId: string | null;
  selectedIdeaId: string | null;
  frame: number;
  notice: string;
  promptMode: "build-goal" | "loop-goal" | "goal" | "task" | "steer" | "reset-main" | null;
  input: string;
  busy: boolean;
  flowVisible: boolean;
  scroll: Record<ScrollPanelId, number>;
}

interface FooterAction {
  label: string;
  run: () => void;
  emphasized?: boolean;
}

interface HitZone {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
  run: () => void;
}

type ScrollPanelId = "taskDetails" | "activeAgents" | "projectMemory" | "activity";

interface MouseInput {
  kind: "click" | "wheel-up" | "wheel-down";
  x: number;
  y: number;
}

interface TaskBoardRow {
  content: string;
  task: Task | null;
  idea?: IdeaLite | null;
}

const args = Bun.argv.slice(2);
const url = valueAfter("--url") ?? "http://127.0.0.1:4733";
const snapshot = args.includes("--snapshot");
const statusLabel: Record<TaskStatus, string> = {
  inbox: "Inbox",
  ready: "Ready",
  in_progress: "Working",
  review: "Needs Check",
  merging: "Merging",
  blocked: "Needs Input",
  done: "Done",
};
const spinner = ["◐", "◓", "◑", "◒"];
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const PROMPT_TEXT_ID = "prompt-line";
const FLOW_CANVAS_ID = "flow-canvas";
const FLOW_PANEL_HEIGHT = 7;
const FLOW_MIN_TERMINAL_HEIGHT = 30;
const FLOW_BG = RGBA.fromHex("#0A0D10");
const FLOW_LABEL_FG = RGBA.fromValues(0.45, 0.52, 0.6, 1);
const FLOW_CORE_LABEL_FG = RGBA.fromValues(0.35, 0.65, 0.7, 1);
const FLOW_BLOCKED_LABEL_FG = RGBA.fromValues(0.95, 0.7, 0.4, 1);

const state: AppState = {
  board: await getBoard(),
  runtime: await getRuntime().catch(() => null),
  selectedTaskId: null,
  selectedIdeaId: null,
  frame: 0,
  notice: "Ready.",
  promptMode: null,
  input: "",
  busy: false,
  flowVisible: true,
  scroll: {
    taskDetails: 0,
    activeAgents: 0,
    projectMemory: 0,
    activity: 0,
  },
};
ensureSelection();
let hitZones: HitZone[] = [];
let taskBoardRows: TaskBoardRow[] = [];
let promptPasteActive = false;
let flowField: FlowField | null = null;
let flowScene = emptyFlowScene();
let flowLive = false;
let shuttingDown = false;
let sseConnected = false;
let sseAbort: AbortController | null = null;
let lastBoardAt = Date.now();

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  remote: true,
  width: Number(process.env.COLUMNS) || 120,
  height: Number(process.env.LINES) || 36,
  targetFps: 24,
  maxFps: 60,
  useMouse: true,
  enableMouseMovement: false,
  useKittyKeyboard: null,
  backgroundColor: "#0A0D10",
  openConsoleOnError: false,
  prependInputHandlers: [
    (sequence) => {
      const mouse = parseMouseSequence(sequence);
      if (mouse) {
        handleMouseInput(mouse);
        return true;
      }
      if (state.promptMode) {
        if (handlePromptPasteSequence(sequence)) {
          updatePromptLine();
          return true;
        }
        const input = decodePromptInput(sequence);
        if (input) {
          void handlePromptInput(input).then(() => {
            if (!updatePromptLine()) {
              render();
            }
          });
          return true;
        }
      }
      const key = decodeControlKey(sequence);
      if (!key) {
        return false;
      }
      void handleKey(key);
      return true;
    },
  ],
});

renderer.setTerminalTitle("LoopForge Command Center");
renderer.keyInput.on("keypress", (key) => {
  void handleKey(key.name || key.raw || key.sequence);
});
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

applyBoardToFlow();
renderer.setFrameCallback(async (deltaTime) => {
  if (!flowField || !flowBandHeight()) {
    return;
  }
  flowField.tick(deltaTime / 1000);
  paintFlow();
});
render();
let refreshTimer: ReturnType<typeof setInterval> | null = null;

if (snapshot) {
  await renderer.idle();
  renderer.destroy();
  process.exit(0);
}

if (!state.board.projectState.mainThreadId) {
  void runAction("Open project session", () => post("/api/main/ensure", {}));
}

void consumeEvents();

refreshTimer = setInterval(async () => {
  state.frame++;
  if (state.frame % 4 === 0) {
    state.runtime = await getRuntime().catch(() => state.runtime);
  }
  if (!sseConnected && Date.now() - lastBoardAt > 3000) {
    await refresh().catch(() => {});
  }
  render();
}, 500);

async function handleKey(key: string): Promise<void> {
  if (!state.promptMode && key === "q") {
    shutdown();
  }
  if (state.promptMode) {
    await handlePromptInput({ kind: "key", key });
    if (!updatePromptLine()) {
      render();
    }
    return;
  }
  if (!state.promptMode && selectedIdea() && (key === "y" || key === "n")) {
    if (key === "y") {
      approveSelectedIdea();
    } else {
      rejectSelectedIdea();
    }
    render();
    return;
  }
  if (key === "up" || key === "k") {
    moveSelection(-1);
  } else if (key === "down" || key === "j" || key === "tab") {
    moveSelection(1);
  } else if (key === "pageup") {
    scrollPanel("taskDetails", -6);
  } else if (key === "pagedown") {
    scrollPanel("taskDetails", 6);
  } else if (key === "g") {
    openPrompt("goal", "Describe the goal to compile.");
  } else if (key === "b") {
    openPrompt("build-goal", "Describe the goal to build now.");
  } else if (key === "a") {
    openPrompt("task", "Type a task title to add without Codex planning.");
  } else if (key === "s") {
    if (!selectedTask()) {
      state.notice = "Select a task before steering.";
    } else {
      openPrompt("steer", `Steer ${selectedTask()?.id}.`);
    }
  } else if (key === "r") {
    void runAction("Run queue", () => post("/api/run-queue", {}));
  } else if (key === "enter" || key === "return") {
    const task = selectedTask();
    if (task) {
      void runAction(`Run ${task.id}`, () => post(`/api/tasks/${task.id}/run`, {}));
    }
  } else if (key === "x") {
    stopSelectedTask();
  } else if (key === "v") {
    const task = selectedTask();
    if (task) {
      void runAction(`Review ${task.id}`, () => post(`/api/tasks/${task.id}/review`, {}));
    }
  } else if (key === "m") {
    const task = selectedTask();
    if (task) {
      void runAction(`Merge ${task.id}`, () => post(`/api/tasks/${task.id}/merge`, {}));
    }
  } else if (key === "c") {
    const task = selectedTask();
    if (task) {
      void runAction(`Compact ${task.id}`, () => post(`/api/tasks/${task.id}/card`, {}));
    }
  } else if (key === "R") {
    openPrompt("reset-main", "Type RESET to clear memory, or RESET custom-id.");
  } else if (key === "p") {
    state.flowVisible = !state.flowVisible;
    state.notice = state.flowVisible ? "Agent Flow shown." : "Agent Flow hidden.";
  } else if (key === "delete") {
    deleteSelectedTask();
  }
  render();
}

function shutdown(): void {
  shuttingDown = true;
  sseAbort?.abort();
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  renderer.destroy();
  process.exit(0);
}

async function handlePromptInput(
  input: { kind: "key"; key: string } | { kind: "text"; text: string },
): Promise<void> {
  if (input.kind === "text") {
    appendPromptText(input.text);
    return;
  }
  const key = input.key;
  if (key === "escape") {
    state.promptMode = null;
    state.input = "";
    state.notice = "Canceled.";
    return;
  }
  if (key === "backspace") {
    state.input = state.input.slice(0, -1);
    return;
  }
  if (key === "enter" || key === "return") {
    const mode = state.promptMode;
    const value = state.input.trim();
    state.promptMode = null;
    state.input = "";
    if (mode === "build-goal" && value) {
      await buildGoal(value);
    } else if (mode === "loop-goal" && value) {
      await loopNewGoal(value);
    } else if (mode === "goal" && value) {
      await planGoal(value);
    } else if (mode === "task" && value) {
      await addManualTask(value);
    } else if (mode === "steer" && value && selectedTask()) {
      await addInputToSelectedTask(value);
    } else if (mode === "reset-main") {
      await resetProjectMemory(value);
    } else {
      state.notice = "Input is required.";
    }
    return;
  }
  if (key.length === 1 && key >= " ") {
    appendPromptText(key);
  }
}

async function loopNewGoal(text: string): Promise<void> {
  await runAction(
    "Loop new goal",
    () => post("/api/goals/loop", { text }),
    {
      complete: (result) => {
        const goalId = (result as { goalId?: string })?.goalId ?? "the new goal";
        return `Goal loop started on ${goalId}: one agent owns it; its plan mirrors here as it works.`;
      },
    },
  );
}

function appendPromptText(text: string): void {
  text = normalizePromptText(text);
  if (!text) {
    return;
  }
  state.input = normalizePromptText(`${state.input}${text}`).slice(0, 8000);
}

function handlePromptPasteSequence(sequence: string): boolean {
  if (sequence === BRACKETED_PASTE_START) {
    promptPasteActive = true;
    return true;
  }
  if (sequence === BRACKETED_PASTE_END) {
    promptPasteActive = false;
    return true;
  }
  if (sequence.startsWith(BRACKETED_PASTE_START)) {
    promptPasteActive = true;
    const text = sequence.slice(BRACKETED_PASTE_START.length);
    if (text) {
      appendPromptText(text.replace(BRACKETED_PASTE_END, ""));
    }
    if (sequence.includes(BRACKETED_PASTE_END)) {
      promptPasteActive = false;
    }
    return true;
  }
  if (promptPasteActive) {
    appendPromptText(sequence.replace(BRACKETED_PASTE_END, ""));
    if (sequence.includes(BRACKETED_PASTE_END)) {
      promptPasteActive = false;
    }
    return true;
  }
  return false;
}

async function buildGoal(text: string): Promise<void> {
  await runAction(
    "Build goal",
    async () => {
      const result = await post("/api/goals/build", { text }) as GoalMutationResult;
      const firstTask = result.tasks[0];
      if (firstTask) {
        state.selectedTaskId = firstTask.id;
      }
      return result;
    },
    {
      started: "Planning goal and starting ready work...",
      complete: (result) => {
        const tasks = mutationTasks(result);
        const firstTask = tasks[0];
        if (!firstTask) {
          return "Goal submitted. No tasks were created.";
        }
        return `Created ${tasks.length} task${
          tasks.length === 1 ? "" : "s"
        } and started ready work. LoopForge will close the goal when proof is complete. Selected ${firstTask.title}.`;
      },
    },
  );
}

async function planGoal(text: string): Promise<void> {
  await runAction(
    "Plan goal",
    async () => {
      const result = await post("/api/goals", { text }) as GoalMutationResult;
      const firstTask = result.tasks[0];
      if (firstTask) {
        state.selectedTaskId = firstTask.id;
      }
      return result;
    },
    {
      started: "Planning goal with Codex...",
      complete: (result) => {
        const tasks = mutationTasks(result);
        const firstTask = tasks[0];
        if (!firstTask) {
          return "Plan complete. No tasks were created.";
        }
        return `Planned ${tasks.length} task${
          tasks.length === 1 ? "" : "s"
        }. Selected ${firstTask.title}.`;
      },
    },
  );
}

async function addManualTask(title: string): Promise<void> {
  await runAction(
    "Add task",
    async () => {
      const result = await post("/api/tasks", {
        title,
        description: title,
        acceptanceCriteria: `Complete and validate: ${title}`,
        priority: 100,
      }) as GoalMutationResult;
      const firstTask = result.tasks[0];
      if (firstTask) {
        state.selectedTaskId = firstTask.id;
      }
      return result;
    },
    {
      started: "Adding task...",
      complete: (result) => {
        const firstTask = mutationTasks(result)[0];
        return firstTask ? `Added ${firstTask.title}.` : "Task added.";
      },
    },
  );
}

async function addInputToSelectedTask(message: string): Promise<void> {
  const task = selectedTask();
  if (!task) {
    state.notice = "Select a task before adding input.";
    return;
  }
  await runAction(
    `Add input to ${task.id}`,
    async () => {
      await post(`/api/tasks/${task.id}/steer`, { message });
      if (task.status === "blocked") {
        await post(`/api/tasks/${task.id}/run`, {});
        return { restarted: true, task };
      }
      return { restarted: false, task };
    },
    {
      started: `Adding input to ${task.id}...`,
      complete: (result) => {
        const payload = result as { restarted?: boolean; task?: Task };
        return payload.restarted
          ? `Added input and restarted ${payload.task?.title ?? task.id}.`
          : `Added input to ${payload.task?.title ?? task.id}.`;
      },
    },
  );
}

async function resetProjectMemory(value: string): Promise<void> {
  const reset = parseResetMemoryConfirmation(value);
  if (!reset.confirmed) {
    state.notice = "Type RESET to reset project memory, or RESET custom-id.";
    return;
  }
  await runAction(
    "Reset project memory",
    () => post("/api/main/reset", { threadId: reset.threadId ?? "" }),
    {
      started: "Resetting project memory...",
      complete: "Project memory reset.",
    },
  );
}

async function closeActiveGoal(): Promise<void> {
  const goal = activeGoalProgress();
  if (!goal?.completionReady) {
    state.notice = goal
      ? `${goal.goal.id} is not ready to close: ${goal.completionReason}`
      : "No open goal is ready to close.";
    return;
  }
  await runAction(
    `Close ${goal.goal.id}`,
    () =>
      post(`/api/goals/${encodeURIComponent(goal.goal.id)}/close`, {
        summary: `${goal.done}/${goal.total} tasks done. ${goal.completionReason}`,
      }),
    {
      started: `Closing ${goal.goal.id}...`,
      complete: `${goal.goal.id} closed.`,
    },
  );
}

function activeGoalProgress(): ReturnType<typeof summarizeGoalProgress> {
  return summarizeGoalProgress(state.board);
}

async function runAction(
  label: string,
  action: () => Promise<unknown>,
  messages: {
    started?: string;
    complete?: string | ((result: unknown) => string);
  } = {},
): Promise<void> {
  if (state.busy) {
    state.notice = "An action is already running.";
    return;
  }
  state.busy = true;
  state.notice = messages.started ?? `${label} started.`;
  render();
  try {
    const result = await action();
    await refresh();
    state.notice = typeof messages.complete === "function"
      ? messages.complete(result)
      : messages.complete ?? `${label} complete.`;
  } catch (error) {
    state.notice = error instanceof Error ? error.message : String(error);
  } finally {
    state.busy = false;
    render();
  }
}

function mutationTasks(result: unknown): Task[] {
  if (!result || typeof result !== "object" || !("tasks" in result)) {
    return [];
  }
  const tasks = (result as { tasks: unknown }).tasks;
  return Array.isArray(tasks) ? tasks as Task[] : [];
}

function render(): void {
  const existing = renderer.root.getRenderable("app");
  if (existing) {
    renderer.root.remove("app");
  }
  const running = state.board.runs.filter((run) => run.status === "running").length;
  const pulse = state.busy || running ? spinner[state.frame % spinner.length] : " ";
  const selected = selectedTask();
  taskBoardRows = buildTaskBoardRows();
  const streamLines = displayEvents(state.board.events).map((event) =>
    activityLine(event, state.board.tasks)
  );
  const idea = selectedIdea();
  const detailLines = idea
    ? ideaDetails(idea)
    : selected
    ? taskDetails(selected)
    : ["No task selected."];
  const agentLines = activeAgentLines();
  const prompt = state.promptMode ? promptPreview() : state.notice;
  const footerRows = createFooterActionRows();
  hitZones = buildHitZones();

  renderer.root.add(
    Box(
      {
        id: "app",
        width: "100%",
        height: "100%",
        flexDirection: "column",
        backgroundColor: "#0A0D10",
      },
      Box(
        {
          height: 3,
          flexDirection: "column",
          paddingX: 1,
          backgroundColor: "#1E2A32",
        },
        Text({
          content: `${pulse} ${statusHeadline()}`,
          fg: "#B7F7D4",
        }),
        Text({
          content: `Agent ${
            state.runtime?.backend ?? state.runtime?.config.model ?? "unknown"
          }  Active agents ${running}/${
            state.runtime?.workflow.maxConcurrentAgents ?? "?"
          }  Project memory ${state.board.projectState.mainThreadId ?? "not started"}`,
          fg: "#8A98A8",
        }),
      ),
      ...(flowBandHeight() ? [flowPanel()] : []),
      Box(
        { flexGrow: 1, flexDirection: "row" },
        taskRailPanel(taskBoardRows),
        Box(
          { width: "39%", height: "100%", flexDirection: "column" },
          panel(
            "Task Details",
            visiblePanelLines("taskDetails", detailLines, 19),
            "100%",
            "#A7F3D0",
            "66%",
            "taskDetails",
          ),
          panel(
            "Active Agents",
            visiblePanelLines("activeAgents", agentLines, 9),
            "100%",
            "#93C5FD",
            "100%",
            "activeAgents",
          ),
        ),
        Box(
          { width: "30%", height: "100%", flexDirection: "column" },
          panel(
            "Project Memory",
            visiblePanelLines("projectMemory", mainThreadLines(), 10),
            "100%",
            "#C4B5FD",
            "36%",
            "projectMemory",
          ),
          panel(
            "Activity",
            visiblePanelLines(
              "activity",
              streamLines.length ? streamLines : ["No activity yet."],
              21,
            ),
            "100%",
            "#FDE68A",
            "100%",
            "activity",
          ),
        ),
      ),
      Box(
        { height: 5, flexDirection: "column", paddingX: 1, backgroundColor: "#14211A" },
        Text({ id: PROMPT_TEXT_ID, content: prompt, fg: "#D9F99D" }),
        ...footerRows.map((actions) =>
          Box(
            { height: 1, flexDirection: "row", gap: 1 },
            ...actions.map((action) => footerButton(action)),
          )
        ),
      ),
    ),
  );
  updateFlowLive();
  paintFlow();
  renderer.requestRender();
}

function flowBandHeight(): number {
  if (!state.flowVisible) {
    return 0;
  }
  return terminalDimensions().height >= FLOW_MIN_TERMINAL_HEIGHT ? FLOW_PANEL_HEIGHT : 0;
}

function flowPanel() {
  const { width } = terminalDimensions();
  return Box(
    {
      height: FLOW_PANEL_HEIGHT,
      border: true,
      borderStyle: "rounded",
      borderColor: "#67E8F9",
      title: "Agent Flow",
      backgroundColor: "#0A0D10",
      flexDirection: "column",
    },
    FrameBuffer({
      id: FLOW_CANVAS_ID,
      width: Math.max(10, width - 2),
      height: FLOW_PANEL_HEIGHT - 2,
    }),
  );
}

function applyBoardToFlow(): void {
  flowScene = updateFlowScene(flowScene, state.board, Date.now());
  if (!flowField) {
    const { width } = terminalDimensions();
    flowField = new FlowField({ cols: Math.max(10, width - 2), rows: FLOW_PANEL_HEIGHT - 2 });
  }
  flowField.applyScene(flowScene);
}

function updateFlowLive(): void {
  const shouldLive = !snapshot && flowBandHeight() > 0;
  if (shouldLive && !flowLive) {
    renderer.requestLive();
    flowLive = true;
  } else if (!shouldLive && flowLive) {
    renderer.dropLive();
    flowLive = false;
  }
}

function paintFlow(): void {
  if (!flowField || !flowBandHeight()) {
    return;
  }
  const renderable = renderer.root.findDescendantById(FLOW_CANVAS_ID) as
    | FrameBufferRenderable
    | undefined;
  const buffer = renderable?.frameBuffer;
  if (!buffer) {
    return;
  }
  flowField.resize(buffer.width, buffer.height);
  buffer.clear(FLOW_BG);
  flowField.render((cellX, cellY, char, r, g, b) => {
    buffer.setCell(cellX, cellY, char, RGBA.fromValues(r, g, b, 1), FLOW_BG);
  });
  const labelRow = buffer.height - 1;
  for (const anchor of flowField.anchors()) {
    const label = anchor.kind === "core" ? anchor.label : short(anchor.label, 14);
    const x = Math.max(
      0,
      Math.min(buffer.width - label.length, anchor.cellX - (label.length >> 1)),
    );
    const fg = anchor.kind === "core"
      ? FLOW_CORE_LABEL_FG
      : anchor.mood === "blocked"
      ? FLOW_BLOCKED_LABEL_FG
      : FLOW_LABEL_FG;
    buffer.drawText(label, x, labelRow, fg);
  }
  renderer.requestRender();
}

async function consumeEvents(): Promise<void> {
  while (!shuttingDown) {
    sseAbort = new AbortController();
    try {
      const response = await fetch(`${url}/api/events`, {
        signal: sseAbort.signal,
        headers: { accept: "text/event-stream" },
      });
      if (!response.ok || !response.body) {
        throw new Error(`/api/events ${response.status}`);
      }
      sseConnected = true;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      let eventType = "message";
      let data = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffered += decoder.decode(value, { stream: true });
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
          const line = buffered.slice(0, newline).replace(/\r$/, "");
          buffered = buffered.slice(newline + 1);
          if (line.startsWith("event:")) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            data += line.slice(5).trim();
          } else if (!line) {
            if (data) {
              handleServerEvent(eventType, data);
            }
            eventType = "message";
            data = "";
          }
          newline = buffered.indexOf("\n");
        }
      }
    } catch {
      // Server unreachable or stream dropped. Reconnect below.
    }
    sseConnected = false;
    if (shuttingDown) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function handleServerEvent(type: string, data: string): void {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return;
  }
  if (type === "board") {
    state.board = payload as BoardSnapshot;
    lastBoardAt = Date.now();
    ensureSelection();
    applyBoardToFlow();
    render();
  } else if (type === "activity") {
    const event = payload as ActivityEvent;
    if (event.kind === "close" && flowField) {
      flowField.celebrate();
      return;
    }
    const target = pulseTargetForEvent(flowScene, event);
    if (target && flowField) {
      flowField.pulse(target);
    }
  }
}

function updatePromptLine(): boolean {
  if (!state.promptMode) {
    return false;
  }
  const prompt = renderer.root.getRenderable(PROMPT_TEXT_ID);
  if (!prompt || !("content" in prompt)) {
    return false;
  }
  (prompt as { content: string }).content = promptPreview();
  renderer.requestRender();
  return true;
}

function taskRailPanel(rows: TaskBoardRow[]) {
  return Box(
    {
      width: "31%",
      height: "100%",
      border: true,
      borderStyle: "rounded",
      borderColor: "#7DD3FC",
      title: "Task Board",
      padding: 1,
      flexDirection: "column",
      backgroundColor: "#0D1117",
    },
    ...rows.map((row) =>
      Text({
        content: row.content,
        fg: row.task?.status === "blocked"
          ? "#FDE68A"
          : row.task?.status === "done"
          ? "#9CA3AF"
          : "#E5E7EB",
        height: 1,
        onMouseDown: () => {
          if (row.task) {
            selectTask(row.task.id);
            render();
          } else if (row.idea) {
            selectIdea(row.idea.id);
            render();
          }
        },
      })
    ),
  );
}

function createFooterActionRows(): FooterAction[][] {
  const idea = selectedIdea();
  const taskAction = idea ? null : selectedTaskFooterAction();
  const primary: FooterAction[] = [
    { label: "Build Goal", run: () => openPrompt("build-goal", "Describe the goal to build now.") },
    {
      label: "Loop New",
      run: () => openPrompt("loop-goal", "Describe the goal; one agent loops it to done."),
    },
    { label: "New Task", run: () => openPrompt("task", "Type a task title.") },
    { label: "Plan Only", run: () => openPrompt("goal", "Describe the goal to compile.") },
    ...(taskAction ? [taskAction] : []),
    ...(idea
      ? [
        { label: "Approve Idea", run: approveSelectedIdea, emphasized: true },
        { label: "Reject Idea", run: rejectSelectedIdea },
      ]
      : []),
  ];
  const goal = activeGoalProgress();
  if (goal?.completionReady) {
    primary.push({ label: "Close Goal", run: closeActiveGoal });
  }
  const loopGoalId = selectedTask()?.goalId ??
    state.board?.goals.find((candidate) => candidate.status === "open")?.id;
  if (loopGoalId) {
    primary.push({
      label: "Loop Goal",
      run: () =>
        void runAction(
          `Loop ${loopGoalId}`,
          () => post(`/api/goals/${loopGoalId}/loop`, {}),
          {
            complete: () =>
              `Goal loop started on ${loopGoalId}: one agent owns the goal; its plan mirrors here as it works.`,
          },
        ),
    });
  }
  const secondary: FooterAction[] = [
    {
      label: "Run Ready Tasks",
      run: () =>
        void runAction("Run queue", () => post("/api/run-queue", {}), {
          complete: (result) => {
            const note = (result as { note?: string })?.note;
            return note || "Queue running: dispatching ready tasks up to the agent limit.";
          },
        }),
    },
    {
      label: "Reply",
      run: () => {
        const task = selectedTask();
        if (task) {
          openPrompt("steer", `Tell LoopForge what ${task.id} needs.`);
        } else {
          state.notice = "Select a task before adding input.";
        }
      },
    },
    { label: "Compact Memory", run: compactProjectMemory },
    {
      label: "Reset Memory",
      run: () => openPrompt("reset-main", "Type RESET to clear memory, or RESET custom-id."),
    },
    ...(state.board.tasks.some((item) => item.status === "done")
      ? [{ label: "Clear Done", run: clearDoneTasks }]
      : []),
    { label: "Delete Task", run: deleteSelectedTask },
    { label: "Exit", run: shutdown },
  ];
  const toggles: FooterAction[] = [
    {
      label: rescueLabel(),
      run: cycleRescue,
      emphasized: Boolean(state.runtime?.rescue?.enabled),
    },
    ...(state.runtime?.rescue?.enabled
      ? [{
        label: `Tries: ${state.runtime.rescue.afterAttempts}`,
        run: cycleRescueAttempts,
        emphasized: true,
      }]
      : []),
    {
      label: plannerLabel(),
      run: cyclePlanner,
      emphasized: Boolean(state.runtime?.planner?.enabled),
    },
    {
      label: scoutLabel(),
      run: cycleScout,
      emphasized: Boolean(state.runtime?.scout?.enabled),
    },
    {
      label: `Agents: ${state.runtime?.workflow.maxConcurrentAgents ?? "?"}`,
      run: cycleMaxAgents,
    },
  ];
  return [primary, secondary, toggles];
}

const RESCUE_CYCLE = ["off", "codex", "claude", "local"] as const;

function rescueLabel(): string {
  const rescue = state.runtime?.rescue;
  return rescue?.enabled ? `Rescue: ${rescue.backend}` : "Rescue: Off";
}

function cycleRescue(): void {
  const rescue = state.runtime?.rescue;
  const current = rescue?.enabled ? rescue.backend : "off";
  const index = RESCUE_CYCLE.indexOf(current as typeof RESCUE_CYCLE[number]);
  const next = RESCUE_CYCLE[(index + 1) % RESCUE_CYCLE.length];
  void runAction(
    "Rescue model",
    async () => {
      const updated = await patch("/api/rescue", {
        enabled: next !== "off",
        ...(next !== "off" ? { backend: next } : {}),
      }) as { enabled: boolean; backend: string; afterAttempts: number };
      if (state.runtime) {
        state.runtime.rescue = updated;
      }
      return updated;
    },
    {
      started: "Updating rescue model...",
      complete: (result) => {
        const rescueState = result as { enabled: boolean; backend: string; afterAttempts: number };
        return rescueState.enabled
          ? `Rescue model armed: ${rescueState.backend} reviews stuck tasks after ${rescueState.afterAttempts} failed tries (for pursue loops and long runs).`
          : "Rescue model off.";
      },
    },
  );
}

const RESCUE_TRIES_CYCLE = [1, 3, 5, 10];

function cycleRescueAttempts(): void {
  const current = state.runtime?.rescue?.afterAttempts ?? 1;
  const index = RESCUE_TRIES_CYCLE.indexOf(current);
  const next = RESCUE_TRIES_CYCLE[(index + 1) % RESCUE_TRIES_CYCLE.length];
  void runAction(
    "Rescue tries",
    async () => {
      const updated = await patch("/api/rescue", { afterAttempts: next }) as {
        enabled: boolean;
        backend: string;
        afterAttempts: number;
      };
      if (state.runtime) {
        state.runtime.rescue = updated;
      }
      return updated;
    },
    {
      started: "Updating rescue tries...",
      complete: (result) => {
        const rescueState = result as { afterAttempts: number };
        return `Rescue model now chimes in after ${rescueState.afterAttempts} failed tr${
          rescueState.afterAttempts === 1 ? "y" : "ies"
        }.`;
      },
    },
  );
}

const PLANNER_CYCLE = ["off", "codex", "claude", "local"] as const;

function plannerLabel(): string {
  const planner = state.runtime?.planner;
  return planner?.enabled ? `Planner: ${planner.backend}` : "Planner: Off";
}

function cyclePlanner(): void {
  const planner = state.runtime?.planner;
  const current = planner?.enabled ? planner.backend : "off";
  const index = PLANNER_CYCLE.indexOf(current as typeof PLANNER_CYCLE[number]);
  const next = PLANNER_CYCLE[(index + 1) % PLANNER_CYCLE.length];
  void runAction(
    "Planner model",
    async () => {
      const updated = await patch("/api/planner", {
        enabled: next !== "off",
        ...(next !== "off" ? { backend: next } : {}),
      }) as { enabled: boolean; backend: string };
      if (state.runtime) {
        state.runtime.planner = updated;
      }
      return updated;
    },
    {
      started: "Updating planner model...",
      complete: (result) => {
        const plannerState = result as { enabled: boolean; backend: string };
        return plannerState.enabled
          ? `Planner routed: ${plannerState.backend} compiles and replans goals while workers stay on the main backend.`
          : "Planner routing off; planning follows the main backend.";
      },
    },
  );
}

const SCOUT_CYCLE = ["off", "codex", "claude", "local"] as const;

function scoutLabel(): string {
  const scout = state.runtime?.scout;
  return scout?.enabled ? `Scout: ${scout.backend}` : "Scout: Off";
}

function cycleScout(): void {
  const scout = state.runtime?.scout;
  const current = scout?.enabled ? scout.backend : "off";
  const index = SCOUT_CYCLE.indexOf(current as typeof SCOUT_CYCLE[number]);
  const next = SCOUT_CYCLE[(index + 1) % SCOUT_CYCLE.length];
  void runAction(
    "Scout",
    async () => {
      const updated = await patch("/api/scout", {
        enabled: next !== "off",
        ...(next !== "off" ? { backend: next } : {}),
      }) as { enabled: boolean; backend: string };
      if (state.runtime) {
        state.runtime.scout = updated;
      }
      return updated;
    },
    {
      started: "Updating scout...",
      complete: (result) => {
        const scoutState = result as { enabled: boolean; backend: string };
        return scoutState.enabled
          ? `Scout armed: ${scoutState.backend} proposes ideas during pursue runs; you approve or reject them.`
          : "Scout off.";
      },
    },
  );
}

function approveSelectedIdea(): void {
  const idea = selectedIdea();
  if (!idea) {
    return;
  }
  state.selectedIdeaId = null;
  void runAction(
    `Approve ${idea.id}`,
    () => post(`/api/ideas/${idea.id}/approve`, {}),
    {
      started: `Approved ${idea.id}; the planner is compiling it into a goal...`,
      complete: () => `${idea.id} planned into Ready. Run Ready Tasks builds it.`,
    },
  );
}

function rejectSelectedIdea(): void {
  const idea = selectedIdea();
  if (!idea) {
    return;
  }
  state.selectedIdeaId = null;
  void runAction(
    `Reject ${idea.id}`,
    () => post(`/api/ideas/${idea.id}/reject`, {}),
    {
      started: `Rejecting ${idea.id}...`,
      complete: () => `${idea.id} rejected; the scout will not pitch it again.`,
    },
  );
}

const MAX_AGENTS_CYCLE = [1, 2, 3, 4];

function cycleMaxAgents(): void {
  const current = state.runtime?.workflow.maxConcurrentAgents ?? 2;
  const index = MAX_AGENTS_CYCLE.indexOf(current);
  const next = MAX_AGENTS_CYCLE[(index + 1) % MAX_AGENTS_CYCLE.length];
  void runAction(
    "Max agents",
    async () => {
      const updated = await patch("/api/workflow/agents", { maxConcurrentAgents: next }) as {
        maxConcurrentAgents: number;
      };
      if (state.runtime) {
        state.runtime.workflow.maxConcurrentAgents = updated.maxConcurrentAgents;
      }
      return updated;
    },
    {
      started: "Updating max concurrent agents...",
      complete: (result) => {
        const workflowState = result as { maxConcurrentAgents: number };
        return `Up to ${workflowState.maxConcurrentAgents} agent${
          workflowState.maxConcurrentAgents === 1 ? "" : "s"
        } can now run at once.`;
      },
    },
  );
}

async function patch(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${url}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(String(payload.error || response.statusText));
  }
  return await response.json();
}

function selectedTaskFooterAction(): FooterAction | null {
  const task = selectedTask();
  if (!task) {
    return null;
  }
  if (isTaskRunning(task.id)) {
    return { label: "Stop Task", run: stopSelectedTask };
  }
  if (task.status === "review") {
    return {
      label: "Review & Merge",
      run: () =>
        void runAction(
          `Review and merge ${task.id}`,
          () => post(`/api/tasks/${task.id}/review`, {}),
        ),
    };
  }
  if (task.status === "done" || task.status === "merging") {
    return null;
  }
  return {
    label: "Start Task",
    run: () => void runAction(`Start ${task.title}`, () => post(`/api/tasks/${task.id}/run`, {})),
  };
}

function footerButton(action: FooterAction) {
  return Box(
    {
      height: 1,
      width: footerButtonWidth(action),
      backgroundColor: action.emphasized ? "#4A3D1F" : "#203029",
      onMouseDown: () => {
        action.run();
        render();
      },
    },
    Text({ content: ` ${action.label} `, fg: action.emphasized ? "#FDE68A" : "#B7F7D4" }),
  );
}

function footerButtonWidth(action: FooterAction): number {
  return Math.max(12, action.label.length + 4);
}

function panel(
  title: string,
  lines: string[],
  width: string,
  color: string,
  height: string | number = "100%",
  scrollId?: ScrollPanelId,
) {
  return Box(
    {
      width,
      height,
      border: true,
      borderStyle: "rounded",
      borderColor: color,
      title,
      padding: 1,
      flexDirection: "column",
      backgroundColor: "#0D1117",
      onMouseScroll: scrollId
        ? (event) => {
          scrollPanel(scrollId, event.scroll?.direction === "up" ? -3 : 3);
          event.stopPropagation();
          render();
        }
        : undefined,
    },
    Text({ content: lines.join("\n"), fg: "#E5E7EB" }),
  );
}

function visiblePanelLines(id: ScrollPanelId, lines: string[], height: number): string[] {
  const maxScroll = Math.max(0, lines.length - height);
  state.scroll[id] = Math.max(0, Math.min(state.scroll[id], maxScroll));
  const visible = lines.slice(state.scroll[id], state.scroll[id] + height);
  if (maxScroll > 0) {
    const position = `${state.scroll[id] + 1}-${Math.min(state.scroll[id] + height, lines.length)}`;
    return [`${position} of ${lines.length}`, ...visible.slice(0, Math.max(0, height - 1))];
  }
  return visible;
}

async function refresh(): Promise<void> {
  state.board = await getBoard();
  state.runtime = await getRuntime().catch(() => state.runtime);
  lastBoardAt = Date.now();
  ensureSelection();
  applyBoardToFlow();
}

async function getBoard(): Promise<BoardSnapshot> {
  return await get("/api/board") as BoardSnapshot;
}

async function getRuntime(): Promise<RuntimeSnapshot> {
  return await get("/api/runtime") as RuntimeSnapshot;
}

async function get(path: string): Promise<unknown> {
  const response = await fetch(`${url}${path}`);
  if (!response.ok) {
    throw new Error(`${path} ${response.status}`);
  }
  return await response.json();
}

async function post(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(String(payload.error || response.statusText));
  }
  return await response.json();
}

async function del(path: string): Promise<unknown> {
  const response = await fetch(`${url}${path}`, { method: "DELETE" });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(String(payload.error || response.statusText));
  }
  return await response.json();
}

function taskLine(task: Task, selected: boolean): string {
  const marker = selected ? ">" : " ";
  const active = task.status === "in_progress" ? spinner[state.frame % spinner.length] : " ";
  const conflicts = task.conflictSignals.length ? "!" : " ";
  const phase = friendlyLoopPhase(task.loopPhase);
  return `${marker}${active} ${statusLabel[task.status]} ${phase} ${conflicts} ${
    short(task.title, 42)
  }`;
}

function taskDetails(task: Task): string[] {
  const recommendation = taskRecommendation(task, taskMessages(task));
  const lines = [
    task.title,
    `Status: ${statusLabel[task.status]}`,
    `Phase: ${friendlyLoopPhase(task.loopPhase)}  Gate: ${friendlyGate(task.currentGate)}`,
    `Attempt: ${task.loopAttempt}  Risk: ${friendlyRisk(task.riskLevel)}`,
    `Task: ${task.id}`,
    "",
    recommendation.heading,
    ...wrap(recommendation.summary, 58).slice(0, 3),
    ...wrap(recommendation.action, 58).slice(0, 3),
    ...needsInputLines(task),
    "",
    "Current Work",
    `Branch: ${task.branchName ?? "not started yet"}`,
    `Workspace: ${task.worktreePath ?? "not created yet"}`,
    `Dependencies: ${task.dependencyIds.length ? task.dependencyIds.join(", ") : "none"}`,
    ...(task.supervisorDecision
      ? ["", "Supervisor", ...wrap(task.supervisorDecision, 58).slice(0, 3)]
      : []),
    ...changedFilesLines(task),
    ...validationEvidenceLines(task),
    ...validationLogLines(task),
    "",
    "Recent Activity",
    ...selectedTaskActivityLines(task),
    "",
    "What To Do",
    ...(task.taskCard ? wrap(task.taskCard, 58) : wrap(task.description, 58)).slice(0, 8),
    "",
    "Done When",
    ...wrap(task.acceptanceCriteria || "No acceptance criteria recorded.", 58).slice(0, 6),
    "",
    "Verification Plan",
    ...wrap(task.verificationPlan || "Run focused validation for the changed surface.", 58).slice(
      0,
      5,
    ),
  ];
  if (task.verificationSummary) {
    lines.push("", "Verification Evidence", ...wrap(task.verificationSummary, 58).slice(0, 6));
  }
  if (task.conflictSignals.length) {
    lines.push(
      "",
      "Conflict Signals",
      ...task.conflictSignals.slice(-4).map((item) => `! ${item}`),
    );
  }
  if (task.handoffSummary) {
    lines.push("", "Handoff", ...wrap(task.handoffSummary, 58).slice(0, 6));
  }
  return lines;
}

function changedFilesLines(task: Task): string[] {
  if (!task.touchedPaths.length) {
    return [];
  }
  return ["", "Changed Files", ...task.touchedPaths.slice(0, 6).map((item) => `- ${item}`)];
}

function validationEvidenceLines(task: Task): string[] {
  if (!task.validation.trim()) {
    return [];
  }
  const evidence = parseValidationEvidence(task.validation);
  return [
    "",
    "Validation Evidence",
    `Gates ${evidence.verificationGatesRecorded ? evidence.verificationGates.length : "missing"}`,
    `Verify ${evidence.verificationVerdict ?? "missing"} | Review ${
      evidence.reviewVerdict ?? "missing"
    }`,
    `Impl ${evidence.implementationStatus ?? "missing"} | Test ${evidence.testStatus ?? "missing"}`,
    `Proof ${evidence.verificationHasProofDetails ? "recorded" : "missing"}`,
    `Commit ${evidence.commitCreated ? evidence.commit : evidence.commit ?? "missing"} | Git ${
      evidence.finalGitStatus ?? "missing"
    }`,
  ];
}

function validationLogLines(task: Task): string[] {
  if (!task.validation.trim()) {
    return [];
  }
  return ["", "Validation Log", ...wrap(validationPreview(task.validation), 58).slice(0, 5)];
}

function selectedTaskActivityLines(task: Task): string[] {
  const events = displayEvents(state.board.events)
    .filter((event) => event.taskId === task.id)
    .slice(-5);
  if (!events.length) {
    return ["No activity recorded for this task yet."];
  }
  return events.map((event) => activityLine(event, state.board.tasks));
}

function validationPreview(value: string): string {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12)
    .join(" | ");
}

function needsInputLines(task: Task): string[] {
  if (task.status !== "blocked") {
    return [];
  }
  const pending = taskMessages(task).filter((message) => !message.processed);
  const explanation = blockedExplanation(task.blockedReason);
  const prompt = task.needsInputPrompt || explanation.action;
  return [
    "",
    "Needs Input",
    ...wrap(explanation.summary, 58).slice(0, 4),
    ...wrap(prompt, 58).slice(0, 3),
    ...pending.slice(-2).flatMap((message) => [
      "",
      `Queued input from ${message.role}:`,
      ...wrap(message.message, 58).slice(0, 3),
    ]),
  ];
}

function taskMessages(task: Task): QueuedMessage[] {
  return state.board.messages.filter((message) => message.taskId === task.id);
}

function activeAgentLines(): string[] {
  const runningRuns = state.board.runs.filter((run) => run.status === "running");
  const statuses = activeAgentStatuses();
  const externals = state.board.externalAgents ?? [];
  if (!statuses.length && !runningRuns.length && !externals.length && !state.busy) {
    return ["No agents are running.", "Start a selected task or run the board."];
  }
  const lines: string[] = [];
  if (state.busy) {
    lines.push(`${spinner[state.frame % spinner.length]} ${state.notice}`);
  }
  for (const status of statuses) {
    const task = state.board.tasks.find((item) => item.id === status.taskId);
    const risk = status.risk && status.risk !== "none" ? ` ! ${friendlyRisk(status.risk)}` : "";
    lines.push(
      `${spinner[state.frame % spinner.length]} ${task?.id ?? status.taskId}  ${
        friendlyPhase(status.phase)
      }${risk}`,
    );
    lines.push(`   ${short(status.headline, 60)}`);
    if (status.detail && status.detail !== status.headline) {
      lines.push(`   ${short(status.detail, 60)}`);
    }
    if (status.needsInputPrompt) {
      lines.push(`   Needs: ${short(status.needsInputPrompt, 52)}`);
    }
    if (status.lastSupervisorAction) {
      lines.push("   Supervisor sent guidance.");
    }
  }
  for (const run of runningRuns) {
    if (statuses.some((status) => status.runId === run.taskId || status.taskId === run.taskId)) {
      continue;
    }
    const task = state.board.tasks.find((item) => item.id === run.taskId);
    lines.push(`${spinner[state.frame % spinner.length]} Working on ${task?.title ?? run.taskId}`);
  }
  for (const agent of externals) {
    const marker = agent.state === "working"
      ? spinner[state.frame % spinner.length]
      : agent.state === "blocked"
      ? "!"
      : "·";
    lines.push(`${marker} ${agent.agent}  ${friendlyExternalState(agent.state)}`);
    if (agent.headline) {
      lines.push(`   ${short(agent.headline, 60)}`);
    }
  }
  return lines.length ? lines : ["No agents are running."];
}

function friendlyExternalState(value: ExternalAgentStatus["state"]): string {
  const labels: Record<ExternalAgentStatus["state"], string> = {
    working: "Working",
    blocked: "Needs Input",
    done: "Done",
    idle: "Idle",
  };
  return labels[value] ?? value;
}

function activeAgentStatuses(): AgentStatus[] {
  const runningRunIds = new Set(
    state.board.runs.filter((run) => run.status === "running").map((run) => run.id),
  );
  return (state.runtime?.activeAgentStatuses ?? state.board.agentStatuses).filter((status) =>
    runningRunIds.has(status.runId)
  );
}

function friendlyPhase(phase: string): string {
  const labels: Record<string, string> = {
    starting: "Starting",
    planning: "Planning",
    reading: "Reading",
    editing: "Editing",
    running: "Running",
    testing: "Testing",
    reviewing: "Reviewing",
    merging: "Merging",
    blocked: "Blocked",
    done: "Done",
  };
  return labels[phase] ?? "Working";
}

function friendlyLoopPhase(phase: string): string {
  const labels: Record<string, string> = {
    queued: "Queued",
    planning: "Planning",
    working: "Working",
    testing: "Testing",
    repairing: "Repairing",
    reviewing: "Reviewing",
    remembering: "Remembering",
    done: "Done",
    blocked: "Needs Input",
  };
  return labels[phase] ?? friendlyPhase(phase);
}

function friendlyGate(gate: string): string {
  const labels: Record<string, string> = {
    waiting: "Waiting",
    context: "Reading Context",
    worktree: "Worktree",
    "context-manifest": "Task Packet",
    implementation: "Implementation",
    repair: "Repair",
    verification: "Verification",
    "test-engineer": "Verification",
    commit: "Commit",
    stopping: "Stopping",
    "automatic-review": "Review",
    review: "Review",
    merge: "Merge",
    "project-memory": "Project Memory",
    complete: "Complete",
    "needs-input": "Needs Input",
    stopped: "Stopped",
  };
  return labels[gate] ?? gate.replace(/[-_]/g, " ");
}

function friendlyRisk(risk: string): string {
  const labels: Record<string, string> = {
    low: "low",
    medium: "medium",
    high: "high",
    test_failed: "test failed",
    conflict: "conflict",
    stale: "stale",
    needs_user: "needs input",
    session: "session",
  };
  return labels[risk] ?? risk;
}

function buildTaskBoardRows(): TaskBoardRow[] {
  const active = orderedActiveTasks();
  const blocked = state.board.tasks.filter((task) => task.status === "blocked");
  const done = state.board.tasks.filter((task) => task.status === "done");
  const rows = [
    ...taskSectionRows("Working / Ready", active, "No active tasks."),
    ...taskSectionRows("Needs Input", blocked, "Nothing needs input."),
    ...taskSectionRows("Done", done, "No completed tasks yet."),
  ];
  if (state.board.ideas.length) {
    rows.push({ content: " Ideas (scout)", task: null });
    rows.push(...state.board.ideas.map((idea) => ({
      content: `${idea.id === state.selectedIdeaId ? ">" : " "} ◇ ${idea.id} ${
        short(idea.title, 30)
      }`,
      task: null,
      idea,
    })));
    rows.push({ content: "", task: null });
  }
  return rows;
}

function taskSectionRows(title: string, tasks: Task[], empty: string): TaskBoardRow[] {
  const rows: TaskBoardRow[] = [{ content: ` ${title}`, task: null }];
  if (!tasks.length) {
    rows.push({ content: `   ${empty}`, task: null });
  } else {
    rows.push(
      ...tasks.map((task) => ({ content: taskLine(task, task.id === state.selectedTaskId), task })),
    );
  }
  rows.push({ content: "", task: null });
  return rows;
}

function mainThreadLines(): string[] {
  const goal = activeGoalProgress();
  const closedGoals = summarizeClosedGoals(state.board, 2);
  return [
    "Project Health",
    ...formatHealthLines(state.board).slice(0, 4),
    state.runtime?.rescue?.enabled
      ? `Rescue: ${state.runtime.rescue.backend} after ${state.runtime.rescue.afterAttempts} tries`
      : "Rescue: off",
    state.runtime?.planner?.enabled
      ? `Planner: ${state.runtime.planner.backend}`
      : "Planner: main backend",
    state.runtime?.scout?.enabled
      ? `Scout: ${state.runtime.scout.backend} (${state.board.ideas.length} ideas pending)`
      : "Scout: off",
    (() => {
      const manual = listManualVerificationItems(state.board);
      return manual.length
        ? `Verify by hand: ${manual.length} task${manual.length === 1 ? "" : "s"} (see standup)`
        : "Verify by hand: none pending";
    })(),
    "",
    `Memory thread: ${state.board.projectState.mainThreadId ?? "not started"}`,
    `Created: ${state.board.projectState.mainThreadCreatedAt ?? "not started"}`,
    "",
    "Current Goal",
    ...(goal
      ? [
        `${goal.goal.id} ${goal.status}  ${goal.done}/${goal.total} done (${goal.percentDone}%)`,
        ...wrap(goal.goal.text, 44).slice(0, 3),
        ...wrap(`Contract: ${goal.goal.completionContract}`, 44).slice(0, 3),
        `Verdict: ${goal.completionVerdict}`,
        ...winConditionLines(goal.goal.id),
        `Evidence gaps: ${goal.evidenceGaps.length}`,
        ...goal.evidenceGaps.slice(0, 2).flatMap((gap) => wrap(`- ${gap}`, 44).slice(0, 2)),
        `Next: ${short(goal.nextAction, 38)}`,
      ]
      : ["No goal planned yet."]),
    "",
    "Closed Goals",
    ...(closedGoals.length
      ? closedGoals.flatMap((item) => [
        `${item.id} ${item.closedAt ?? ""}`,
        ...wrap(item.text, 44).slice(0, 2),
      ]).slice(0, 6)
      : ["No closed goals yet."]),
    "",
    ...wrap(state.board.projectState.mainThreadSummary || "No project summary yet.", 44).slice(
      0,
      2,
    ),
  ];
}

function winConditionLines(goalId: string): string[] {
  const probes = (state.board.probes ?? []).filter((probe) => probe.goalId === goalId);
  if (!probes.length) {
    return [];
  }
  const passed = probes.filter((probe) => probe.lastStatus === "passed").length;
  const lights = probes
    .map((probe) => probe.lastStatus === "passed" ? "●" : probe.lastStatus === "failed" ? "○" : "◌")
    .join("");
  return [`Win: ${passed}/${probes.length} ${lights}`];
}

function statusHeadline(): string {
  const runningRuns = state.board.runs.filter((run) => run.status === "running");
  const blocked = state.board.tasks.filter((task) => task.status === "blocked");
  if (state.busy) {
    return `LoopForge is working: ${state.notice}`;
  }
  if (runningRuns.length) {
    const titles = runningRuns.map((run) =>
      state.board.tasks.find((task) => task.id === run.taskId)?.title ?? run.taskId
    );
    return `LoopForge is working on ${short(titles.join(", "), 100)}`;
  }
  if (blocked.length) {
    return `${blocked.length} task${blocked.length === 1 ? "" : "s"} need input`;
  }
  const goal = activeGoalProgress();
  if (goal?.completionReady) {
    return `${goal.goal.id} ready to close`;
  }
  const review = state.board.tasks.filter((task) => task.status === "review");
  if (review.length) {
    return `${review.length} task${review.length === 1 ? "" : "s"} ready for Review & Merge`;
  }
  const ready = state.board.tasks.filter((task) =>
    task.status === "ready" || task.status === "inbox"
  );
  if (ready.length) {
    return `${ready.length} task${ready.length === 1 ? "" : "s"} ready to start`;
  }
  const done = state.board.tasks.filter((task) => task.status === "done");
  if (done.length) {
    return `${done.length} completed task${done.length === 1 ? "" : "s"} on the board`;
  }
  return `LoopForge Command Center  ${state.board.tasks.length} tasks`;
}

function selectedTask(): Task | null {
  if (state.selectedIdeaId) {
    return null;
  }
  return state.board.tasks.find((task) => task.id === state.selectedTaskId) ?? null;
}

function selectedIdea(): IdeaLite | null {
  return state.board.ideas.find((idea) => idea.id === state.selectedIdeaId) ?? null;
}

function selectIdea(ideaId: string): void {
  const idea = state.board.ideas.find((item) => item.id === ideaId);
  if (idea) {
    state.selectedIdeaId = idea.id;
    state.scroll.taskDetails = 0;
    state.notice = `Idea ${idea.id}: approve with y, reject with n.`;
  }
}

function ideaDetails(idea: IdeaLite): string[] {
  return [
    `${idea.id}  ${idea.title}`,
    idea.buildsOn ? `Builds on: ${idea.buildsOn}` : "",
    "",
    ...idea.pitch.split("\n").flatMap((line) => wrap(line, 44)),
    ...(idea.sources.length ? ["", "Sources:", ...idea.sources.map((url) => `- ${url}`)] : []),
    "",
    "Approve (y) compiles this into a goal with tasks",
    "and win conditions in Ready. Reject (n) removes it",
    "and the scout never re-pitches it.",
  ].filter((line, index, lines) => line !== "" || lines[index - 1] !== "");
}

function ensureSelection(): void {
  if (state.selectedTaskId && state.board.tasks.some((task) => task.id === state.selectedTaskId)) {
    return;
  }
  state.selectedTaskId = orderedTasks()[0]?.id ?? null;
}

function moveSelection(delta: number): void {
  const items: Array<{ kind: "task" | "idea"; id: string }> = [
    ...orderedTasks().map((task) => ({ kind: "task" as const, id: task.id })),
    ...state.board.ideas.map((idea) => ({ kind: "idea" as const, id: idea.id })),
  ];
  if (!items.length) {
    return;
  }
  const selectedId = state.selectedIdeaId ?? state.selectedTaskId;
  const current = Math.max(0, items.findIndex((item) => item.id === selectedId));
  const next = items[(current + delta + items.length) % items.length];
  if (next.kind === "idea") {
    selectIdea(next.id);
  } else {
    selectTask(next.id);
  }
}

function openPrompt(mode: AppState["promptMode"], notice: string): void {
  state.promptMode = mode;
  state.input = "";
  state.notice = notice;
}

function deleteSelectedTask(): void {
  const task = selectedTask();
  if (!task) {
    state.notice = "Select a task to delete.";
    return;
  }
  void runAction(`Delete ${task.title}`, () => del(`/api/tasks/${task.id}`));
}

function clearDoneTasks(): void {
  const count = state.board.tasks.filter((task) => task.status === "done").length;
  if (!count) {
    state.notice = "No completed tasks to clear.";
    return;
  }
  void runAction(
    "Clear completed tasks",
    () => del("/api/tasks/done"),
    {
      started: "Clearing completed tasks...",
      complete: `Cleared ${count} completed task${count === 1 ? "" : "s"}.`,
    },
  );
}

function compactProjectMemory(): void {
  if (!state.board.projectState.mainThreadId) {
    state.notice = "Project memory has not started yet.";
    return;
  }
  void runAction(
    "Compact project memory",
    () => post("/api/main/compact", {}),
    {
      started: "Compacting project memory...",
      complete: "Project memory compaction requested.",
    },
  );
}

function stopSelectedTask(): void {
  const task = selectedTask();
  if (!task) {
    state.notice = "Select a running task to stop.";
    return;
  }
  if (!isTaskRunning(task.id)) {
    state.notice = `${task.title} is not running.`;
    return;
  }
  void runAction(
    `Stop ${task.title}`,
    () => post(`/api/tasks/${task.id}/stop`, {}),
    {
      started: `Stopping ${task.title}...`,
      complete: `Stop requested for ${task.title}.`,
    },
  );
}

function isTaskRunning(taskId: string): boolean {
  return state.board.runs.some((run) => run.taskId === taskId && run.status === "running");
}

function orderedTasks(): Task[] {
  return [
    ...orderedActiveTasks(),
    ...state.board.tasks.filter((task) => task.status === "blocked"),
    ...state.board.tasks.filter((task) => task.status === "done"),
  ];
}

function orderedActiveTasks(): Task[] {
  return state.board.tasks.filter((task) =>
    task.status === "inbox" || task.status === "ready" || task.status === "in_progress" ||
    task.status === "review" || task.status === "merging"
  );
}

function valueAfter(name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
}

function promptLabel(mode: AppState["promptMode"]): string {
  if (mode === "build-goal") return "Build goal:";
  if (mode === "goal") return "Plan goal:";
  if (mode === "task") return "New task:";
  if (mode === "steer") return "Add input:";
  if (mode === "reset-main") return "Reset memory:";
  return "";
}

function short(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function wrap(value: string, max: number): string[] {
  const words = value.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (!line) {
      line = word;
    } else if (`${line} ${word}`.length > max) {
      lines.push(line);
      line = word;
    } else {
      line = `${line} ${word}`;
    }
  }
  if (line) {
    lines.push(line);
  }
  return lines.length ? lines : [""];
}

function promptPreview(): string {
  const label = promptLabel(state.promptMode);
  const cursor = state.frame % 2 ? " " : "_";
  const preview = short(state.input || "", 150);
  const count = state.input.length ? ` ${state.input.length} chars` : "";
  return `${label}${count} ${preview}${cursor}`;
}

// Footer buttons handle their own clicks via native onMouseDown; only the
// task rail needs coordinate zones (its rows scroll under a virtual list).
function buildHitZones(): HitZone[] {
  const width = Number(process.env.COLUMNS) || 120;
  const taskRailWidth = Math.floor(width * 0.31);
  const taskRowsTop = 6 + flowBandHeight();
  const zones: HitZone[] = [];
  for (let index = 0; index < taskBoardRows.length; index++) {
    const task = taskBoardRows[index].task;
    if (!task) {
      continue;
    }
    zones.push({
      x1: 1,
      x2: taskRailWidth,
      y1: taskRowsTop + index,
      y2: taskRowsTop + index,
      run: () => selectTask(task.id),
    });
  }
  return zones;
}

function parseMouseSequence(sequence: string): MouseInput | null {
  if (!sequence.startsWith(String.fromCharCode(27) + "[<")) {
    return null;
  }
  const suffix = sequence.at(-1);
  if (suffix !== "M") {
    return null;
  }
  const parts = sequence.slice(3, -1).split(";");
  if (parts.length !== 3) {
    return null;
  }
  const button = Number(parts[0]);
  const x = Number(parts[1]);
  const y = Number(parts[2]);
  if (!Number.isFinite(button) || !Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  const baseButton = button & ~28;
  if (baseButton === 64) {
    return { kind: "wheel-up", x, y };
  }
  if (baseButton === 65) {
    return { kind: "wheel-down", x, y };
  }
  if (button <= 2) {
    return { kind: "click", x, y };
  }
  return null;
}

function handleMouseInput(input: MouseInput): void {
  if (input.kind !== "click") {
    handleWheel(input);
    return;
  }
  const action = hitZones.find((zone) =>
    input.x >= zone.x1 && input.x <= zone.x2 && input.y >= zone.y1 && input.y <= zone.y2
  );
  if (action) {
    action.run();
    render();
  }
}

function handleWheel(input: MouseInput): void {
  const { width, height } = terminalDimensions();
  const taskRailWidth = Math.floor(width * 0.31);
  const centerWidth = Math.floor(width * 0.39);
  const contentTop = 4 + flowBandHeight();
  const contentBottom = height - 4;
  if (input.x <= taskRailWidth) {
    moveSelection(input.kind === "wheel-up" ? -1 : 1);
    render();
    return;
  }
  const panel = scrollPanelAt(
    input.x,
    input.y,
    taskRailWidth,
    centerWidth,
    contentTop,
    contentBottom,
  );
  if (panel) {
    scrollPanel(panel, input.kind === "wheel-up" ? -3 : 3);
    render();
  }
}

function terminalDimensions(): { width: number; height: number } {
  return {
    width: renderer.width || renderer.terminalWidth || Number(process.env.COLUMNS) || 120,
    height: renderer.height || renderer.terminalHeight || Number(process.env.LINES) || 36,
  };
}

function scrollPanelAt(
  x: number,
  y: number,
  taskRailWidth: number,
  centerWidth: number,
  contentTop: number,
  contentBottom: number,
): ScrollPanelId | null {
  if (y < contentTop || y > contentBottom) {
    return null;
  }
  const centerStart = taskRailWidth + 1;
  const centerEnd = taskRailWidth + centerWidth;
  if (x >= centerStart && x <= centerEnd) {
    const centerHeight = contentBottom - contentTop + 1;
    const detailsEnd = contentTop + Math.floor(centerHeight * 0.66);
    return y <= detailsEnd ? "taskDetails" : "activeAgents";
  }
  if (x > centerEnd) {
    const rightHeight = contentBottom - contentTop + 1;
    const memoryEnd = contentTop + Math.floor(rightHeight * 0.36);
    return y <= memoryEnd ? "projectMemory" : "activity";
  }
  return null;
}

function scrollPanel(panel: ScrollPanelId, delta: number): void {
  state.scroll[panel] = Math.max(0, state.scroll[panel] + delta);
}

function selectTask(taskId: string): void {
  const task = state.board.tasks.find((item) => item.id === taskId);
  if (task) {
    if (state.selectedTaskId !== task.id) {
      state.scroll.taskDetails = 0;
    }
    state.selectedTaskId = task.id;
    state.selectedIdeaId = null;
    state.notice = `Selected ${task.id}.`;
  }
}
