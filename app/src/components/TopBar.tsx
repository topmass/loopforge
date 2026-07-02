import { useStore } from "../store";

// The single top strip: brand, the model roles filling each seat, what the loop
// is doing right now, the Activity tab toggle, connection health, and the
// settings gear. Merges the old TopBar and StatusStrip into one slim bar. The
// role chips and now-line only appear once runtime has loaded; brand + conn dot
// always render (so "connecting..." is visible on first paint).
export function TopBar(
  { onSettings, onActivity, activityActive }: {
    onSettings: () => void;
    onActivity: () => void;
    activityActive: boolean;
  },
) {
  const conn = useStore((s) => s.conn);
  const runtime = useStore((s) => s.runtime);
  const activity = useStore((s) => s.activity);
  const dot = conn === "live" ? "bg-emerald-500" : conn === "down" ? "bg-red-400" : "bg-amber-400";

  const role = (label: string, value: string, on = true) => (
    <button
      type="button"
      onClick={onSettings}
      className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-xs hover:border-slate-600"
      title="Open model settings"
    >
      <span className="text-slate-500">{label}</span>
      <span className={on ? "text-slate-800" : "text-slate-400"}>{value}</span>
    </button>
  );
  // The most recent loop/agent line is "what it's doing now".
  const now = [...activity].reverse().find((e) =>
    e.role === "loop" || e.role === "codex" || e.role === "lifecycle"
  );

  return (
    <header className="glass flex items-center gap-3 border-x-0 border-t-0 border-b border-slate-200 px-4 py-2.5">
      <span className="text-lg font-semibold tracking-tight">
        Loop<span className="text-orange-600">Forge</span>
      </span>
      <button
        type="button"
        onClick={onSettings}
        title="Model settings"
        className="text-xs text-slate-500 hover:text-slate-800"
      >
        {runtime?.backend ?? "connecting..."} ⚙
      </button>
      {runtime && (
        <>
          {role("main", runtime.backendRaw ?? "?")}
          {role("rescue", runtime.rescue?.enabled ? runtime.rescue.backend : "off", !!runtime.rescue?.enabled)}
          {role("planner", runtime.planner?.enabled ? runtime.planner.backend : "off", !!runtime.planner?.enabled)}
          {role("scout", runtime.scout?.enabled ? runtime.scout.backend : "off", !!runtime.scout?.enabled)}
        </>
      )}
      {now && (
        <span className="ml-2 flex min-w-0 items-center gap-1.5 text-xs text-slate-500">
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-orange-500" />
          <span className="truncate">{now.message.slice(0, 90)}</span>
        </span>
      )}
      <div className="ml-auto flex items-center gap-3">
        <button
          type="button"
          onClick={onActivity}
          className={`rounded-md border border-slate-200 px-3 py-1 text-xs ${
            activityActive ? "bg-slate-900 text-white" : "text-slate-500 hover:text-slate-800"
          }`}
        >
          Activity
        </button>
        <span className="flex items-center gap-1.5 text-xs text-slate-500">
          <span className={`h-2 w-2 rounded-full ${dot}`} />
          {conn}
        </span>
      </div>
    </header>
  );
}
