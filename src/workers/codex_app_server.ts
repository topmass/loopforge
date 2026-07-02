import { ActivityEventInput } from "../board/types.ts";
import { LoopForgeConfig, readConfig } from "../board/store.ts";

export interface CodexEventHandler {
  (event: ActivityEventInput): void;
}

export interface CodexSession {
  threadId: string;
  cwd: string;
}

export interface CodexSessionOptions {
  name?: string;
  baseInstructions?: string;
  developerInstructions?: string;
}

export interface CodexTurnInput {
  prompt: string;
  title: string;
}

export interface CodexTurnResult {
  threadId: string;
  turnId: string;
  status: string;
  completed: boolean;
}

export interface CodexThreadReadResult {
  threadId: string;
  name: string | null;
  status: string | null;
  turnCount: number;
  raw: unknown;
}

export interface CodexThreadListResult {
  threads: unknown[];
  cursor: string | null;
}

type JsonObject = Record<string, unknown>;

interface PendingRequest {
  resolve: (value: JsonObject) => void;
  reject: (reason: Error) => void;
}

export interface CodexClient {
  startSession(cwd: string, options?: CodexSessionOptions): Promise<CodexSession>;
  resumeSession(
    cwd: string,
    threadId: string,
    options?: CodexSessionOptions,
  ): Promise<CodexSession>;
  forkSession?(
    cwd: string,
    threadId: string,
    options?: CodexSessionOptions,
  ): Promise<CodexSession>;
  runTurn(session: CodexSession, input: CodexTurnInput): Promise<CodexTurnResult>;
  setThreadName?(session: CodexSession, name: string): Promise<void>;
  readThread?(session: CodexSession, includeTurns?: boolean): Promise<CodexThreadReadResult>;
  listThreads?(options?: { limit?: number; searchTerm?: string }): Promise<CodexThreadListResult>;
  compactThread?(session: CodexSession): Promise<void>;
  steerTurn?(session: CodexSession, message: string): Promise<void>;
  interruptTurn?(session: CodexSession): Promise<void>;
  stop(): Promise<void>;
}

// The subset of Deno.ChildProcess the client actually uses. A real child
// satisfies it structurally; tests inject a fake so bridge supervision can be
// exercised without spawning uv.
export interface BridgeProcess {
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly status: Promise<{ success: boolean; code: number }>;
  kill(signo?: Deno.Signal): void;
}

export type BridgeSpawn = (cwd: string) => BridgeProcess;

export class CodexAppServerClient implements CodexClient {
  private child: BridgeProcess | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readonly encoder = new TextEncoder();
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private exitTimes: number[] = [];
  private static readonly CRASH_WINDOW_MS = 10_000;
  private static readonly CRASH_THRESHOLD = 3;

  constructor(
    private readonly onEvent: CodexEventHandler = () => {},
    private readonly settings: Pick<LoopForgeConfig, "model" | "reasoningEffort" | "fastMode"> =
      readConfig(Deno.cwd()),
    private readonly spawnBridge: BridgeSpawn = defaultBridgeSpawn,
  ) {}

  async startSession(cwd: string, options: CodexSessionOptions = {}): Promise<CodexSession> {
    this.start(cwd);
    const result = await this.request("thread_start", {
      cwd,
      model: this.settings.model,
      sandbox: "full_access",
      name: options.name,
      baseInstructions: options.baseInstructions,
      developerInstructions: options.developerInstructions,
    });
    return {
      threadId: stringResult(result.threadId, "Codex SDK bridge did not return a thread id."),
      cwd,
    };
  }

  async resumeSession(
    cwd: string,
    threadId: string,
    options: CodexSessionOptions = {},
  ): Promise<CodexSession> {
    this.start(cwd);
    const result = await this.request("thread_resume", {
      cwd,
      threadId,
      name: options.name,
      baseInstructions: options.baseInstructions,
      developerInstructions: options.developerInstructions,
    });
    return {
      threadId: stringResult(
        result.threadId,
        "Codex SDK bridge did not return a resumed thread id.",
      ),
      cwd,
    };
  }

