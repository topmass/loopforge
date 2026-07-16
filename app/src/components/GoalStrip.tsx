import { useStore } from "../store";
import { api } from "../api";
import { STATUS, useArmedDelete } from "./ui";

// A slim strip of the OPEN goals above the board - clicking one makes it the
// steering target for the ChatBar and the win-conditions / detail context. Open
// goals only; closed goals live in the board's Done column instead.
export function GoalStrip() {
  const board = useStore((s) => s.board);
  const activeGoalId = useStore((s) => s.activeGoalId);
  const setActiveGoal = useStore((s) => s.setActiveGoal);
  const loopActiveAt = useStore((s) => s.loopActiveAt);
  const { armed, arm, disarm } = useArmedDelete();
  const open = (board?.goals ?? []).filter((g) => g.status === "open");
  const tasks = board?.tasks ?? [];
  if (open.length === 0) return null;
  const now = Date.now();
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
      {open.map((g) => {
        const live = now - (loopActiveAt[g.id] ?? 0) < 90_000;
        const blocked = tasks.some((t) => t.goalId === g.id && t.status === "blocked");
        const active = g.id === activeGoalId;
        const isArmed = armed === g.id;
        const words = g.text.split(/\s+/).slice(0, 5).join(" ");
        return (
          <button
            key={g.id}
            type="button"
            onClick={() => setActiveGoal(g.id)}
            onMouseLeave={() => {
              if (armed === g.id) disarm();
            }}
            className={`group flex items-center gap-2 rounded-full border px-3 py-1 text-xs transition-colors ${
              isArmed
                ? "border-danger bg-danger-soft"
                : active
                ? "border-accent bg-accent-soft shadow-sm"
                : "border-line bg-surface-raised hover:border-line-strong"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                blocked ? STATUS.blocked.dot : live ? STATUS.live.dot : STATUS.idle.dot
              }`}
            />
            <span className="font-medium text-ink">{g.id}</span>
            <span className="max-w-[22ch] truncate text-ink-muted">{words}</span>
            {
              /* x arms; a second click within 4s removes. stopPropagation so the
                chip's select-on-click never fires from the x. */
            }
            <span
              role="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                if (isArmed) {
                  disarm();
                  void api.deleteGoal(g.id);
                } else {
                  arm(g.id);
                }
              }}
              className={isArmed
                ? "shrink-0 font-semibold text-danger"
                : "shrink-0 text-ink-faint opacity-0 transition hover:text-danger group-hover:opacity-100"}
            >
              {isArmed ? "remove?" : "×"}
            </span>
          </button>
        );
      })}
    </div>
  );
}
