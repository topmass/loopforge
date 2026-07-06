import path from "node:path";
import { workflowPath } from "../paths.ts";
import { defaultAgentsInstructions } from "../workers/task_memory.ts";
import type { ReasoningEffort } from "../board/store.ts";

export type WorkflowHookStage = "after_create" | "before_run" | "after_run" | "before_remove";

export interface WorkflowHook {
  command: string;
  timeoutMs: number;
}

export interface WorkflowAuthority {
  publish: boolean;
  maxTriageRetries: number;
}

export interface WorkflowRuntime {
  version: number;
  trackerKind: "loopforge-local";
  maxConcurrentAgents: number;
  maxTurns: number;
  maxRetries: number;
  retryBackoffMs: number;
  model: string;
  reasoningEffort: ReasoningEffort;
  fastMode: boolean;
  githubPrReview: boolean;
  worktreesDir: string;
  hooks: Record<WorkflowHookStage, WorkflowHook[]>;
  authority: WorkflowAuthority;
  instructions: string;
}

type ParsedValue = string | number | boolean | string[] | ParsedRecord;

interface ParsedRecord {
  [key: string]: ParsedValue;
}

const HOOK_STAGES: WorkflowHookStage[] = [
  "after_create",
  "before_run",
  "after_run",
  "before_remove",
];

export function ensureWorkflow(root: string): void {
  const target = workflowPath(root);
  try {
    Deno.statSync(target);
  } catch {
    Deno.writeTextFileSync(target, defaultWorkflow());
  }
}

// Managed context block synced into the project's AGENTS.md (created if missing) and
// CLAUDE.md (only when the file already exists), so any harness that auto-loads those
// files learns it may be running inside LoopForge's pseudo-autonomous loop. Content
// between the markers is owned by LoopForge and refreshed on init.
const AGENT_CONTEXT_BEGIN = "<!-- loopforge:autonomy:begin -->";
const AGENT_CONTEXT_END = "<!-- loopforge:autonomy:end -->";

export function agentContextBlock(): string {
  return `${AGENT_CONTEXT_BEGIN}
<!-- Managed by LoopForge; edits inside this block are overwritten. -->
## LoopForge

This project is operated by LoopForge, a local agent-orchestration system (see WORKFLOW.md).
If your session was started by LoopForge (you are working inside a \`.loopforge/worktrees\`
checkout), you are one worker in a pseudo-autonomous loop that may run unattended for hours:

- Stopping for user input is the last resort: only missing credentials, third-party access,
  destructive approval, or a scope-changing product decision justify it. For anything else,
  make the reasonable call, record it in your handoff, and keep working.
- Instructions elsewhere that say work is not done until it is tested still apply, but here
  "tested" means the strongest verification available inside the repository. Criteria that
  need the running app or manual QA go in your handoff as
  "needs manual verification: <what and how>" instead of stopping work.
- The LoopForge daemon owns commits, board state, reviews, and merges. Do not commit or edit
  \`.loopforge/\` state yourself.
${AGENT_CONTEXT_END}`;
}

export function ensureAgentContext(root: string): void {
  syncAgentContextFile(path.join(root, "AGENTS.md"), true);
  syncAgentContextFile(path.join(root, "CLAUDE.md"), false);
}

function syncAgentContextFile(target: string, createIfMissing: boolean): void {
  let current: string | null;
  try {
    current = Deno.readTextFileSync(target);
  } catch {
    current = null;
  }
  if (current === null && !createIfMissing) {
    return;
  }
  const block = agentContextBlock();
  if (current === null) {
    Deno.writeTextFileSync(target, `${defaultAgentsInstructions()}\n${block}\n`);
    return;
  }
  const begin = current.indexOf(AGENT_CONTEXT_BEGIN);
  const end = current.indexOf(AGENT_CONTEXT_END);
  if (begin >= 0 && end > begin) {
    const next = current.slice(0, begin) + block + current.slice(end + AGENT_CONTEXT_END.length);
    if (next !== current) {
      Deno.writeTextFileSync(target, next);
    }
    return;
  }
  const separator = current.endsWith("\n") ? "\n" : "\n\n";
  Deno.writeTextFileSync(target, `${current}${separator}${block}\n`);
}

export function readWorkflow(root: string): WorkflowRuntime {
  ensureWorkflow(root);
  return parseWorkflow(Deno.readTextFileSync(workflowPath(root)));
}

