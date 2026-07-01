import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useStore } from "./store";
import { api } from "./api";
import { workerChips, type WorkerChip } from "./agent_status";
import type { Goal, PlanStep } from "./types";

// Shared spring - the soft, slightly bouncy motion of a calm home menu.
const spring = { type: "spring", stiffness: 320, damping: 30 } as const;

export function App() {
  const conn = useStore((s) => s.conn);
  const runtime = useStore((s) => s.runtime);
  const board = useStore((s) => s.board);
  const activeGoalId = useStore((s) => s.activeGoalId);
  const [logOpen, setLogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const activeGoal = board?.goals.find((g) => g.id === activeGoalId) ?? null;

  return (
    <div className="flex h-full w-full flex-col">
      <TopBar
        conn={conn}
        backend={runtime?.backend}
        logOpen={logOpen}
        onToggleLog={() => setLogOpen((v) => !v)}
        onSettings={() => setSettingsOpen(true)}
      />
      <AnimatePresence>
        {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      </AnimatePresence>
      <StatusStrip onSettings={() => setSettingsOpen(true)} />
      <AlertsBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-h-0 flex-1 flex-col">
          {!activeGoal ? <EmptyState /> : <KanbanView goalId={activeGoal.id} />}
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
    <div className="border-b border-amber-200 bg-amber-50">
      {blocked.map((e, i) => (
        <div key={`b-${i}`} className="flex items-start gap-2 px-4 py-2 text-sm">
          <span className="mt-0.5 text-amber-700">needs you</span>
          <span className="text-amber-900">{e.summary}</span>
        </div>
      ))}
      {holds.map((t) => (
        <div key={t.id} className="flex items-center gap-3 px-4 py-2 text-sm">
          <span className="text-amber-700">verify by hand</span>
          <span className="flex-1 truncate text-amber-900">
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

// A live strip showing which model fills each role and what the loop is doing
// right now - so "how is it working" is always answerable at a glance.
function StatusStrip({ onSettings }: { onSettings: () => void }) {
  const runtime = useStore((s) => s.runtime);
  const activity = useStore((s) => s.activity);
  if (!runtime) return null;
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
    <div className="glass-soft flex items-center gap-2 border-x-0 border-t-0 border-b border-slate-200 px-4 py-2">
      {role("main", runtime.backendRaw ?? "?")}
      {role("rescue", runtime.rescue?.enabled ? runtime.rescue.backend : "off", !!runtime.rescue?.enabled)}
      {role("planner", runtime.planner?.enabled ? runtime.planner.backend : "off", !!runtime.planner?.enabled)}
      {role("scout", runtime.scout?.enabled ? runtime.scout.backend : "off", !!runtime.scout?.enabled)}
      {now && (
        <span className="ml-2 flex min-w-0 items-center gap-1.5 text-xs text-slate-500">
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-orange-500" />
          <span className="truncate">{now.message.slice(0, 90)}</span>
        </span>
      )}
    </div>
  );
}

const BACKENDS = ["codex", "claude", "local", "pi"] as const;

// Model routing settings - the same knobs the TUI exposed (main backend +
// rescue / planner / scout), live-editable via the config PATCH endpoints.
function SettingsModal({ onClose }: { onClose: () => void }) {
  const runtime = useStore((s) => s.runtime);
  const setRuntime = useStore((s) => s.setRuntime);
  const [saving, setSaving] = useState<string | null>(null);

  const refresh = async () => setRuntime(await api.runtime());

  const wrap = async (key: string, fn: () => Promise<unknown>) => {
    setSaving(key);
    try {
      await fn();
      await refresh();
    } finally {
      setSaving(null);
    }
  };

  const roleValue = (role?: { enabled: boolean; backend: string }) =>
    role?.enabled ? role.backend : "off";

  const RoleRow = (
    { label, help, value, onChange }: {
      label: string;
      help: string;
      value: string;
      onChange: (v: string) => void;
    },
  ) => (
    <div className="flex items-center justify-between gap-3 border-b border-slate-200 py-3">
      <div>
        <div className="text-sm font-medium text-slate-800">{label}</div>
        <div className="text-xs text-slate-500">{help}</div>
      </div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-sm outline-none focus:border-orange-400/50"
      >
        {["off", ...BACKENDS].map((b) => <option key={b} value={b} className="bg-white">{b}</option>)}
      </select>
    </div>
  );

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 z-50 flex items-center justify-center bg-slate-900/20 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.94, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96 }}
        transition={spring}
        className="glass w-[460px] rounded-3xl p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-base font-semibold">Model settings</span>
          <button type="button" onClick={onClose} className="text-slate-500 transition-colors hover:text-slate-800">✕</button>
        </div>
        {saving && <div className="mb-2 text-xs text-orange-600">Saving {saving}...</div>}

        <div className="flex items-center justify-between gap-3 border-b border-slate-200 py-3">
          <div>
            <div className="text-sm font-medium text-slate-800">Main agent</div>
            <div className="text-xs text-slate-500">
              The model the loop owner and workers run on. ({runtime?.backend ?? "?"})
            </div>
          </div>
          <select
            value={runtime?.backendRaw ?? "codex"}
            onChange={(e) => void wrap("main backend", () => api.setBackend(e.target.value))}
            className="rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-sm outline-none focus:border-orange-400/50"
          >
            {BACKENDS.map((b) => <option key={b} value={b} className="bg-white">{b}</option>)}
          </select>
        </div>

        <RoleRow
          label="Rescue model"
          help="Senior model consulted when a task keeps failing. 'savior'."
          value={roleValue(runtime?.rescue)}
          onChange={(v) =>
            void wrap("rescue", () =>
              api.setRescue(v === "off" ? { enabled: false } : { enabled: true, backend: v }))}
        />
        <RoleRow
          label="Planner model"
          help="Compiles goals into tasks + win conditions. Off = follow main."
          value={roleValue(runtime?.planner)}
          onChange={(v) =>
            void wrap("planner", () =>
              api.setPlanner(v === "off" ? { enabled: false } : { enabled: true, backend: v }))}
        />
        <RoleRow
          label="Scout model"
          help="Proposes next-build ideas for your review. Off = no scouting."
          value={roleValue(runtime?.scout)}
          onChange={(v) =>
            void wrap("scout", () =>
              api.setScout(v === "off" ? { enabled: false } : { enabled: true, backend: v }))}
        />

        <div className="flex items-center justify-between gap-3 border-b border-slate-200 py-3">
          <div>
            <div className="text-sm font-medium text-slate-800">Parallel sub-agents</div>
            <div className="text-xs text-slate-500">
              Max sub-agents the main agent runs at once. It is told to fan out work up to this many.
            </div>
          </div>
          <div className="flex items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1">
            <button
              type="button"
              onClick={() =>
                void wrap("parallel agents", () =>
                  api.setMaxAgents(Math.max(1, (runtime?.maxParallelAgents ?? 5) - 1)))}
              className="h-7 w-7 rounded-lg text-slate-700 transition hover:bg-slate-100"
            >
              −
            </button>
            <span className="w-7 text-center text-sm font-semibold tabular-nums text-orange-700">
              {runtime?.maxParallelAgents ?? 5}
            </span>
            <button
              type="button"
              onClick={() =>
                void wrap("parallel agents", () =>
                  api.setMaxAgents(Math.min(12, (runtime?.maxParallelAgents ?? 5) + 1)))}
              className="h-7 w-7 rounded-lg text-slate-700 transition hover:bg-slate-100"
            >
              +
            </button>
          </div>
        </div>

        <label className="mt-3 flex cursor-pointer items-center justify-between gap-3 border-t border-slate-200 pt-3">
          <div>
            <div className="text-sm font-medium text-slate-800">Push sub-agent branches</div>
            <div className="text-xs text-slate-500">
              When a fan-out sub-agent finishes, push its branch to origin (if any); the loop still
              merges everything at the end.
            </div>
          </div>
          <input
            type="checkbox"
            checked={!!runtime?.pushBranches}
            onChange={(e) =>
              void wrap("push branches", () => api.setPushBranches(e.target.checked))}
            className="h-4 w-4 accent-orange-500"
          />
        </label>

        <div className="mt-4 text-xs text-slate-500">
          Changes apply to new work immediately. codex uses your Codex login; claude uses Anthropic
          usage; local/pi use your configured local model.
        </div>
      </motion.div>
    </motion.div>
  );
}

function ActivityDrawer() {
  const lifecycle = useStore((s) => s.lifecycle);
  const recent = lifecycle.slice(-80).reverse();
  const color: Record<string, string> = {
    "goal.blocked": "text-amber-700",
    "verified": "text-emerald-600",
    "goal.closed": "text-emerald-600",
    "subagent.spawned": "text-sky-400",
    "subagent.merged": "text-sky-400",
    "plan.updated": "text-slate-500",
  };
  return (
    <aside className="glass flex w-80 shrink-0 flex-col border-y-0 border-r-0 border-l border-slate-200">
      <div className="border-b border-slate-200 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
        Activity
      </div>
      <div className="flex-1 overflow-y-auto p-3 text-xs">
        {recent.length === 0
          ? <div className="text-slate-400">No lifecycle activity yet.</div>
          : recent.map((e, i) => (
            <div key={i} className="mb-2 border-b border-slate-100 pb-2">
              <span className={color[e.kind] ?? "text-slate-500"}>{e.kind}</span>
              <div className="text-slate-700">{e.summary.slice(0, 200)}</div>
            </div>
          ))}
      </div>
    </aside>
  );
}

function TopBar(
  { conn, backend, logOpen, onToggleLog, onSettings }: {
    conn: string;
    backend?: string;
    logOpen: boolean;
    onToggleLog: () => void;
    onSettings: () => void;
  },
) {
  const dot = conn === "live" ? "bg-emerald-500" : conn === "down" ? "bg-red-400" : "bg-amber-400";
  return (
    <header className="glass flex items-center gap-4 border-x-0 border-t-0 border-b-white/5 px-4 py-2.5">
      <span className="text-lg font-semibold tracking-tight">
        Loop<span className="text-orange-600">Forge</span>
      </span>
      <button
        type="button"
        onClick={onSettings}
        title="Model settings"
        className="text-xs text-slate-500 hover:text-slate-800"
      >
        {backend ?? "connecting..."} ⚙
      </button>
      <div className="ml-auto flex items-center gap-3">
        <button
          type="button"
          onClick={onToggleLog}
          className={`rounded-md border border-slate-200 px-3 py-1 text-xs ${
            logOpen ? "bg-slate-900 text-white" : "text-slate-500 hover:text-slate-800"
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

// One space per project: the project (cwd) IS the space - one main agent
// growing it over time. The current (open) goal is what that agent is building
// now; closed goals are the project's history. There is no multi-space list.
function GoalTile(
  { goal, active, live, onSelect, onRemove }: {
    goal: Goal;
    active: boolean;
    live: boolean;
    onSelect: () => void;
    onRemove: () => Promise<void>;
  },
) {
  const [confirming, setConfirming] = useState(false);
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={spring}
      whileHover={{ scale: 1.015 }}
      className={`group relative flex items-center overflow-hidden rounded-2xl border p-0.5 transition-colors ${
        active
          ? "border-orange-300 bg-orange-50 shadow-sm"
          : "border-slate-200 bg-slate-50 hover:bg-slate-100"
      }`}
    >
      <button type="button" onClick={onSelect} className="min-w-0 flex-1 px-3 py-2.5 text-left">
        <span className="flex items-center gap-2">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              goal.status === "open"
                ? live
                  ? "animate-pulse bg-orange-500"
                  : "bg-orange-500"
                : "bg-emerald-500"
            }`}
          />
          <span className={`truncate text-sm ${active ? "text-slate-900" : "text-slate-700"}`}>
            {goal.text}
          </span>
        </span>
        <span className="mt-0.5 block pl-4 text-[11px] text-slate-500">
          {goal.id} · {goal.status === "open" ? (live ? "working" : "active") : "done"}
        </span>
      </button>
      {confirming
        ? (
          <span className="flex shrink-0 items-center gap-1 pr-2 text-xs">
            <button
              type="button"
              onClick={() => void onRemove()}
              className="rounded-lg bg-red-500/90 px-2 py-0.5 text-white"
            >
              delete
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="text-slate-500 hover:text-slate-800"
            >
              ✕
            </button>
          </span>
        )
        : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            title="Remove goal"
            className="shrink-0 px-2.5 py-2 text-slate-400 opacity-0 transition hover:text-red-600 group-hover:opacity-100"
          >
            ✕
          </button>
        )}
    </motion.div>
  );
}

function Sidebar() {
  const board = useStore((s) => s.board);
  const runtime = useStore((s) => s.runtime);
  const activeGoalId = useStore((s) => s.activeGoalId);
  const setActiveGoal = useStore((s) => s.setActiveGoal);
  const loopActiveAt = useStore((s) => s.loopActiveAt);
  const goals = board?.goals ?? [];
  const open = goals.filter((g) => g.status === "open");
  const history = goals.filter((g) => g.status !== "open").reverse();
  const now = Date.now();
  const isLive = (id: string) => now - (loopActiveAt[id] ?? 0) < 90_000;
  const projectName = runtime?.project?.name ?? "project";
  const projectPath = runtime?.project?.path ?? "";

  const remove = async (id: string) => {
    await api.deleteGoal(id);
    if (activeGoalId === id) setActiveGoal(null);
  };

  return (
    <aside className="glass-soft flex w-64 shrink-0 flex-col border-r border-slate-200">
      {/* The space = this project. One main agent grows it. */}
      <div className="px-4 pb-1 pt-4">
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          Project
        </div>
        <div className="mt-2 flex items-center gap-2.5 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-orange-100 text-sm">
            🛠
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-slate-900">{projectName}</span>
            <span className="block truncate text-[11px] text-slate-500" title={projectPath}>
              {projectPath || "one main agent"}
            </span>
          </span>
        </div>
      </div>

      <div className="flex-1 space-y-1.5 overflow-y-auto px-3 pb-3 pt-3">
        <div className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          Current goal
        </div>
        {open.length === 0 && (
          <div className="px-2 py-2 text-sm text-slate-500">
            No active goal. Describe one below to start the loop.
          </div>
        )}
        <AnimatePresence initial={false}>
          {open.map((g) => (
            <GoalTile
              key={g.id}
              goal={g}
              active={g.id === activeGoalId}
              live={isLive(g.id)}
              onSelect={() => setActiveGoal(g.id)}
              onRemove={() => remove(g.id)}
            />
          ))}
        </AnimatePresence>

        {history.length > 0 && (
          <>
            <div className="px-1 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              History
            </div>
            <AnimatePresence initial={false}>
              {history.map((g) => (
                <GoalTile
                  key={g.id}
                  goal={g}
                  active={g.id === activeGoalId}
                  live={false}
                  onSelect={() => setActiveGoal(g.id)}
                  onRemove={() => remove(g.id)}
                />
              ))}
            </AnimatePresence>
          </>
        )}
      </div>
    </aside>
  );
}

function planColumns(steps: PlanStep[]) {
  return {
    todo: steps.filter((s) => s.status === "todo"),
    doing: steps.filter((s) => s.status === "doing"),
    // Plan items append at the bottom of LOOP_PLAN.md, so file order is oldest
    // first; the Done column reads newest first.
    done: steps.filter((s) => s.status === "done").reverse(),
  };
}

// Live per-task worker status the board already tracks (phase, what it's doing
// now, risk) - the TUI showed this; the web used to drop it. Rendered whenever
// any worker is running, regardless of whether the open goal has a plan yet.
function ActiveWorkersStrip(
  { chips, onSelect }: { chips: WorkerChip[]; onSelect: (taskId: string) => void },
) {
  if (chips.length === 0) return null;
  return (
    <div className="border-b border-slate-200 px-4 py-3">
      <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        Active workers <span className="text-slate-400">{chips.length} running</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {chips.map((chip) => (
          <button
            key={chip.key}
            type="button"
            onClick={() => chip.taskId && onSelect(chip.taskId)}
            className="flex items-center gap-2 rounded-xl border border-orange-300 bg-orange-50 px-3 py-2 text-left text-sm shadow-sm"
          >
            <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-orange-500" />
            <span className="font-medium text-slate-800">{chip.label}</span>
            <span className="max-w-[32ch] truncate text-[11px] text-slate-500" title={chip.detail}>
              {chip.detail}
            </span>
            {chip.tone
              ? (
                <span
                  className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${chip.tone.className}`}
                >
                  {chip.tone.label}
                </span>
              )
              : null}
          </button>
        ))}
      </div>
    </div>
  );
}

function KanbanView({ goalId }: { goalId: string }) {
  const steps = useStore((s) => s.planByGoal[goalId]) ?? [];
  const subagents = useStore((s) => s.subagentsByGoal[goalId]) ?? [];
  const activeWorkers = useStore((s) => s.runtime?.activeAgentStatuses) ?? [];
  const externalAgents = useStore((s) => s.runtime?.externalAgents) ?? [];
  const probes = useStore((s) => s.board?.probes ?? []);
  const selectTask = useStore((s) => s.selectTask);
  const cols = useMemo(() => planColumns(steps), [steps]);
  const workers = useMemo(
    () => workerChips(activeWorkers, externalAgents),
    [activeWorkers, externalAgents],
  );
  const goalProbes = probes.filter((p) => p.goalId === goalId);
  const passed = goalProbes.filter((p) => p.lastStatus === "passed").length;
  const running = subagents.filter((s) => s.state === "running").length;

  if (steps.length === 0 && subagents.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ActiveWorkersStrip chips={workers} onSelect={selectTask} />
        <IdlePlan goalId={goalId} />
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {goalProbes.length > 0 && (
        <div className="border-b border-slate-200 px-4 py-2 text-xs text-slate-500">
          Win conditions: {passed}/{goalProbes.length} passing
        </div>
      )}
      <ActiveWorkersStrip chips={workers} onSelect={selectTask} />
      {/* Parallel sub-agents as a live strip - lit while coding, calm when merged. */}
      {subagents.length > 0 && (
        <div className="border-b border-slate-200 px-4 py-3">
          <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Sub-agents{" "}
            <span className="text-slate-400">
              {running > 0 ? `${running} coding in parallel` : `${subagents.length} merged`}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <AnimatePresence initial={false}>
              {subagents.map((sa) => {
                const live = sa.state === "running";
                return (
                  <motion.button
                    layout
                    key={sa.title}
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={spring}
                    whileHover={{ y: -2 }}
                    type="button"
                    onClick={() => selectTask(sa.title)}
                    className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm ${
                      live ? "border-orange-300 bg-orange-50 shadow-sm" : "border-emerald-300 bg-emerald-50"
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        live ? "animate-pulse bg-orange-500" : "bg-emerald-500"
                      }`}
                    />
                    <span className="font-medium text-slate-800">
                      {sa.title.replace(/^Spawned sub-agent\s*/i, "")}
                    </span>
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                      {live ? "coding" : "merged"}
                    </span>
                  </motion.button>
                );
              })}
            </AnimatePresence>
          </div>
        </div>
      )}
      <div className="grid flex-1 grid-cols-3 gap-4 overflow-y-auto p-4">
        {(["todo", "doing", "done"] as const).map((col) => (
          <div key={col} className="flex flex-col gap-2.5">
            <div className="px-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              {col === "todo" ? "To do" : col === "doing" ? "In progress" : "Done"}{" "}
              <span className="text-slate-400">{cols[col].length}</span>
            </div>
            <AnimatePresence initial={false}>
              {cols[col].map((step, i) => (
                <motion.button
                  layout
                  key={`${col}-${step.title}`}
                  initial={{ opacity: 0, y: 12, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{ ...spring, delay: Math.min(i * 0.03, 0.2) }}
                  whileHover={{ scale: 1.02, y: -2 }}
                  type="button"
                  onClick={() => selectTask(step.title)}
                  className={`rounded-2xl border p-3 text-left ${
                    col === "doing"
                      ? "border-orange-300 bg-orange-50 shadow-sm"
                      : col === "done"
                      ? "border-emerald-300 bg-emerald-50"
                      : "border-slate-200 bg-slate-50"
                  }`}
                >
                  <div className="text-sm font-medium text-slate-900">{step.title}</div>
                  {step.note && (
                    <div className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-slate-500">
                      {step.note}
                    </div>
                  )}
                </motion.button>
              ))}
            </AnimatePresence>
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-slate-500">
      <div className="text-2xl">Describe a goal to begin</div>
      <div className="max-w-md text-sm text-slate-500">
        Type what you want built below. LoopForge plans it, runs one agent that owns the goal, and
        shows its plan here live.
      </div>
    </div>
  );
}

// An open goal with no plan yet: its loop is not running. Offer to start it so
// the owning agent plans and works live - like kicking off a Codex goal.
function IdlePlan({ goalId }: { goalId: string }) {
  const loopActiveAt = useStore((s) => s.loopActiveAt[goalId]);
  const planning = useStore((s) => s.planningByGoal[goalId]);
  const working = loopActiveAt !== undefined && Date.now() - loopActiveAt < 120_000;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // Kickoff: the goal exists but planning is still compiling it into tasks and
  // win conditions. Calm indicator instead of the idle "start the loop" prompt.
  if (planning) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-slate-500">
        <div className="flex items-center gap-2 text-lg">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-orange-500" />
          Planning the goal
        </div>
        <div className="max-w-md text-sm text-slate-500">
          Breaking it into tasks and win conditions...
        </div>
      </div>
    );
  }

  if (working) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-slate-500">
        <div className="flex items-center gap-2 text-lg">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-orange-500" />
          {goalId}: agent is working
        </div>
        <div className="max-w-md text-sm text-slate-500">
          The owning agent is planning and acting now. Its plan appears here at the end of the
          current turn. Add a task below any time to steer it.
        </div>
      </div>
    );
  }

  const start = async () => {
    setBusy(true);
    setNote(null);
    try {
      await api.loopExistingGoal(goalId);
      setNote("Loop started - the agent is planning. Its plan will appear here live.");
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-slate-500">
      <div className="text-lg">No plan yet for {goalId}</div>
      <div className="max-w-md text-sm text-slate-500">
        Start this goal's loop and one agent will own it - planning, working, and verifying - with
        its plan streaming here. Add tasks any time below to steer it.
      </div>
      <button
        type="button"
        onClick={() => void start()}
        disabled={busy}
        className="rounded-md bg-orange-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? "Starting..." : "Run this goal's loop"}
      </button>
      {note && <div className="max-w-md text-xs text-slate-500">{note}</div>}
    </div>
  );
}

// Clicking a task or sub-agent shows what it is + everything the looping agent
// recorded about it: its status, the evidence/notes the agent wrote, and (for a
// sub-agent) its branch and merge state, plus a timeline of related events.
function DetailPanel() {
  const selectedTaskId = useStore((s) => s.selectedTaskId);
  const activeGoalId = useStore((s) => s.activeGoalId);
  const steps = useStore((s) => (activeGoalId ? s.planByGoal[activeGoalId] : undefined)) ?? [];
  const subagents = useStore((s) => (activeGoalId ? s.subagentsByGoal[activeGoalId] : undefined)) ?? [];
  const lifecycle = useStore((s) => s.lifecycle);
  const selectTask = useStore((s) => s.selectTask);
  if (!selectedTaskId) return null;

  const step = steps.find((s) => s.title === selectedTaskId);
  const sub = subagents.find((s) => s.title === selectedTaskId);
  const isSub = Boolean(sub);
  const related = lifecycle
    .filter((e) => e.taskId === selectedTaskId || e.data?.title === selectedTaskId)
    .slice(-20);
  // For a sub-agent, the agent's recorded note is the latest merge/progress
  // summary it reported back (its plan steps have no inline note field).
  const subNote = isSub
    ? related.filter((e) => e.kind === "subagent.merged" || e.kind === "subagent.progress").at(-1)
      ?.summary ?? null
    : null;

  const statusLabel = sub
    ? sub.state === "merged" ? "merged" : "running"
    : step?.status ?? "unknown";
  const statusColor = statusLabel === "done" || statusLabel === "merged"
    ? "bg-emerald-100 text-emerald-700"
    : statusLabel === "doing" || statusLabel === "running"
    ? "bg-orange-100 text-orange-700"
    : "bg-slate-300/20 text-slate-700";

  return (
    <aside className="glass flex w-96 shrink-0 flex-col border-y-0 border-r-0 border-l border-slate-200">
      <div className="flex items-start justify-between gap-2 border-b border-slate-200 px-4 py-3">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            {isSub ? "Sub-agent" : "Task"}
          </div>
          <div className="truncate text-sm font-semibold text-slate-900">{selectedTaskId}</div>
        </div>
        <button type="button" onClick={() => selectTask(null)} className="text-slate-500 hover:text-slate-800">
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${statusColor}`}>
          {statusLabel}
        </span>

        {(step?.note || subNote) && (
          <div className="mt-3">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              What the agent recorded
            </div>
            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{step?.note ?? subNote}</p>
          </div>
        )}

        {isSub && (
          <div className="mt-3 rounded-md border border-violet-200 bg-violet-50 p-2 text-xs text-violet-700">
            Runs in its own worktree/branch, then merges back into the goal branch.
            {sub!.state === "merged" ? " Merged ✓" : " Working now…"}
          </div>
        )}

        {!step?.note && !subNote && !isSub && (
          <p className="mt-3 text-sm text-slate-500">
            No notes yet - the agent fills this in as it works this item.
          </p>
        )}

        {related.length > 0 && (
          <div className="mt-4">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Timeline
            </div>
            <div className="mt-1">
              {related.map((e, i) => (
                <div key={i} className="border-b border-slate-100 py-1.5 text-xs">
                  <span className="text-slate-500">{e.kind}</span>
                  <div className="text-slate-700">{e.summary.slice(0, 200)}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function ChatBar({ activeGoalId, hasOpenGoal }: { activeGoalId: string | null; hasOpenGoal: boolean }) {
  const setActiveGoal = useStore((s) => s.setActiveGoal);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState(false);

  const send = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (activeGoalId && hasOpenGoal) {
        await api.addTask(activeGoalId, value);
      } else {
        // Focus the freshly created goal so its planning indicator shows even if
        // a closed goal was the previously active one.
        const { goalId } = await api.startGoalLoop(value, { questionMode: ask });
        setActiveGoal(goalId);
      }
      setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="glass border-x-0 border-b-0 border-t border-slate-200 p-3">
      {error && <div className="mb-2 text-xs text-red-600">{error}</div>}
      <div className="flex gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter inserts a newline.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          placeholder={hasOpenGoal
            ? "Add a task / steer the active goal...  (Enter to send, Shift+Enter for newline)"
            : "Describe a goal to build...  (Enter to send, Shift+Enter for newline)"}
          className="flex-1 resize-none rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={busy}
          className="rounded-2xl bg-orange-600 px-5 text-sm font-semibold text-white shadow-sm transition hover:bg-orange-700 disabled:opacity-50"
        >
          {hasOpenGoal ? "Add" : "Start"}
        </button>
      </div>
      {!hasOpenGoal && (
        <label className="mt-2 flex w-fit cursor-pointer items-center gap-1.5 text-xs text-slate-500">
          <input
            type="checkbox"
            checked={ask}
            onChange={(e) => setAsk(e.target.checked)}
            className="accent-orange-500"
          />
          Ask clarifying questions first (like Codex plan mode)
        </label>
      )}
    </div>
  );
}
