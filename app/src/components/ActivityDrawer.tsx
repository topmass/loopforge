import { useStore } from "../store";

// The lifecycle stream, rendered as the right panel's "Activity" tab (the tab
// bar in RightPanel supplies the column + header, so this is just the list).
export function ActivityDrawer() {
  const lifecycle = useStore((s) => s.lifecycle);
  const recent = lifecycle.slice(-80).reverse();
  const color: Record<string, string> = {
    "goal.blocked": "text-amber-700",
    "verified": "text-emerald-600",
    "goal.closed": "text-emerald-600",
    "subagent.spawned": "text-sky-400",
    "subagent.merged": "text-sky-400",
    "plan.updated": "text-slate-500",
  };
  return (
    <div className="flex-1 overflow-y-auto p-3 text-xs">
      {recent.length === 0
        ? <div className="text-slate-400">No lifecycle activity yet.</div>
        : recent.map((e, i) => (
          <div key={i} className="mb-2 border-b border-slate-100 pb-2">
            <span className={color[e.kind] ?? "text-slate-500"}>{e.kind}</span>
            <div className="text-slate-700">{e.summary.slice(0, 200)}</div>
          </div>
        ))}
    </div>
  );
}
