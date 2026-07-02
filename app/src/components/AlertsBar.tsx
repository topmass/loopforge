import { useState } from "react";
import { useStore } from "../store";
import { api } from "../api";

// Fail-checkin surface: blocked decision briefs and manual-verification holds,
// the two moments the system needs the human. Each hold offers one-click
// sign-off (restart -> merge).
export function AlertsBar() {
  const board = useStore((s) => s.board);
  const lifecycle = useStore((s) => s.lifecycle);
  const [busy, setBusy] = useState<string | null>(null);

  const holds = (board?.tasks ?? []).filter((t) => t.currentGate === "manual-verification");
  const closedGoals = new Set(
    (board?.goals ?? []).filter((g) => g.status === "closed").map((g) => g.id),
  );
  // A blocked brief is live only while it is the goal's LATEST lifecycle
  // signal - any later event (the steer answer's task.added, plan.updated from
  // resumed work) means the loop moved on and the ask is stale.
  const lastEventIdx = new Map<string, number>();
  const lastBlockedIdx = new Map<string, number>();
  lifecycle.forEach((e, i) => {
    if (!e.goalId) return;
    lastEventIdx.set(e.goalId, i);
    if (e.kind === "goal.blocked") lastBlockedIdx.set(e.goalId, i);
  });
  const blocked = [...lastBlockedIdx.entries()]
    .filter(([goalId, i]) => !closedGoals.has(goalId) && lastEventIdx.get(goalId) === i)
    .map(([, i]) => lifecycle[i])
    .slice(-3);

  if (!holds.length && !blocked.length) return null;

  const signOff = async (taskId: string) => {
    setBusy(taskId);
    try {
      await api.runTask(taskId);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="border-b border-warn bg-warn-soft">
      {blocked.map((e, i) => (
        <div key={`b-${i}`} className="flex items-start gap-2 px-4 py-2 text-sm">
          <span className="mt-0.5 text-warn-ink">needs you</span>
          <span className="text-warn-ink">{e.summary}</span>
        </div>
      ))}
      {holds.map((t) => (
        <div key={t.id} className="flex items-center gap-3 px-4 py-2 text-sm">
          <span className="text-warn-ink">verify by hand</span>
          <span className="flex-1 truncate text-warn-ink">
            {t.needsInputPrompt?.split("\n")[0] ?? t.title}
          </span>
          <button
            type="button"
            onClick={() => void signOff(t.id)}
            disabled={busy === t.id}
            className="rounded-md bg-ok px-3 py-1 text-xs font-medium text-on-accent disabled:opacity-50"
          >
            {busy === t.id ? "merging..." : "Verify & merge"}
          </button>
        </div>
      ))}
    </div>
  );
}
