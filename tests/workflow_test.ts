import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  ensureAgentContext,
  parseWorkflow,
  readWorkflow,
  setWorkflowMaxConcurrentAgents,
  setWorkflowUseWorktrees,
} from "../src/workflow/workflow.ts";

Deno.test("workflow parser normalizes Symphony-style local kanban config", () => {
  const workflow = parseWorkflow(`---
version: 1
tracker:
  kind: loopforge-local
agent:
  max_concurrent_agents: 3
  max_turns: 2
  max_retries: 4
  retry_backoff_ms: 2500
codex:
  model: gpt-5.5
  reasoning_effort: xhigh
  fast_mode: false
github:
  pr_review: true
workspace:
  worktrees_dir: .loopforge/worktrees
  hooks:
    before_run:
      - printf ready
    after_run: [printf done]
---
# Custom Workflow

Keep the local Kanban as the tracker.
`);

  assertEquals(workflow.trackerKind, "loopforge-local");
  assertEquals(workflow.maxConcurrentAgents, 3);
  assertEquals(workflow.maxTurns, 2);
  assertEquals(workflow.maxRetries, 4);
  assertEquals(workflow.retryBackoffMs, 2500);
  assertEquals(workflow.reasoningEffort, "xhigh");
  assertEquals(workflow.fastMode, false);
  assertEquals(workflow.githubPrReview, true);
  assertEquals(workflow.hooks.before_run[0].command, "printf ready");
  assertEquals(workflow.hooks.after_run[0].command, "printf done");
  assertStringIncludes(workflow.instructions, "Custom Workflow");
});

Deno.test("workflow parser reads authority policy with conservative defaults", () => {
  const defaults = parseWorkflow("# No frontmatter\n");
  assertEquals(defaults.authority.publish, true);
  assertEquals(defaults.authority.maxTriageRetries, 2);

  const custom = parseWorkflow(`---
version: 1
authority:
  publish: false
  max_triage_retries: 0
---
# Custom
`);
  assertEquals(custom.authority.publish, false);
  assertEquals(custom.authority.maxTriageRetries, 0);
});

Deno.test("setWorkflowMaxConcurrentAgents edits only that frontmatter line", () => {
  const root = Deno.makeTempDirSync({ prefix: "loopforge-workflow-" });
  try {
    const updated = setWorkflowMaxConcurrentAgents(root, 4);
    assertEquals(updated.maxConcurrentAgents, 4);
    const source = Deno.readTextFileSync(`${root}/WORKFLOW.md`);
    assertStringIncludes(source, "max_concurrent_agents: 4");
    assertStringIncludes(source, "max_retries: 1");
    assertStringIncludes(source, "# LoopForge Workflow");
    assertEquals(readWorkflow(root).maxConcurrentAgents, 4);

    Deno.writeTextFileSync(
      `${root}/WORKFLOW.md`,
      "---\nversion: 1\nagent:\n  max_turns: 5\n---\n# Custom body\n",
    );
    assertEquals(setWorkflowMaxConcurrentAgents(root, 3).maxConcurrentAgents, 3);
    const inserted = Deno.readTextFileSync(`${root}/WORKFLOW.md`);
    assertStringIncludes(inserted, "agent:\n  max_concurrent_agents: 3\n  max_turns: 5");
    assertStringIncludes(inserted, "# Custom body");

    assertThrows(() => setWorkflowMaxConcurrentAgents(root, 0));
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("workflow useWorktrees defaults to true and round-trips through the setter", () => {
  const root = Deno.makeTempDirSync({ prefix: "loopforge-workflow-" });
  try {
    assertEquals(readWorkflow(root).useWorktrees, true);
    assertEquals(setWorkflowUseWorktrees(root, false).useWorktrees, false);
    assertStringIncludes(Deno.readTextFileSync(`${root}/WORKFLOW.md`), "use_worktrees: false");
    assertEquals(readWorkflow(root).useWorktrees, false);
    assertEquals(setWorkflowUseWorktrees(root, true).useWorktrees, true);
    assertEquals(readWorkflow(root).useWorktrees, true);

    // Inserts under workspace: when a hand-edited file lost the line.
    Deno.writeTextFileSync(
      `${root}/WORKFLOW.md`,
      "---\nversion: 1\nworkspace:\n  worktrees_dir: .loopforge/worktrees\n---\n# Custom body\n",
    );
    assertEquals(setWorkflowUseWorktrees(root, false).useWorktrees, false);
    assertStringIncludes(
      Deno.readTextFileSync(`${root}/WORKFLOW.md`),
      "workspace:\n  use_worktrees: false\n  worktrees_dir:",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("ensureAgentContext creates AGENTS.md but never creates CLAUDE.md", () => {
  const root = Deno.makeTempDirSync({ prefix: "loopforge-context-" });
  try {
    ensureAgentContext(root);
    const agents = Deno.readTextFileSync(`${root}/AGENTS.md`);
    assertStringIncludes(agents, "pseudo-autonomous loop");
    assertStringIncludes(agents, "needs manual verification");
    assertThrows(() => Deno.statSync(`${root}/CLAUDE.md`));
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("ensureAgentContext appends to existing files and refreshes a stale managed block", () => {
  const root = Deno.makeTempDirSync({ prefix: "loopforge-context-" });
  try {
    Deno.writeTextFileSync(`${root}/AGENTS.md`, "# My project rules\n- always test in game\n");
    Deno.writeTextFileSync(
      `${root}/CLAUDE.md`,
      "# Claude rules\n<!-- loopforge:autonomy:begin -->\nstale\n<!-- loopforge:autonomy:end -->\ntail\n",
    );
    ensureAgentContext(root);

    const agents = Deno.readTextFileSync(`${root}/AGENTS.md`);
    assertStringIncludes(agents, "# My project rules");
    assertStringIncludes(agents, "always test in game");
    assertStringIncludes(agents, "pseudo-autonomous loop");

    const claude = Deno.readTextFileSync(`${root}/CLAUDE.md`);
    assertStringIncludes(claude, "# Claude rules");
    assertStringIncludes(claude, "pseudo-autonomous loop");
    assertStringIncludes(claude, "tail");
    assertEquals(claude.includes("stale"), false);
    assertEquals(claude.split("loopforge:autonomy:begin").length, 2);

    // A second run is a no-op, not another append.
    ensureAgentContext(root);
    assertEquals(Deno.readTextFileSync(`${root}/AGENTS.md`), agents);
    assertEquals(Deno.readTextFileSync(`${root}/CLAUDE.md`), claude);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});
