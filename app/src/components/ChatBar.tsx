import { useState } from "react";
import { useStore } from "../store";
import { api } from "../api";

// The shared send logic: steer the active OPEN goal (addTask), or start a fresh
// goal-loop when none is active. Owns busy/error state and returns whether the
// send landed so the caller can clear its input. Reused by the global ChatBar
// and the Thread view composer instead of duplicating the branch.
export function useChatSend() {
  const setActiveGoal = useStore((s) => s.setActiveGoal);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (
    value: string,
    opts: { activeGoalId: string | null; hasOpenGoal: boolean; ask?: boolean },
  ): Promise<boolean> => {
    const trimmed = value.trim();
    if (!trimmed || busy) return false;
    setBusy(true);
    setError(null);
    try {
      if (opts.activeGoalId && opts.hasOpenGoal) {
        await api.addTask(opts.activeGoalId, trimmed);
      } else {
        // Focus the freshly created goal so its planning indicator shows even if
        // a closed goal was the previously active one.
        const { goalId } = await api.startGoalLoop(trimmed, { questionMode: opts.ask });
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

export function ChatBar({ activeGoalId, hasOpenGoal }: { activeGoalId: string | null; hasOpenGoal: boolean }) {
  const { send: sendMessage, busy, error } = useChatSend();
  const [text, setText] = useState("");
  const [ask, setAsk] = useState(false);

  const send = async () => {
    const ok = await sendMessage(text, { activeGoalId, hasOpenGoal, ask });
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
            // Enter sends; Shift+Enter inserts a newline.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          placeholder={hasOpenGoal
            ? "Add a task / steer the active goal...  (Enter to send, Shift+Enter for newline)"
            : "Describe a goal to build...  (Enter to send, Shift+Enter for newline)"}
          className="flex-1 resize-none rounded-2xl border border-line bg-surface-overlay px-4 py-2.5 text-sm text-ink outline-none transition placeholder:text-ink-faint focus:border-accent focus:ring-2 focus:ring-accent-soft"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={busy}
          className="rounded-2xl bg-accent-strong px-5 text-sm font-semibold text-on-accent shadow-sm transition hover:opacity-90 disabled:opacity-50"
        >
          {hasOpenGoal ? "Add" : "Start"}
        </button>
      </div>
      {!hasOpenGoal && (
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
