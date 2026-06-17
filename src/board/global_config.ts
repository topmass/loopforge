// Machine-level LoopForge settings shared by every project: which agent
// backend runs workers, and how to reach local/self-hosted models.
// Stored at ~/.loopforge/config.json (override the directory with
// LOOPFORGE_HOME, mainly for tests).

import path from "node:path";

export const AGENT_BACKENDS = ["codex", "pi", "claude", "local"] as const;

export type AgentBackend = typeof AGENT_BACKENDS[number];

export interface GlobalConfig {
  backend: AgentBackend;
  local: {
    endpoint: string;
    model: string;
    apiKey: string;
  };
  pi: {
    provider: string;
    model: string;
  };
  claude: {
    model: string;
  };
  rescue: {
    enabled: boolean;
    backend: AgentBackend;
    afterAttempts: number;
  };
  planner: {
    enabled: boolean;
    backend: AgentBackend;
  };
  scout: {
    enabled: boolean;
    backend: AgentBackend;
  };
  search: {
    endpoint: string;
  };
  // When true, fan-out sub-agents push their branch to origin on completion
  // (if a remote exists) before the loop merges everything at the end.
  pushBranches: boolean;
}

export interface GlobalConfigPatch {
  backend?: AgentBackend;
  local?: Partial<GlobalConfig["local"]>;
  pi?: Partial<GlobalConfig["pi"]>;
  claude?: Partial<GlobalConfig["claude"]>;
  rescue?: Partial<GlobalConfig["rescue"]>;
  planner?: Partial<GlobalConfig["planner"]>;
  scout?: Partial<GlobalConfig["scout"]>;
  search?: Partial<GlobalConfig["search"]>;
  pushBranches?: boolean;
}

export function loopforgeHome(): string {
  // GOALFORGE_HOME and ~/.goalforge are honored for installs from before the
  // LoopForge rename.
  const override = Deno.env.get("LOOPFORGE_HOME") ?? Deno.env.get("GOALFORGE_HOME");
  if (override?.trim()) {
    return override.trim();
  }
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  const next = path.join(home, ".loopforge");
  const legacy = path.join(home, ".goalforge");
  return dirExists(next) || !dirExists(legacy) ? next : legacy;
}

function dirExists(target: string): boolean {
  try {
    return Deno.statSync(target).isDirectory;
  } catch {
    return false;
  }
}

export function globalConfigPath(): string {
  return path.join(loopforgeHome(), "config.json");
}

export function defaultGlobalConfig(): GlobalConfig {
  return {
    backend: "codex",
    local: {
      endpoint: "http://127.0.0.1:8080/v1",
      model: "local-model",
      apiKey: "none",
    },
    pi: {
      provider: "",
      model: "",
    },
    claude: {
      model: "claude-sonnet-4-6",
    },
    rescue: {
      enabled: false,
      backend: "codex",
      afterAttempts: 2,
    },
    planner: {
      enabled: false,
      backend: "codex",
    },
    scout: {
      enabled: false,
      backend: "codex",
    },
    search: {
      endpoint: "",
    },
    pushBranches: false,
  };
}

export function readGlobalConfig(): GlobalConfig {
  const defaults = defaultGlobalConfig();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(Deno.readTextFileSync(globalConfigPath()));
  } catch {
    return defaults;
  }
  return {
    backend: normalizeBackend(parsed.backend, defaults.backend),
    local: {
      endpoint: stringValue(record(parsed.local).endpoint, defaults.local.endpoint),
      model: stringValue(record(parsed.local).model, defaults.local.model),
      apiKey: stringValue(record(parsed.local).apiKey, defaults.local.apiKey),
    },
    pi: {
      provider: stringValue(record(parsed.pi).provider, defaults.pi.provider),
      model: stringValue(record(parsed.pi).model, defaults.pi.model),
    },
    claude: {
      model: stringValue(record(parsed.claude).model, defaults.claude.model),
    },
    rescue: {
      enabled: record(parsed.rescue).enabled === true,
      backend: normalizeBackend(record(parsed.rescue).backend, defaults.rescue.backend),
      afterAttempts: intValue(record(parsed.rescue).afterAttempts, defaults.rescue.afterAttempts),
    },
    planner: {
      enabled: record(parsed.planner).enabled === true,
      backend: normalizeBackend(record(parsed.planner).backend, defaults.planner.backend),
    },
    scout: {
      enabled: record(parsed.scout).enabled === true,
      backend: normalizeBackend(record(parsed.scout).backend, defaults.scout.backend),
    },
    search: {
      endpoint: typeof record(parsed.search).endpoint === "string"
        ? (record(parsed.search).endpoint as string).trim()
        : defaults.search.endpoint,
    },
    pushBranches: parsed.pushBranches === true,
  };
}

function intValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function updateGlobalConfig(patch: GlobalConfigPatch): GlobalConfig {
  const current = readGlobalConfig();
  const next: GlobalConfig = {
    backend: patch.backend ?? current.backend,
    local: { ...current.local, ...patch.local },
    pi: { ...current.pi, ...patch.pi },
    claude: { ...current.claude, ...patch.claude },
    rescue: { ...current.rescue, ...patch.rescue },
    planner: { ...current.planner, ...patch.planner },
    scout: { ...current.scout, ...patch.scout },
    search: { ...current.search, ...patch.search },
    pushBranches: patch.pushBranches ?? current.pushBranches,
  };
  Deno.mkdirSync(loopforgeHome(), { recursive: true });
  Deno.writeTextFileSync(globalConfigPath(), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function describeBackend(config: GlobalConfig): string {
  if (config.backend === "codex") {
    return "codex (native Codex app-server)";
  }
  if (config.backend === "claude") {
    return `claude via pi (${config.claude.model})`;
  }
  if (config.backend === "local") {
    return `local via pi (${config.local.model} at ${config.local.endpoint})`;
  }
  const model = [config.pi.provider, config.pi.model].filter(Boolean).join("/");
  return model ? `pi (${model})` : "pi (pi default model)";
}

export function normalizeBackend(value: unknown, fallback: AgentBackend): AgentBackend {
  return AGENT_BACKENDS.includes(value as AgentBackend) ? value as AgentBackend : fallback;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