  async forkSession(
    cwd: string,
    threadId: string,
    options: CodexSessionOptions = {},
  ): Promise<CodexSession> {
    this.start(cwd);
    const result = await this.request("thread_fork", {
      cwd,
      threadId,
      model: this.settings.model,
      sandbox: "full_access",
      name: options.name,
      baseInstructions: options.baseInstructions,
      developerInstructions: options.developerInstructions,
    });
    return {
      threadId: stringResult(
        result.threadId,
        "Codex SDK bridge did not return a forked thread id.",
      ),
      cwd,
    };
  }

  async runTurn(session: CodexSession, input: CodexTurnInput): Promise<CodexTurnResult> {
    this.start(session.cwd);
    const result = await this.request("turn_run", {
      threadId: session.threadId,
      cwd: session.cwd,
      title: input.title,
      prompt: input.prompt,
      model: this.settings.model,
      effort: this.settings.reasoningEffort,
      fastMode: this.settings.fastMode,
      sandbox: "full_access",
    });
    return {
      threadId: stringResult(result.threadId, "Codex SDK bridge did not return a turn thread id."),
      turnId: typeof result.turnId === "string" ? result.turnId : "sdk-turn",
      status: typeof result.status === "string" ? result.status : "completed",
      completed: typeof result.completed === "boolean" ? result.completed : true,
    };
  }

  async setThreadName(session: CodexSession, name: string): Promise<void> {
    this.start(session.cwd);
    await this.request("thread_set_name", { threadId: session.threadId, name });
  }

  async readThread(
    session: CodexSession,
    includeTurns = false,
  ): Promise<CodexThreadReadResult> {
    this.start(session.cwd);
    const result = await this.request("thread_read", {
      threadId: session.threadId,
      includeTurns,
    });
    return {
      threadId: stringResult(result.threadId, "Codex SDK bridge did not return thread read id."),
      name: typeof result.name === "string" ? result.name : null,
      status: typeof result.status === "string" ? result.status : null,
      turnCount: typeof result.turnCount === "number" ? result.turnCount : 0,
      raw: result.raw,
    };
  }

  async compactThread(session: CodexSession): Promise<void> {
    this.start(session.cwd);
    await this.request("thread_compact", { threadId: session.threadId });
  }

  async listThreads(
    options: { limit?: number; searchTerm?: string } = {},
  ): Promise<CodexThreadListResult> {
    this.start(Deno.cwd());
    const result = await this.request("thread_list", {
      limit: options.limit,
      searchTerm: options.searchTerm,
    });
    return {
      threads: Array.isArray(result.threads) ? result.threads : [],
      cursor: typeof result.cursor === "string" ? result.cursor : null,
    };
  }

  async steerTurn(session: CodexSession, message: string): Promise<void> {
    this.start(session.cwd);
    await this.request("turn_steer", {
      threadId: session.threadId,
      cwd: session.cwd,
      message,
    });
  }

  async interruptTurn(session: CodexSession): Promise<void> {
    this.start(session.cwd);
    await this.request("turn_interrupt", {
      threadId: session.threadId,
      cwd: session.cwd,
    });
  }

  async stop(): Promise<void> {
    if (this.writer) {
      await this.request("stop", {}).catch(() => {});
    }
    for (const pending of this.pending.values()) {
      pending.reject(new Error("Codex SDK bridge stopped."));
    }
    this.pending.clear();
    await this.writer?.close().catch(() => {});
    this.child?.kill("SIGTERM");
    this.child = null;
    this.writer = null;
  }

  private start(cwd: string): void {
    if (this.child) {
      return;
    }
    if (
      isCrashLooping(
        this.exitTimes,
        Date.now(),
        CodexAppServerClient.CRASH_WINDOW_MS,
        CodexAppServerClient.CRASH_THRESHOLD,
      )
    ) {
      throw new Error(
        `Codex SDK bridge crash-looped ${CodexAppServerClient.CRASH_THRESHOLD} times in ` +
          `${CodexAppServerClient.CRASH_WINDOW_MS / 1000}s; not restarting. ` +
          `Check that 'uv run --with openai-codex' works.`,
      );
    }
    const child = this.spawnBridge(cwd);
    this.child = child;
    this.writer = child.stdin.getWriter();
    this.readStdout(child.stdout);
    this.readStderr(child.stderr);
    child.status
      .then((status) => this.handleExit(child, status.success, status.code))
      .catch(() => this.handleExit(child, false, -1));
  }

