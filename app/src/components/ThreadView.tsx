import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { api } from "../api";
import { useChatSend } from "./ChatBar";
import type { Goal, GoalThread, ThreadEntry } from "../types";

// The per-loop Thread view: a T3-style conversation of the ACTIVE goal's loop,
// turns oldest-first. Data comes from GET /api/goals/:id/thread on mount + goal
// change; live updates re-fetch on a 2s trailing debounce whenever a matching
// activity event lands in the store (we never splice events into turns client
// side). Agent prose renders as pre-wrap text - no markdown library this wave.

const AGENT_COLLAPSE = 1200;
const NEAR_BOTTOM_PX = 150;

// Four muted left-border tints so parallel fan-out agents read as distinct
// voices; chosen by a hash of the agent title so a title always gets one tone.
const FANOUT_TINTS = [
  "border-l-sky-300",
  "border-l-violet-300",
  "border-l-teal-300",
  "border-l-rose-300",
];

function hashIndex(s: string, n: number): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % n;
}

function relTime(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Loop messages are prefixed with "GOAL-N: "; strip it so system chips read
// cleanly (agent prose and tool lines carry no prefix, so this is a no-op there).
function stripGoalPrefix(text: string): string {
  return text.replace(/^GOAL-\d+:\s*/, "");
}

type EntryRender = "user" | "agent" | "tool" | "task" | "fanout" | "chip" | "skip";

function classify(e: ThreadEntry): EntryRender {
  if (e.role.startsWith("fanout:")) return "fanout";
  if (e.role === "user") return "user"; // kind "steer"
  if (e.role === "plan" && e.kind === "task") return "task"; // lf-task mutation
  if (e.role === "loop" && e.kind === "agent") return "agent";
  if (e.kind.includes("tool") || e.kind.startsWith("item/")) return "tool";
  if (e.role === "loop" && e.kind === "iteration") return "skip"; // the turn rule names it
  return "chip"; // lifecycle + remaining loop kinds (probes/merge/hold/blocked/finished/plan/git/session/steer)
}

function chipTone(kind: string): string {
  if (["verified", "goal.closed", "subagent.merged", "merge", "finished"].includes(kind)) {
    return "border-emerald-300 bg-emerald-50 text-emerald-700";
  }
  if (["goal.blocked", "blocked", "hold"].includes(kind)) {
    return "border-amber-300 bg-amber-50 text-amber-700";
  }
  return "border-slate-200 bg-slate-50 text-slate-500";
}

export function ThreadView({ goal }: { goal: Goal | null }) {
  const goalId = goal?.id ?? null;
  const open = goal?.status === "open";

  const [thread, setThread] = useState<GoalThread | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [atBottom, setAtBottom] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const wantGoal = useRef<string | null>(null);

  // Newest live activity id for THIS goal (0 = none). A primitive so the
  // selector stays stable; it advances only when a matching SSE event lands,
  // which drives the debounced refresh without reacting to other goals' chatter.
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
      const next = await api.getGoalThread(id);
      if (wantGoal.current !== id) return; // goal switched mid-flight
      setThread(next);
      setError(null);
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
    setThread(null);
    setError(null);
    setExpanded(new Set());
    setAtBottom(true);
    atBottomRef.current = true;
    if (goalId) void load(goalId, false);
  }, [goalId, load]);

  // Live refresh: a matching activity event bumps activityTick; re-fetch on a 2s
  // trailing debounce (each new event resets the timer). Silent, so the reader's
  // scroll position and the initial spinner are left alone.
  useEffect(() => {
    if (!goalId || activityTick === 0) return;
    const t = setTimeout(() => void load(goalId, true), 2000);
    return () => clearTimeout(t);
  }, [activityTick, goalId, load]);

  // Auto-scroll to bottom on load/update, but only when the reader is already
  // near the bottom (ref, so this never fires mid scroll-up). thread drives it.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [thread]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    atBottomRef.current = near;
    setAtBottom(near);
  };

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setAtBottom(true);
  };

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (!goal) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-slate-500">
        <div className="text-lg">Select a loop from the sidebar.</div>
      </div>
    );
  }

  const turns = thread?.turns ?? [];
  const emptyThread = thread !== null && turns.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {thread?.truncated && (
        <div className="border-b border-slate-200 bg-slate-50 px-4 py-1.5 text-center text-[11px] text-slate-400">
          older turns trimmed
        </div>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-4 py-4">
          {error && <div className="mb-3 text-center text-xs text-red-600">{error}</div>}
          {loading && !thread && (
            <div className="py-10 text-center text-sm text-slate-400">Loading thread...</div>
          )}
          {emptyThread && (
            <div className="py-10 text-center text-sm text-slate-500">
              No activity yet - the loop has not started.
            </div>
          )}
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
            {turns.map((turn) => (
              <div key={turn.index} className="flex flex-col gap-3">
                <TurnSeparator index={turn.index} startedAt={turn.startedAt} />
                {turn.entries.map((entry) => (
                  <EntryRow
                    key={entry.id}
                    entry={entry}
                    open={expanded.has(entry.id)}
                    onToggle={() => toggle(entry.id)}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
        {!atBottom && turns.length > 0 && (
          <button
            type="button"
            onClick={jumpToLatest}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-slate-200 bg-white/90 px-3 py-1 text-xs font-medium text-slate-600 shadow-sm backdrop-blur transition hover:text-slate-900"
          >
            jump to latest
          </button>
        )}
      </div>
      <ThreadComposer goalId={goal.id} open={open} />
    </div>
  );
}

function TurnSeparator({ index, startedAt }: { index: number; startedAt: string | null }) {
  const when = relTime(startedAt);
  return (
    <div className="flex items-center gap-3 py-1 text-[11px] uppercase tracking-[0.18em] text-slate-400">
      <span className="h-px flex-1 bg-slate-200" />
      <span>
        {index === 0 ? "setup" : `turn ${index}`}
        {when && <span className="ml-2 lowercase tracking-normal text-slate-300">{when}</span>}
      </span>
      <span className="h-px flex-1 bg-slate-200" />
    </div>
  );
}

function EntryRow(
  { entry, open, onToggle }: { entry: ThreadEntry; open: boolean; onToggle: () => void },
) {
  const type = classify(entry);
  switch (type) {
    case "skip":
      return null;

    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[70%] whitespace-pre-wrap rounded-2xl bg-orange-50 px-4 py-2.5 text-sm text-orange-900">
            {entry.text}
          </div>
        </div>
      );

    case "agent": {
      const long = entry.text.length > AGENT_COLLAPSE;
      const shown = long && !open ? entry.text.slice(0, AGENT_COLLAPSE) : entry.text;
      return (
        <div className="flex justify-start">
          <div className="max-w-[85%] rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm leading-relaxed text-slate-700 shadow-sm">
            <div className="whitespace-pre-wrap">{shown}{long && !open ? "..." : ""}</div>
            {long && (
              <button
                type="button"
                onClick={onToggle}
                className="mt-2 text-xs font-medium text-orange-600 hover:text-orange-700"
              >
                {open ? "show less" : "show more"}
              </button>
            )}
          </div>
        </div>
      );
    }

    case "tool":
      return (
        <button
          type="button"
          onClick={onToggle}
          className="flex w-full items-start gap-2 text-left"
        >
          <span className="mt-0.5 shrink-0 text-slate-400">{"\u{1F527}"}</span>
          <span
            className={`min-w-0 flex-1 font-mono text-xs text-slate-500 ${
              open ? "whitespace-pre-wrap" : "truncate"
            }`}
          >
            {entry.text}
          </span>
        </button>
      );

    case "task":
      return (
        <div className="flex items-start gap-2 text-xs text-slate-500">
          <span className="mt-px shrink-0">{"☐"}</span>
          <span className="min-w-0 flex-1 truncate">{stripGoalPrefix(entry.text)}</span>
        </div>
      );

    case "fanout": {
      const title = entry.role.slice("fanout:".length);
      const tint = FANOUT_TINTS[hashIndex(title, FANOUT_TINTS.length)];
      return (
        <button
          type="button"
          onClick={onToggle}
          className={`flex w-full flex-col items-start border-l-2 pl-3 text-left ${tint}`}
        >
          <span className="w-full truncate text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            {title}
          </span>
          <span
            className={`w-full text-xs text-slate-500 ${open ? "whitespace-pre-wrap" : "truncate"}`}
          >
            {entry.text}
          </span>
        </button>
      );
    }

    default: {
      const text = stripGoalPrefix(entry.text);
      return (
        <div className="flex justify-center">
          <span
            className={`max-w-[80%] truncate rounded-full border px-2.5 py-1 text-[11px] ${
              chipTone(entry.kind)
            }`}
            title={text}
          >
            {text.length > 140 ? `${text.slice(0, 140)}...` : text}
          </span>
        </div>
      );
    }
  }
}

// The Thread composer: steers the ACTIVE goal only. Reuses the ChatBar send
// logic via useChatSend; disabled (with a nudge to the Board) when closed.
function ThreadComposer({ goalId, open }: { goalId: string; open: boolean }) {
  const { send, busy, error } = useChatSend();
  const [text, setText] = useState("");

  const submit = async () => {
    if (!open) return;
    const ok = await send(text, { activeGoalId: goalId, hasOpenGoal: true });
    if (ok) setText("");
  };

  return (
    <div className="glass border-x-0 border-b-0 border-t border-slate-200 p-3">
      {error && <div className="mb-2 text-xs text-red-600">{error}</div>}
      <div className="flex gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={2}
          disabled={!open}
          placeholder={open
            ? "Steer this loop...  (Enter to send, Shift+Enter for newline)"
            : "This loop is closed - start a new goal from the Board tab."}
          className="flex-1 resize-none rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-orange-300 focus:ring-2 focus:ring-orange-100 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !open}
          className="rounded-2xl bg-orange-600 px-5 text-sm font-semibold text-white shadow-sm transition hover:bg-orange-700 disabled:opacity-50"
        >
          Steer
        </button>
      </div>
    </div>
  );
}
