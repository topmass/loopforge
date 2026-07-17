// Armed schedules (thread-first step 10): recurring, tightly-scoped action
// classes the server ticks while it runs. Deliberately NOT free-running
// autonomy - a schedule may re-check probes or run a scout pass (ideas still
// gate on human approval), and it can never start implementation work or
// approve a held merge. Runs are idempotent per interval: last_run_at is
// stamped before the action executes so a slow tick cannot double-fire.

import { BoardStore } from "../board/store.ts";
import { Schedule } from "../board/types.ts";
import { runGoalProbes } from "./goal_probes.ts";

export interface ScheduleDeps {
  // Goals whose loops are currently running - their probes are skipped (the
  // loop re-checks its own every turn, and probe runs would collide).
  listActiveLoops: () => string[];
  // Report a line into the front transcript (regressions, scout outcomes).
  report: (message: string) => void;
  // Kick one scout pass; resolves when done. Optional: projects without a
  // scout configuration simply skip scout schedules.
  runScoutPass?: () => Promise<void>;
  onBoardChanged?: () => void;
}

export function dueSchedules(store: BoardStore, now = Date.now()): Schedule[] {
  return store.listSchedules().filter((schedule) => {
    if (!schedule.enabled) {
      return false;
    }
    const last = schedule.lastRunAt ? Date.parse(schedule.lastRunAt) : 0;
    return now - last >= schedule.intervalMinutes * 60_000;
  });
}

export async function runDueSchedules(
  store: BoardStore,
  deps: ScheduleDeps,
  now = Date.now(),
): Promise<void> {
  for (const schedule of dueSchedules(store, now)) {
    // Stamp first: a crash or slow action must not double-fire the interval.
    store.stampScheduleRun(schedule.id);
    try {
      if (schedule.kind === "probe-recheck") {
        await recheckProbes(store, deps, schedule);
      } else if (schedule.kind === "scout") {
        await deps.runScoutPass?.();
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      deps.report(`[schedule ${schedule.kind} failed: ${detail.slice(0, 160)}]`);
    }
  }
}

// Re-run win conditions for closed and idle-open goals; a probe that was
// passing and now fails is a regression worth surfacing - stale evidence is
// how "done" quietly rots.
async function recheckProbes(
  store: BoardStore,
  deps: ScheduleDeps,
  schedule: Schedule,
): Promise<void> {
  const active = new Set(deps.listActiveLoops());
  const goals = store.getBoard().goals.filter((goal) =>
    (schedule.goalId ? goal.id === schedule.goalId : true) && !active.has(goal.id)
  );
  let changed = false;
  for (const goal of goals) {
    const probes = store.listProbes(goal.id);
    if (!probes.length) {
      continue;
    }
    const before = new Map(probes.map((probe) => [probe.id, probe.lastStatus]));
    // Closed goals' work is merged: probes run in the root. An idle open
    // goal's unmerged work lives in its loop worktree when one exists.
    const cwd = goal.status === "open" && goal.loopWorktree ? goal.loopWorktree : undefined;
    const summary = await runGoalProbes(store.root, store, goal.id, cwd ?? store.root);
    changed = true;
    const regressed = summary.results.filter((result) =>
      !result.passed && before.get(result.probe.id) === "passed"
    );
    if (regressed.length) {
      deps.report(
        `[schedule] ${goal.id} probe regression: ${
          regressed.map((result) => result.probe.label).join("; ").slice(0, 200)
        }`,
      );
    }
  }
  if (changed) {
    deps.onBoardChanged?.();
  }
}