  // A crashed bridge used to leave its dead handle in place, wedging every
  // later request behind the `if (this.child) return` guard. Clear the handles
  // so the next request respawns, reject any in-flight requests as
  // unknown-outcome (never silently retried), and track rapid crashes so a
  // broken bridge cannot fork-bomb uv.
  private handleExit(child: BridgeProcess, success: boolean, code: number): void {
    if (this.child !== child) {
      return;
    }
    this.child = null;
    this.writer = null;
    if (!success) {
      const now = Date.now();
      this.exitTimes.push(now);
      this.exitTimes = this.exitTimes.filter(
        (time) => time >= now - CodexAppServerClient.CRASH_WINDOW_MS,
      );
    }
    if (this.pending.size > 0) {
      const reason = new Error(
        `Codex SDK bridge exited${
          success ? "" : ` with code ${code}`
        }; in-flight turn outcome is unknown and was not retried.`,
      );
      for (const pending of this.pending.values()) {
        pending.reject(reason);
      }
      this.pending.clear();
    }
  }

  private async request(op: string, params: unknown): Promise<JsonObject> {
    const id = this.nextId++;
    const response = new Promise<JsonObject>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    await this.send({ id, op, params });
    return await response;
  }

  private async send(payload: JsonObject): Promise<void> {
    if (!this.writer) {
      throw new Error("Codex SDK bridge is not running.");
    }
    await this.writer.write(this.encoder.encode(`${JSON.stringify(payload)}\n`));
  }

  private async readStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
    for await (const line of lines(stream)) {
      const payload = safeJson(line);
      if (!payload) {
        this.emit("codex", "stdout", line, line);
        continue;
      }
      if (payload.fatal) {
        for (const pending of this.pending.values()) {
          pending.reject(new Error(String(payload.fatal)));
        }
        this.pending.clear();
        this.emit("codex", "error", String(payload.fatal), payload);
        continue;
      }
      if (payload.event && typeof payload.event === "object") {
        const event = payload.event as JsonObject;
        this.emit(
          typeof event.role === "string" ? event.role : "codex",
          typeof event.kind === "string" ? event.kind : "event",
          typeof event.message === "string" ? event.message : "",
          event.raw ?? payload,
        );
        continue;
      }
      if (typeof payload.id === "number" && "result" in payload) {
        const pending = this.pending.get(payload.id);
        if (pending) {
          this.pending.delete(payload.id);
          pending.resolve(payload.result as JsonObject);
        }
        continue;
      }
      if (typeof payload.id === "number" && "error" in payload) {
        const pending = this.pending.get(payload.id);
        if (pending) {
          this.pending.delete(payload.id);
          pending.reject(new Error(JSON.stringify(payload.error)));
        }
      }
    }
  }

  private async readStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    for await (const line of lines(stream)) {
      this.emit("codex", "stderr", line, line);
    }
  }

  private emit(role: string, kind: string, message: string, raw: unknown): void {
    if (!message.length) {
      return;
    }
    this.onEvent({
      taskId: null,
      runId: null,
      role,
      kind,
      message,
      raw,
    });
  }
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
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function stringResult(value: unknown, message: string): string {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  throw new Error(message);
}

export function isCrashLooping(
  exitTimes: number[],
  now: number,
  windowMs: number,
  threshold: number,
): boolean {
  const recent = exitTimes.filter((time) => time >= now - windowMs);
  return recent.length >= threshold;
}

function defaultBridgeSpawn(cwd: string): Deno.ChildProcess {
  const command = new Deno.Command("uv", {
    args: [
      "run",
      "--prerelease=allow",
      "--with",
      "openai-codex",
      "python",
      new URL("../../scripts/loopforge_codex_bridge.py", import.meta.url).pathname,
    ],
    cwd,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  return command.spawn();
}
