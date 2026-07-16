import { useState } from "react";
import { motion } from "motion/react";
import { useStore } from "../store";
import { api } from "../api";
import { spring } from "./ui";

const BACKENDS = ["codex", "claude", "local"] as const;
// Install command shown in the local backend's doctor line when pi is missing.
// The real package that ships the `pi` binary (verified against the installed
// pnpm shim), not the pi.dev marketing name.
const PI_INSTALL = "pnpm add -g @earendil-works/pi-coding-agent";
// The real ReasoningEffort union from src/board/store.ts - keep in sync.
const REASONING = ["low", "medium", "high", "xhigh"] as const;
// The native Claude Code CLI's --effort ladder (see CLAUDE_EFFORT_LEVELS in
// src/board/global_config.ts).
const CLAUDE_EFFORT = ["low", "medium", "high", "xhigh", "max"] as const;
// Common Claude models offered in the picker; "other..." reveals a free-text box.
const CLAUDE_MODELS = [
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-haiku-4-5",
  "claude-sonnet-4-6",
] as const;

// Model routing settings - the same knobs the TUI exposed (main backend +
// rescue / planner / scout), live-editable via the config PATCH endpoints.
export function SettingsModal({ onClose }: { onClose: () => void }) {
  const runtime = useStore((s) => s.runtime);
  const setRuntime = useStore((s) => s.setRuntime);
  const [saving, setSaving] = useState<string | null>(null);
  // Whether the Claude picker is showing its free-text box (an unknown model, or
  // the user explicitly chose "other...").
  const [claudeOther, setClaudeOther] = useState(false);

  const refresh = async () => setRuntime(await api.runtime());

  const wrap = async (key: string, fn: () => Promise<unknown>) => {
    setSaving(key);
    try {
      await fn();
      await refresh();
    } finally {
      setSaving(null);
    }
  };

  const roleValue = (role?: { enabled: boolean; backend: string }) =>
    role?.enabled ? role.backend : "off";

  const RoleRow = (
    { label, help, value, onChange }: {
      label: string;
      help: string;
      value: string;
      onChange: (v: string) => void;
    },
  ) => (
    <div className="flex items-center justify-between gap-3 border-b border-line py-3">
      <div>
        <div className="text-sm font-medium text-ink">{label}</div>
        <div className="text-xs text-ink-muted">{help}</div>
      </div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-xl border border-line bg-surface-sunken px-2.5 py-1.5 text-sm outline-none focus:border-accent"
      >
        {["off", ...BACKENDS].map((b) => (
          <option key={b} value={b} className="bg-surface-overlay">{b}</option>
        ))}
      </select>
    </div>
  );

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 z-50 flex items-center justify-center bg-scrim backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.94, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96 }}
        transition={spring}
        className="glass w-[460px] rounded-3xl p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-base font-semibold">Model settings</span>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-muted transition-colors hover:text-ink"
          >
            ✕
          </button>
        </div>
        {saving && (
          <div className="mb-2 text-xs text-accent">Saving {saving}...</div>
        )}

        <div className="flex items-center justify-between gap-3 border-b border-line py-3">
          <div>
            <div className="text-sm font-medium text-ink">Main agent</div>
            <div className="text-xs text-ink-muted">
              The model the loop owner and workers run on. ({runtime?.backend ??
                "?"})
            </div>
          </div>
          <select
            value={runtime?.backendRaw ?? "codex"}
            onChange={(e) =>
              void wrap("main backend", () => api.setBackend(e.target.value))}
            className="rounded-xl border border-line bg-surface-sunken px-2.5 py-1.5 text-sm outline-none focus:border-accent"
          >
            {BACKENDS.map((b) => (
              <option key={b} value={b} className="bg-surface-overlay">
                {b}
              </option>
            ))}
          </select>
        </div>

        <RoleRow
          label="Rescue model"
          help="Senior model consulted when a task keeps failing. 'savior'."
          value={roleValue(runtime?.rescue)}
          onChange={(v) =>
            void wrap(
              "rescue",
              () =>
                api.setRescue(
                  v === "off"
                    ? { enabled: false }
                    : { enabled: true, backend: v },
                ),
            )}
        />
        <RoleRow
          label="Planner model"
          help="Compiles goals into tasks + win conditions. Off = follow main."
          value={roleValue(runtime?.planner)}
          onChange={(v) =>
            void wrap(
              "planner",
              () =>
                api.setPlanner(
                  v === "off"
                    ? { enabled: false }
                    : { enabled: true, backend: v },
                ),
            )}
        />
        <RoleRow
          label="Scout model"
          help="Proposes next-build ideas for your review. Off = no scouting."
          value={roleValue(runtime?.scout)}
          onChange={(v) =>
            void wrap(
              "scout",
              () =>
                api.setScout(
                  v === "off"
                    ? { enabled: false }
                    : { enabled: true, backend: v },
                ),
            )}
        />

        {/* Model power: codex knobs (per-project) + the Claude model (machine-wide). */}
        <div className="border-b border-line py-3">
          <div className="text-sm font-medium text-ink">Model power</div>
          <div className="text-xs text-ink-muted">
            How hard the models think. codex is per-project; claude is
            machine-wide.
          </div>

          <div className="mt-3 space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
              codex
              {runtime?.backendRaw === "codex" && (
                <span className="ml-2 rounded-full bg-accent-soft px-1.5 py-0.5 font-medium normal-case tracking-normal text-accent-ink">
                  main agent
                </span>
              )}
            </div>
            <input
              key={runtime?.config?.model ?? ""}
              defaultValue={runtime?.config?.model ?? ""}
              placeholder="model id (e.g. gpt-5.4)"
              onBlur={(e) =>
                void wrap("codex model", () =>
                  api.setConfig({ model: e.target.value.trim() }))}
              className="w-full rounded-xl border border-line bg-surface-sunken px-2.5 py-1.5 text-sm outline-none focus:border-accent"
            />
            <div className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-xs text-ink-muted">
                reasoning
              </span>
              <div className="flex flex-1 items-center gap-1 rounded-xl border border-line bg-surface-sunken p-1">
                {REASONING.map((r) => {
                  const on = runtime?.config?.reasoningEffort === r;
                  return (
                    <button
                      key={r}
                      type="button"
                      onClick={() =>
                        void wrap(
                          "reasoning",
                          () => api.setConfig({ reasoningEffort: r }),
                        )}
                      className={`flex-1 rounded-lg px-2 py-1 text-xs font-medium transition ${
                        on
                          ? "bg-accent-strong text-on-accent shadow-sm"
                          : "text-ink-muted hover:bg-surface-sunken"
                      }`}
                    >
                      {r}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-xs text-ink-muted">
                speed
              </span>
              <div className="flex flex-1 items-center gap-1 rounded-xl border border-line bg-surface-sunken p-1">
                {([["fast", true], ["normal", false]] as const).map(
                  ([label, fast]) => {
                    const on = !!runtime?.config?.fastMode === fast;
                    return (
                      <button
                        key={label}
                        type="button"
                        onClick={() =>
                          void wrap(
                            "speed",
                            () => api.setConfig({ fastMode: fast }),
                          )}
                        className={`flex-1 rounded-lg px-2 py-1 text-xs font-medium transition ${
                          on
                            ? "bg-accent-strong text-on-accent shadow-sm"
                            : "text-ink-muted hover:bg-surface-sunken"
                        }`}
                      >
                        {label}
                      </button>
                    );
                  },
                )}
              </div>
            </div>
          </div>

          <div className="mt-3 space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
              claude
              {runtime?.backendRaw === "claude" && (
                <span className="ml-2 rounded-full bg-accent-soft px-1.5 py-0.5 font-medium normal-case tracking-normal text-accent-ink">
                  main agent
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-xs text-ink-muted">
                model
              </span>
              <select
                value={claudeOther ||
                    !CLAUDE_MODELS.includes(
                      (runtime?.claudeModel ?? "") as typeof CLAUDE_MODELS[
                        number
                      ],
                    )
                  ? "other"
                  : runtime?.claudeModel}
                onChange={(e) => {
                  if (e.target.value === "other") {
                    setClaudeOther(true);
                    return;
                  }
                  setClaudeOther(false);
                  void wrap(
                    "claude model",
                    () =>
                      api.setClaudeModel(e.target.value),
                  );
                }}
                className="flex-1 rounded-xl border border-line bg-surface-sunken px-2.5 py-1.5 text-sm outline-none focus:border-accent"
              >
                {CLAUDE_MODELS.map((m) => (
                  <option key={m} value={m} className="bg-surface-overlay">
                    {m}
                  </option>
                ))}
                <option value="other" className="bg-surface-overlay">
                  other...
                </option>
              </select>
            </div>
            {(claudeOther ||
              !CLAUDE_MODELS.includes(
                (runtime?.claudeModel ?? "") as typeof CLAUDE_MODELS[number],
              )) && (
              <input
                key={runtime?.claudeModel ?? ""}
                defaultValue={CLAUDE_MODELS.includes(
                    (runtime?.claudeModel ?? "") as typeof CLAUDE_MODELS[
                      number
                    ],
                  )
                  ? ""
                  : runtime?.claudeModel ?? ""}
                placeholder="model id"
                onBlur={(e) =>
                  e.target.value.trim() &&
                  void wrap(
                    "claude model",
                    () => api.setClaudeModel(e.target.value.trim()),
                  )}
                className="w-full rounded-xl border border-line bg-surface-sunken px-2.5 py-1.5 text-sm outline-none focus:border-accent"
              />
            )}
            <div className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-xs text-ink-muted">
                effort
              </span>
              <div className="flex flex-1 items-center gap-1 rounded-xl border border-line bg-surface-sunken p-1">
                {CLAUDE_EFFORT.map((t) => {
                  const on = runtime?.claudeEffort === t;
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() =>
                        void wrap(
                          "claude effort",
                          () => api.setClaudeEffort(t),
                        )}
                      className={`flex-1 rounded-lg px-1.5 py-1 text-[11px] font-medium transition ${
                        on
                          ? "bg-accent-strong text-on-accent shadow-sm"
                          : "text-ink-muted hover:bg-surface-sunken"
                      }`}
                    >
                      {t}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="text-[11px] text-ink-faint">
              runs your local Claude Code (claude CLI) with its native effort
              levels
            </div>
          </div>

          {
            /* local: the pi coding agent. A doctor line for the binary, plus an
              advanced override to route through pi's own providers. */
          }
          <div className="mt-3 space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
              local
              {runtime?.backendRaw === "local" && (
                <span className="ml-2 rounded-full bg-accent-soft px-1.5 py-0.5 font-medium normal-case tracking-normal text-accent-ink">
                  main agent
                </span>
              )}
            </div>
            {runtime?.piBinary?.found
              ? (
                <div className="text-[11px] text-ok">
                  pi ✓ {runtime.piBinary.version ?? ""}
                </div>
              )
              : (
                <div className="text-[11px] text-warn-ink">
                  pi not found - install:{" "}
                  <span
                    role="button"
                    tabIndex={-1}
                    title="Copy"
                    onClick={() =>
                      void navigator.clipboard?.writeText(PI_INSTALL)}
                    className="cursor-pointer rounded bg-surface-sunken px-1 py-0.5 font-mono text-ink-muted"
                  >
                    {PI_INSTALL}
                  </span>
                </div>
              )}
            <details>
              <summary className="cursor-pointer text-[11px] text-ink-muted">
                advanced
              </summary>
              <div className="mt-2 space-y-2">
                <input
                  key={`pi-provider-${runtime?.localPiProvider ?? ""}`}
                  defaultValue={runtime?.localPiProvider ?? ""}
                  placeholder="pi provider (blank = local endpoint)"
                  onBlur={(e) =>
                    void wrap(
                      "pi provider",
                      () => api.setLocalPi({ provider: e.target.value.trim() }),
                    )}
                  className="w-full rounded-xl border border-line bg-surface-sunken px-2.5 py-1.5 text-sm outline-none focus:border-accent"
                />
                <input
                  key={`pi-model-${runtime?.localPiModel ?? ""}`}
                  defaultValue={runtime?.localPiModel ?? ""}
                  placeholder="pi model (optional)"
                  onBlur={(e) =>
                    void wrap(
                      "pi model",
                      () => api.setLocalPi({ model: e.target.value.trim() }),
                    )}
                  className="w-full rounded-xl border border-line bg-surface-sunken px-2.5 py-1.5 text-sm outline-none focus:border-accent"
                />
                <div className="text-[11px] text-ink-faint">
                  override to route through pi's own providers instead of the
                  local endpoint
                </div>
              </div>
            </details>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-b border-line py-3">
          <div>
            <div className="text-sm font-medium text-ink">
              Parallel sub-agents
            </div>
            <div className="text-xs text-ink-muted">
              Max sub-agents the main agent runs at once. It is told to fan out
              work up to this many.
            </div>
          </div>
          <div className="flex items-center gap-1 rounded-xl border border-line bg-surface-sunken p-1">
            <button
              type="button"
              onClick={() =>
                void wrap(
                  "parallel agents",
                  () =>
                    api.setMaxAgents(
                      Math.max(1, (runtime?.maxParallelAgents ?? 5) - 1),
                    ),
                )}
              className="h-7 w-7 rounded-lg text-ink transition hover:bg-surface-sunken"
            >
              −
            </button>
            <span className="w-7 text-center text-sm font-semibold tabular-nums text-accent-ink">
              {runtime?.maxParallelAgents ?? 5}
            </span>
            <button
              type="button"
              onClick={() =>
                void wrap(
                  "parallel agents",
                  () =>
                    api.setMaxAgents(
                      Math.min(12, (runtime?.maxParallelAgents ?? 5) + 1),
                    ),
                )}
              className="h-7 w-7 rounded-lg text-ink transition hover:bg-surface-sunken"
            >
              +
            </button>
          </div>
        </div>

        <label className="flex cursor-pointer items-center justify-between gap-3 border-b border-line py-3">
          <div>
            <div className="text-sm font-medium text-ink">
              Isolated worktrees
            </div>
            <div className="text-xs text-ink-muted">
              Run each loop in its own git worktree and merge only on green
              probes. Off = agents work directly in this project folder, you own
              git, and fan-out is unavailable.
            </div>
          </div>
          <input
            type="checkbox"
            checked={runtime?.workflow?.useWorktrees !== false}
            onChange={(e) =>
              void wrap(
                "worktrees",
                () => api.setUseWorktrees(e.target.checked),
              )}
            className="h-4 w-4 accent-accent"
          />
        </label>

        <label className="mt-3 flex cursor-pointer items-center justify-between gap-3 border-t border-line pt-3">
          <div>
            <div className="text-sm font-medium text-ink">
              Push sub-agent branches
            </div>
            <div className="text-xs text-ink-muted">
              When a fan-out sub-agent finishes, push its branch to origin (if
              any); the loop still merges everything at the end.
            </div>
          </div>
          <input
            type="checkbox"
            checked={!!runtime?.pushBranches}
            onChange={(e) =>
              void wrap(
                "push branches",
                () => api.setPushBranches(e.target.checked),
              )}
            className="h-4 w-4 accent-accent"
          />
        </label>

        <div className="mt-4 text-xs text-ink-muted">
          Changes apply to new work immediately. codex uses your Codex login;
          claude uses Anthropic usage; local runs the pi coding agent on your
          configured local model.
        </div>
      </motion.div>
    </motion.div>
  );
}
