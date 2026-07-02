import { useStore } from "../store";

// The lifecycle stream, rendered as the right panel's "Activity" tab (the tab
// bar in RightPanel supplies the column + header, so this is just the list).
export function ActivityDrawer() {
  const lifecycle = useStore((s) => s.lifecycle);
  const recent = lifecycle.slice(-80).reverse();
  const color: Record<string, string> = {
    "goal.blocked": "text-warn-ink",
    "verified": "text-ok",
    "goal.closed": "text-ok",
    "subagent.spawned": "text-voice-1",
    "subagent.merged": "text-voice-1",
    "plan.updated": "text-ink-muted",
  };
  return (
    <div className="flex-1 overflow-y-auto p-3 text-xs">
      {recent.length === 0
        ? <div className="text-ink-faint">No lifecycle activity yet.</div>
        : recent.map((e, i) => (
          <div key={i} className="mb-2 border-b border-line pb-2">
            <span className={color[e.kind] ?? "text-ink-muted"}>{e.kind}</span>
            <div className="text-ink">{e.summary.slice(0, 200)}</div>
          </div>
        ))}
    </div>
  );
}