export function parseWorkflow(source: string): WorkflowRuntime {
  const { frontmatter, body } = splitFrontmatter(source);
  const data = parseSimpleYaml(frontmatter);
  const agent = record(data.agent);
  const codex = record(data.codex);
  const tracker = record(data.tracker);
  const workspace = record(data.workspace);
  const github = record(data.github);
  const hooks = record(workspace.hooks);
  const authority = record(data.authority);

  return {
    version: numberValue(data.version, 1),
    trackerKind: tracker.kind === "loopforge-local" ? "loopforge-local" : "loopforge-local",
    maxConcurrentAgents: positiveInt(agent.max_concurrent_agents, 2),
    maxTurns: positiveInt(agent.max_turns, 3),
    maxRetries: positiveInt(agent.max_retries, 1),
    retryBackoffMs: positiveInt(agent.retry_backoff_ms, 1000),
    model: stringValue(codex.model, "gpt-5.5"),
    reasoningEffort: reasoningValue(codex.reasoning_effort, "high"),
    fastMode: booleanValue(codex.fast_mode, true),
    githubPrReview: booleanValue(github.pr_review, false),
    worktreesDir: stringValue(workspace.worktrees_dir, ".loopforge/worktrees"),
    hooks: normalizeHooks(hooks),
    authority: {
      publish: booleanValue(authority.publish, true),
      maxTriageRetries: nonNegativeInt(authority.max_triage_retries, 2),
    },
    instructions: body.trim() || defaultInstructions(),
  };
}

// WORKFLOW.md is a user-owned file, so changing one knob means line surgery on
// the frontmatter, not a rewrite: replace the existing max_concurrent_agents
// line in place, or insert one under agent: when it is missing.
export function setWorkflowMaxConcurrentAgents(root: string, count: number): WorkflowRuntime {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`max_concurrent_agents must be a positive integer, got ${count}.`);
  }
  ensureWorkflow(root);
  const target = workflowPath(root);
  const source = Deno.readTextFileSync(target);
  const existing = source.match(/^(\s*)max_concurrent_agents:\s*\S.*$/m);
  let next: string;
  if (existing) {
    next = source.replace(existing[0], `${existing[1]}max_concurrent_agents: ${count}`);
  } else {
    const agentLine = source.match(/^agent:\s*$/m);
    if (!agentLine) {
      throw new Error("WORKFLOW.md frontmatter has no agent: section to update.");
    }
    next = source.replace(agentLine[0], `agent:\n  max_concurrent_agents: ${count}`);
  }
  Deno.writeTextFileSync(target, next);
  return parseWorkflow(next);
}

export function defaultWorkflow(): string {
  return `---
version: 1
tracker:
  kind: loopforge-local
agent:
  max_concurrent_agents: 2
	  max_turns: 3
  max_retries: 1
  retry_backoff_ms: 1000
codex:
  model: gpt-5.5
  reasoning_effort: high
  fast_mode: true
github:
  pr_review: false
authority:
  publish: true
  max_triage_retries: 2
workspace:
  worktrees_dir: .loopforge/worktrees
  hooks:
    after_create: []
    before_run: []
    after_run: []
    before_remove: []
---
${defaultInstructions()}
`;
}

function defaultInstructions(): string {
  return `# LoopForge Workflow

LoopForge is a local Codex orchestration layer backed by this repository's Kanban board.
Use this file as the repo-owned contract for how agents should plan, implement, test, review,
and merge work.

## Board Contract
- Inbox is for raw or paused work that needs user input.
- Ready is dispatchable work.
- Started is work currently owned by a Codex worker.
- Review means implementation and validation evidence exist.
- Merging means review approved and LoopForge is applying the local merge or PR gate.
- Inbox also holds work that needs user direction or a resolved blocker.
- Done means the reviewer approved the work and LoopForge merged it.

## Loop Contract
Every task moves through a durable loop:
Queued -> Planning -> Working -> Testing -> Repairing -> Reviewing -> Remembering -> Done.
Blocked means LoopForge has a concrete blocker or user decision to show on the board.
Each phase should preserve the current gate, next action, verification summary, and any needed input.

## Workpad Contract
Every worker handoff should preserve:
- The task objective and any narrowed assumptions.
- Files or surfaces inspected.
- Files changed.
- Validation commands and observed results.
- Blockers, confusions, or follow-up tasks.

	## Agent Contract
	- Work in the assigned worktree only.
	- Keep edits scoped to the task acceptance criteria.
	- Follow the task verification plan and any discovered verification gates.
	- Use subagents only for independent investigation, verification, or implementation slices.
- Do not mutate .loopforge runtime state directly.
- Do not create commits; LoopForge records commits, reviews, and merges.
- LoopForge runs pseudo-autonomously: the user may be away for hours. Stopping for input is
  the last resort, reserved for credentials, third-party access, destructive approval, or a
  scope-changing product decision. Anything else: decide, note it in the handoff, keep going.
- Criteria that need the running app or manual QA never block: verify what is checkable in
  the repository and record "needs manual verification: <what and how>" in the handoff.
- If truly blocked, state the blocker and the exact user decision or repo change needed.

## Authority Contract
- Repo-level operations such as committing the root working tree and pushing to the remote are
  LoopForge harness actions, never agent actions. The authority frontmatter controls them:
  publish allows the harness publish action, max_triage_retries bounds triage-driven retries.
- When a worker blocks with a concrete question, the LoopForge main agent triages it first:
  resolve it with an allowed harness action, retry the worker once with corrected instructions,
  or escalate to the user with one clear ask.
- Hard external blockers (missing credentials, third-party accounts, user-only decisions) always
  escalate immediately. The same blocker appearing twice always escalates.
`;
}

