// Machine-level LoopForge settings shared by every project: which agent
// backend runs workers, and how to reach local/self-hosted models.
// Stored at ~/.loopforge/config.json (override the directory with
// LOOPFORGE_HOME, mainly for tests).

import path from "node:path";

export const AGENT_BACKENDS = ["codex", "claude", "local"] as const;

export type AgentBackend = typeof AGENT_BACKENDS[number];

// Claude runs the native Claude Code CLI, whose `--effort <level>` ladder these
// mirror. Verified against `claude --help`.
export const CLAUDE_EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ClaudeEffort = typeof CLAUDE_EFFORT_LEVELS[number];

export interface GlobalConfig {
  backend: AgentBackend;
  local: {
    endpoint: string;
    model: string;
    apiKey: string;
    // Advanced pi override: when piProvider is set, the local backend routes
    // through pi's own provider registry (pi.dev) instead of the
    // LoopForge-managed local endpoint. Empty = use the local endpoint provider.
    piProvider: string;
    piModel: string;
  };
  claude: {
    model: string;
    effort: string;
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
  // Review can run on a stronger backend than the execution loop: grind cheap
  // (e.g. pi/local), then have a powerhouse model gate the merge.
  reviewer: {
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
  // Hard cap on how many fan-out sub-agents the goal loop runs in parallel.
  // The main agent is told to use up to this many disjoint-scope sub-agents.
  maxParallelAgents: number;
}

export interface GlobalConfigPatch {
  backend?: AgentBackend;
  local?: Partial<GlobalConfig["local"]>;
  claude?: Partial<GlobalConfig["claude"]>;
  rescue?: Partial<GlobalConfig["rescue"]>;
  planner?: Partial<GlobalConfig["planner"]>;
  reviewer?: Partial<GlobalConfig["reviewer"]>;
  scout?: Partial<GlobalConfig["scout"]>;
  search?: Partial<GlobalConfig["search"]>;
  pushBranches?: boolean;
  maxParallelAgents?: number;
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
      piProvider: "",
      piModel: "",
    },
    claude: {
      model: "claude-sonnet-4-6",
      effort: "high",
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
    reviewer: {
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
    maxParallelAgents: 5,
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
  const local = {
    endpoint: stringValue(record(parsed.local).endpoint, defaults.local.endpoint),
    model: stringValue(record(parsed.local).model, defaults.local.model),
    apiKey: stringValue(record(parsed.local).apiKey, defaults.local.apiKey),
    piProvider: stringValue(record(parsed.local).piProvider, defaults.local.piProvider),
    piModel: stringValue(record(parsed.local).piModel, defaults.local.piModel),
  };
  // MIGRATION: pre-merge configs had a separate "pi" backend with its own
  // provider block. Fold that provider into the local backend's advanced pi
  // override so existing pi routing keeps working now that "pi" is gone as a
  // picker entry. Only seed when the new field is still unset.
  if (parsed.backend === "pi" && !local.piProvider) {
    const legacyPi = record(parsed.pi);
    local.piProvider = stringValue(legacyPi.provider, "");
    local.piModel = stringValue(legacyPi.model, "");
  }
  return {
    backend: normalizeBackend(parsed.backend, defaults.backend),
    local,
    claude: {
      model: stringValue(record(parsed.claude).model, defaults.claude.model),
      effort: normalizeClaudeEffort(record(parsed.claude).effort, defaults.claude.effort),
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
    reviewer: {
      enabled: record(parsed.reviewer).enabled === true,
      backend: normalizeBackend(record(parsed.reviewer).backend, defaults.reviewer.backend),
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
    maxParallelAgents: intValue(parsed.maxParallelAgents, defaults.maxParallelAgents),
  };
}

function intValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

// The parallel-agent cap is a small bounded range: at least 1, capped at 12 so
// a typo can't spawn an unbounded fleet of worktrees.
function clampAgents(value: number): number {
  if (!Number.isFinite(value)) return 5;
  return Math.max(1, Math.min(12, Math.round(value)));
}

export function updateGlobalConfig(patch: GlobalConfigPatch): GlobalConfig {
  const current = readGlobalConfig();
  // Re-normalize the patched effort level so an invalid value can't be persisted.
  const claude = { ...current.claude, ...patch.claude };
  claude.effort = normalizeClaudeEffort(claude.effort, defaultGlobalConfig().claude.effort);
  const next: GlobalConfig = {
    backend: patch.backend ?? current.backend,
    local: { ...current.local, ...patch.local },
    claude,
    rescue: { ...current.rescue, ...patch.rescue },
    planner: { ...current.planner, ...patch.planner },
    reviewer: { ...current.reviewer, ...patch.reviewer },
    scout: { ...current.scout, ...patch.scout },
    search: { ...current.search, ...patch.search },
    pushBranches: patch.pushBranches ?? current.pushBranches,
    maxParallelAgents: clampAgents(patch.maxParallelAgents ?? current.maxParallelAgents),
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
    return `claude (${config.claude.model})`;
  }
  // local runs the pi coding agent. With an advanced pi override it routes
  // through pi's own provider registry; otherwise it drives the
  // LoopForge-managed local endpoint provider.
  if (config.local.piProvider) {
    const model = [config.local.piProvider, config.local.piModel].filter(Boolean).join("/");
    return `local via pi (${model})`;
  }
  return `pi agent, local model ${config.local.model} at ${config.local.endpoint}`;
}

export function normalizeBackend(value: unknown, fallback: AgentBackend): AgentBackend {
  // "pi" merged into "local": any legacy pi value (main backend or a role
  // backend) resolves to local.
  if (value === "pi") {
    return "local";
  }
  return AGENT_BACKENDS.includes(value as AgentBackend) ? value as AgentBackend : fallback;
}

export function normalizeClaudeEffort(value: unknown, fallback: string): string {
  return CLAUDE_EFFORT_LEVELS.includes(value as ClaudeEffort) ? value as string : fallback;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
