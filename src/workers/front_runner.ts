// The front agent (thread-first step 7): the user-facing chief of staff.
// Deliberately constrained - short control-plane turns only, one at a time,
// every turn grounded in a freshly generated ledger digest (never model
// recollection), and a CLOSED action grammar: answer, DELEGATE_GOAL, or
// STEER_GOAL. Implementation work always happens in background goal loops.
//
// Its thread identity (front_thread_id) is separate from main_thread_id:
// task workers fork from the main thread, so user conversation must never
// contaminate that lineage.

import { BoardStore } from "../board/store.ts";
import { ActivityEventInput, FrontMessage } from "../board/types.ts";
import { createAgentClient } from "./agent_backend.ts";
import { CodexClient, CodexSession } from "./codex_app_server.ts";
import { isMissingCodexThreadText } from "./codex_event_normalizer.ts";
import { probeLights } from "./goal_probes.ts";
import { contextPath } from "../paths.ts";

export interface FrontRunnerOptions {
  onEvent?: (event: ActivityEventInput & { taskId: string | null; runId: string | null }) => void;
  createCodexClient?: (
    onEvent: (event: ActivityEventInput) => void,
  ) => CodexClient;
  // Which goals currently have running loops (the server's admission registry).
  listActiveLoops?: () => string[];
  // Start a background goal loop from delegated text. Returns the new goal id,
  // or null when admission was denied (capacity).
  delegateGoal?: (text: string) => string | null;
  // Queue a steer for a goal's loop (resuming it if dormant). Returns whether
  // the goal exists.
  steerGoal?: (goalId: string, text: string) => boolean;
}

const DELEGATE_TOKEN = "DELEGATE_GOAL:";
const STEER_TOKEN = "STEER_GOAL:";

