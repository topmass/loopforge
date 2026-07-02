// A CodexClient that drives the native Claude Code CLI (`claude -p ...
// --output-format stream-json`), one child process per turn. This replaces the
// pi indirection for the claude backend: LoopForge now speaks the CLI's own
// stream-json wire format directly, the same NDJSON the Claude Agent SDK emits.
//
// Unlike the codex bridge (a long-lived process behind BridgeSpawn), each turn
// spawns a fresh `claude` and exits when the turn ends, so there is NO
// crash-loop supervision here - a failed turn is just a thrown Error, and the
// next turn starts a new process. The CLI assigns the durable session id on the
// first turn's init message; we capture it and pass it back with `--resume` on
// later turns so the conversation continues.

import { ActivityEventInput } from "../board/types.ts";
import {
  BridgeProcess,
  CodexClient,
  CodexSession,
  CodexTurnInput,
  CodexTurnResult,
} from "./codex_app_server.ts";

export interface CodexEventHandler {
  (event: ActivityEventInput): void;
}

export interface ClaudeCodeSettings {
  model: string;
  effort: string;
}

// One process per turn, so the injectable spawn takes the per-turn argv (the
// codex bridge's spawn only needs cwd because its args are fixed). Tests inject
// a fake that records argv and replays canned stream-json; the default spawns
// the real CLI.
export type ClaudeSpawn = (args: string[], cwd: string) => BridgeProcess;

// startSession has no process to ask for an id yet - Claude Code mints the
// session id on the first turn's init message. We hand back this placeholder and
// swap in the real id when it arrives; `--resume` is only added once we hold a
// real id (a persisted placeholder means "no session yet, start fresh").
const PENDING_SESSION = "claude-pending";

type JsonObject = Record<string, unknown>;

export class ClaudeCodeClient implements CodexClient {
  private child: BridgeProcess | null = null;
  private turnCounter = 0;

  constructor(
    private readonly onEvent: CodexEventHandler = () => {},
    private readonly settings: ClaudeCodeSettings = { model: "claude-sonnet-4-6", effort: "high" },
    private readonly spawn: ClaudeSpawn = defaultClaudeSpawn,
  ) {}

  startSession(cwd: string): Promise<CodexSession> {
    return Promise.resolve({ threadId: PENDING_SESSION, cwd });
  }

  // --resume does the actual work on the next turn; resuming is just carrying
  // the id forward on a fresh session object.
  resumeSession(cwd: string, threadId: string): Promise<CodexSession> {
    return Promise.resolve({ threadId, cwd });
  }

  async runTurn(session: CodexSession, input: CodexTurnInput): Promise<CodexTurnResult> {
    const args = [
      "-p",
      input.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      this.settings.model,
      "--effort",
      this.settings.effort,
      "--dangerously-skip-permissions",
    ];
    if (session.threadId && session.threadId !== PENDING_SESSION) {
      args.push("--resume", session.threadId);
    }

    const child = this.spawn(args, session.cwd);
    this.child = child;
    const turnId = `claude-turn-${++this.turnCounter}`;

    // Drain stderr in parallel so a chatty CLI cannot deadlock on a full pipe;
    // its tail is only surfaced when the process exits non-zero.
    const stderrChunks: string[] = [];
    const stderrDone = this.drain(child.stderr, stderrChunks);

    try {
      for await (const line of lines(child.stdout)) {
        const payload = safeJson(line);
        if (payload) {
          this.handleMessage(session, payload);
        }
      }
      await stderrDone;
      const status = await child.status;
      if (!status.success) {
        const tail = stderrChunks.join("").slice(-500);
        throw new Error(`claude CLI exited with code ${status.code}: ${tail}`);
      }
      return { threadId: session.threadId, turnId, status: "completed", completed: true };
    } finally {
      // Whether the turn completed or threw, this process is done; clear the
      // handle so a later stop() never kills an unrelated child.
      if (this.child === child) {
        this.child = null;
      }
    }
  }

  // Best-effort and idempotent: no long-lived process exists between turns, so
  // there is only ever at most one in-flight child to kill.
  stop(): Promise<void> {
    try {
      this.child?.kill("SIGTERM");
    } catch {
      // Already exited; nothing to kill.
    }
    this.child = null;
    return Promise.resolve();
  }

  private handleMessage(session: CodexSession, payload: JsonObject): void {
    const type = payload.type;
    // init/system message carries the durable session id; capture it so later
    // turns resume the same conversation, and surface it once.
    if (type === "system" && typeof payload.session_id === "string" && payload.session_id) {
      if (session.threadId !== payload.session_id) {
        session.threadId = payload.session_id;
        this.emit("codex", "session", `Claude session ${payload.session_id}`, payload);
      }
      return;
    }
    if (type === "assistant") {
      this.handleAssistant(payload);
      return;
    }
    // Final result message: usage totals, no new text (assistant blocks already
    // streamed it). extractTokenTotal in goal_loop searches for a total_tokens
    // key, which Claude's usage does not carry, so compute it from the parts.
    if (type === "result") {
      const total = usageTotalTokens(payload.usage);
      this.emit("codex", "tokens", `Turn complete (${total} tokens).`, {
        ...payload,
        total_tokens: total,
      });
    }
  }

  private handleAssistant(payload: JsonObject): void {
    const message = payload.message;
    const content = isRecord(message) ? message.content : undefined;
    if (!Array.isArray(content)) {
      return;
    }
    for (const block of content) {
      if (!isRecord(block)) {
        continue;
      }
      if (block.type === "text" && typeof block.text === "string") {
        // role "codex" is a legacy engine-wide constant meaning "the agent
        // backend" - goal_loop accumulates response text from codex/agent
        // events. Renaming it is a separate cross-cutting refactor.
        this.emit("codex", "agent", block.text, block);
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        this.emit("codex", "tool", summarizeTool(block.name, block.input), block);
      }
    }
  }

  private async drain(stream: ReadableStream<Uint8Array>, into: string[]): Promise<void> {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      into.push(decoder.decode(value, { stream: true }));
    }
  }

  private emit(role: string, kind: string, message: string, raw: unknown): void {
    if (!message.trim()) {
      return;
    }
    this.onEvent({ taskId: null, runId: null, role, kind, message, raw });
  }
}

// A one-line tool summary (name + brief input), capped so a huge input cannot
// flood the work log.
function summarizeTool(name: string, input: unknown): string {
  let detail = "";
  if (isRecord(input)) {
    const command = input.command ?? input.cmd ?? input.file_path ?? input.path ?? input.pattern;
    detail = typeof command === "string" ? command : JSON.stringify(input);
  }
  const summary = detail ? `${name}: ${detail}` : name;
  return summary.length > 160 ? `${summary.slice(0, 157)}...` : summary;
}

// Sum every token bucket Claude reports (prompt, output, and both cache tiers)
// into the single total goal_loop's budget tracker looks for.
function usageTotalTokens(usage: unknown): number {
  if (!isRecord(usage)) {
    return 0;
  }
  let total = 0;
  for (
    const key of [
      "input_tokens",
      "output_tokens",
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
    ]
  ) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      total += value;
    }
  }
  return total;
}

async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      if (part.trim()) {
        yield part;
      }
    }
  }
  if (buffer.trim()) {
    yield buffer;
  }
}

function safeJson(line: string): JsonObject | null {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultClaudeSpawn(args: string[], cwd: string): Deno.ChildProcess {
  const command = new Deno.Command("claude", {
    args,
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });
  return command.spawn();
}
