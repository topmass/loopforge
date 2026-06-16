import { assert, assertEquals } from "@std/assert";
import { BoardStore } from "../src/board/store.ts";
import {
  isLifecycleEvent,
  LIFECYCLE_ROLE,
  parseLifecycleEvent,
  planStepsFromCodexRaw,
  planUpdated,
} from "../src/board/lifecycle.ts";
import type { ActivityEvent } from "../src/board/types.ts";

Deno.test("lifecycle events round-trip through the store with their payload", () => {
  const root = Deno.makeTempDirSync();
  new Deno.Command("git", { args: ["init", "-b", "main"], cwd: root }).outputSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal } = store.createGoal("Ship it");
    const stored = store.appendLifecycleEvent(
      planUpdated(goal.id, [
        { title: "Build the widget", status: "done", note: "wrote widget.ts" },
        { title: "Document it", status: "doing", note: "" },
      ]),
    );
    assertEquals(stored.role, LIFECYCLE_ROLE);
    assertEquals(stored.kind, "plan.updated");
    assert(isLifecycleEvent(stored));

    const feed = store.listLifecycleEvents(goal.id);
    assertEquals(feed.length, 1);
    assertEquals(feed[0].kind, "plan.updated");
    assertEquals(feed[0].goalId, goal.id);
    const steps = feed[0].data.steps as Array<{ title: string; status: string; note: string }>;
    assertEquals(steps.length, 2);
    assertEquals(steps[0], { title: "Build the widget", status: "done", note: "wrote widget.ts" });
    assertEquals(steps[1].status, "doing");

    // goalId filter excludes other goals' lifecycle events.
    const other = store.createGoal("Other");
    store.appendLifecycleEvent({
      kind: "goal.closed",
      goalId: other.goal.id,
      taskId: null,
      summary: "done",
      data: {},
    });
    assertEquals(store.listLifecycleEvents(goal.id).length, 1);
    assertEquals(store.listLifecycleEvents().length, 2);
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("non-lifecycle activity events are ignored by the typed feed", () => {
  const free: ActivityEvent = {
    id: 1,
    taskId: "TASK-1",
    runId: null,
    role: "codex",
    kind: "agent",
    message: "working",
    createdAt: "now",
    rawJson: null,
  };
  assertEquals(isLifecycleEvent(free), false);
  assertEquals(parseLifecycleEvent(free), null);
});

Deno.test("planStepsFromCodexRaw extracts update_plan steps from a nested raw event", () => {
  const raw = {
    method: "turn/plan/updated",
    params: {
      plan: [
        { step: "Inspect the repo", status: "completed" },
        { step: "Patch the handler", status: "in_progress" },
        { step: "Add tests", status: "pending" },
      ],
    },
  };
  const steps = planStepsFromCodexRaw(raw);
  assert(steps);
  assertEquals(steps!.length, 3);
  assertEquals(steps![0], { title: "Inspect the repo", status: "done", note: "" });
  assertEquals(steps![1].status, "doing");
  assertEquals(steps![2].status, "todo");
  assertEquals(planStepsFromCodexRaw({ no: "plan" }), null);
});
