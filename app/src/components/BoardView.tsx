import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useStore } from "../store";
import { api } from "../api";
import { type WorkerChip, workerChips } from "../agent_status";
import type { PlanStep } from "../types";
import { spring, STATUS } from "./ui";
import { LineMark } from "./marks";
import { GoalStrip } from "./GoalStrip";
import { ProbePanel } from "./ProbePanel";

// A tiny muted pill tagging which goal a board card belongs to, shown only when
// more than one goal is open (a single open goal needs no disambiguation).
function GoalChip({ id }: { id: string }) {
  return (
    <span className="mb-1 inline-block rounded-full bg-surface-sunken px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-ink-muted">
      {id}
    </span>
  );
}

// Live per-task worker status the board already tracks (phase, what it's doing
// now, risk) - the TUI showed this; the web used to drop it. Rendered whenever
// any worker is running, regardless of whether the open goal has a plan yet.
function ActiveWorkersStrip(
  { chips, onSelect }: { chips: WorkerChip[]; onSelect: (taskId: string) => void },
) {
  if (chips.length === 0) return null;
  return (
    <div className="border-b border-line px-4 py-3">
      <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-muted">
        Active workers <span className="text-ink-faint">{chips.length} running</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {chips.map((chip) => (
          <button
            key={chip.key}
            type="button"
            onClick={() => chip.taskId && onSelect(chip.taskId)}
            className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm shadow-sm ${STATUS.live.pill}`}
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS.live.dot}`} />
            <span className="font-medium text-ink">{chip.label}</span>
            <span className="max-w-[32ch] truncate text-[11px] text-ink-muted" title={chip.detail}>
              {chip.detail}
            </span>
            {chip.tone
              ? (
                <span
                  className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${chip.tone.className}`}
                >
                  {chip.tone.label}
                </span>
              )
              : null}
          </button>
        ))}
      </div>
    </div>
  );
}

// Compact numbers for the loop telemetry strip: 41200 -> "41k".
function fmtTokens(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

// 8m, 62m -> "1h 2m".
function fmtElapsed(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// The project-wide board: one Kanban across ALL goals. To Do / In Progress pull
// from open goals; Done groups every goal's finished items (newest goal first)
// so the column IS the project's history and a fresh goal starts visually clean.
export function BoardView() {
  const board = useStore((s) => s.board);
  const planByGoal = useStore((s) => s.planByGoal);
  const activeGoalId = useStore((s) => s.activeGoalId);
  const subagents = useStore((s) => (activeGoalId ? s.subagentsByGoal[activeGoalId] : undefined)) ??
    [];
  const activeWorkers = useStore((s) => s.runtime?.activeAgentStatuses) ?? [];
  const externalAgents = useStore((s) => s.runtime?.externalAgents) ?? [];
  // Fallback OUTSIDE the selector: an inline `?? []` returns a fresh array per
  // call while board is null, and useSyncExternalStore treats the unstable
  // snapshot as an infinite update loop (React #185) now that Board mounts
  // before the first board snapshot arrives.
  const probes = useStore((s) => s.board?.probes) ?? [];
  const selectTask = useStore((s) => s.selectTask);
  // Win-conditions editor visibility (scoped goal only).
  const [probesOpen, setProbesOpen] = useState(false);

  const goals = board?.goals ?? [];
  const openGoals = goals.filter((g) => g.status === "open");
  // When a loop is selected the whole board is scoped to it; otherwise the
  // columns span every goal and cards/groups carry their goal id.
  const filtered = activeGoalId !== null;
  const showGoalChip = !filtered && openGoals.length > 1;
  const workers = workerChips(activeWorkers, externalAgents);

  // To Do / In Progress: the selected loop, or every open goal, tagged by id.
  const columnGoals = filtered ? goals.filter((g) => g.id === activeGoalId) : openGoals;
  const todo: { step: PlanStep; goalId: string }[] = [];
  const doing: { step: PlanStep; goalId: string }[] = [];
  for (const g of columnGoals) {
    for (const step of planByGoal[g.id] ?? []) {
      if (step.status === "todo") todo.push({ step, goalId: g.id });
      else if (step.status === "doing") doing.push({ step, goalId: g.id });
    }
  }
  // Done: the selected loop only, or every goal (newest goal group first: goals
  // arrive oldest first). Plan items append oldest first, so items within a
  // group read newest first. Empty groups are dropped.
  const doneSource = filtered ? goals.filter((g) => g.id === activeGoalId) : [...goals].reverse();
  const doneGroups = doneSource.map((g) => ({
    goal: g,
    done: (planByGoal[g.id] ?? []).filter((s) => s.status === "done").reverse(),
  })).filter((grp) => grp.done.length > 0);
  const doneCount = doneGroups.reduce((sum, grp) => sum + grp.done.length, 0);
  const anyContent = todo.length > 0 || doing.length > 0 || doneGroups.length > 0;

  const goalProbes = activeGoalId ? probes.filter((p) => p.goalId === activeGoalId) : [];
  const passed = goalProbes.filter((p) => p.lastStatus === "passed").length;
  const running = subagents.filter((s) => s.state === "running").length;
  // Live loop telemetry for the scoped goal: shown while the loop is active
  // (recent activity) and the goal is still open.
  const loopStatus = useStore((s) => (activeGoalId ? s.loopStatusByGoal[activeGoalId] : undefined));
  const statusActiveAt = useStore((s) => (activeGoalId ? s.loopActiveAt[activeGoalId] : undefined));
  const scopedGoal = activeGoalId ? goals.find((g) => g.id === activeGoalId) : undefined;
  const showLoopStatus = Boolean(
    loopStatus && scopedGoal?.status === "open" &&
      statusActiveAt !== undefined && Date.now() - statusActiveAt < 120_000,
  );
  // A merge held for the user's manual verification: surface the explicit
  // Approve action instead of asking them to find and restart a Review card.
  const mergeHold = activeGoalId
    ? (board?.tasks ?? []).find((t) =>
      t.goalId === activeGoalId && t.status === "review" &&
      t.currentGate === "manual-verification" && t.branchName
    )
    : undefined;

  if (goals.length === 0) {
    return <EmptyState />;
  }
  // No plan items on any goal yet: show the active goal's kickoff state
  // (planning indicator / working / run-the-loop), which IdlePlan resolves.
  if (!anyContent) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <GoalStrip />
        <ActiveWorkersStrip chips={workers} onSelect={selectTask} />
        {activeGoalId ? <IdlePlan goalId={activeGoalId} /> : <EmptyState />}
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <GoalStrip />
      {(goalProbes.length > 0 || showLoopStatus) && (
        <div className="flex items-baseline gap-3 border-b border-line px-4 py-2 text-xs text-ink-muted">
          {activeGoalId && (
            <button
              type="button"
              onClick={() => setProbesOpen(!probesOpen)}
              className="shrink-0 transition-colors hover:text-ink"
              title="Edit win conditions"
            >
              Win conditions: {passed}/{goalProbes.length} passing{" "}
              <span className="text-ink-faint">{probesOpen ? "▾" : "▸"}</span>
            </button>
          )}
          {showLoopStatus && loopStatus && (
            <span className="min-w-0 truncate text-ink-faint" title={loopStatus.reason}>
              iter {loopStatus.iteration}/{loopStatus.maxIterations} ·{" "}
              {fmtTokens(loopStatus.tokensUsed)} tok · {fmtElapsed(loopStatus.elapsedMs)}
              {loopStatus.reason ? ` · waiting on: ${loopStatus.reason}` : ""}
            </span>
          )}
        </div>
      )}
      {probesOpen && activeGoalId && (
        <ProbePanel
          goalId={activeGoalId}
          probes={goalProbes}
          loopLive={statusActiveAt !== undefined && Date.now() - statusActiveAt < 120_000}
        />
      )}
      {mergeHold && activeGoalId && (
        <div className="flex items-center gap-3 border-b border-warn bg-warn-soft px-4 py-2.5">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS.held.dot}`} />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-warn-ink">
              Merge held for your verification
            </div>
            <div
              className="truncate text-[11px] text-ink-muted"
              title={mergeHold.needsInputPrompt ?? ""}
            >
              {mergeHold.needsInputPrompt}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void api.approveMerge(activeGoalId)}
            className="shrink-0 rounded-xl bg-accent-strong px-3 py-1.5 text-xs font-semibold text-on-accent transition hover:opacity-90"
          >
            Approve merge
          </button>
        </div>
      )}
      <ActiveWorkersStrip chips={workers} onSelect={selectTask} />
      {/* Parallel sub-agents as a live strip - lit while coding, calm when merged. */}
      {subagents.length > 0 && (
        <div className="border-b border-line px-4 py-3">
          <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-muted">
            Sub-agents{" "}
            <span className="text-ink-faint">
              {running > 0 ? `${running} coding in parallel` : `${subagents.length} merged`}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <AnimatePresence initial={false}>
              {subagents.map((sa) => {
                const live = sa.state === "running";
                return (
                  <motion.button
                    layout
                    key={sa.title}
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={spring}
                    whileHover={{ y: -2 }}
                    type="button"
                    onClick={() => selectTask(sa.title)}
                    className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm ${
                      live ? `${STATUS.live.pill} shadow-sm` : STATUS.done.pill
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        live ? STATUS.live.dot : STATUS.done.dot
                      }`}
                    />
                    <span className="font-medium text-ink">
                      {sa.title.replace(/^Spawned sub-agent\s*/i, "")}
                    </span>
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                      {live ? "coding" : "merged"}
                    </span>
                  </motion.button>
                );
              })}
            </AnimatePresence>
          </div>
        </div>
      )}
      <div className="grid flex-1 grid-cols-3 gap-4 overflow-y-auto p-4">
        {/* To Do */}
        <div className="flex flex-col gap-2.5">
          <div className="px-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-muted">
            To do <span className="font-mono text-ink-faint">{todo.length}</span>
          </div>
          <AnimatePresence initial={false}>
            {todo.map(({ step, goalId }, i) => (
              <motion.button
                layout
                key={`todo-${goalId}-${step.title}`}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ ...spring, delay: Math.min(i * 0.03, 0.2) }}
                whileHover={{ y: -2 }}
                type="button"
                onClick={() => selectTask(step.title)}
                className="rounded-2xl border border-line bg-surface-raised p-3 text-left"
              >
                {showGoalChip && <GoalChip id={goalId} />}
                <div className="text-sm font-medium text-ink">{step.title}</div>
                {step.note && (
                  <div className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-ink-muted">
                    {step.note}
                  </div>
                )}
              </motion.button>
            ))}
          </AnimatePresence>
        </div>

        {/* In Progress */}
        <div className="flex flex-col gap-2.5">
          <div className="px-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-muted">
            In progress <span className="font-mono text-ink-faint">{doing.length}</span>
          </div>
          <AnimatePresence initial={false}>
            {doing.map(({ step, goalId }, i) => (
              <motion.button
                layout
                key={`doing-${goalId}-${step.title}`}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ ...spring, delay: Math.min(i * 0.03, 0.2) }}
                whileHover={{ y: -2 }}
                type="button"
                onClick={() => selectTask(step.title)}
                className="rounded-2xl border border-line-strong bg-surface-raised p-3 text-left shadow-sm"
              >
                {showGoalChip && <GoalChip id={goalId} />}
                <div className="flex items-center gap-2">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS.live.dot}`} />
                  <div className="text-sm font-medium text-ink">{step.title}</div>
                </div>
                {step.note && (
                  <div className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-ink-muted">
                    {step.note}
                  </div>
                )}
              </motion.button>
            ))}
          </AnimatePresence>
        </div>

        {/* Done: the project's history, grouped by goal (newest goal first). */}
        <div className="flex flex-col gap-2.5">
          <div className="px-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-muted">
            Done <span className="font-mono text-ink-faint">{doneCount}</span>
          </div>
          {doneGroups.map((grp) => (
            <div key={grp.goal.id} className="flex flex-col gap-2.5">
              {!filtered && (
                <div className="flex items-center gap-2 px-1 pt-1 text-[11px] text-ink-muted">
                  <span className="rounded-full bg-surface-sunken px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-ink-muted">
                    {grp.goal.id}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{grp.goal.text.slice(0, 40)}</span>
                  <span className="shrink-0 font-mono text-ink-faint">{grp.done.length} done</span>
                </div>
              )}
              <AnimatePresence initial={false}>
                {grp.done.map((step, i) => (
                  <motion.button
                    layout
                    key={`done-${grp.goal.id}-${step.title}`}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ ...spring, delay: Math.min(i * 0.03, 0.2) }}
                    whileHover={{ y: -2 }}
                    type="button"
                    onClick={() => selectTask(step.title)}
                    className="rounded-2xl border border-line bg-surface-sunken p-3 text-left"
                  >
                    <div className="text-sm font-medium text-ink-muted">{step.title}</div>
                    {step.note && (
                      <div className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-ink-muted">
                        {step.note}
                      </div>
                    )}
                  </motion.button>
                ))}
              </AnimatePresence>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-ink-muted">
      <LineMark variant="board" className="mb-1 h-12 w-12 text-ink-faint" />
      <div className="text-2xl">Describe a goal to begin</div>
      <div className="max-w-md text-sm text-ink-muted">
        Type what you want built below. LoopForge plans it, runs one agent that owns the goal, and
        shows its plan here live.
      </div>
    </div>
  );
}

// An open goal with no plan yet: its loop is not running. Offer to start it so
// the owning agent plans and works live - like kicking off a Codex goal.
function IdlePlan({ goalId }: { goalId: string }) {
  const loopActiveAt = useStore((s) => s.loopActiveAt[goalId]);
  const planning = useStore((s) => s.planningByGoal[goalId]);
  const working = loopActiveAt !== undefined && Date.now() - loopActiveAt < 120_000;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // Kickoff: the goal exists but planning is still compiling it into tasks and
  // win conditions. Calm indicator instead of the idle "start the loop" prompt.
  if (planning) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-ink-muted">
        <div className="flex items-center gap-2 text-lg">
          <span className={`h-2.5 w-2.5 rounded-full ${STATUS.live.dot}`} />
          Planning the goal
        </div>
        <div className="max-w-md text-sm text-ink-muted">
          Breaking it into tasks and win conditions...
        </div>
      </div>
    );
  }

  if (working) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-ink-muted">
        <div className="flex items-center gap-2 text-lg">
          <span className={`h-2.5 w-2.5 rounded-full ${STATUS.live.dot}`} />
          {goalId}: agent is working
        </div>
        <div className="max-w-md text-sm text-ink-muted">
          The owning agent is planning and acting now. Its plan appears here at the end of the
          current turn. Add a task below any time to steer it.
        </div>
      </div>
    );
  }

  const start = async () => {
    setBusy(true);
    setNote(null);
    try {
      await api.loopExistingGoal(goalId);
      setNote("Loop started - the agent is planning. Its plan will appear here live.");
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-ink-muted">
      <LineMark variant="board" className="h-12 w-12 text-ink-faint" />
      <div className="text-lg">No plan yet for {goalId}</div>
      <div className="max-w-md text-sm text-ink-muted">
        Start this goal's loop and one agent will own it - planning, working, and verifying - with
        its plan streaming here. Add tasks any time below to steer it.
      </div>
      <button
        type="button"
        onClick={() => void start()}
        disabled={busy}
        className="rounded-md bg-accent-strong px-4 py-2 text-sm font-medium text-on-accent disabled:opacity-50"
      >
        {busy ? "Starting..." : "Run this goal's loop"}
      </button>
      {note && <div className="max-w-md text-xs text-ink-muted">{note}</div>}
    </div>
  );
}
