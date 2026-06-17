import { assertEquals } from "@std/assert";
import { BoardStore } from "../src/board/store.ts";

// Regression: a fan-out emits hundreds of agent-chatter events. The lifecycle
// feed must still return the sub-agent/plan events (the GUI rehydrates the node
// view from it), not lose them behind the chatter in a fixed-size window.
Deno.test("listLifecycleEvents keeps lifecycle events buried under agent chatter", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal } = store.createGoal("Build it in parallel");

    // 5 sub-agents spawn...
    for (const title of ["api", "ui", "css", "js", "readme"]) {
      store.appendLifecycleEvent({
        kind: "subagent.spawned",
        goalId: goal.id,
        taskId: null,
        summary: title,
        data: { title },
      });
    }
    // ...then each floods the feed with chatter while it works.
    for (let i = 0; i < 800; i++) {
      store.appendEvent(null, null, "fanout:worker", "agent", `working chunk ${i}`);
    }

    const events = store.listLifecycleEvents(goal.id);
    const spawned = events.filter((e) => e.kind === "subagent.spawned");
    // All 5 spawns survive even though 800 chatter events came after them.
    assertEquals(spawned.length, 5);
    assertEquals(
      spawned.map((e) => e.data.title).sort(),
      ["api", "css", "js", "readme", "ui"],
    );
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});
