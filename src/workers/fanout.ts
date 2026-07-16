// Fan-out: the goal-loop owner delegates N independent subtasks, each with an
// exclusive write scope, to parallel sub-agents in their own worktrees. This is
// LoopForge's own observable, worktree-isolated, board-tracked replacement for
// Codex's native spawn_agent (which forks an invisible workspace). The disjoint
// write-scope contract - lifted from Codex's spawn_agent guidance - is the core
// safety invariant: enforced here, not just requested.

import path from "node:path";
import { ActivityEvent, ActivityEventInput, ExternalAgentState } from "../board/types.ts";
import { BoardStore } from "../board/store.ts";
import { CodexClient } from "./codex_app_server.ts";
import {
  gitCommitAll,
  gitMergeBranch,
  gitPushBranch,
  prepareFanoutWorktree,
  removeTaskWorktree,
  runCommand,
} from "./git_utils.ts";
import { shouldRecordActivity } from "./activity_filter.ts";
import { withRepoLock } from "./repo_coordinator.ts";

export const LOOP_FANOUT_TOKEN = "LOOP_FANOUT";

export interface FanoutSubtask {
  title: string;
  instruction: string;
  writeScope: string[];
}

export interface FanoutResult {
  merged: Array<{ title: string; branch: string; summary: string }>;
  failed: Array<{ title: string; error: string }>;
}

