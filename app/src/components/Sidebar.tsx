import { useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import { useStore } from "../store";
import { api } from "../api";
import type { Goal, ProjectEntry } from "../types";
import { useArmedDelete } from "./ui";
import { FolderPicker } from "./FolderPicker";

// The project IS the container: the sidebar lists registered projects (repos),
// one LoopForge command center over many. Clicking one switches the whole client
// to that project's server (openProject -> setApiBase); the current one is
// highlighted. Below projects, a LOOPS list shows the current project's goals
// (T3-thread-style), selecting one the same way a goal chip does.
export function Sidebar() {
  const apiBase = useStore((s) => s.apiBase);
  const setApiBase = useStore((s) => s.setApiBase);
  const board = useStore((s) => s.board);
  const activeGoalId = useStore((s) => s.activeGoalId);
  const setActiveGoal = useStore((s) => s.setActiveGoal);
  const loopActiveAt = useStore((s) => s.loopActiveAt);
  const lifecycle = useStore((s) => s.lifecycle);
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [pathInput, setPathInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Independent arm-then-confirm state for project rows and loop rows.
  const { armed, arm, disarm } = useArmedDelete();
  const loopArm = useArmedDelete();

  const remove = async (root: string) => {
    disarm();
    setError(null);
    try {
      const { projects } = await api.removeProject(root);
      setProjects(projects);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const refresh = async () => {
    try {
      const { projects } = await api.listProjects();
      setProjects(projects);
    } catch {
      // registry is best-effort; the sidebar just stays as-is
    }
  };
  useEffect(() => {
    void refresh();
  }, []);

  // Which registered project the client is currently pointed at: for a child
  // server, the entry whose live URL matches apiBase; on the primary origin, the
  // entry the primary server flagged as current.
  const activeRoot = apiBase
    ? projects.find((p) => p.url && new URL(p.url).origin === apiBase)?.root ?? null
    : projects.find((p) => p.current)?.root ?? null;

  const switchTo = async (root: string) => {
    setError(null);
    try {
      const { url } = await api.openProject(root);
      // The primary origin serves the page, so its own server is reached with a
      // relative "" base; a child on another port needs its absolute origin.
      const origin = new URL(url).origin;
      setApiBase(origin === window.location.origin ? "" : origin);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const add = async () => {
    const value = pathInput.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { projects } = await api.addProject(value);
      setProjects(projects);
      setPathInput("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Loops list: the current project's goals, open (newest first) then a
  // collapsible history of closed ones. Derived here from the shared board /
  // lifecycle state - nothing new stored.
  const goals = board?.goals ?? [];
  const openGoals = [...goals].filter((g) => g.status === "open").reverse();
  const closedGoals = [...goals].filter((g) => g.status === "closed").reverse();
  // Latest lifecycle kind per goal - a goal whose most recent signal is
  // goal.blocked is waiting on you (amber dot).
  const lastKindByGoal = new Map<string, string>();
  lifecycle.forEach((e) => {
    if (e.goalId) lastKindByGoal.set(e.goalId, e.kind);
  });
  const now = Date.now();
  const loopDot = (g: Goal): string => {
    if (g.status === "closed") return "bg-emerald-500";
    if (lastKindByGoal.get(g.id) === "goal.blocked") return "bg-amber-500";
    if (now - (loopActiveAt[g.id] ?? 0) < 120_000) return "animate-pulse bg-orange-500";
    return "bg-slate-400";
  };
  const renderLoopRow = (g: Goal) => {
    const active = g.id === activeGoalId;
    const isArmed = loopArm.armed === g.id;
    return (
      <button
        key={g.id}
        type="button"
        onClick={() => setActiveGoal(g.id)}
        onMouseLeave={() => {
          if (loopArm.armed === g.id) loopArm.disarm();
        }}
        className={`group flex w-full min-w-0 items-center gap-2 rounded-2xl border px-3 py-2 text-left transition-colors ${
          isArmed
            ? "border-red-300 bg-red-50"
            : active
            ? "border-orange-300 bg-orange-50 shadow-sm"
            : "border-slate-200 bg-slate-50 hover:bg-slate-100"
        }`}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${loopDot(g)}`} />
        <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-slate-500">
          {g.id}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-slate-600">{g.text}</span>
        {/* Same arm-then-confirm delete as the goal chips. */}
        <span
          role="button"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            if (isArmed) {
              loopArm.disarm();
              void api.deleteGoal(g.id);
            } else {
              loopArm.arm(g.id);
            }
          }}
          className={isArmed
            ? "shrink-0 text-[11px] font-semibold text-red-600"
            : "shrink-0 text-slate-400 opacity-0 transition hover:text-red-600 group-hover:opacity-100"}
        >
          {isArmed ? "remove?" : "×"}
        </span>
      </button>
    );
  };

  return (
    <aside className="glass-soft flex w-64 shrink-0 flex-col border-r border-slate-200">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-4 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          Projects
        </div>
        <div className="space-y-1.5 px-3 pb-3 pt-2">
          {projects.length === 0 && (
            <div className="px-2 py-2 text-sm text-slate-500">
              No projects yet. Add one below.
            </div>
          )}
          {projects.map((p) => {
            const active = p.root === activeRoot;
            const isArmed = armed === p.root;
            return (
              <button
                key={p.root}
                type="button"
                onClick={() => void switchTo(p.root)}
                onMouseLeave={() => {
                  if (armed === p.root) disarm();
                }}
                className={`group flex w-full min-w-0 items-center gap-2.5 rounded-2xl border px-3 py-2.5 text-left transition-colors ${
                  isArmed
                    ? "border-red-300 bg-red-50"
                    : active
                    ? "border-orange-300 bg-orange-50 shadow-sm"
                    : "border-slate-200 bg-slate-50 hover:bg-slate-100"
                }`}
              >
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-orange-100 text-sm">
                  🛠
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-sm font-semibold ${active ? "text-slate-900" : "text-slate-700"}`}>
                    {p.name}
                  </span>
                  <span className="block truncate text-[11px] text-slate-500" title={p.root}>
                    {p.root}
                  </span>
                </span>
                {/* The current project cannot be removed (it would orphan the live
                    server). x arms; a second click within 4s removes it. */}
                {!active && (
                  <span
                    role="button"
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (isArmed) void remove(p.root);
                      else arm(p.root);
                    }}
                    className={isArmed
                      ? "shrink-0 text-xs font-semibold text-red-600"
                      : "shrink-0 text-slate-400 opacity-0 transition hover:text-red-600 group-hover:opacity-100"}
                  >
                    {isArmed ? "remove?" : "×"}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          Loops
        </div>
        <div className="space-y-1 px-3 pb-3">
          {goals.length === 0 && (
            <div className="px-2 py-1 text-sm text-slate-500">No loops yet.</div>
          )}
          {openGoals.map(renderLoopRow)}
          {closedGoals.length > 0 && (
            <div className="pt-1">
              <button
                type="button"
                onClick={() => setHistoryOpen((v) => !v)}
                className="flex w-full items-center gap-1.5 px-2 py-1 text-[11px] font-medium text-slate-400 transition hover:text-slate-600"
              >
                <span>{historyOpen ? "▾" : "▸"}</span>
                history <span className="text-slate-400">{closedGoals.length}</span>
              </button>
              {historyOpen && <div className="mt-1 space-y-1">{closedGoals.map(renderLoopRow)}</div>}
            </div>
          )}
        </div>
      </div>

      {/* Add a project by absolute path, or browse for one; the server validates it. */}
      <div className="border-t border-slate-200 px-3 py-3">
        {error && <div className="mb-2 text-xs text-red-600">{error}</div>}
        <div className="flex gap-1.5">
          <input
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void add();
              }
            }}
            placeholder="/absolute/path/to/repo"
            className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-orange-300"
          />
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            title="Browse folders"
            className="rounded-xl border border-slate-200 bg-white px-2.5 text-xs text-slate-600 transition hover:bg-slate-100"
          >
            📁
          </button>
          <button
            type="button"
            onClick={() => void add()}
            disabled={busy}
            className="rounded-xl bg-orange-600 px-3 text-xs font-semibold text-white transition hover:bg-orange-700 disabled:opacity-50"
          >
            {busy ? "..." : "Add"}
          </button>
        </div>
      </div>

      <AnimatePresence>
        {pickerOpen && (
          <FolderPicker
            initialPath={pathInput.trim().startsWith("/") ? pathInput.trim() : ""}
            onAdded={(list) => {
              setProjects(list);
              setPathInput("");
            }}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </AnimatePresence>
    </aside>
  );
}