export class FrontRunner {
  // Turns serialize on this chain: one front turn at a time, ever.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly root: string,
    private readonly store: BoardStore,
    private readonly options: FrontRunnerOptions = {},
  ) {}

  // Enqueue a user message for a front turn. Resolves with the persisted
  // front reply once the turn (and any delegated action) has been recorded.
  handle(text: string): Promise<FrontMessage> {
    const turn = this.queue.then(() => this.runTurn(text));
    // Keep the chain alive through failures; the caller sees the rejection.
    this.queue = turn.catch(() => {});
    return turn;
  }

  private async runTurn(text: string): Promise<FrontMessage> {
    const client = (this.options.createCodexClient ??
      ((onEvent: (event: ActivityEventInput) => void) => createAgentClient(this.root, onEvent)))(
        (event) => {
          if (event.role === "codex" && event.kind === "agent") {
            responseText += event.message;
          }
          this.options.onEvent?.({
            ...event,
            taskId: event.taskId ?? null,
            runId: event.runId ?? null,
            role: "front",
          });
        },
      );
    let responseText = "";
    try {
      const session = await this.openFrontSession(client);
      const prompt = this.buildPrompt(text);
      try {
        await client.runTurn(session, { title: "LoopForge front turn", prompt });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!isMissingCodexThreadText(message)) {
          throw error;
        }
        // A lost backend thread is a speed bump: the transcript and ledger are
        // durable, so start fresh and retry once.
        this.store.setFrontThreadId(null);
        responseText = "";
        const fresh = await this.openFrontSession(client);
        await client.runTurn(fresh, { title: "LoopForge front turn", prompt });
      }
      const { reply, action } = this.applyActions(responseText.trim());
      const finalText = action ? `${reply}\n\n${action}`.trim() : reply;
      const message = this.store.appendFrontMessage(
        "front",
        finalText || "(no reply)",
        this.store.getFrontThreadId() ?? undefined,
      );
      // Idle compaction (thread-first step 9): turns serialize, so right after
      // a turn IS idle. Summaries are rebuildable caches, never truth - the
      // raw transcript and the ledger stay authoritative in SQLite.
      await this.maybeCompact(client).catch(() => {});
      return message;
    } finally {
      await client.stop().catch(() => {});
    }
  }

  // Compact when the uncompacted tail passes 12 messages or ~24k characters:
  // regenerate the deterministic resume capsule, advance the cursor, then let
  // the backend fold its own context (optional; not every backend supports it).
  private async maybeCompact(client: CodexClient): Promise<void> {
    const cursor = this.store.getFrontCompactCursor();
    const tail = this.store.listFrontMessages({ afterId: cursor, limit: 1000 });
    const chars = tail.reduce((total, message) => total + message.message.length, 0);
    if (tail.length < 12 && chars < 24_000) {
      return;
    }
    this.writeResumeCapsule();
    this.store.setFrontCompactCursor(tail[tail.length - 1].id);
    const threadId = this.store.getFrontThreadId();
    if (threadId && client.compactThread) {
      await client.compactThread({ threadId, cwd: this.root }).catch(() => {});
    }
  }

  // The resume capsule is generated purely from the ledger + transcript tail:
  // no model turn, always rebuildable, safe to lose. Authoritative human
  // instructions (AGENTS.md, WORKFLOW.md, project-specsheet.md) are never
  // touched by compaction.
  private writeResumeCapsule(): void {
    const capsule = [
      "# LoopForge resume capsule",
      "",
      "Generated automatically after front-thread compaction. A rebuildable",
      "cache of ledger state - do not edit by hand; authoritative instructions",
      "live in AGENTS.md / WORKFLOW.md / project-specsheet.md.",
      "",
      `Updated: ${new Date().toISOString()}`,
      "",
      "## Project ledger",
      this.buildLedgerDigest(),
      "",
      "## Recent conversation tail",
      ...this.store.listFrontMessages({ limit: 8 }).map((message) =>
        `- ${message.role}: ${message.message.split("\n")[0].slice(0, 160)}`
      ),
      "",
    ].join("\n");
    const target = contextPath(this.root, "current-state.md");
    Deno.mkdirSync(contextPath(this.root), { recursive: true });
    Deno.writeTextFileSync(target, capsule);
  }

  private async openFrontSession(client: CodexClient): Promise<CodexSession> {
    const existing = this.store.getFrontThreadId();
    if (existing) {
      try {
        return await client.resumeSession(this.root, existing);
      } catch {
        this.store.setFrontThreadId(null);
      }
    }
    const session = await client.startSession(this.root);
    this.store.setFrontThreadId(session.threadId);
    return session;
  }

  // Execute at most one action token from the reply and describe the result
  // in plain text appended to the transcript - receipts, not silent effects.
  private applyActions(reply: string): { reply: string; action: string | null } {
    const delegateAt = reply.indexOf(DELEGATE_TOKEN);
    if (delegateAt >= 0) {
      const stripped = reply.slice(0, delegateAt).trim();
      const payload = reply.slice(delegateAt + DELEGATE_TOKEN.length).trim();
      try {
        const parsed = JSON.parse(payload.split("\n")[0]) as { text?: string };
        const goalText = parsed.text?.trim() ?? "";
        if (!goalText) {
          return { reply: stripped, action: "[delegation skipped: empty goal text]" };
        }
        const goalId = this.options.delegateGoal?.(goalText) ?? null;
        return {
          reply: stripped,
          action: goalId
            ? `[delegated to ${goalId}: ${goalText.slice(0, 120)}]`
            : "[delegation refused: loop capacity reached - try again when a loop finishes]",
        };
      } catch {
        return { reply: stripped, action: "[delegation skipped: malformed DELEGATE_GOAL payload]" };
      }
    }
    const steerAt = reply.indexOf(STEER_TOKEN);
    if (steerAt >= 0) {
      const stripped = reply.slice(0, steerAt).trim();
      const rest = reply.slice(steerAt + STEER_TOKEN.length).trim();
      const match = rest.match(/^(GOAL-\d+)\s+(.+)/s);
      if (!match) {
        return { reply: stripped, action: "[steer skipped: expected STEER_GOAL: GOAL-N <text>]" };
      }
      const [, goalId, steerText] = match;
      if (!this.store.goalExists(goalId)) {
        return { reply: stripped, action: `[steer refused: ${goalId} is not in the ledger]` };
      }
      const ok = this.options.steerGoal?.(goalId, steerText.split("\n")[0].trim()) ?? false;
      return {
        reply: stripped,
        action: ok ? `[steer queued for ${goalId}]` : `[steer failed for ${goalId}]`,
      };
    }
    return { reply, action: null };
  }

  // The freshly generated project ledger: the front agent narrates this, it
  // does not remember it. Stamped with the event revision for "as of when".
  private buildLedgerDigest(): string {
    const board = this.store.getBoard();
    const active = new Set(this.options.listActiveLoops?.() ?? []);
    const lines: string[] = [];
    lines.push(`revision: ${this.store.eventRevision()}`);
    for (const goal of board.goals) {
      const probes = board.probes.filter((probe) => probe.goalId === goal.id);
      const passed = probes.filter((probe) => probe.lastStatus === "passed").length;
      const state = goal.status === "closed"
        ? "closed"
        : active.has(goal.id)
        ? "loop running"
        : "open, idle";
      lines.push(
        `- ${goal.id} [${state}] ${goal.text.slice(0, 140)}` +
          (probes.length
            ? ` | win conditions ${passed}/${probes.length} ${probeLights(probes)}`
            : "") +
          (goal.status === "closed" && goal.closureSummary
            ? ` | closed: ${goal.closureSummary.slice(0, 140)}`
            : ""),
      );
    }
    const holds = board.tasks.filter((task) =>
      task.status === "review" && task.currentGate === "manual-verification" && task.branchName
    );
    for (const hold of holds) {
      lines.push(
        `- HELD MERGE ${hold.goalId}: awaiting the user's explicit approval (${hold.id}). Do not approve it yourself.`,
      );
    }
    const blocked = board.tasks.filter((task) => task.status === "blocked");
    for (const task of blocked) {
      lines.push(
        `- BLOCKED ${task.goalId ?? "?"}/${task.id}: ${
          (task.needsInputPrompt ?? "").slice(0, 160)
        }`,
      );
    }
    return lines.join("\n");
  }

  private buildPrompt(text: string): string {
    const recent = this.store.listFrontMessages({ limit: 12 })
      .map((message) => `${message.role === "user" ? "USER" : "FRONT"}: ${message.message}`)
      .join("\n");
    return `You are the LoopForge front agent for this project: a chief of staff, not an implementer.
Keep this turn SHORT and control-plane only: answer, recommend, delegate, or steer. You must NOT
edit files, run builds, or do implementation work yourself - background goal loops do that, with
executable win conditions proving completion.

PROJECT LEDGER (freshly generated from the database - this is the current truth; never answer from
memory when the ledger disagrees):
${this.buildLedgerDigest()}

RECENT CONVERSATION:
${recent}

THE USER JUST SAID:
${text}

Reply concisely. Then, if and only if an action is needed, end with EXACTLY ONE of:
- ${DELEGATE_TOKEN} {"text":"<self-contained goal text for a background loop>"} on its own line, to start new implementation work.
- ${STEER_TOKEN} GOAL-N <one line of guidance> to steer that goal's loop.
Rules: never fabricate goal ids - only steer goals present in the ledger. Decisions that belong to
the user (held merges, blocked asks) are surfaced in plain words, never acted on. A question that
the ledger answers needs no action token at all.`;
  }
}
