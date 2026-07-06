import { assertEquals, assertStringIncludes } from "@std/assert";
import { BoardStore } from "../src/board/store.ts";
import {
  formatGoalLines,
  formatHealthLines,
  formatStatusLines,
  listManualVerificationItems,
} from "../src/board/status_lines.ts";

Deno.test("status lines include active goal verdict and task counts", () => {
  const root = Deno.makeTempDirSync({ prefix: "loopforge-status-" });
  const store = new BoardStore(root);
  try {
    store.initProject();
    store.createGoal("Ship status output");

    const text = formatStatusLines(store.getBoard()).join("\n");

    assertStringIncludes(text, "Ready: 1");
    assertStringIncludes(text, "Active goal:");
    assertStringIncludes(text, "GOAL-1: Ready To Run - 0/1 done (0%)");
    assertStringIncludes(text, "Contract:");
    assertStringIncludes(text, "Recently closed goals:\nnone");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("status lines include recent closed goals", () => {
  const root = Deno.makeTempDirSync({ prefix: "loopforge-status-" });
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal, task } = store.createGoal("Close status goal");
    store.requestTransition(task.id, "in_progress");
    store.updateTaskValidation(
      task.id,
      [
        "Turn status: completed",
        "Test turn status: completed",
        "Discovered verification gates:",
        "- Diff inspection: git diff --stat && git diff --check - Every task needs a basic changed-file and whitespace sanity check.",
        "",
        "Verification verdict:",
        "VERIFICATION_PASSED",
        "- Focused validation passed with recorded proof.",
        "Commit: abc123",
        "Git status:",
        "clean",
        "LoopForge review: APPROVED",
      ].join("\n"),
    );
    store.updateTaskCard(task.id, "TASK-1 complete.");
    store.updateTaskHandoff(task.id, "Validated and absorbed.");
    store.requestTransition(task.id, "review");
    store.requestTransition(task.id, "done");
    store.closeGoal(goal.id, "Closed from status test.");

    const text = formatStatusLines(store.getBoard()).join("\n");

    assertStringIncludes(text, "Active goal:\nnone");
    assertStringIncludes(text, "Recently closed goals:");
    assertStringIncludes(text, "GOAL-1: Close status goal - Closed from status test.");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("goal lines list open and closed goal details", () => {
  const root = Deno.makeTempDirSync({ prefix: "loopforge-status-" });
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal, task } = store.createGoal("Close listed goal");
    store.requestTransition(task.id, "in_progress");
    store.updateTaskValidation(
      task.id,
      [
        "Turn status: completed",
        "Test turn status: completed",
        "Discovered verification gates:",
        "- Diff inspection: git diff --stat && git diff --check - Every task needs a basic changed-file and whitespace sanity check.",
        "",
        "Verification verdict:",
        "VERIFICATION_PASSED",
        "- Focused validation passed with recorded proof.",
        "Commit: abc123",
        "Git status:",
        "clean",
        "LoopForge review: APPROVED",
      ].join("\n"),
    );
    store.updateTaskCard(task.id, "TASK-1 complete.");
    store.updateTaskHandoff(task.id, "Validated and absorbed.");
    store.requestTransition(task.id, "review");
    store.requestTransition(task.id, "done");
    store.closeGoal(goal.id, "Closed from goals list test.");
    store.createGoal("Next open goal");

    const text = formatGoalLines(store.getBoard()).join("\n");

    assertStringIncludes(text, "GOAL-1 closed");
    assertStringIncludes(text, "Close listed goal");
    assertStringIncludes(text, "Closure: Closed from goals list test.");
    assertStringIncludes(text, "GOAL-2 open: Next open goal");
    assertStringIncludes(text, "Ready To Run - 0/1 done (0%)");
    assertStringIncludes(text, "Contract:");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("health lines summarize project readiness and next action", () => {
  const root = Deno.makeTempDirSync({ prefix: "loopforge-status-" });
  const store = new BoardStore(root);
  try {
    store.initProject();
    store.setMainThread("thread-main", "Project memory ready.");
    const { task } = store.createGoal("Ship health output");

    const text = formatHealthLines(store.getBoard()).join("\n");

    assertStringIncludes(text, "Project health: Ready To Run");
    assertStringIncludes(text, "Main memory: ready thread-main");
    assertStringIncludes(text, "Tasks: 1 ready, 0 working, 0 need input, 0 review, 0 done");
    assertStringIncludes(text, `Next: ${task.id}: start the task or run ready tasks.`);
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("health lines name the main ensure remediation when memory is missing", () => {
  const root = Deno.makeTempDirSync({ prefix: "loopforge-status-" });
  const store = new BoardStore(root);
  try {
    store.initProject();
    store.createGoal("Create memory");

    const text = formatHealthLines(store.getBoard()).join("\n");

    assertStringIncludes(text, "Project health: Needs Project Memory");
    assertStringIncludes(text, "Main memory: not started");
    assertStringIncludes(
      text,
      "Next: Open the GUI or run `loopforge main ensure` to create project memory.",
    );
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("health lines recommend evidence repair before done cleanup", () => {
  const root = Deno.makeTempDirSync({ prefix: "loopforge-status-" });
  const store = new BoardStore(root);
  try {
    store.initProject();
    store.setMainThread("thread-main", "Project memory ready.");
    const { task } = store.createGoal("Repair evidence");
    store.requestTransition(task.id, "in_progress");
    store.updateTaskValidation(task.id, "deno test passed");
    store.requestTransition(task.id, "review");
    store.requestTransition(task.id, "done");

    const text = formatHealthLines(store.getBoard()).join("\n");

    assertStringIncludes(text, "Project health: Needs Attention");
    assertStringIncludes(text, "Next: GOAL-1: resolve evidence gaps before closing the goal.");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("manual verification items collect notes from finished tasks only", () => {
  const items = listManualVerificationItems({
    tasks: [
      {
        id: "TASK-1",
        title: "Ship dialog",
        status: "done",
        validation:
          "VERIFICATION_PASSED\n- checks ran.\nRemaining risks: needs manual verification: confirm the dialog renders.",
        handoffSummary: "- Needs manual verification: confirm the dialog renders.",
        verificationSummary: "",
      },
      {
        id: "TASK-2",
        title: "Still working",
        status: "in_progress",
        validation: "needs manual verification: not yet",
        handoffSummary: "",
        verificationSummary: "",
      },
      {
        id: "TASK-3",
        title: "Fully proven",
        status: "done",
        validation: "VERIFICATION_PASSED\n- everything covered in-repo.",
        handoffSummary: "",
        verificationSummary: "",
      },
    ],
  });
  assertEquals(items.length, 1);
  assertEquals(items[0].taskId, "TASK-1");
  assertEquals(items[0].notes.length, 2);
});
