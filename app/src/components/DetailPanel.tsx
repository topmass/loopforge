import { useStore } from "../store";

// Clicking a task or sub-agent shows what it is + everything the looping agent
// recorded about it: its status, the evidence/notes the agent wrote, and (for a
// sub-agent) its branch and merge state, plus a timeline of related events.
// Rendered as the right panel's "Detail" tab (RightPanel supplies the column +
// tab bar), so this returns the header + body directly.
export function DetailPanel() {
  const selectedTaskId = useStore((s) => s.selectedTaskId);
  const planByGoal = useStore((s) => s.planByGoal);
  const subagentsByGoal = useStore((s) => s.subagentsByGoal);
  const lifecycle = useStore((s) => s.lifecycle);
  const selectTask = useStore((s) => s.selectTask);
  // The panel is persistent now (a tab, not a swap), so an empty selection shows
  // a gentle prompt instead of collapsing the whole column.
  if (!selectedTaskId) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-slate-400">
        Select a task or sub-agent to see what the agent recorded.
      </div>
    );
  }

  // The board is project-wide, so a selected card can belong to any goal - look
  // it up by title across every goal's plan / sub-agents, not just the active.
  const step = Object.values(planByGoal).flat().find((s) => s.title === selectedTaskId);
  const sub = Object.values(subagentsByGoal).flat().find((s) => s.title === selectedTaskId);
  const isSub = Boolean(sub);
  const related = lifecycle
    .filter((e) => e.taskId === selectedTaskId || e.data?.title === selectedTaskId)
    .slice(-20);
  // For a sub-agent, the agent's recorded note is the latest merge/progress
  // summary it reported back (its plan steps have no inline note field).
  const subNote = isSub
    ? related.filter((e) => e.kind === "subagent.merged" || e.kind === "subagent.progress").at(-1)
      ?.summary ?? null
    : null;

  const statusLabel = sub
    ? sub.state === "merged" ? "merged" : "running"
    : step?.status ?? "unknown";
  const statusColor = statusLabel === "done" || statusLabel === "merged"
    ? "bg-emerald-100 text-emerald-700"
    : statusLabel === "doing" || statusLabel === "running"
    ? "bg-orange-100 text-orange-700"
    : "bg-slate-300/20 text-slate-700";

  return (
    <>
      <div className="flex items-start justify-between gap-2 border-b border-slate-200 px-4 py-3">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            {isSub ? "Sub-agent" : "Task"}
          </div>
          <div className="truncate text-sm font-semibold text-slate-900">{selectedTaskId}</div>
        </div>
        <button type="button" onClick={() => selectTask(null)} className="text-slate-500 hover:text-slate-800">
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${statusColor}`}>
          {statusLabel}
        </span>

        {(step?.note || subNote) && (
          <div className="mt-3">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              What the agent recorded
            </div>
            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{step?.note ?? subNote}</p>
          </div>
        )}

        {isSub && (
          <div className="mt-3 rounded-md border border-violet-200 bg-violet-50 p-2 text-xs text-violet-700">
            Runs in its own worktree/branch, then merges back into the goal branch.
            {sub!.state === "merged" ? " Merged ✓" : " Working now…"}
          </div>
        )}

        {!step?.note && !subNote && !isSub && (
          <p className="mt-3 text-sm text-slate-500">
            No notes yet - the agent fills this in as it works this item.
          </p>
        )}

        {related.length > 0 && (
          <div className="mt-4">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Timeline
            </div>
            <div className="mt-1">
              {related.map((e, i) => (
                <div key={i} className="border-b border-slate-100 py-1.5 text-xs">
                  <span className="text-slate-500">{e.kind}</span>
                  <div className="text-slate-700">{e.summary.slice(0, 200)}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