// Parse a LOOP_FANOUT request: the marker line followed by a JSON object
// { "subtasks": [ { title, instruction, writeScope: [glob...] }, ... ] }.
// Fails closed (null) on anything malformed.
export function parseFanoutRequest(responseText: string): FanoutSubtask[] | null {
  const markerIndex = responseText.indexOf(LOOP_FANOUT_TOKEN);
  if (markerIndex < 0) {
    return null;
  }
  const after = responseText.slice(markerIndex + LOOP_FANOUT_TOKEN.length);
  const start = after.indexOf("{");
  const end = after.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(after.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const raw = (parsed as Record<string, unknown>).subtasks;
  if (!Array.isArray(raw)) {
    return null;
  }
  const subtasks: FanoutSubtask[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title.trim() : "";
    const instruction = typeof record.instruction === "string" ? record.instruction.trim() : "";
    const writeScope = Array.isArray(record.writeScope)
      ? record.writeScope.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        .map((s) => s.trim())
      : [];
    if (title && instruction && writeScope.length) {
      subtasks.push({ title, instruction, writeScope });
    }
  }
  return subtasks.length ? subtasks : null;
}

// Two subtasks conflict when their write scopes can touch the same file. Scopes
// are reduced to path prefixes (globs stripped); a conflict is any prefix that
// is equal to or a parent of another across different subtasks.
export function findScopeConflict(subtasks: FanoutSubtask[]): string | null {
  const owned: Array<{ prefix: string; title: string }> = [];
  for (const sub of subtasks) {
    for (const glob of sub.writeScope) {
      const prefix = scopePrefix(glob);
      for (const existing of owned) {
        if (prefixOverlaps(prefix, existing.prefix) && existing.title !== sub.title) {
          return `"${sub.title}" (${glob}) overlaps "${existing.title}" (${
            existing.prefix || "/"
          })`;
        }
      }
      owned.push({ prefix, title: sub.title });
    }
  }
  return null;
}

function scopePrefix(glob: string): string {
  // Strip everything from the first wildcard onward, then trailing slashes.
  const wildcard = glob.search(/[*?[]/);
  const base = wildcard >= 0 ? glob.slice(0, wildcard) : glob;
  return base.replace(/\/+$/, "");
}

// The files a sub-agent changed that no declared scope covers. A bare "**"
// scope reduces to an empty prefix that covers everything; otherwise a file is
// covered when it equals the prefix or sits under it.
export function scopeViolations(files: string[], writeScope: string[]): string[] {
  return files.filter((file) =>
    !writeScope.some((glob) => {
      const prefix = scopePrefix(glob);
      return prefix === "" || file === prefix || file.startsWith(`${prefix}/`);
    })
  );
}

function prefixOverlaps(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  // A parent dir contains a child path: "src/api" overlaps "src/api/x.ts".
  return longer === shorter || longer.startsWith(`${shorter}/`);
}

export interface FanoutRunnerOptions {
  createCodexClient: (onEvent: (event: ActivityEventInput) => void) => CodexClient;
  onEvent?: (event: ActivityEvent) => void;
  maxConcurrency: number;
  projectInstructions: string;
  pushBranches?: boolean;
}

export class FanoutRunner {
  constructor(
    private readonly root: string,
    private readonly store: BoardStore,
    private readonly options: FanoutRunnerOptions,
  ) {}

  // Mirror a fan-out sub-agent's lifecycle onto the board's external-agents
  // table, so the goal-loop path shows up on the Kanban / Active Workers strip
  // alongside dispatcher tasks. Best-effort: a report never fails a run.
  private reportAgent(
    subId: string,
    title: string,
    state: ExternalAgentState,
    headline: string,
    cwd?: string,
  ): void {
    try {
      this.store.reportExternalAgent({ id: subId, agent: title, state, headline, cwd });
    } catch {
      // Board observability only.
    }
  }

  // Run subtasks concurrently (bounded by maxConcurrency) in their own
  // worktrees off the loop branch, then merge each sub-branch back into the
  // loop worktree sequentially. Emits subagent.* lifecycle events throughout.
  async run(
    goalId: string,
    loopBranch: string,
    loopWorktree: string,
    subtasks: FanoutSubtask[],
  ): Promise<FanoutResult> {
    const result: FanoutResult = { merged: [], failed: [] };
    const completed: Array<
      { subId: string; sub: FanoutSubtask; branch: string; worktreePath: string; summary: string }
    > = [];
    let index = 0;
    let nextWorker = 0;
    // Fan-out worktrees outlive a round, and nextWorker resets each run, so a
    // per-run tag keeps subIds (and their branch/worktree names) unique across
    // rounds of the same goal instead of colliding on "goal-0".
    const runTag = crypto.randomUUID().slice(0, 4);

    const runOne = async (sub: FanoutSubtask, workerId: number): Promise<void> => {
      const subId = `${goalId}-${runTag}-${workerId}`;
      this.emit(this.store.appendLifecycleEvent({
        kind: "subagent.spawned",
        goalId,
        taskId: null,
        summary: sub.title,
        data: { title: sub.title, writeScope: sub.writeScope },
      }));
      this.reportAgent(subId, sub.title, "working", `Starting: ${sub.title}`);
      try {
        const assignment = await withRepoLock(
          this.store,
          this.root,
          "fanout-worktree",
          () => prepareFanoutWorktree(this.root, loopBranch, subId),
        );
        this.reportAgent(
          subId,
          sub.title,
          "working",
          `Working: ${sub.title}`,
          assignment.worktreePath,
        );
        let responseText = "";
        const codex = this.options.createCodexClient((event) => {
          if (event.role === "codex" && event.kind === "agent") {
            responseText += event.message;
          }
          const activity = { ...event, role: `fanout:${sub.title}` };
          if (shouldRecordActivity(activity)) {
            // Fires from the sub-agent's stream reader - a transient DB error
            // here must cost one activity line, not the process.
            try {
              this.emit(this.store.appendAgentEvent(activity, goalId));
            } catch (error) {
              console.error(`fanout activity append failed for ${goalId}:`, error);
            }
          }
        });
        try {
          const session = await codex.startSession(assignment.worktreePath, {
            name: `LoopForge - ${subId} - ${sub.title}`,
          });
          await codex.runTurn(session, {
            title: `${subId}: ${sub.title}`,
            prompt: this.buildSubtaskPrompt(sub),
          });
        } finally {
          await codex.stop().catch(() => {});
        }
        // Enforce the declared write scope before committing: gitCommitAll would
        // otherwise commit everything in the worktree, so revert anything the
        // sub-agent touched outside its scope and keep only in-scope work.
        // -uall lists every untracked FILE individually; without it porcelain
        // collapses a new nested path to its top-most untracked dir ("sites/"),
        // which fails to match a deeper scope like sites/welcome/** and gets
        // in-scope work reverted as a false positive.
        const statusOut = await runCommand(assignment.worktreePath, [
          "git",
          "status",
          "--porcelain",
          "--untracked-files=all",
        ]);
        const changedFiles = statusOut.split(/\r?\n/)
          .filter((line) => line.trim().length > 0)
          .map((line) => {
            let file = line.slice(3);
            if (file.includes(" -> ")) {
              file = file.split(" -> ").at(-1) ?? file;
            }
            if (file.startsWith('"') && file.endsWith('"')) {
              file = file.slice(1, -1);
            }
            return file;
          });
        const violations = scopeViolations(changedFiles, sub.writeScope);
        for (const file of violations) {
          try {
            await runCommand(assignment.worktreePath, ["git", "checkout", "HEAD", "--", file]);
          } catch {
            // Untracked file - checkout cannot restore it, so remove it outright.
            // Recursive because porcelain reports a fully-untracked directory as
            // one "dir/" entry, not per-file.
            try {
              await Deno.remove(path.join(assignment.worktreePath, file), { recursive: true });
            } catch {
              // Already gone.
            }
          }
        }
        const allOutOfScope = changedFiles.length > 0 &&
          violations.length === changedFiles.length;

        const commit = await gitCommitAll(assignment.worktreePath, `${subId} ${sub.title}`);
        if (commit === null) {
          // A no-op (or wholly out-of-scope) branch must never be reported
          // upward as merged work.
          const error = allOutOfScope
            ? "all changes were outside the declared write scope"
            : "produced no file changes";
          this.reportAgent(subId, sub.title, "blocked", `${sub.title} - ${error}`.slice(0, 200));
          result.failed.push({ title: sub.title, error });
          return;
        }
        let summary = responseText.trim().slice(0, 600) || "(no summary)";
        if (violations.length) {
          summary += `\nNOTE: reverted out-of-scope changes: ${violations.join(", ")}`;
        }
        // Optionally push the sub-agent's branch to origin on completion, so
        // its work is shareable before the final merge.
        let pushed = false;
        if (this.options.pushBranches) {
          pushed = await gitPushBranch(assignment.worktreePath, assignment.branchName);
        }
        completed.push({
          subId,
          sub,
          branch: assignment.branchName,
          worktreePath: assignment.worktreePath,
          summary,
        });
        this.reportAgent(
          subId,
          sub.title,
          "working",
          `${sub.title} - ready to merge`,
          assignment.worktreePath,
        );
        this.emit(this.store.appendLifecycleEvent({
          kind: "subagent.progress",
          goalId,
          taskId: null,
          summary: pushed
            ? `${sub.title}: complete and pushed to ${assignment.branchName}.`
            : `${sub.title}: worktree complete, ready to merge.`,
          data: { title: sub.title, branch: assignment.branchName, pushed },
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.reportAgent(subId, sub.title, "blocked", `${sub.title} - ${message}`.slice(0, 200));
        result.failed.push({ title: sub.title, error: message });
      }
    };

    // Slot-bounded concurrency: keep maxConcurrency workers busy.
    const workers: Promise<void>[] = [];
    const launch = (): boolean => {
      if (index >= subtasks.length) {
        return false;
      }
      const sub = subtasks[index++];
      const workerId = nextWorker++;
      const p = runOne(sub, workerId).finally(() => {
        const slot = workers.indexOf(p);
        if (slot >= 0) {
          workers.splice(slot, 1);
        }
      });
      workers.push(p);
      return true;
    };
    while (workers.length < this.options.maxConcurrency && launch()) {
      // fill initial slots
    }
    while (workers.length) {
      await Promise.race(workers);
      while (workers.length < this.options.maxConcurrency && launch()) {
        // refill freed slots
      }
    }

    // Merge completed sub-branches into the loop worktree one at a time so two
    // merges never race the same index.
    for (const done of completed) {
      try {
        await gitMergeBranch(loopWorktree, done.branch);
        result.merged.push({ title: done.sub.title, branch: done.branch, summary: done.summary });
        this.reportAgent(done.subId, done.sub.title, "done", `${done.sub.title} - merged`);
        this.emit(this.store.appendLifecycleEvent({
          kind: "subagent.merged",
          goalId,
          taskId: null,
          summary: `${done.sub.title} merged into the loop branch.`,
          data: { title: done.sub.title, branch: done.branch },
        }));
        // Reclaim the merged sub-worktree so rounds do not accumulate them.
        await withRepoLock(
          this.store,
          this.root,
          "fanout-reclaim",
          () => removeTaskWorktree(this.root, done.worktreePath, done.branch),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.reportAgent(done.subId, done.sub.title, "blocked", `${done.sub.title} - merge failed`);
        result.failed.push({ title: done.sub.title, error: `merge failed: ${message}` });
        // On merge failure, deliberately leave the branch and worktree in place
        // for inspection - unique names keep the next round from colliding.
      }
    }
    return result;
  }

  private buildSubtaskPrompt(sub: FanoutSubtask): string {
    return `You are a LoopForge fan-out sub-agent working one bounded subtask in your own isolated worktree.

Subtask: ${sub.title}
${sub.instruction}

EXCLUSIVE WRITE SCOPE - you may ONLY create or edit files matching:
${sub.writeScope.map((s) => `- ${s}`).join("\n")}
Do not touch any file outside this scope; another agent owns the rest. Verify your change with real commands. Do not create commits; LoopForge commits and merges your worktree.

Project context:
${this.options.projectInstructions}

End with a compact summary: files changed, how you verified, and anything the integrator must know.`;
  }

  private emit(event: ActivityEvent): void {
    this.options.onEvent?.(event);
  }
}

export function summarizeFanout(result: FanoutResult): string {
  const lines: string[] = [];
  if (result.merged.length) {
    lines.push(`Fan-out merged ${result.merged.length} subtask(s) into the loop branch:`);
    for (const m of result.merged) {
      lines.push(`- ${m.title}: ${m.summary.replace(/\s+/g, " ").slice(0, 200)}`);
    }
  }
  if (result.failed.length) {
    lines.push(`Fan-out had ${result.failed.length} failure(s) - handle inline:`);
    for (const f of result.failed) {
      lines.push(`- ${f.title}: ${f.error.slice(0, 200)}`);
    }
  }
  lines.push(
    "Integrate these results, update ./lf-task, and continue. Do not re-do merged work.",
  );
  return lines.join("\n");
}
