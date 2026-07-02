// The live store: one SSE connection to /api/events feeds board snapshots and
// the lifecycle/activity stream; REST calls drive goals and steers. The whole
// UI (sidebar, chat, Kanban, planet view) reads from here, so Kanban and the
// node view can never disagree - they project the same state.

import { create } from "zustand";
import type {
  ActivityEvent,
  BoardSnapshot,
  LifecycleEvent,
  PlanStep,
  Runtime,
} from "./types";
import { parseLifecycle } from "./api";

export type ConnState = "connecting" | "live" | "down";

interface AppState {
  conn: ConnState;
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

  setConn: (c: ConnState) => void;
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

  setConn: (conn) => set({ conn }),

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
      activeGoalId: null,
      selectedTaskId: null,
    }),

  applyBoard: (board) =>
    set((state) => {
      // The steering target is an OPEN goal; when none are open the board still
      // renders its Done history and activeGoalId may stay null.
      const stillOpen = state.activeGoalId !== null &&
        board.goals.some((g) => g.id === state.activeGoalId && g.status === "open");
      const openGoal = board.goals.find((g) => g.status === "open");
      return {
        board,
        activeGoalId: stillOpen ? state.activeGoalId : openGoal?.id ?? null,
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
