// AgentClient backed by the pi coding agent's RPC mode (`pi --mode rpc`,
// JSONL over stdio). One pi subprocess per client; pi's session files act as
// thread ids. Pi events are translated into the Codex event vocabulary so the
// normalizer, live supervisor, and activity feed work unchanged.

import {
  CodexClient,
  CodexEventHandler,
  CodexSession,
  CodexSessionOptions,
  CodexThreadReadResult,
  CodexTurnInput,
  CodexTurnResult,
} from "./codex_app_server.ts";

export interface PiRpcClientOptions {
  command?: string[];
  provider?: string;
  model?: string;
  thinking?: string;
}

type JsonObject = Record<string, unknown>;

interface PendingRequest {
  resolve: (value: JsonObject) => void;
  reject: (reason: Error) => void;
}

interface TurnWaiter {
  resolve: () => void;
  reject: (reason: Error) => void;
}

export function piBinaryCommand(): string[] {
  const override = Deno.env.get("LOOPFORGE_PI_BIN");
  return override?.trim() ? [override.trim()] : ["pi"];
}

// Build the argument list (everything after the binary) pi is spawned with, so
// arg construction is a pure function the tests can assert without spawning.
export function piRpcArgs(options: PiRpcClientOptions): string[] {
  const base = options.command ?? [...piBinaryCommand(), "--mode", "rpc"];
  const args = [...base.slice(1)];
  if (options.provider) {
    args.push("--provider", options.provider);
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.thinking) {
    args.push("--thinking", options.thinking);
  }
  return args;
}