function splitFrontmatter(source: string): { frontmatter: string; body: string } {
  if (!source.startsWith("---\n")) {
    return { frontmatter: "", body: source };
  }
  const end = source.indexOf("\n---", 4);
  if (end < 0) {
    return { frontmatter: "", body: source };
  }
  return {
    frontmatter: source.slice(4, end).trim(),
    body: source.slice(end + 4).replace(/^\r?\n/, ""),
  };
}

function parseSimpleYaml(source: string): Record<string, ParsedValue> {
  const root: Record<string, ParsedValue> = {};
  const stack: Array<{
    indent: number;
    value: Record<string, ParsedValue> | string[];
    parent?: Record<string, ParsedValue>;
    key?: string;
  }> = [
    { indent: -1, value: root },
  ];
  for (const rawLine of source.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) {
      continue;
    }
    const indent = rawLine.match(/^\s*/)?.[0].length ?? 0;
    const line = rawLine.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    if (line.startsWith("- ")) {
      let current = stack[stack.length - 1];
      if (!Array.isArray(current.value) && current.parent && current.key) {
        const items: string[] = [];
        current.parent[current.key] = items;
        current = { ...current, value: items };
        stack[stack.length - 1] = current;
      }
      if (Array.isArray(current.value)) {
        current.value.push(String(parseScalar(line.slice(2))));
      }
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!match) {
      continue;
    }
    const parent = stack[stack.length - 1].value;
    if (Array.isArray(parent)) {
      continue;
    }
    const key = match[1];
    const rest = match[2] ?? "";
    if (!rest) {
      const child: Record<string, ParsedValue> = {};
      parent[key] = child;
      stack.push({ indent, value: child, parent, key });
    } else {
      parent[key] = parseScalar(rest);
    }
  }
  return root;
}

function parseScalar(value: string): ParsedValue {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed === "[]") return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).split(",").map((item) => item.trim()).filter(Boolean);
  }
  return trimmed.replace(/^["']|["']$/g, "");
}

function normalizeHooks(
  hooks: Record<string, ParsedValue>,
): Record<WorkflowHookStage, WorkflowHook[]> {
  const result: Record<WorkflowHookStage, WorkflowHook[]> = {
    after_create: [],
    before_run: [],
    after_run: [],
    before_remove: [],
  };
  for (const stage of HOOK_STAGES) {
    const value = hooks[stage];
    if (Array.isArray(value)) {
      result[stage] = value.map((command) => ({ command, timeoutMs: 120000 }));
    } else if (typeof value === "string" && value.trim()) {
      result[stage] = [{ command: value.trim(), timeoutMs: 120000 }];
    }
  }
  return result;
}

function record(value: ParsedValue | undefined): Record<string, ParsedValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value: ParsedValue | undefined, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberValue(value: ParsedValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positiveInt(value: ParsedValue | undefined, fallback: number): number {
  const number = numberValue(value, fallback);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function nonNegativeInt(value: ParsedValue | undefined, fallback: number): number {
  const number = numberValue(value, fallback);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function booleanValue(value: ParsedValue | undefined, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function reasoningValue(
  value: ParsedValue | undefined,
  fallback: ReasoningEffort,
): ReasoningEffort {
  return typeof value === "string" && ["low", "medium", "high", "xhigh"].includes(value)
    ? value as ReasoningEffort
    : fallback;
}
