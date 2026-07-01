import { ActivityEventInput, GoalProbeDraft, TaskDraft } from "../board/types.ts";
import { CodexClient } from "./codex_app_server.ts";
import { createPlannerClient } from "./agent_backend.ts";
import { shouldRecordActivity } from "./activity_filter.ts";
import { readWorkflow } from "../workflow/workflow.ts";
import { collectAgentsInstructions } from "./project_context.ts";

export interface GoalPlannerOptions {
  onEvent?: (event: ActivityEventInput) => void;
  projectMemory?: string;
  createCodexClient?: (
    onEvent: (event: ActivityEventInput) => void,
  ) => CodexClient;
}

export interface GoalPlan {
  tasks: TaskDraft[];
  completionContract: string;
  probes: GoalProbeDraft[];
}

export class GoalPlanner {
  readonly root: string;
  readonly onEvent?: (event: ActivityEventInput) => void;
  readonly projectMemory?: string;
  readonly createCodexClient: (
    onEvent: (event: ActivityEventInput) => void,
  ) => CodexClient;

  constructor(root: string, options: GoalPlannerOptions = {}) {
    this.root = root;
    this.onEvent = options.onEvent;
    this.projectMemory = options.projectMemory;
    this.createCodexClient = options.createCodexClient ??
      ((onEvent) => createPlannerClient(this.root, onEvent));
  }

  async plan(goalText: string): Promise<TaskDraft[]> {
    return (await this.planGoal(goalText)).tasks;
  }

  async planGoal(goalText: string): Promise<GoalPlan> {
    let responseText = "";
    const codex = this.createCodexClient((event) => {
      if (event.role === "codex" && event.kind === "agent") {
        responseText += event.message;
      }
      const activity = {
        taskId: null,
        runId: null,
        role: "compiler",
        kind: event.kind,
        message: event.message,
        raw: event.raw,
      };
      if (shouldRecordActivity(activity)) {
        this.onEvent?.(activity);
      }
    });

    try {
      const session = await codex.startSession(this.root);
      const workflow = readWorkflow(this.root);
      const projectInstructions = await collectAgentsInstructions(this.root);
      await codex.runTurn(session, {
        title: "LoopForge goal compiler",
        prompt: buildPlannerPrompt(
          goalText,
          this.projectMemory,
          workflow.instructions,
          projectInstructions,
        ),
      });
      return parsePlannerPlanResponse(responseText);
    } finally {
      await codex.stop().catch(() => {});
    }
  }
}

export function parsePlannerResponse(responseText: string): TaskDraft[] {
  return parsePlannerPlanResponse(responseText).tasks;
}

export function parsePlannerPlanResponse(responseText: string): GoalPlan {
  const jsonText = extractJson(responseText);
  const parsed = JSON.parse(jsonText);
  const record = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
  const rawTasks = Array.isArray(parsed)
    ? parsed
    : Array.isArray(record?.tasks)
    ? record.tasks
    : [parsed];
  const completionContract = stringField(
    record?.completionContract,
    "- Complete every planned task.\n- Validate, review, commit, and record handoff evidence before closing the goal.",
  );
  const probes = parseProbeDrafts(record?.probes);

  const tasks = rawTasks.slice(0, 12).map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`Planner task ${index + 1} is not an object.`);
    }
    const record = item as Record<string, unknown>;
    const prompt = limitText(
      stringField(
        record.prompt,
        stringField(record.description, stringField(record.title, `Task ${index + 1}`)),
      ),
      4000,
    );
    const opsAction = record.kind === "ops" && record.opsAction === "publish"
      ? "publish" as const
      : undefined;
    return {
      title: stringField(record.title, `Task ${index + 1}`),
      description: prompt,
      acceptanceCriteria: stringField(
        record.acceptanceCriteria,
        "- Implement the task.\n- Run relevant validation.",
      ),
      priority: numberField(record.priority, 100 - index),
      workpad: stringField(record.workpad, "Created by LoopForge prompt compiler."),
      dependsOn: stringArrayField(record.dependsOn),
      riskLevel: riskField(record.riskLevel),
      verificationPlan: stringField(
        record.verificationPlan,
        "- Inspect the changed surface.\n- Run focused validation.\n- Record evidence.",
      ),
      kind: opsAction ? "ops" as const : "code" as const,
      opsAction,
    };
  });

  if (!tasks.length) {
    throw new Error("Planner returned no tasks.");
  }
  return { tasks, completionContract, probes };
}

function parseProbeDrafts(value: unknown): GoalProbeDraft[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, 8).flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as Record<string, unknown>;
    const label = stringField(record.label, "").slice(0, 120);
    const command = stringField(record.command, "");
    if (!label || !command) {
      return [];
    }
    return [{
      label,
      command,
      expectContains: typeof record.expectContains === "string" && record.expectContains.trim()
        ? record.expectContains.trim()
        : undefined,
      timeoutMs: typeof record.timeoutMs === "number" && record.timeoutMs > 0
        ? Math.min(Math.round(record.timeoutMs), 300000)
        : undefined,
    }];
  });
}

