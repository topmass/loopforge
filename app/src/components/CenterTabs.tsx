export type CenterTab = "board" | "thread";

// The center column's tab row: Board (the kanban, default) and Thread (the
// per-loop conversation view landing in Wave C). Tab choice is App state, reset
// to Board on project switch.
export function CenterTabs({ tab, onTab }: { tab: CenterTab; onTab: (t: CenterTab) => void }) {
  const tabClass = (active: boolean) =>
    `rounded-md px-3 py-1 text-xs font-medium transition ${
      active ? "bg-slate-900 text-white" : "text-slate-500 hover:text-slate-800"
    }`;
  return (
    <div className="glass-soft flex items-center gap-1 border-x-0 border-t-0 border-b border-slate-200 px-3 py-1.5">
      <button type="button" onClick={() => onTab("board")} className={tabClass(tab === "board")}>
        Board
      </button>
      <button type="button" onClick={() => onTab("thread")} className={tabClass(tab === "thread")}>
        Thread
      </button>
    </div>
  );
}
