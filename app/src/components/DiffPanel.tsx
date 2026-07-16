import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { api } from "../api";
import { LineMark } from "./marks";
import type { GoalDiff, GoalDiffFile } from "../types";

// The Diff tab: per-file unified diffs for the ACTIVE goal's loop branch
// (base..branch while the loop runs, the merge commit once closed). Data comes
// from GET /api/goals/:id/diff on mount + goal change; live updates re-fetch on
// a 2s trailing debounce whenever a matching activity event lands, so the diff
// grows while a loop works (same pattern as ThreadView).

const AUTO_EXPAND_MAX = 8;
const MAX_PATCH_LINES = 1500;

// Truncate a long path in the middle: keep the first 12 and last 24 chars.
function truncatePath(path: string): string {
  if (path.length <= 12 + 24 + 3) return path;
  return `${path.slice(0, 12)}...${path.slice(-24)}`;
}

type LineKind = "add" | "del" | "hunk" | "meta" | "plain";

// Classify a unified-diff line for rendering. "meta" lines are suppressed (the
// file header row already shows the path). Order matters: "+++"/"---" must be
// caught as meta before the bare "+"/"-" checks.
function classifyLine(line: string): LineKind {
  if (
    line.startsWith("diff --git") || line.startsWith("index ") ||
    line.startsWith("+++") || line.startsWith("---")
  ) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "plain";
}

export function DiffPanel() {
  const goalId = useStore((s) => s.activeGoalId);

  const [diff, setDiff] = useState<GoalDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const wantGoal = useRef<string | null>(null);
  const seeded = useRef<string | null>(null);

  // Newest live activity id for THIS goal (0 = none); a primitive so the
  // selector stays stable and only advances on a matching event.
  const activityTick = useStore((s) => {
    if (!goalId) return 0;
    for (let i = s.activity.length - 1; i >= 0; i--) {
      if (s.activity[i].goalId === goalId) return s.activity[i].id;
    }
    return 0;
  });

  const load = useCallback(async (id: string, silent: boolean) => {
    if (!silent) setLoading(true);
    try {
      const next = await api.getGoalDiff(id);
      if (wantGoal.current !== id) return; // goal switched mid-flight
      setDiff(next);
      setError(null);
      // Seed the default expansion once per goal (expanded when small, else all
      // collapsed); silent refreshes then preserve the reader's toggles.
      if (seeded.current !== id) {
        seeded.current = id;
        setExpanded(
          next.files.length <= AUTO_EXPAND_MAX ? new Set(next.files.map((f) => f.path)) : new Set(),
        );
      }
    } catch (e) {
      if (wantGoal.current !== id) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!silent && wantGoal.current === id) setLoading(false);
    }
  }, []);

  // Fetch on mount + goal change; reset per-goal view state.
  useEffect(() => {
    wantGoal.current = goalId;
    seeded.current = null;
    setDiff(null);
    setError(null);
    setExpanded(new Set());
    if (goalId) void load(goalId, false);
  }, [goalId, load]);

  // Live refresh: a matching activity event bumps activityTick; re-fetch on a 2s
  // trailing debounce (each new event resets the timer). Silent, so the initial
  // spinner and the reader's expansion state are left alone.
  useEffect(() => {
    if (!goalId || activityTick === 0) return;
    const t = setTimeout(() => void load(goalId, true), 2000);
    return () => clearTimeout(t);
  }, [activityTick, goalId, load]);

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  if (!goalId) {
    return <EmptyState text="Select a loop to view its changes." />;
  }

  const files = diff?.files ?? [];
  const totalAdd = files.reduce((n, f) => n + f.additions, 0);
  const totalDel = files.reduce((n, f) => n + f.deletions, 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {diff?.truncated && (
        <div className="border-b border-line bg-surface-sunken px-4 py-1.5 text-center text-[11px] text-ink-faint">
          file list truncated
        </div>
      )}
      {diff && !diff.note && files.length > 0 && (
        <div className="border-b border-line px-4 py-3 text-xs text-ink-muted">
          {files.length} file{files.length === 1 ? "" : "s"}
          {" · "}
          <span className="font-mono text-ok">+{totalAdd}</span>{" "}
          <span className="font-mono text-danger">-{totalDel}</span>
        </div>
      )}
      <div className="flex-1 overflow-y-auto">
        {error && <div className="px-4 py-3 text-center text-xs text-danger">{error}</div>}
        {loading && !diff && (
          <div className="py-10 text-center text-sm text-ink-faint">Loading diff...</div>
        )}
        {diff?.note && <EmptyState text={diff.note} />}
        {diff && !diff.note && files.length === 0 && (
          <EmptyState text="No changes yet on this loop's branch." />
        )}
        {files.map((file) => (
          <FileSection
            key={file.path}
            file={file}
            open={expanded.has(file.path)}
            onToggle={() => toggle(file.path)}
          />
        ))}
      </div>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center text-sm text-ink-muted">
      <LineMark variant="diff" className="h-12 w-12 text-ink-faint" />
      {text}
    </div>
  );
}

function FileSection(
  { file, open, onToggle }: { file: GoalDiffFile; open: boolean; onToggle: () => void },
) {
  return (
    <div className="border-b border-line">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-4 py-2 text-left transition hover:bg-surface-sunken"
      >
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs text-ink"
          title={file.path}
        >
          {truncatePath(file.path)}
        </span>
        {file.binary && (
          <span className="shrink-0 rounded-full border border-line bg-surface-sunken px-1.5 py-0.5 text-[10px] text-ink-muted">
            binary
          </span>
        )}
        {file.truncated && (
          <span className="shrink-0 rounded-full border border-warn bg-warn-soft px-1.5 py-0.5 text-[10px] text-warn-ink">
            patch truncated
          </span>
        )}
        <span className="shrink-0 font-mono text-xs text-ok">+{file.additions}</span>
        <span className="shrink-0 font-mono text-xs text-danger">-{file.deletions}</span>
      </button>
      {open && <PatchBody patch={file.patch} />}
    </div>
  );
}

function PatchBody({ patch }: { patch: string }) {
  const lines = patch.split("\n");
  const shown = lines.slice(0, MAX_PATCH_LINES);
  const extra = lines.length - shown.length;
  return (
    <div className="overflow-x-auto bg-surface-raised pb-2 font-mono text-xs">
      {shown.map((line, i) => {
        const kind = classifyLine(line);
        if (kind === "meta") return null;
        const cls = kind === "add"
          ? "bg-ok-soft text-ok-ink"
          : kind === "del"
          ? "bg-danger-soft text-danger-ink"
          : kind === "hunk"
          ? "bg-surface-sunken text-ink-muted"
          : "text-ink";
        return (
          <div key={i} className={`whitespace-pre px-4 ${cls}`}>
            {line || " "}
          </div>
        );
      })}
      {extra > 0 && <div className="px-4 py-1 text-ink-faint">... {extra} more lines</div>}
    </div>
  );
}
