// The live store: one SSE connection to /api/events feeds board snapshots and
// the lifecycle/activity stream; REST calls drive goals and steers. The whole
// UI (sidebar, chat, Kanban, planet view) reads from here, so Kanban and the
// node view can never disagree - they project the same state.

import { create } from "zustand";
import type {
  ActivityEvent,
  BoardSnapshot,
  LifecycleEvent,
  LoopStatus,
  PlanStep,
  Runtime,
} from "./types";
import { parseLifecycle } from "./api";

export type ConnState = "connecting" | "live" | "down";
export type Theme = "light" | "dark";

// First paint theme: a stored choice wins; otherwise Night Ops (dark) is the
// flagship default, unless the OS explicitly prefers light.
function initialTheme(): Theme {
  const stored = typeof localStorage !== "undefined" ? localStorage.getItem("lf-theme") : null;
  if (stored === "light" || stored === "dark") return stored;
  const prefersLight = typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: light)").matches;
  return prefersLight ? "light" : "dark";
}

interface AppState {
  conn: ConnState;
  theme: Theme;
  // Origin of the server the client currently talks to. "" = the primary origin
  // that served the page; a child project's absolute origin when switched to it.
  apiBase: string;
  board: BoardSnapshot | null;
  runtime: Runtime | null;
  lifecycle: LifecycleEvent[];
  activity: ActivityEvent[];
  // The most recent plan.updated step list per goal - the Kanban/planet source.
  planByGoal: Record<string, PlanStep[]>;
  // Goals whose kickoff planning turn is in flight (goal exists, no plan yet).
  // Set on goal.planning; cleared once the plan lands or the goal moves on.
  planningByGoal: Record<string, boolean>;
  // Sub-agents spawned by the loop owner, per goal - distinct nodes in the
  // planet view (the main agent is the core; these are its satellites).
  subagentsByGoal: Record<string, { title: string; state: "running" | "merged" }[]>;
  activeGoalId: string | null;
  selectedTaskId: string | null;
  // Last time a goal's loop emitted activity, so the UI can show "working"
  // before the first plan.updated lands (a long first turn looks idle otherwise).
  loopActiveAt: Record<string, number>;
  // Latest per-iteration loop telemetry (loop.status events) per goal.
  loopStatusByGoal: Record<string, LoopStatus>;

  setConn: (c: ConnState) => void;
  setTheme: (t: Theme) => void;
  setApiBase: (base: string) => void;
  resetLive: () => void;
  applyBoard: (b: BoardSnapshot) => void;
  applyActivity: (e: ActivityEvent) => void;
  setRuntime: (r: Runtime) => void;
  selectTask: (id: string | null) => void;
  setActiveGoal: (id: string | null) => void;
}

