import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  extractBlockedAsk,
  loopPlanComplete,
  loopPlanContract,
  loopPlanFingerprint,
  parseLoopPlan,
  signalsComplete,
} from "../src/workers/loop_plan.ts";

Deno.test("loop plan parser reads todo, doing, and done items with notes", () => {
  const items = parseLoopPlan(`# Goal: ship it
Some prose the agent wrote.
- [ ] Add the config gate -- needs ConfigEntry wiring
- [~] Patch the rebuy handler
- [x] Fix soil planting -- proven by dotnet build
* [X] Star bullet works too
- [] not an item
`);
  assertEquals(items.length, 4);
  assertEquals(items[0], {
    title: "Add the config gate",
    status: "todo",
    note: "needs ConfigEntry wiring",
  });
  assertEquals(items[1].status, "doing");
  assertEquals(items[2], {
    title: "Fix soil planting",
    status: "done",
    note: "proven by dotnet build",
  });
  assertEquals(items[3].status, "done");
  assertEquals(loopPlanComplete(items), false);
  assertEquals(loopPlanComplete(items.slice(2)), true);
  assertEquals(loopPlanComplete([]), false);
});

Deno.test("loop signals: complete token, blocked ask, stall fingerprint", () => {
  assert(signalsComplete("All finished.\nLOOP_COMPLETE"));
  assert(!signalsComplete("We will reach LOOP_COMPLETE soon."));
  assertEquals(
    extractBlockedAsk("did some work\nLOOP_BLOCKED: need the Stripe test key to continue"),
    "need the Stripe test key to continue",
  );
  assertEquals(extractBlockedAsk("no blockers here"), null);
  const items = parseLoopPlan("- [ ] a\n- [x] b");
  const same = loopPlanFingerprint(items, "abc123");
  assertEquals(same, loopPlanFingerprint(items, "abc123"));
  assert(same !== loopPlanFingerprint(items, "def456"));
  assertStringIncludes(loopPlanContract(), "LOOP_PLAN.md");
  assertStringIncludes(loopPlanContract(), "LOOP_BLOCKED");
  // The plan is a live Kanban, not a post-hoc changelog: it must teach the
  // in-progress marker and the changelog ban.
  assertStringIncludes(loopPlanContract(), "- [~]");
  assertStringIncludes(loopPlanContract(), "not a changelog");
});
