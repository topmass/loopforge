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
  board: BoardSnapshot | null;
  runtime: Runtime | null;
  lifecycle: LifecycleEvent[];
  activity: ActivityEvent[];
  // The most recent plan.updated step list per goal - the Kanban/planet source.
  planByGoal: Record<string, PlanStep[]>;
  // Sub-agents spawned by the loop owner, per goal - distinct nodes in the
  // planet view (the main agent is the core; these are its satellites).
  subagentsByGoal: Record<string, { title: string; state: "running" | "merged" }[]>;
  activeGoalId: string | null;
  selectedTaskId: string | null;
  // Transient pulse events for the planet view to animate, keyed by an id.
  pulses: { id: number; kind: string; taskId: string | null; at: number }[];

  setConn: (c: ConnState) => void;
  applyBoard: (b: BoardSnapshot) => void;
  applyActivity: (e: ActivityEvent) => void;
  setRuntime: (r: Runtime) => void;
  selectTask: (id: string | null) => void;
  setActiveGoal: (id: string | null) => void;
}

let pulseSeq = 1;

export const useStore = create<AppState>((set) => ({
  conn: "connecting",
  board: null,
  runtime: null,
  lifecycle: [],
  activity: [],
  planByGoal: {},
  subagentsByGoal: {},
  activeGoalId: null,
  selectedTaskId: null,
  pulses: [],

  setConn: (conn) => set({ conn }),

  applyBoard: (board) =>
    set((state) => {
      const openGoal = board.goals.find((g) => g.status === "open");
      return {
        board,
        activeGoalId: state.activeGoalId ?? openGoal?.id ?? board.goals.at(-1)?.id ?? null,
      };
    }),

  applyActivity: (event) =>
    set((state) => {
      const lifecycle = parseLifecycle(event);
      const next: Partial<AppState> = {
        activity: [...state.activity.slice(-400), event],
      };
      if (lifecycle) {
        next.lifecycle = [...state.lifecycle.slice(-400), lifecycle];
        // plan.updated carries the authoritative step list for its goal.
        if (lifecycle.kind === "plan.updated" && lifecycle.goalId) {
          const steps = (lifecycle.data.steps as PlanStep[]) ?? [];
          next.planByGoal = { ...state.planByGoal, [lifecycle.goalId]: steps };
        }
        // Subagent + status events become transient pulses for the planet view.
        if (
          lifecycle.kind === "subagent.spawned" ||
          lifecycle.kind === "subagent.progress" ||
          lifecycle.kind === "subagent.merged" ||
          lifecycle.kind === "goal.blocked" ||
          lifecycle.kind === "verified"
        ) {
          next.pulses = [
            ...state.pulses.slice(-30),
            { id: pulseSeq++, kind: lifecycle.kind, taskId: lifecycle.taskId, at: Date.now() },
          ];
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
