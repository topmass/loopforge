import { useMemo, useState } from "react";
import { useStore } from "./store";
import { api } from "./api";
import type { PlanStep } from "./types";
import { NodeView } from "./NodeView";

export function App() {
  const conn = useStore((s) => s.conn);
  const runtime = useStore((s) => s.runtime);
  const board = useStore((s) => s.board);
  const activeGoalId = useStore((s) => s.activeGoalId);
  const [view, setView] = useState<"kanban" | "node">("kanban");

  const [logOpen, setLogOpen] = useState(false);
  const activeGoal = board?.goals.find((g) => g.id === activeGoalId) ?? null;

  return (
    <div className="flex h-full w-full flex-col">
      <TopBar
        conn={conn}
        backend={runtime?.backend}
        view={view}
        onView={setView}
        logOpen={logOpen}
        onToggleLog={() => setLogOpen((v) => !v)}
      />
      <AlertsBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-h-0 flex-1 flex-col">
          {!activeGoal
            ? <EmptyState />
            : view === "kanban"
            ? <KanbanView goalId={activeGoal.id} />
            : <NodeView goalId={activeGoal.id} />}
        </main>
        {logOpen ? <ActivityDrawer /> : <DetailPanel />}
      </div>
      <ChatBar activeGoalId={activeGoalId} hasOpenGoal={activeGoal?.status === "open"} />
    </div>
  );
}

// Fail-checkin surface: blocked decision briefs and manual-verification holds,
// the two moments the system needs the human. Each hold offers one-click
// sign-off (restart -> merge).
function AlertsBar() {
  const board = useStore((s) => s.board);
  const lifecycle = useStore((s) => s.lifecycle);
  const [busy, setBusy] = useState<string | null>(null);

  const holds = (board?.tasks ?? []).filter((t) => t.currentGate === "manual-verification");
  // Latest blocked event per goal that has not since closed.
  const closedGoals = new Set(
    (board?.goals ?? []).filter((g) => g.status === "closed").map((g) => g.id),
  );
  const blocked = lifecycle
    .filter((e) => e.kind === "goal.blocked" && e.goalId && !closedGoals.has(e.goalId))
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
    <div className="border-b border-amber-700/40 bg-amber-950/30">
      {blocked.map((e, i) => (
        <div key={`b-${i}`} className="flex items-start gap-2 px-4 py-2 text-sm">
          <span className="mt-0.5 text-amber-400">needs you</span>
          <span className="text-amber-100">{e.summary}</span>
        </div>
      ))}
      {holds.map((t) => (
        <div key={t.id} className="flex items-center gap-3 px-4 py-2 text-sm">
          <span className="text-amber-400">verify by hand</span>
          <span className="flex-1 truncate text-amber-100">
            {t.needsInputPrompt?.split("\n")[0] ?? t.title}
          </span>
          <button
            type="button"
            onClick={() => void signOff(t.id)}
            disabled={busy === t.id}
            className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
          >
            {busy === t.id ? "merging..." : "Verify & merge"}
          </button>
        </div>
      ))}
    </div>
  );
}

function ActivityDrawer() {
  const lifecycle = useStore((s) => s.lifecycle);
  const recent = lifecycle.slice(-80).reverse();
  const color: Record<string, string> = {
    "goal.blocked": "text-amber-400",
    "verified": "text-emerald-400",
    "goal.closed": "text-emerald-400",
    "subagent.spawned": "text-sky-400",
    "subagent.merged": "text-sky-400",
    "plan.updated": "text-slate-400",
  };
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-slate-800 bg-slate-900/40">
      <div className="border-b border-slate-800 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
        Activity
      </div>
      <div className="flex-1 overflow-y-auto p-3 text-xs">
        {recent.length === 0
          ? <div className="text-slate-600">No lifecycle activity yet.</div>
          : recent.map((e, i) => (
            <div key={i} className="mb-2 border-b border-slate-800/50 pb-2">
              <span className={color[e.kind] ?? "text-slate-500"}>{e.kind}</span>
              <div className="text-slate-300">{e.summary.slice(0, 200)}</div>
            </div>
          ))}
      </div>
    </aside>
  );
}

