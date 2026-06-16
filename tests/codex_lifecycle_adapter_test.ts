import { assert, assertEquals } from "@std/assert";
import { codexEventToLifecycle } from "../src/workers/codex_lifecycle_adapter.ts";

Deno.test("native codex plan event maps to plan.updated with steps", () => {
  const ev = codexEventToLifecycle("GOAL-1", {
    kind: "turn/plan/updated",
    raw: {
      params: {
        plan: [
          { step: "Read code", status: "completed" },
          { step: "Patch", status: "in_progress" },
        ],
      },
    },
  });
  assert(ev);
  assertEquals(ev!.kind, "plan.updated");
  const steps = ev!.data.steps as Array<{ status: string }>;
  assertEquals(steps.length, 2);
  assertEquals(steps[0].status, "done");
  assertEquals(steps[1].status, "doing");
});

Deno.test("native goal + multi_agent events map to canonical kinds", () => {
  const goal = codexEventToLifecycle("GOAL-1", {
    kind: "thread/goal/updated",
    raw: { params: { goal: { objective: "Ship the thing" } } },
  });
  assertEquals(goal!.kind, "goal.planning");
  assertEquals(goal!.summary, "Ship the thing");

  const spawn = codexEventToLifecycle("GOAL-1", {
    kind: "multi_agent_v1.spawn_agent",
    raw: { output: { agent_id: "abc", nickname: "Zeno" } },
  });
  assertEquals(spawn!.kind, "subagent.spawned");
  assertEquals(spawn!.data.nickname, "Zeno");

  const wait = codexEventToLifecycle("GOAL-1", {
    kind: "multi_agent_v1.wait_agent",
    message: "Boyle completed app.py",
  });
  assertEquals(wait!.kind, "subagent.merged");

  const closed = codexEventToLifecycle("GOAL-1", { kind: "thread/goal/cleared" });
  assertEquals(closed!.kind, "goal.closed");
});

Deno.test("unrecognized native events are ignored", () => {
  assertEquals(codexEventToLifecycle("GOAL-1", { kind: "item/commandExecution/outputDelta" }), null);
  assertEquals(codexEventToLifecycle("GOAL-1", { kind: "plan", raw: { nothing: true } }), null);
});
