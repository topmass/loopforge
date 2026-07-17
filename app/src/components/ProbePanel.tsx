import { useState } from "react";
import { api } from "../api";
import type { Probe } from "../types";
import { useArmedDelete } from "./ui";

// Status dot tones for a probe row: real probe states, not the shared loop
// STATUS keys (a probe is passed/failed/pending, never "live").
function probeDot(status: string): string {
  if (status === "passed") return "bg-ok";
  if (status === "failed") return "bg-danger";
  return "bg-ink-faint";
}

// One editable win condition: dot + label row; expanded, the command is a mono
// textarea with the last output underneath - the output IS the diagnosis when
// a planner-written probe is broken (quoting bugs read right off the trace).
function ProbeRow(
  { probe, busy, onSave, onDelete }: {
    probe: Probe;
    busy: boolean;
    onSave: (id: number, patch: { label: string; command: string }) => void;
    onDelete: (id: number) => void;
  },
) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(probe.label);
  const [command, setCommand] = useState(probe.command);
  const { armed, arm, disarm } = useArmedDelete();
  const dirty = label.trim() !== probe.label ||
    command.trim() !== probe.command;

  return (
    <div className="rounded-xl border border-line bg-surface-raised">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
      >
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${probeDot(probe.lastStatus)}`}
        />
        <span className="min-w-0 flex-1 truncate text-ink">{probe.label}</span>
        <span className="shrink-0 text-[10px] uppercase tracking-wider text-ink-faint">
          {probe.lastStatus}
        </span>
        <span className="shrink-0 text-ink-faint">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-line px-3 py-2.5">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="what this check proves"
            className="w-full rounded-lg border border-line bg-surface-overlay px-2.5 py-1.5 text-xs text-ink outline-none focus:border-accent"
          />
          <textarea
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            rows={3}
            spellCheck={false}
            className="w-full resize-y rounded-lg border border-line bg-surface-sunken px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-ink outline-none focus:border-accent"
          />
          {probe.lastOutput && (
            <pre className="max-h-36 overflow-auto rounded-lg bg-surface-sunken px-2.5 py-2 font-mono text-[10px] leading-relaxed text-ink-muted">
              {probe.lastOutput}
            </pre>
          )}
          {probe.lastStatus === "failed" && !probe.lastOutput && (
            <div className="text-[10px] text-ink-faint">
              exited non-zero with no output
            </div>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy || !dirty || !label.trim() || !command.trim()}
              onClick={() =>
                onSave(probe.id, {
                  label: label.trim(),
                  command: command.trim(),
                })}
              className="rounded-lg bg-accent-strong px-3 py-1 text-xs font-semibold text-on-accent transition hover:opacity-90 disabled:opacity-40"
            >
              Save
            </button>
            {dirty && (
              <button
                type="button"
                onClick={() => {
                  setLabel(probe.label);
                  setCommand(probe.command);
                }}
                className="rounded-lg border border-line px-3 py-1 text-xs text-ink-muted transition hover:bg-surface-sunken"
              >
                Reset
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (armed === String(probe.id)) {
                  disarm();
                  onDelete(probe.id);
                } else {
                  arm(String(probe.id));
                }
              }}
              className={`ml-auto rounded-lg border px-3 py-1 text-xs transition ${
                armed === String(probe.id)
                  ? "border-danger bg-danger-soft text-danger-ink"
                  : "border-line text-ink-muted hover:bg-surface-sunken"
              }`}
            >
              {armed === String(probe.id) ? "Really delete?" : "Delete"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// The win-conditions editor under the board strip: list, edit, add, delete,
// and re-run the scoped goal's probes. Everything lands in the board snapshot
// via SSE, so results appear without local state juggling.
export function ProbePanel({ goalId, probes, loopLive }: {
  goalId: string;
  probes: Probe[];
  loopLive: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newCommand, setNewCommand] = useState("");

  const wrap = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1.5 border-b border-line px-4 py-3">
      {error && <div className="text-xs text-danger">{error}</div>}
      {probes.map((probe) => (
        <ProbeRow
          key={probe.id}
          probe={probe}
          busy={busy}
          onSave={(id, patch) => void wrap(() => api.updateProbe(id, patch))}
          onDelete={(id) => void wrap(() => api.deleteProbe(id))}
        />
      ))}
      {adding
        ? (
          <div className="space-y-2 rounded-xl border border-line bg-surface-raised px-3 py-2.5">
            <input
              autoFocus
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="what this check proves"
              className="w-full rounded-lg border border-line bg-surface-overlay px-2.5 py-1.5 text-xs text-ink outline-none focus:border-accent"
            />
            <textarea
              value={newCommand}
              onChange={(e) => setNewCommand(e.target.value)}
              rows={2}
              spellCheck={false}
              placeholder="command that exits 0 when the condition holds"
              className="w-full resize-y rounded-lg border border-line bg-surface-sunken px-2.5 py-1.5 font-mono text-[11px] text-ink outline-none focus:border-accent"
            />
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy || !newLabel.trim() || !newCommand.trim()}
                onClick={() =>
                  void wrap(async () => {
                    await api.addProbe(
                      goalId,
                      newLabel.trim(),
                      newCommand.trim(),
                    );
                    setNewLabel("");
                    setNewCommand("");
                    setAdding(false);
                  })}
                className="rounded-lg bg-accent-strong px-3 py-1 text-xs font-semibold text-on-accent transition hover:opacity-90 disabled:opacity-40"
              >
                Add
              </button>
              <button
                type="button"
                onClick={() => setAdding(false)}
                className="rounded-lg border border-line px-3 py-1 text-xs text-ink-muted transition hover:bg-surface-sunken"
              >
                Cancel
              </button>
            </div>
          </div>
        )
        : (
          <div className="flex items-center gap-2 pt-0.5">
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="rounded-lg border border-line px-3 py-1 text-xs text-ink-muted transition hover:bg-surface-sunken"
            >
              Add win condition
            </button>
            <button
              type="button"
              disabled={busy || loopLive || probes.length === 0}
              title={loopLive ? "The running loop re-checks these every turn." : undefined}
              onClick={() => void wrap(() => api.checkGoal(goalId))}
              className="rounded-lg border border-line px-3 py-1 text-xs text-ink-muted transition hover:bg-surface-sunken disabled:opacity-40"
            >
              {busy ? "Running..." : "Re-run checks"}
            </button>
          </div>
        )}
    </div>
  );
}