export const useStore = create<AppState>((set) => ({
  conn: "connecting",
  theme: initialTheme(),
  apiBase: "",
  board: null,
  runtime: null,
  lifecycle: [],
  activity: [],
  planByGoal: {},
  planningByGoal: {},
  subagentsByGoal: {},
  activeGoalId: null,
  selectedTaskId: null,
  loopActiveAt: {},
  loopStatusByGoal: {},

  setConn: (conn) => set({ conn }),

  // Persist the theme choice; an App effect mirrors it onto <html data-theme>.
  setTheme: (theme) => {
    try {
      localStorage.setItem("lf-theme", theme);
    } catch {
      // private mode / no storage: session-only theme is fine
    }
    set({ theme });
  },

  // Switching projects: setApiBase flips the origin (an App effect keyed on it
  // reconnects), resetLive drops the previous project's live state before the
  // new project's board + lifecycle backlog are refetched.
  setApiBase: (apiBase) => set({ apiBase }),
  resetLive: () =>
    set({
      lifecycle: [],
      activity: [],
      planByGoal: {},
      planningByGoal: {},
      subagentsByGoal: {},
      loopActiveAt: {},
      loopStatusByGoal: {},
      activeGoalId: null,
      selectedTaskId: null,
    }),

  applyBoard: (board) =>
    set((state) => {
      // A selected loop stays selected while it exists - closed loops are valid
      // selections (scoped history, resume target). Auto-focus the first open
      // goal only on the very first board or when the selection was deleted;
      // once a board exists an explicit "All" (null) choice sticks.
      const stillExists = state.activeGoalId !== null &&
        board.goals.some((g) => g.id === state.activeGoalId);
      const openGoal = board.goals.find((g) => g.status === "open");
      const firstBoard = state.board === null;
      return {
        board,
        activeGoalId: stillExists
          ? state.activeGoalId
          : firstBoard || state.activeGoalId !== null
          ? openGoal?.id ?? null
          : null,
      };
    }),

  applyActivity: (event) =>
    set((state) => {
      const lifecycle = parseLifecycle(event);
      const next: Partial<AppState> = {
        activity: [...state.activity.slice(-400), event],
      };
      // Stamp loop liveness so the UI can show "working" before plan.updated.
      // Loop activity events prefix their message with the goal id.
      const goalRef = lifecycle?.goalId ?? event.message.match(/^(GOAL-\d+)/)?.[1] ?? null;
      if (goalRef && (event.role === "loop" || event.role === "lifecycle")) {
        next.loopActiveAt = { ...state.loopActiveAt, [goalRef]: Date.now() };
      }
      if (lifecycle) {
        next.lifecycle = [...state.lifecycle.slice(-400), lifecycle];
        // Kickoff planning window: show a planning indicator until the plan
        // lands (plan.updated) or the goal moves on (task/blocked/closed).
        if (lifecycle.goalId) {
          if (lifecycle.kind === "goal.planning") {
            next.planningByGoal = { ...state.planningByGoal, [lifecycle.goalId]: true };
          } else if (
            lifecycle.kind === "plan.updated" ||
            lifecycle.kind === "task.added" ||
            lifecycle.kind === "goal.blocked" ||
            lifecycle.kind === "goal.closed"
          ) {
            next.planningByGoal = { ...state.planningByGoal, [lifecycle.goalId]: false };
          }
        }
        // loop.status carries the loop's live telemetry for the board strip.
        if (lifecycle.kind === "loop.status" && lifecycle.goalId) {
          next.loopStatusByGoal = {
            ...state.loopStatusByGoal,
            [lifecycle.goalId]: {
              iteration: Number(lifecycle.data.iteration) || 0,
              maxIterations: Number(lifecycle.data.maxIterations) || 0,
              tokensUsed: Number(lifecycle.data.tokensUsed) || 0,
              elapsedMs: Number(lifecycle.data.elapsedMs) || 0,
              reason: typeof lifecycle.data.reason === "string" ? lifecycle.data.reason : "",
            },
          };
        }
        // plan.updated carries the authoritative step list for its goal.
        if (lifecycle.kind === "plan.updated" && lifecycle.goalId) {
          const steps = (lifecycle.data.steps as PlanStep[]) ?? [];
          next.planByGoal = { ...state.planByGoal, [lifecycle.goalId]: steps };
        }
        // Track spawned/merged subagents as persistent satellite nodes.
        if (
          (lifecycle.kind === "subagent.spawned" || lifecycle.kind === "subagent.merged") &&
          lifecycle.goalId
        ) {
          const title = (lifecycle.data.title as string) ?? lifecycle.taskId ?? lifecycle.summary;
          const existing = state.subagentsByGoal[lifecycle.goalId] ?? [];
          const state2: "running" | "merged" = lifecycle.kind === "subagent.merged"
            ? "merged"
            : "running";
          const found = existing.find((s) => s.title === title);
          const updated = found
            ? existing.map((s) => (s.title === title ? { ...s, state: state2 } : s))
            : [...existing, { title, state: state2 }];
          next.subagentsByGoal = { ...state.subagentsByGoal, [lifecycle.goalId]: updated };
        }
      }
      return next;
    }),

  setRuntime: (runtime) => set({ runtime }),
  selectTask: (selectedTaskId) => set({ selectedTaskId }),
  setActiveGoal: (activeGoalId) => set({ activeGoalId }),
}));
