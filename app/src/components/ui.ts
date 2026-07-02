import { useRef, useState } from "react";

// Shared spring - the soft, slightly bouncy motion of a calm home menu.
export const spring = { type: "spring", stiffness: 320, damping: 30 } as const;

// One status vocabulary for every dot / chip / pill in the app, so a "live"
// loop, a "done" step, and a "blocked" agent read identically wherever they
// appear. `dot` colors a status dot (live carries the radar pulse defined in
// index.css); `pill` is the border + soft fill + ink for an outlined status
// chip. blocked and held share the warn tone, split only by their label.
export type StatusKey = "live" | "done" | "blocked" | "held" | "idle";

export const STATUS: Record<StatusKey, { dot: string; pill: string; label: string }> = {
  live: { dot: "radar-dot text-accent bg-accent", pill: "border-accent bg-accent-soft text-accent-ink", label: "live" },
  done: { dot: "bg-ok", pill: "border-ok bg-ok-soft text-ok-ink", label: "done" },
  blocked: { dot: "bg-warn", pill: "border-warn bg-warn-soft text-warn-ink", label: "blocked" },
  held: { dot: "bg-warn", pill: "border-warn bg-warn-soft text-warn-ink", label: "held" },
  idle: { dot: "bg-ink-faint", pill: "border-line bg-surface-sunken text-ink-muted", label: "idle" },
};

// Arm-then-confirm for destructive row/chip actions: the first click on the x
// arms an id (auto-disarming after 4s); a second click within the window
// confirms. Shared by the project rows, the goal chips, and the loop rows so all
// three behave identically.
export function useArmedDelete() {
  const [armed, setArmed] = useState<string | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disarm = () => {
    if (armTimer.current) clearTimeout(armTimer.current);
    setArmed(null);
  };
  const arm = (id: string) => {
    if (armTimer.current) clearTimeout(armTimer.current);
    setArmed(id);
    armTimer.current = setTimeout(() => setArmed(null), 4000);
  };
  return { armed, arm, disarm };
}
