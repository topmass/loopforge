import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildPlannerPrompt,
  parsePlannerPlanResponse,
  parsePlannerResponse,
} from "../src/workers/goal_planner.ts";

Deno.test("planner prompt states the red-first win-condition rule", () => {
  const prompt = buildPlannerPrompt("Add a widget to the settings page");
  assertStringIncludes(prompt, "FAILS before the work");
  assertStringIncludes(prompt, "OUTCOME");
});

Deno.test("planner parser accepts fenced JSON task lists", () => {
  const tasks = parsePlannerResponse(`Here is the plan:
\`\`\`json
[
  {
    "title": "Add queue controls",
    "description": "Add controls for sequential task execution.",
	    "acceptanceCriteria": "- Queue button is visible.\\n- Queue route runs tasks.",
	    "priority": 250,
	    "workpad": "Can run before review automation.",
	    "dependsOn": [],
	    "riskLevel": "low",
	    "verificationPlan": "- Run route smoke test."
	  }
	]
\`\`\`
`);

  assertEquals(tasks.length, 1);
  assertEquals(tasks[0].title, "Add queue controls");
  assertEquals(tasks[0].priority, 250);
  assertEquals(tasks[0].riskLevel, "low");
  assertEquals(tasks[0].verificationPlan, "- Run route smoke test.");
});

Deno.test("planner parser accepts one compiled prompt object", () => {
  const tasks = parsePlannerResponse(JSON.stringify({
    title: "Build activity feed",
    prompt: "Implement an activity feed and validate it.",
    acceptanceCriteria: "- Feed renders.\n- Validation passes.",
    priority: 900,
    workpad: "Independent feature.",
  }));

  assertEquals(tasks.length, 1);
  assertEquals(tasks[0].description, "Implement an activity feed and validate it.");
  assertEquals(tasks[0].workpad, "Independent feature.");
});

Deno.test("planner parser keeps goal graph dependencies", () => {
  const tasks = parsePlannerResponse(JSON.stringify([
    {
      title: "Create profile model",
      prompt: "Add profile data model.",
      acceptanceCriteria: "- Model exists.",
      priority: 900,
      workpad: "Foundation.",
      dependsOn: [],
      riskLevel: "medium",
      verificationPlan: "- Run model tests.",
    },
    {
      title: "Build profile UI",
      prompt: "Add profile UI.",
      acceptanceCriteria: "- UI renders.",
      priority: 800,
      workpad: "Depends on model.",
      dependsOn: ["Create profile model"],
      riskLevel: "high",
      verificationPlan: "- Run UI smoke test.",
    },
  ]));

  assertEquals(tasks.length, 2);
  assertEquals(tasks[1].dependsOn, ["Create profile model"]);
  assertEquals(tasks[1].riskLevel, "high");
  assertEquals(tasks[1].verificationPlan, "- Run UI smoke test.");
});

Deno.test("planner parser accepts goal contracts with task arrays", () => {
  const plan = parsePlannerPlanResponse(JSON.stringify({
    completionContract: "- All task evidence is complete.\n- The TUI shows the final state.",
    tasks: [
      {
        title: "Expose goal contract",
        prompt: "Store and render the goal completion contract.",
        acceptanceCriteria: "- Contract appears in status output.",
        priority: 900,
        workpad: "Goal-level memory feature.",
        dependsOn: [],
        riskLevel: "medium",
        verificationPlan: "- Run status-line tests.",
      },
    ],
  }));

  assertEquals(plan.tasks.length, 1);
  assertEquals(plan.tasks[0].title, "Expose goal contract");
  assertEquals(
    plan.completionContract,
    "- All task evidence is complete.\n- The TUI shows the final state.",
  );
});

Deno.test("planner parser classifies ops publish tasks and fails closed on unknown actions", () => {
  const plan = parsePlannerPlanResponse(JSON.stringify({
    completionContract: "- The remote head matches the local head.",
    tasks: [
      {
        title: "Commit and push current state",
        prompt: "Publish the repository state to the origin remote.",
        acceptanceCriteria: "- Remote matches local head.",
        priority: 200,
        workpad: "Ops task.",
        dependsOn: [],
        riskLevel: "low",
        verificationPlan: "- Confirm 0 ahead after push.",
        kind: "ops",
        opsAction: "publish",
      },
      {
        title: "Deploy to production",
        prompt: "Deploy the app.",
        acceptanceCriteria: "- Deployed.",
        priority: 100,
        workpad: "Unknown ops action falls back to code.",
        dependsOn: [],
        riskLevel: "high",
        verificationPlan: "- Check deploy.",
        kind: "ops",
        opsAction: "deploy",
      },
    ],
  }));
  assertEquals(plan.tasks[0].kind, "ops");
  assertEquals(plan.tasks[0].opsAction, "publish");
  assertEquals(plan.tasks[1].kind, "code");
  assertEquals(plan.tasks[1].opsAction, undefined);
});
