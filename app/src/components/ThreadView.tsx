import type { Goal } from "../types";

// Wave-C placeholder for the per-loop thread view. Shows the selected goal's id
// + title, or a prompt when nothing is selected.
export function ThreadView({ goal }: { goal: Goal | null }) {
  if (!goal) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-slate-500">
        <div className="text-lg">Select a loop to view its thread.</div>
      </div>
    );
  }
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-slate-500">
      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-slate-500">
        {goal.id}
      </span>
      <div className="max-w-md text-lg text-slate-700">{goal.text}</div>
      <div className="text-sm text-slate-400">Thread view lands in the next wave.</div>
    </div>
  );
}
