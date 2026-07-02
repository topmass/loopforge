import { useStore } from "../store";
import { STATUS } from "./ui";

export type CenterTab = "board" | "thread";

// The center column's tab row: Board (the kanban, default) and Thread (the
// per-loop conversation view). Tab choice is App state, reset to Board on
// project switch. The Thread tab shows a subtle live dot when the active goal
// emitted loop activity in the last 2 minutes (reuses loopActiveAt).
export function CenterTabs({ tab, onTab }: { tab: CenterTab; onTab: (t: CenterTab) => void }) {
  const activeGoalId = useStore((s) => s.activeGoalId);
  const lastActive = useStore((s) => (activeGoalId ? s.loopActiveAt[activeGoalId] : undefined));
  const live = lastActive !== undefined && Date.now() - lastActive < 120_000;
  const tabClass = (active: boolean) =>
    `rounded-md px-3 py-1 text-xs font-medium transition ${
      active ? "bg-ink text-surface" : "text-ink-muted hover:text-ink"
    }`;
  return (
    <div className="glass-soft flex items-center gap-1 border-x-0 border-t-0 border-b border-line px-3 py-1.5">
      <button type="button" onClick={() => onTab("board")} className={tabClass(tab === "board")}>
        Board
      </button>
      <button
        type="button"
        onClick={() => onTab("thread")}
        className={`flex items-center gap-1.5 ${tabClass(tab === "thread")}`}
      >
        Thread
        {live && <span className={`h-1.5 w-1.5 rounded-full ${STATUS.live.dot}`} />}
      </button>
    </div>
  );
}