export function buildPlannerPrompt(
  goalText: string,
  projectMemory = "No project memory was supplied.",
  workflowInstructions = "No WORKFLOW.md instructions were supplied.",
  projectInstructions = "No project instructions were supplied.",
): string {
  return `You are the LoopForge prompt compiler for a local coding project.

	Turn the user's rough feature request into a compact LoopForge task graph.

Rules:
- Output only valid JSON. Do not wrap it in markdown.
- Return one JSON object with completionContract, probes, and tasks.
- probes is a JSON array of 1 to 6 executable win conditions: objects with label,
  command, and optional expectContains. The goal can only close when every probe passes.
- Each probe verifies the OUTCOME of the requested work in its real runtime form: curl the
  served or deployed page for the new behavior or content, run the produced program, or hit the
  API. A probe must observe what the user asked for, not the presence of related strings in
  source code.
- RED-FIRST: every probe must be a check that FAILS before the work is done and passes only once
  it is done. If a candidate probe would already pass on the repo as it stands, it is not a win
  condition - replace it with one that proves the NEW work. LoopForge runs a baseline at goal
  start; already-green probes are demoted to regression guards and cannot close the goal.
- Each command is a shell one-liner run from the repository root that exits 0 on success (it may
  start and stop a process it needs). Keep probes cheap and deterministic. Grep or file checks are
  acceptable only as secondary probes next to at least one outcome probe.
- completionContract is a compact markdown checklist that defines what must be true before the overall goal can be closed.
- tasks is a JSON array of 1 to 12 task objects.
- Each task object must include title, prompt, acceptanceCriteria, priority, workpad, dependsOn, riskLevel, and verificationPlan.
- prompt is the exact multiline prompt a Codex worker will follow for this goal.
- prompt must be under 4,000 characters.
- priority is an integer from 0 to 999. Higher priority runs first.
- dependsOn is an array of earlier task titles this task needs before it can run. Use [] when independent.
- PARALLELISM IS THE DEFAULT: dependsOn must be [] unless this task literally consumes
  another task's output (its files, its API, its schema). Touching the same project or the
  same theme is NOT a dependency. Separate bug fixes are independent even when they live in
  the same codebase; chains of dependsOn serialize the whole goal and one stuck task then
  freezes every task behind it.
- riskLevel is low, medium, or high.
- verificationPlan is a markdown string with the cheapest reliable proof for that task.
- acceptanceCriteria must be a single markdown string with concrete checkable bullets.
- Every acceptance criterion must be checkable INSIDE the repository: builds, tests, greps,
  file inspection. Never require running the game or app, manual QA, or in-game testing as
  a criterion; the verifier cannot do those and the task would fail verification forever.
  Put manual playtest suggestions in workpad instead.
- Keep each prompt scoped so one worker can complete it in an isolated git worktree.
- If the goal is a repository-level publish operation (for example committing and pushing the
  current working tree or existing local commits to the remote), return exactly one task with
  kind set to "ops" and opsAction set to "publish". LoopForge runs ops tasks itself at the
  repository root; no Codex worker or worktree is involved. Do not mark implementation work as ops.
- Split broad goals into coherent implementation tasks that can run safely in parallel when independent.
- Include relevant repo-inspection, implementation, and validation instructions in the prompt.
- Mention dependency, parallelization, or delegation notes in workpad.
- Do not ask the user follow-up questions. Make reasonable assumptions and encode them in the prompt.
- Do not include unrelated cleanup.

	Repo WORKFLOW.md instructions:
	${workflowInstructions}

	Project VISION.md, project-specsheet.md, and AGENTS.md context:
	${projectInstructions}

	Current LoopForge board memory:
${projectMemory}

User goal:
${goalText}
`;
}

function extractJson(responseText: string): string {
  const trimmed = responseText.trim();
  if (
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith("{") && trimmed.endsWith("}"))
  ) {
    return trimmed;
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return extractJson(fenced[1]);
  }
  const arrayStart = trimmed.indexOf("[");
  const arrayEnd = trimmed.lastIndexOf("]");
  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  const useObject = objectStart >= 0 && (arrayStart < 0 || objectStart < arrayStart);
  const start = useObject ? objectStart : arrayStart;
  const end = useObject ? objectEnd : arrayEnd;
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  throw new Error("Planner response did not contain JSON.");
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberField(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringArrayField(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function riskField(value: unknown): "low" | "medium" | "high" {
  return value === "low" || value === "high" ? value : "medium";
}

function limitText(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) {
    return value;
  }
  return value.slice(0, maxCharacters - 80).trimEnd() +
    "\n\n[LoopForge truncated this compiled prompt to keep it under 4,000 characters.]";
}
