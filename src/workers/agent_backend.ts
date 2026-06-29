// Resolves which agent backend runs LoopForge workers and builds clients for
// it. Codex stays the native default; pi (pi.dev) provides every other model:
// claude = pi with the Anthropic provider, local = pi with a LoopForge-managed
// custom provider pointed at any OpenAI-compatible endpoint (llama.cpp, vLLM,
// LM Studio, Ollama).

import path from "node:path";
import { GlobalConfig, readGlobalConfig } from "../board/global_config.ts";
import { readConfig } from "../board/store.ts";
import { ActivityEventInput } from "../board/types.ts";
import { CodexAppServerClient, CodexClient } from "./codex_app_server.ts";
import { PiRpcClient } from "./pi_rpc_client.ts";

export const LOCAL_PI_PROVIDER_ID = "loopforge-local";

export function createAgentClient(
  root: string,
  onEvent: (event: ActivityEventInput) => void,
  config: GlobalConfig = readGlobalConfig(),
): CodexClient {
  if (config.backend === "pi") {
    return new PiRpcClient(onEvent, {
      provider: config.pi.provider || undefined,
      model: config.pi.model || undefined,
    });
  }
  if (config.backend === "claude") {
    return new PiRpcClient(onEvent, {
      provider: "anthropic",
      model: config.claude.model,
    });
  }
  if (config.backend === "local") {
    ensureLocalPiProvider(config);
    return new PiRpcClient(onEvent, {
      provider: LOCAL_PI_PROVIDER_ID,
      model: config.local.model,
    });
  }
  return new CodexAppServerClient(onEvent, readConfig(root));
}

// The planner role can run on a stronger backend than the execution loop:
// plan on a subscription model, grind locally for free.
export function createPlannerClient(
  root: string,
  onEvent: (event: ActivityEventInput) => void,
  config: GlobalConfig = readGlobalConfig(),
): CodexClient {
  if (config.planner.enabled) {
    return createAgentClient(root, onEvent, { ...config, backend: config.planner.backend });
  }
  return createAgentClient(root, onEvent, config);
}

// The reviewer role gates the merge and can run on a stronger backend than the
// execution loop: implement on a cheap/local model, review on a powerhouse.
export function createReviewerClient(
  root: string,
  onEvent: (event: ActivityEventInput) => void,
  config: GlobalConfig = readGlobalConfig(),
): CodexClient {
  if (config.reviewer.enabled) {
    return createAgentClient(root, onEvent, { ...config, backend: config.reviewer.backend });
  }
  return createAgentClient(root, onEvent, config);
}

export function piModelsPath(): string {
  const override = Deno.env.get("LOOPFORGE_PI_MODELS_PATH");
  if (override?.trim()) {
    return override.trim();
  }
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  return path.join(home, ".pi", "agent", "models.json");
}

export function ensureLocalPiProvider(
  config: GlobalConfig,
  modelsPath = piModelsPath(),
  contextWindow: number | null = detectLocalContextWindow(config.local.endpoint),
): boolean {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(Deno.readTextFileSync(modelsPath));
  } catch {
    // Missing or invalid file starts from an empty registry.
  }
  const providers = isRecord(parsed.providers) ? parsed.providers : {};
  const existing = isRecord(providers[LOCAL_PI_PROVIDER_ID])
    ? providers[LOCAL_PI_PROVIDER_ID] as Record<string, unknown>
    : null;
  const desired = {
    name: "LoopForge Local",
    baseUrl: config.local.endpoint,
    api: "openai-completions",
    apiKey: config.local.apiKey || "none",
    models: [{
      id: config.local.model,
      ...(contextWindow ? { contextWindow } : {}),
    }],
  };
  if (existing && JSON.stringify(existing) === JSON.stringify(desired)) {
    return false;
  }
  const next = {
    ...parsed,
    providers: { ...providers, [LOCAL_PI_PROVIDER_ID]: desired },
  };
  Deno.mkdirSync(path.dirname(modelsPath), { recursive: true });
  Deno.writeTextFileSync(modelsPath, `${JSON.stringify(next, null, 2)}\n`);
  return true;
}

// llama.cpp servers report the loaded context size at /props. Without it pi
// assumes the model's trained window and never compacts, so over-long prompts
// silently come back empty. Other servers simply do not respond here.
export function detectLocalContextWindow(endpoint: string): number | null {
  try {
    const base = endpoint.replace(/\/v1\/?$/, "");
    const request = new Deno.Command("curl", {
      args: ["-s", "--max-time", "3", `${base}/props`],
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    if (!request.success) {
      return null;
    }
    const props = JSON.parse(new TextDecoder().decode(request.stdout));
    const nCtx = isRecord(props) && isRecord(props.default_generation_settings)
      ? Number(props.default_generation_settings.n_ctx)
      : NaN;
    return Number.isInteger(nCtx) && nCtx > 0 ? nCtx : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
