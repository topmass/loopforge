import { DetailPanel } from "./DetailPanel";
import { ActivityDrawer } from "./ActivityDrawer";
import { DiffPanel } from "./DiffPanel";

export type RightTab = "detail" | "activity" | "diff";

// The persistent right column: a fixed-width side panel with three tabs. Detail
// (default) shows the selected task; Activity shows the lifecycle stream; Diff
// shows the active goal's per-loop diff. The old logOpen toggle that swapped
// whole panels is gone - the panel stays mounted and the tabs switch its content.
export function RightPanel({ tab, onTab }: { tab: RightTab; onTab: (t: RightTab) => void }) {
  const tabClass = (active: boolean) =>
    `rounded-md px-3 py-1 text-xs font-medium transition ${
      active ? "bg-slate-900 text-white" : "text-slate-500 hover:text-slate-800"
    }`;
  return (
    <aside className="glass flex w-96 shrink-0 flex-col border-y-0 border-r-0 border-l border-slate-200">
      <div className="flex items-center gap-1 border-b border-slate-200 px-2 py-1.5">
        <button type="button" onClick={() => onTab("detail")} className={tabClass(tab === "detail")}>
          Detail
        </button>
        <button type="button" onClick={() => onTab("activity")} className={tabClass(tab === "activity")}>
          Activity
        </button>
        <button type="button" onClick={() => onTab("diff")} className={tabClass(tab === "diff")}>
          Diff
        </button>
      </div>
      {tab === "activity" ? <ActivityDrawer /> : tab === "diff" ? <DiffPanel /> : <DetailPanel />}
    </aside>
  );
}