export class PiRpcClient implements CodexClient {
  private child: Deno.ChildProcess | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readonly encoder = new TextEncoder();
  private nextId = 1;
  private pending = new Map<string, PendingRequest>();
  private activeThreadId: string | null = null;
  private turnCounter = 0;
  private currentTurnId: string | null = null;
  private turnWaiter: TurnWaiter | null = null;
  private turnFailure: string | null = null;
  private agentEnded = false;
  private retryPending = false;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly onEvent: CodexEventHandler = () => {},
    private readonly options: PiRpcClientOptions = {},
  ) {}

  async startSession(cwd: string, options: CodexSessionOptions = {}): Promise<CodexSession> {
    this.start(cwd);
    const state = await this.request("get_state", {});
    const threadId = sessionFileFrom(state);
    this.activeThreadId = threadId;
    if (options.name) {
      await this.request("set_session_name", { name: options.name }).catch(() => {});
    }
    this.emit("codex", "thread", `Started pi session ${threadId}.`, state);
    return { threadId, cwd };
  }

  async resumeSession(
    cwd: string,
    threadId: string,
    options: CodexSessionOptions = {},
  ): Promise<CodexSession> {
    this.start(cwd);
    await this.switchTo(threadId);
    if (options.name) {
      await this.request("set_session_name", { name: options.name }).catch(() => {});
    }
    return { threadId, cwd };
  }

  async forkSession(
    cwd: string,
    threadId: string,
    options: CodexSessionOptions = {},
  ): Promise<CodexSession> {
    this.start(cwd);
    await this.switchTo(threadId);
    try {
      const cloned = await this.request("clone", {});
      if (record(cloned).cancelled) {
        throw new Error("pi cancelled the session clone.");
      }
    } catch {
      // Cloning an empty session fails; fall back to a fresh session that
      // records the parent lineage instead.
      await this.request("new_session", { parentSession: threadId });
    }
    const state = await this.request("get_state", {});
    const childThreadId = sessionFileFrom(state);
    this.activeThreadId = childThreadId;
    if (options.name) {
      await this.request("set_session_name", { name: options.name }).catch(() => {});
    }
    this.emit("codex", "thread", `Forked pi session ${childThreadId} from ${threadId}.`, state);
    return { threadId: childThreadId, cwd };
  }

  async runTurn(session: CodexSession, input: CodexTurnInput): Promise<CodexTurnResult> {
    this.start(session.cwd);
    await this.switchTo(session.threadId);
    const turnId = `pi-turn-${++this.turnCounter}`;
    this.currentTurnId = turnId;
    this.turnFailure = null;
    this.agentEnded = false;
    this.retryPending = false;
    this.cancelEndTimer();
    const done = new Promise<void>((resolve, reject) => {
      this.turnWaiter = { resolve, reject };
    });
    await this.request("prompt", { message: input.prompt });
    await done;
    this.currentTurnId = null;
    const failure = this.turnFailure;
    this.turnFailure = null;
    return {
      threadId: session.threadId,
      turnId,
      status: failure ? "failed" : "completed",
      completed: !failure,
    };
  }

  async steerTurn(session: CodexSession, message: string): Promise<void> {
    this.start(session.cwd);
    await this.request("steer", { message });
  }

  async interruptTurn(session: CodexSession): Promise<void> {
    this.start(session.cwd);
    await this.request("abort", {});
  }

  async setThreadName(session: CodexSession, name: string): Promise<void> {
    this.start(session.cwd);
    await this.switchTo(session.threadId);
    await this.request("set_session_name", { name });
  }

  async readThread(
    session: CodexSession,
    _includeTurns = false,
  ): Promise<CodexThreadReadResult> {
    this.start(session.cwd);
    await this.switchTo(session.threadId);
    const data = await this.request("get_messages", {});
    const messages = Array.isArray(record(data).messages) ? record(data).messages as unknown[] : [];
    const turnCount = messages.filter((message) => record(message).role === "assistant").length;
    const state = await this.request("get_state", {});
    return {
      threadId: session.threadId,
      name: typeof record(state).sessionName === "string"
        ? record(state).sessionName as string
        : null,
      status: null,
      turnCount,
      raw: data,
    };
  }

  async compactThread(session: CodexSession): Promise<void> {
    this.start(session.cwd);
    await this.switchTo(session.threadId);
    await this.request("compact", {});
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelEndTimer();
    for (const pending of this.pending.values()) {
      pending.reject(new Error("Pi RPC client stopped."));
    }
    this.pending.clear();
    this.turnWaiter?.reject(new Error("Pi RPC client stopped."));
    this.turnWaiter = null;
    await this.writer?.close().catch(() => {});
    this.child?.kill("SIGTERM");
    this.child = null;
    this.writer = null;
  }

  private start(cwd: string): void {
    if (this.child) {
      return;
    }
    const base = this.options.command ?? [...piBinaryCommand(), "--mode", "rpc"];
    const command = new Deno.Command(base[0], {
      args: piRpcArgs(this.options),
      cwd,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });
    this.child = command.spawn();
    this.writer = this.child.stdin.getWriter();
    this.readStdout(this.child.stdout);
    this.readStderr(this.child.stderr);
    this.child.status.then((status) => {
      if (this.stopped) {
        return;
      }
      const error = new Error(`pi exited with code ${status.code}.`);
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
      this.turnWaiter?.reject(error);
      this.turnWaiter = null;
    });
  }

  private async switchTo(threadId: string): Promise<void> {
    if (this.activeThreadId === threadId) {
      return;
    }
    const result = await this.request("switch_session", { sessionPath: threadId });
    if (record(result).cancelled) {
      throw new Error(`pi cancelled switching to session ${threadId}.`);
    }
    this.activeThreadId = threadId;
  }

  private async request(type: string, params: JsonObject): Promise<JsonObject> {
    const id = `gf-${this.nextId++}`;
    const response = new Promise<JsonObject>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    await this.send({ id, type, ...params });
    return await response;
  }

  private async send(payload: JsonObject): Promise<void> {
    if (!this.writer) {
      throw new Error("Pi RPC client is not running.");
    }
    await this.writer.write(this.encoder.encode(`${JSON.stringify(payload)}\n`));
  }

  private async readStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.trim()) {
          this.handleLine(line);
        }
        newline = buffer.indexOf("\n");
      }
    }
  }

  private async readStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      const text = decoder.decode(value).trim();
      if (text) {
        this.emit("codex", "stderr", text, text);
      }
    }
  }

  private handleLine(line: string): void {
    let payload: JsonObject;
    try {
      payload = JSON.parse(line) as JsonObject;
    } catch {
      this.emit("codex", "stdout", line, line);
      return;
    }
    if (payload.type === "response") {
      const id = typeof payload.id === "string" ? payload.id : null;
      const pending = id ? this.pending.get(id) : undefined;
      if (!pending || !id) {
        return;
      }
      this.pending.delete(id);
      if (payload.success === false) {
        pending.reject(
          new Error(
            `pi ${String(payload.command ?? "command")} failed: ${
              String(payload.error ?? payload.errorMessage ?? "unknown error")
            }`,
          ),
        );
        return;
      }
      pending.resolve(record(payload.data));
      return;
    }
    this.handleEvent(payload);
  }

  private handleEvent(event: JsonObject): void {
    const raw = { ...event, turnId: this.currentTurnId };
    const type = String(event.type ?? "");
    if (type === "agent_start") {
      const isRetryContinuation = this.endTimer !== null || this.retryPending;
      this.agentEnded = false;
      this.cancelEndTimer();
      if (isRetryContinuation) {
        this.retryPending = false;
        this.turnFailure = null;
        this.emit("codex", "event", "Pi resumed the turn after compaction.", raw);
        return;
      }
      this.emit("codex", "turn/started", "Started pi turn.", raw);
      return;
    }
    if (type === "agent_end") {
      // Pi may compact an overflowed context right after the agent run ends
      // and automatically retry the prompt. Hold the turn open briefly so a
      // compaction retry continues the same LoopForge turn.
      this.agentEnded = true;
      this.scheduleTurnResolve(raw);
      return;
    }
    if (type === "compaction_start") {
      this.cancelEndTimer();
      this.emit("codex", "event", "Pi is compacting the session context.", raw);
      return;
    }
    if (type === "compaction_end") {
      if (event.willRetry === true) {
        this.retryPending = true;
      } else if (this.agentEnded) {
        this.scheduleTurnResolve(raw);
      }
      return;
    }
    if (type === "message_update") {
      const delta = record(event.assistantMessageEvent);
      if (delta.type === "text_delta" && typeof delta.delta === "string") {
        this.emit("codex", "agent", delta.delta, raw);
      } else if (delta.type === "error") {
        this.turnFailure = String(delta.reason ?? "error");
        this.emit("codex", "error", `Pi turn error: ${this.turnFailure}`, raw);
      }
      return;
    }
    if (type === "tool_execution_start") {
      const toolName = String(event.toolName ?? "tool");
      const args = record(event.args);
      if (toolName === "edit" || toolName === "write") {
        this.emit(
          "codex",
          "item/fileChange/patchUpdated",
          `Editing ${String(args.path ?? args.file_path ?? "file")}`,
          raw,
        );
      } else if (toolName === "bash") {
        this.emit(
          "codex",
          "item/started",
          `Started commandExecution: ${String(args.command ?? "")}`,
          raw,
        );
      } else {
        this.emit(
          "codex",
          "item/started",
          `Started reading: ${toolName} ${String(args.path ?? args.pattern ?? "")}`,
          raw,
        );
      }
      return;
    }
    if (type === "tool_execution_end") {
      const toolName = String(event.toolName ?? "tool");
      if (toolName === "bash") {
        const text = toolResultText(event.result);
        if (text) {
          this.emit(
            "codex",
            "item/commandExecution/outputDelta",
            text.slice(-600),
            raw,
          );
        }
        this.emit("codex", "item/completed", "Completed commandExecution.", raw);
      } else {
        this.emit("codex", "item/completed", `Completed ${toolName}.`, raw);
      }
      if (event.isError) {
        this.emit("codex", "error", `Pi tool ${toolName} failed.`, raw);
      }
      return;
    }
    if (type === "auto_retry_start") {
      this.emit(
        "codex",
        "event",
        `Pi is retrying after a transient provider error (attempt ${
          String(event.attempt ?? "?")
        }).`,
        raw,
      );
      return;
    }
    if (type === "auto_retry_end" && event.success === false) {
      this.turnFailure = String(event.finalError ?? "provider error");
      this.emit("codex", "error", `Pi provider error: ${this.turnFailure}`, raw);
      return;
    }
    if (type === "extension_error") {
      this.emit("codex", "error", `Pi extension error: ${String(event.error ?? "")}`, raw);
      return;
    }
    // turn_start/turn_end/message_start/message_end/compaction/queue updates are
    // intentionally quiet; the turn and tool events above carry the signal.
  }

  private scheduleTurnResolve(raw: unknown): void {
    this.cancelEndTimer();
    this.endTimer = setTimeout(() => {
      this.endTimer = null;
      if (this.retryPending) {
        return;
      }
      this.emit("codex", "turn/completed", "Pi turn completed.", raw);
      this.turnWaiter?.resolve();
      this.turnWaiter = null;
    }, 600);
  }

  private cancelEndTimer(): void {
    if (this.endTimer !== null) {
      clearTimeout(this.endTimer);
      this.endTimer = null;
    }
  }

  private emit(role: string, kind: string, message: string, raw: unknown): void {
    if (!message.trim()) {
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

function sessionFileFrom(state: JsonObject): string {
  const sessionFile = state.sessionFile;
  if (typeof sessionFile === "string" && sessionFile.trim()) {
    return sessionFile;
  }
  throw new Error(
    "pi did not report a session file. Session persistence must stay enabled for LoopForge.",
  );
}

function toolResultText(result: unknown): string {
  const content = record(result).content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => (record(item).type === "text" ? String(record(item).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

function record(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}
