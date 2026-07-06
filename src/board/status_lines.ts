import { BoardSnapshot } from "./types.ts";
import { summarizeClosedGoals, summarizeGoalProgress } from "./goal_progress.ts";

export function formatStatusLines(board: BoardSnapshot): string[] {
  const lines = board.statuses.map((status) => {
    const count = board.tasks.filter((task) => task.status === status.id).length;
    return `${status.label}: ${count}`;
  });
  const goal = summarizeGoalProgress(board);
  lines.push("");
  lines.push("Active goal:");
  if (goal) {
    lines.push(
      `${goal.goal.id}: ${goal.completionVerdict} - ${goal.done}/${goal.total} done (${goal.percentDone}%)`,
    );
    if (goal.goal.completionContract.trim()) {
      lines.push(`Contract: ${oneLine(goal.goal.completionContract, 120)}`);
    }
    lines.push(`Next: ${goal.nextAction}`);
    if (goal.evidenceGaps.length) {
      lines.push(`Evidence gaps: ${goal.evidenceGaps.length}`);
    }
  } else {
    lines.push("none");
  }
  const closed = summarizeClosedGoals(board, 3);
  lines.push("");
  lines.push("Recently closed goals:");
  if (!closed.length) {
    lines.push("none");
  } else {
    lines.push(
      ...closed.map((goal) =>
        `${goal.id}: ${goal.text}${goal.closureSummary ? ` - ${goal.closureSummary}` : ""}`
      ),
    );
  }
  return lines;
}

export function formatGoalLines(board: BoardSnapshot): string[] {
  if (!board.goals.length) {
    return ["No goals recorded."];
  }
  return board.goals.flatMap((goal) => {
    const progress = summarizeGoalProgress(board, goal.id);
    const heading = goal.status === "closed"
      ? `${goal.id} closed ${goal.closedAt ?? "unknown time"}`
      : `${goal.id} open`;
    const lines = [
      `${heading}: ${goal.text}`,
    ];
    if (progress) {
      lines.push(
        `  ${progress.completionVerdict} - ${progress.done}/${progress.total} done (${progress.percentDone}%)`,
      );
      if (progress.evidenceGaps.length) {
        lines.push(`  Evidence gaps: ${progress.evidenceGaps.length}`);
      }
    }
    if (goal.completionContract.trim()) {
      lines.push(`  Contract: ${oneLine(goal.completionContract, 140)}`);
    }
    if (goal.closureSummary) {
      lines.push(`  Closure: ${goal.closureSummary}`);
    }
    return lines;
  });
}

function oneLine(value: string, maxCharacters: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > maxCharacters ? `${text.slice(0, maxCharacters - 3)}...` : text;
}

// Tasks that merged or finished with "needs manual verification" notes in
// their evidence: the morning checklist for what only a human can confirm.
export interface ManualVerificationItem {
  taskId: string;
  title: string;
  notes: string[];
}

export function listManualVerificationItems(board: {
  tasks: Array<{
    id: string;
    title: string;
    status: string;
    validation: string;
    handoffSummary: string;
    verificationSummary: string;
  }>;
}): ManualVerificationItem[] {
  const items: ManualVerificationItem[] = [];
  for (const task of board.tasks) {
    if (!["done", "review", "merging"].includes(task.status)) {
      continue;
    }
    const text = [task.validation, task.handoffSummary, task.verificationSummary]
      .filter(Boolean).join("\n");
    const notes = [
      ...new Set(
        text.split(/\r?\n/)
          .map((line) => line.replace(/^[-*\s]+/, "").trim())
          .filter((line) => /needs manual verification/i.test(line)),
      ),
    ];
    if (notes.length) {
      items.push({ taskId: task.id, title: task.title, notes: notes.slice(0, 3) });
    }
  }
  return items;
}

export function formatHealthLines(board: BoardSnapshot): string[] {
  const goal = summarizeGoalProgress(board);
  const running = board.runs.filter((run) => run.status === "running").length;
  const staleAgents = board.agentStatuses.filter((status) => status.risk === "stale").length;
  const ready = board.tasks.filter((task) => task.status === "ready" || task.status === "inbox")
    .length;
  const working =
    board.tasks.filter((task) => task.status === "in_progress" || task.status === "merging").length;
  const needsInput = board.tasks.filter((task) => task.status === "blocked").length;
  const review = board.tasks.filter((task) => task.status === "review").length;
  const done = board.tasks.filter((task) => task.status === "done").length;
  const verdict = healthVerdict({
    hasMainThread: Boolean(board.projectState.mainThreadId),
    running,
    staleAgents,
    needsInput,
    review,
    ready,
    goalReady: goal?.completionReady ?? false,
    evidenceGaps: goal?.evidenceGaps.length ?? 0,
    totalTasks: board.tasks.length,
  });
  return [
    `Project health: ${verdict}`,
    `Main memory: ${
      board.projectState.mainThreadId ? `ready ${board.projectState.mainThreadId}` : "not started"
    }`,
    `Agents: ${running} running${staleAgents ? `, ${staleAgents} stale` : ""}`,
    `Tasks: ${ready} ready, ${working} working, ${needsInput} need input, ${review} review, ${done} done`,
    goal
      ? `Goal: ${goal.goal.id} ${goal.completionVerdict} ${goal.done}/${goal.total} done (${goal.percentDone}%)`
      : "Goal: none",
    ...(goal?.evidenceGaps.length ? [`Evidence gaps: ${goal.evidenceGaps.length}`] : []),
    `Next: ${healthNextAction(board, goal)}`,
  ];
}

function healthVerdict(input: {
  hasMainThread: boolean;
  running: number;
  staleAgents: number;
  needsInput: number;
  review: number;
  ready: number;
  goalReady: boolean;
  evidenceGaps: number;
  totalTasks: number;
}): string {
  if (!input.hasMainThread) return "Needs Project Memory";
  if (input.staleAgents || input.needsInput || input.evidenceGaps) return "Needs Attention";
  if (input.running) return "Working";
  if (input.goalReady) return "Ready To Close";
  if (input.review) return "Ready For Review & Merge";
  if (input.ready) return "Ready To Run";
  if (input.totalTasks) return "Idle With Completed Work";
  return "Idle";
}

function healthNextAction(
  board: BoardSnapshot,
  goal: ReturnType<typeof summarizeGoalProgress>,
): string {
  if (!board.projectState.mainThreadId) {
    return "Open the GUI or run `loopforge main ensure` to create project memory.";
  }
  if (board.agentStatuses.some((status) => status.risk === "stale")) {
    return "Inspect stale active agents before starting more work.";
  }
  const blocked = board.tasks.find((task) => task.status === "blocked");
  if (blocked) return `${blocked.id}: reply with the needed input.`;
  if (goal?.completionReady) return `${goal.goal.id}: close the goal.`;
  const review = board.tasks.find((task) => task.status === "review");
  if (review) return `${review.id}: run Review & Merge.`;
  const ready = board.tasks.find((task) => task.status === "ready" || task.status === "inbox");
  if (ready) return `${ready.id}: start the task or run ready tasks.`;
  if (goal?.evidenceGaps.length) {
    return `${goal.goal.id}: resolve evidence gaps before closing the goal.`;
  }
  if (board.tasks.some((task) => task.status === "done")) {
    return "Clear done tasks when you want a cleaner board.";
  }
  return "Create or build a goal.";
}
