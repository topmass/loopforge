import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useStore } from "../store";
import { api } from "../api";
import { useChatSend } from "./ChatBar";
import { spring } from "./ui";
import { LineMark } from "./marks";
import type { Goal, GoalThread, ThreadEntry } from "../types";

// The per-loop Thread view: a T3-style conversation of the ACTIVE goal's loop,
// turns oldest-first. Data comes from GET /api/goals/:id/thread on mount + goal
// change; live updates re-fetch on a 2s trailing debounce whenever a matching
// activity event lands in the store (we never splice events into turns client
// side). Agent prose renders as pre-wrap text - no markdown library this wave.

const AGENT_COLLAPSE = 1200;
const NEAR_BOTTOM_PX = 150;

// Four muted voice tints so parallel fan-out agents read as distinct voices;
// chosen by a hash of the agent title so a title always gets one tint. Used to
// fill each fan-out entry's square glyph mark.
const FANOUT_TINTS = [
  "bg-voice-1",
  "bg-voice-2",
  "bg-voice-3",
  "bg-voice-4",
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
    return "border-ok bg-ok-soft text-ok-ink";
  }
  if (["goal.blocked", "blocked", "hold"].includes(kind)) {
    return "border-warn bg-warn-soft text-warn-ink";
  }
  return "border-line bg-surface-sunken text-ink-muted";
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
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-ink-muted">
        <LineMark variant="thread" className="h-12 w-12 text-ink-faint" />
        <div className="text-lg">Select a loop from the sidebar.</div>
      </div>
    );
  }

  const turns = thread?.turns ?? [];
  const emptyThread = thread !== null && turns.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {thread?.truncated && (
        <div className="border-b border-line bg-surface-sunken px-4 py-1.5 text-center text-[11px] text-ink-faint">
          older turns trimmed
        </div>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-4 py-4">
          {error && <div className="mb-3 text-center text-xs text-danger">{error}</div>}
          {loading && !thread && (
            <div className="py-10 text-center text-sm text-ink-faint">Loading thread...</div>
          )}
          {emptyThread && (
            <div className="flex flex-col items-center gap-3 py-10 text-center text-sm text-ink-muted">
              <LineMark variant="thread" className="h-12 w-12 text-ink-faint" />
              No activity yet - the loop has not started.
            </div>
          )}
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
            {turns.map((turn) => (
              <div key={turn.index} className="flex flex-col gap-3">
                <TurnSeparator index={turn.index} startedAt={turn.startedAt} />
                {turn.entries.map((entry) => {
                  // Skip rows render nothing; excluding them here keeps the flex
                  // gap from opening a phantom slot for an empty motion wrapper.
                  if (classify(entry) === "skip") return null;
                  return (
                    <motion.div
                      key={entry.id}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={spring}
                    >
                      <EntryRow
                        entry={entry}
                        open={expanded.has(entry.id)}
                        onToggle={() => toggle(entry.id)}
                      />
                    </motion.div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
        <AnimatePresence>
          {!atBottom && turns.length > 0 && (
            <motion.button
              key="jump"
              type="button"
              onClick={jumpToLatest}
              initial={{ opacity: 0, y: 8, x: "-50%" }}
              animate={{ opacity: 1, y: 0, x: "-50%" }}
              exit={{ opacity: 0, y: 8, x: "-50%" }}
              transition={spring}
              className="absolute bottom-3 left-1/2 rounded-full border border-line bg-surface-raised/90 px-3 py-1 text-xs font-medium text-ink-muted shadow-sm backdrop-blur transition-colors hover:text-ink"
            >
              jump to latest
            </motion.button>
          )}
        </AnimatePresence>
      </div>
      <ThreadComposer goalId={goal.id} open={open} />
    </div>
  );
}

function TurnSeparator({ index, startedAt }: { index: number; startedAt: string | null }) {
  const when = relTime(startedAt);
  return (
    <div className="flex items-center gap-3 py-1 text-[11px] uppercase tracking-[0.18em] text-ink-faint">
      <span className="h-px flex-1 bg-line" />
      <span>
        {index === 0 ? "setup" : `turn ${index}`}
        {when && <span className="ml-2 lowercase tracking-normal text-ink-faint">{when}</span>}
      </span>
      <span className="h-px flex-1 bg-line" />
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
      // A hollow accent ring marks the human's steer, aligned to the first line.
      return (
        <div className="flex justify-end gap-2">
          <div className="max-w-[70%] whitespace-pre-wrap rounded-2xl bg-accent-soft px-4 py-2.5 text-sm text-accent-ink">
            {entry.text}
          </div>
          <span
            className="mt-2.5 h-2 w-2 shrink-0 rounded-full border border-accent"
            aria-hidden="true"
          />
        </div>
      );

    case "agent": {
      const long = entry.text.length > AGENT_COLLAPSE;
      const shown = long && !open ? entry.text.slice(0, AGENT_COLLAPSE) : entry.text;
      return (
        // A filled accent dot marks the owning agent's prose.
        <div className="flex justify-start gap-2">
          <span
            className="mt-3 h-2 w-2 shrink-0 rounded-full bg-accent"
            aria-hidden="true"
          />
          <div className="max-w-[85%] rounded-2xl border border-line bg-surface-raised px-4 py-3 text-sm leading-relaxed text-ink shadow-sm">
            <div className="whitespace-pre-wrap">{shown}{long && !open ? "..." : ""}</div>
            {long && (
              <button
                type="button"
                onClick={onToggle}
                className="mt-2 text-xs font-medium text-accent hover:text-accent-ink"
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
          <span className="mt-0.5 shrink-0 text-ink-faint">{"\u{1F527}"}</span>
          <span
            className={`min-w-0 flex-1 font-mono text-xs text-ink-muted ${
              open ? "whitespace-pre-wrap" : "truncate"
            }`}
          >
            {entry.text}
          </span>
        </button>
      );

    case "task":
      return (
        <div className="flex items-start gap-2 text-xs text-ink-muted">
          <span className="mt-px shrink-0">{"☐"}</span>
          <span className="min-w-0 flex-1 truncate">{stripGoalPrefix(entry.text)}</span>
        </div>
      );

    case "fanout": {
      const title = entry.role.slice("fanout:".length);
      const tint = FANOUT_TINTS[hashIndex(title, FANOUT_TINTS.length)];
      return (
        // A small square in the agent's voice tint marks a fan-out voice.
        <button
          type="button"
          onClick={onToggle}
          className="flex w-full items-start gap-2 text-left"
        >
          <span className={`mt-1 h-2 w-2 shrink-0 ${tint}`} aria-hidden="true" />
          <span className="flex min-w-0 flex-1 flex-col items-start">
            <span className="w-full truncate text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
              {title}
            </span>
            <span
              className={`w-full text-xs text-ink-muted ${open ? "whitespace-pre-wrap" : "truncate"}`}
            >
              {entry.text}
            </span>
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
    <div className="glass border-x-0 border-b-0 border-t border-line p-3">
      {error && <div className="mb-2 text-xs text-danger">{error}</div>}
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
          className="flex-1 resize-none rounded-2xl border border-line bg-surface-overlay px-4 py-2.5 text-sm text-ink outline-none transition placeholder:text-ink-faint focus:border-accent focus:ring-2 focus:ring-accent-soft disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-ink-faint"
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !open}
          className="rounded-2xl bg-accent-strong px-5 text-sm font-semibold text-on-accent shadow-sm transition hover:opacity-90 disabled:opacity-50"
        >
          Steer
        </button>
      </div>
    </div>
  );
}
