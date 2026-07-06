import { useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import { useStore } from "../store";
import { api, cleanFolderInput, looksLikeFolderPath } from "../api";
import type { Goal, ProjectEntry } from "../types";
import { STATUS, useArmedDelete } from "./ui";
import { LineMark } from "./marks";
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
    const wasActive = root === activeRoot;
    try {
      const { projects } = await api.removeProject(root);
      setProjects(projects);
      // Removing the project you're viewing is allowed (the server keeps serving
      // and re-registers its root next boot). Re-point the client at something
      // still listed: the first remaining project, or the primary origin if none.
      if (wasActive) {
        if (projects.length > 0) {
          await switchTo(projects[0].root);
        } else {
          setApiBase("");
        }
      }
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
    const value = cleanFolderInput(pathInput);
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
    if (g.status === "closed") return STATUS.done.dot;
    if (lastKindByGoal.get(g.id) === "goal.blocked") return STATUS.blocked.dot;
    if (now - (loopActiveAt[g.id] ?? 0) < 120_000) return STATUS.live.dot;
    return STATUS.idle.dot;
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
            ? "border-danger bg-danger-soft"
            : active
            ? "border-accent bg-accent-soft shadow-sm"
            : "border-line bg-surface-sunken hover:bg-surface-sunken"
        }`}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${loopDot(g)}`} />
        <span className="shrink-0 rounded-full bg-surface-sunken px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-ink-muted">
          {g.id}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-ink-muted">{g.text}</span>
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
            ? "shrink-0 text-[11px] font-semibold text-danger"
            : "shrink-0 text-ink-faint opacity-0 transition hover:text-danger group-hover:opacity-100"}
        >
          {isArmed ? "remove?" : "×"}
        </span>
      </button>
    );
  };

  return (
    <aside className="glass-soft flex w-64 shrink-0 flex-col border-r border-line">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-4 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-muted">
          Projects
        </div>
        <div className="space-y-1.5 px-3 pb-3 pt-2">
          {projects.length === 0 && (
            <div className="px-2 py-2 text-sm text-ink-muted">
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
                    ? "border-danger bg-danger-soft"
                    : active
                    ? "border-accent bg-accent-soft shadow-sm"
                    : "border-line bg-surface-sunken hover:bg-surface-sunken"
                }`}
              >
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-accent-soft text-sm">
                  🛠
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-sm font-semibold ${active ? "text-ink" : "text-ink"}`}>
                    {p.name}
                  </span>
                  <span className="block truncate text-[11px] text-ink-muted" title={p.root}>
                    {p.root}
                  </span>
                </span>
                {/* Every project row is closable (registry-only removal; serve
                    re-registers its own root next boot). x arms; a second click
                    within 4s removes it. */}
                <span
                  role="button"
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isArmed) void remove(p.root);
                    else arm(p.root);
                  }}
                  className={isArmed
                    ? "shrink-0 text-xs font-semibold text-danger"
                    : "shrink-0 text-ink-faint opacity-0 transition hover:text-danger group-hover:opacity-100"}
                >
                  {isArmed ? "remove?" : "×"}
                </span>
              </button>
            );
          })}
        </div>

        <div className="px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-muted">
          Loops
        </div>
        <div className="space-y-1 px-3 pb-3">
          {goals.length === 0 && (
            <div className="flex flex-col items-center gap-2 px-2 py-4 text-center text-sm text-ink-muted">
              <LineMark variant="loops" className="h-8 w-8 text-ink-faint" />
              No loops yet.
            </div>
          )}
          {/* "All" scopes the board to every loop (unified view). Lighter than a
              loop row; selected whenever no single loop is focused. */}
          {goals.length > 0 && (
            <button
              type="button"
              onClick={() => setActiveGoal(null)}
              className={`flex w-full items-center rounded-2xl border px-3 py-1.5 text-left text-[11px] font-medium uppercase tracking-wider transition-colors ${
                activeGoalId === null
                  ? "border-accent bg-accent-soft text-accent-ink shadow-sm"
                  : "border-line bg-surface-sunken text-ink-faint hover:text-ink-muted"
              }`}
            >
              All loops
            </button>
          )}
          {openGoals.map(renderLoopRow)}
          {closedGoals.length > 0 && (
            <div className="pt-1">
              <button
                type="button"
                onClick={() => setHistoryOpen((v) => !v)}
                className="flex w-full items-center gap-1.5 px-2 py-1 text-[11px] font-medium text-ink-faint transition hover:text-ink-muted"
              >
                <span>{historyOpen ? "▾" : "▸"}</span>
                history <span className="text-ink-faint">{closedGoals.length}</span>
              </button>
              {historyOpen && <div className="mt-1 space-y-1">{closedGoals.map(renderLoopRow)}</div>}
            </div>
          )}
        </div>
      </div>

      {/* Add a project by absolute path, or browse for one; the server validates it. */}
      <div className="border-t border-line px-3 py-3">
        {error && <div className="mb-2 text-xs text-danger">{error}</div>}
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
            placeholder="paste a folder path (~, file://, or C:\ work too)"
            className="min-w-0 flex-1 rounded-xl border border-line bg-surface-overlay px-2.5 py-1.5 text-xs text-ink outline-none transition placeholder:text-ink-faint focus:border-accent"
          />
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            title="Browse folders"
            className="rounded-xl border border-line bg-surface-raised px-2.5 text-xs text-ink-muted transition hover:bg-surface-sunken"
          >
            📁
          </button>
          <button
            type="button"
            onClick={() => void add()}
            disabled={busy}
            className="rounded-xl bg-accent-strong px-3 text-xs font-semibold text-on-accent transition hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "..." : "Add"}
          </button>
        </div>
      </div>

      <AnimatePresence>
        {pickerOpen && (
          <FolderPicker
            initialPath={looksLikeFolderPath(cleanFolderInput(pathInput))
              ? cleanFolderInput(pathInput)
              : ""}
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
