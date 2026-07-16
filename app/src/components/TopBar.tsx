import { useStore } from "../store";
import { STATUS } from "./ui";

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
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const dot = conn === "live" ? "bg-ok" : conn === "down" ? "bg-danger" : "bg-warn";

  const role = (label: string, value: string, on = true) => (
    <button
      type="button"
      onClick={onSettings}
      className="flex items-center gap-1.5 rounded-full border border-line bg-surface-raised px-2.5 py-0.5 text-xs hover:border-line-strong"
      title="Open model settings"
    >
      <span className="text-ink-muted">{label}</span>
      <span className={on ? "text-ink" : "text-ink-faint"}>{value}</span>
    </button>
  );
  // The most recent loop/agent line is "what it's doing now".
  const now = [...activity].reverse().find((e) =>
    e.role === "loop" || e.role === "codex" || e.role === "lifecycle"
  );

  return (
    <header className="glass flex items-center gap-3 border-x-0 border-t-0 border-b border-line px-4 py-2.5">
      <span className="flex items-center gap-1.5 text-lg font-semibold tracking-tight">
        {/* open cycle glyph - a ring broken by an arrowhead, suggesting a loop */}
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4 text-accent"
          aria-hidden="true"
        >
          <path d="M20 12a8 8 0 1 1-2.34-5.66" />
          <path d="M20 4v4h-4" />
        </svg>
        <span>
          Loop<span className="text-accent">Forge</span>
        </span>
      </span>
      <button
        type="button"
        onClick={onSettings}
        title="Model settings"
        className="text-xs text-ink-muted hover:text-ink"
      >
        {runtime?.backend ?? "connecting..."} ⚙
      </button>
      {runtime && (
        <>
          {role("main", runtime.backendRaw ?? "?")}
          {role(
            "rescue",
            runtime.rescue?.enabled ? runtime.rescue.backend : "off",
            !!runtime.rescue?.enabled,
          )}
          {role(
            "planner",
            runtime.planner?.enabled ? runtime.planner.backend : "off",
            !!runtime.planner?.enabled,
          )}
          {role(
            "scout",
            runtime.scout?.enabled ? runtime.scout.backend : "off",
            !!runtime.scout?.enabled,
          )}
        </>
      )}
      {now && (
        <span className="ml-2 flex min-w-0 items-center gap-1.5 text-xs text-ink-muted">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS.live.dot}`} />
          <span className="truncate">{now.message.slice(0, 90)}</span>
        </span>
      )}
      <div className="ml-auto flex items-center gap-3">
        <button
          type="button"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          title={theme === "dark"
            ? "Switch to Paper Terminal (light)"
            : "Switch to Night Ops (dark)"}
          className="rounded-md border border-line px-2 py-1 text-xs text-ink-muted transition hover:text-ink"
        >
          {theme === "dark" ? "☀" : "☾"}
        </button>
        <button
          type="button"
          onClick={onActivity}
          className={`rounded-md border border-line px-3 py-1 text-xs ${
            activityActive ? "bg-ink text-surface" : "text-ink-muted hover:text-ink"
          }`}
        >
          Activity
        </button>
        <span className="flex items-center gap-1.5 text-xs text-ink-muted">
          <span className={`h-2 w-2 rounded-full ${dot}`} />
          {conn}
        </span>
      </div>
    </header>
  );
}