function TopBar(
  { conn, backend, view, onView, logOpen, onToggleLog }: {
    conn: string;
    backend?: string;
    view: "kanban" | "node";
    onView: (v: "kanban" | "node") => void;
    logOpen: boolean;
    onToggleLog: () => void;
  },
) {
  const dot = conn === "live" ? "bg-emerald-400" : conn === "down" ? "bg-red-400" : "bg-amber-400";
  return (
    <header className="flex items-center gap-4 border-b border-slate-800 bg-slate-900/60 px-4 py-2">
      <span className="text-lg font-semibold tracking-tight">
        Loop<span className="text-orange-400">Forge</span>
      </span>
      <span className="text-xs text-slate-400">{backend ?? "connecting..."}</span>
      <div className="ml-auto flex items-center gap-3">
        <button
          type="button"
          onClick={onToggleLog}
          className={`rounded-md border border-slate-700 px-3 py-1 text-xs ${
            logOpen ? "bg-slate-700 text-white" : "text-slate-400 hover:text-slate-200"
          }`}
        >
          Activity
        </button>
        <div className="flex overflow-hidden rounded-md border border-slate-700 text-xs">
          {(["kanban", "node"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => onView(v)}
              className={`px-3 py-1 capitalize ${
                view === v ? "bg-slate-700 text-white" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {v}
            </button>
          ))}
        </div>
        <span className="flex items-center gap-1.5 text-xs text-slate-400">
          <span className={`h-2 w-2 rounded-full ${dot}`} />
          {conn}
        </span>
      </div>
    </header>
  );
}

function Sidebar() {
  const board = useStore((s) => s.board);
  const activeGoalId = useStore((s) => s.activeGoalId);
  const setActiveGoal = useStore((s) => s.setActiveGoal);
  const goals = board?.goals ?? [];
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-slate-800 bg-slate-900/40">
      <div className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
        Spaces
      </div>
      <div className="flex-1 overflow-y-auto">
        {goals.length === 0 && (
          <div className="px-3 py-2 text-sm text-slate-500">No goal yet. Describe one below.</div>
        )}
        {goals.map((g) => (
          <button
            key={g.id}
            type="button"
            onClick={() => setActiveGoal(g.id)}
            className={`block w-full px-3 py-2 text-left text-sm ${
              g.id === activeGoalId ? "bg-slate-800 text-white" : "text-slate-300 hover:bg-slate-800/50"
            }`}
          >
            <span className="flex items-center gap-2">
              <span
                className={`h-2 w-2 rounded-full ${
                  g.status === "open" ? "bg-orange-400" : "bg-emerald-400"
                }`}
              />
              <span className="truncate">{g.text}</span>
            </span>
            <span className="text-xs text-slate-500">{g.id} · {g.status}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}

function planColumns(steps: PlanStep[]) {
  return {
    todo: steps.filter((s) => s.status === "todo"),
    doing: steps.filter((s) => s.status === "doing"),
    done: steps.filter((s) => s.status === "done"),
  };
}

function KanbanView({ goalId }: { goalId: string }) {
  const steps = useStore((s) => s.planByGoal[goalId]) ?? [];
  const probes = useStore((s) => s.board?.probes ?? []);
  const selectTask = useStore((s) => s.selectTask);
  const cols = useMemo(() => planColumns(steps), [steps]);
  const goalProbes = probes.filter((p) => p.goalId === goalId);
  const passed = goalProbes.filter((p) => p.lastStatus === "passed").length;

  if (steps.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-slate-500">
        Waiting for the agent's plan...
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {goalProbes.length > 0 && (
        <div className="border-b border-slate-800 px-4 py-2 text-xs text-slate-400">
          Win conditions: {passed}/{goalProbes.length} passing
        </div>
      )}
      <div className="grid flex-1 grid-cols-3 gap-3 overflow-y-auto p-3">
        {(["todo", "doing", "done"] as const).map((col) => (
          <div key={col} className="flex flex-col gap-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              {col} ({cols[col].length})
            </div>
            {cols[col].map((step, i) => (
              <button
                key={`${col}-${i}-${step.title}`}
                type="button"
                onClick={() => selectTask(step.title)}
                className={`rounded-md border p-2 text-left text-sm ${
                  col === "doing"
                    ? "border-orange-500/50 bg-orange-500/10"
                    : col === "done"
                    ? "border-emerald-600/40 bg-emerald-600/10"
                    : "border-slate-700 bg-slate-800/40"
                }`}
              >
                <div className="font-medium text-slate-100">{step.title}</div>
                {step.note && <div className="mt-1 text-xs text-slate-400">{step.note}</div>}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-slate-400">
      <div className="text-2xl">Describe a goal to begin</div>
      <div className="max-w-md text-sm text-slate-500">
        Type what you want built below. LoopForge plans it, runs one agent that owns the goal, and
        shows its plan here live.
      </div>
    </div>
  );
}

function DetailPanel() {
  const selectedTaskId = useStore((s) => s.selectedTaskId);
  const activity = useStore((s) => s.activity);
  const selectTask = useStore((s) => s.selectTask);
  if (!selectedTaskId) return null;
  const related = activity.filter((e) => e.taskId === selectedTaskId).slice(-30);
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-slate-800 bg-slate-900/40">
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
        <span className="truncate text-sm font-semibold">{selectedTaskId}</span>
        <button type="button" onClick={() => selectTask(null)} className="text-slate-500 hover:text-slate-200">
          ✕
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-3 text-xs text-slate-400">
        {related.length === 0
          ? <div className="text-slate-600">No activity recorded for this item yet.</div>
          : related.map((e) => (
            <div key={e.id} className="mb-2 border-b border-slate-800/50 pb-2">
              <span className="text-slate-500">{e.role}/{e.kind}</span>
              <div className="text-slate-300">{e.message.slice(0, 240)}</div>
            </div>
          ))}
      </div>
    </aside>
  );
}

function ChatBar({ activeGoalId, hasOpenGoal }: { activeGoalId: string | null; hasOpenGoal: boolean }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (activeGoalId && hasOpenGoal) {
        await api.addTask(activeGoalId, value);
      } else {
        await api.startGoalLoop(value);
      }
      setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-t border-slate-800 bg-slate-900/60 p-3">
      {error && <div className="mb-2 text-xs text-red-400">{error}</div>}
      <div className="flex gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          placeholder={hasOpenGoal
            ? "Add a task / steer the active goal...  (Cmd/Ctrl+Enter)"
            : "Describe a goal to build...  (Cmd/Ctrl+Enter)"}
          className="flex-1 resize-none rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-orange-500/60"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={busy}
          className="rounded-md bg-orange-500 px-4 text-sm font-medium text-slate-950 disabled:opacity-50"
        >
          {hasOpenGoal ? "Add" : "Start"}
        </button>
      </div>
    </div>
  );
}
