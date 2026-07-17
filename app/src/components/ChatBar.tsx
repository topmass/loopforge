import { useState } from "react";
import { useStore } from "../store";
import { api } from "../api";
import type { Goal } from "../types";

// Where a composed message goes: a fresh goal-loop, or an explicit goal (addTask
// steers an open goal and resumes a closed one server-side). The caller picks
// the target, so nothing is chosen silently.
export type SendTarget =
  | { kind: "front" }
  | { kind: "new"; ask?: boolean }
  | { kind: "goal"; id: string };

// The shared send logic: dispatch on the caller's explicit target. Owns
// busy/error state and returns whether the send landed so the caller can clear
// its input. Reused by the global ChatBar and the Thread view composer.
export function useChatSend() {
  const setActiveGoal = useStore((s) => s.setActiveGoal);
  const setFrontBusy = useStore((s) => s.setFrontBusy);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (value: string, target: SendTarget): Promise<boolean> => {
    const trimmed = value.trim();
    if (!trimmed || busy) return false;
    setBusy(true);
    setError(null);
    try {
      if (target.kind === "front") {
        // The user message echoes back over SSE; the reply follows when the
        // front turn finishes. frontBusy drives the thinking indicator.
        setFrontBusy(true);
        await api.sendFrontMessage(trimmed);
      } else if (target.kind === "goal") {
        await api.addTask(target.id, trimmed);
      } else {
        // Focus the freshly created goal so its planning indicator shows even if
        // a closed goal was the previously active one.
        const { goalId } = await api.startGoalLoop(trimmed, {
          questionMode: target.ask,
        });
        setActiveGoal(goalId);
      }
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return { send, busy, error };
}

export function ChatBar({ goal }: { goal: Goal | null }) {
  const { send: sendMessage, busy, error } = useChatSend();
  const frontSelected = useStore((s) => s.frontSelected);
  const selectFront = useStore((s) => s.selectFront);
  const [text, setText] = useState("");
  const [ask, setAsk] = useState(false);
  // Default target follows the center view: the Main agent when the front
  // thread is shown, otherwise the selected loop; forceNew routes one draft
  // to a fresh loop instead. Reset back to the default after a send.
  const [forceNew, setForceNew] = useState(false);

  const targetFront = frontSelected && !forceNew;
  const targetNew = !targetFront && (!goal || forceNew);
  const goalOpen = goal?.status === "open";
  const target: SendTarget = targetFront
    ? { kind: "front" }
    : targetNew
    ? { kind: "new", ask }
    : { kind: "goal", id: goal!.id };

  const send = async () => {
    const ok = await sendMessage(text, target);
    if (ok) {
      setText("");
      setForceNew(false);
    }
  };

  return (
    <div className="glass border-x-0 border-b-0 border-t border-line p-3">
      {error && <div className="mb-2 text-xs text-danger">{error}</div>}
      {
        /* Explicit target: the main agent, a fresh loop, or steer/resume the
          selected loop. Nothing is chosen silently. */
      }
      <div className="mb-2 flex gap-1.5">
        <button
          type="button"
          onClick={() => {
            setForceNew(false);
            selectFront();
          }}
          className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
            targetFront
              ? "border-accent bg-accent-soft text-accent-ink"
              : "border-line bg-surface-overlay text-ink-muted"
          }`}
        >
          Main agent
        </button>
        <button
          type="button"
          onClick={() => setForceNew(true)}
          className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
            targetNew
              ? "border-accent bg-accent-soft text-accent-ink"
              : "border-line bg-surface-overlay text-ink-muted"
          }`}
        >
          New loop
        </button>
        {goal && (
          <button
            type="button"
            onClick={() => setForceNew(false)}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
              !targetNew
                ? "border-accent bg-accent-soft text-accent-ink"
                : "border-line bg-surface-overlay text-ink-muted"
            }`}
          >
            {goal.id} · {goalOpen ? "add task" : "resume"}
          </button>
        )}
      </div>
      <div className="flex gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter inserts a newline.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          placeholder={targetFront
            ? "Ask, plan, or delegate - the main agent answers from the live ledger...  (Enter to send)"
            : targetNew
            ? "Describe a goal to build...  (Enter to send, Shift+Enter for newline)"
            : goalOpen
            ? "Add a task / steer the active goal...  (Enter to send, Shift+Enter for newline)"
            : `Describe what to add - this resumes ${goal!.id}...`}
          className="flex-1 resize-none rounded-2xl border border-line bg-surface-overlay px-4 py-2.5 text-sm text-ink outline-none transition placeholder:text-ink-faint focus:border-accent focus:ring-2 focus:ring-accent-soft"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={busy}
          className="rounded-2xl bg-accent-strong px-5 text-sm font-semibold text-on-accent shadow-sm transition hover:opacity-90 disabled:opacity-50"
        >
          {targetFront ? "Send" : targetNew ? "Start" : goalOpen ? "Add" : "Resume"}
        </button>
      </div>
      {targetNew && (
        <label className="mt-2 flex w-fit cursor-pointer items-center gap-1.5 text-xs text-ink-muted">
          <input
            type="checkbox"
            checked={ask}
            onChange={(e) => setAsk(e.target.checked)}
            className="accent-accent"
          />
          Ask clarifying questions first (like Codex plan mode)
        </label>
      )}
    </div>
  );
}
