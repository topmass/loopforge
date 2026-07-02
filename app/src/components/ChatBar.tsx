import { useState } from "react";
import { useStore } from "../store";
import { api } from "../api";

export function ChatBar({ activeGoalId, hasOpenGoal }: { activeGoalId: string | null; hasOpenGoal: boolean }) {
  const setActiveGoal = useStore((s) => s.setActiveGoal);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState(false);

  const send = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (activeGoalId && hasOpenGoal) {
        await api.addTask(activeGoalId, value);
      } else {
        // Focus the freshly created goal so its planning indicator shows even if
        // a closed goal was the previously active one.
        const { goalId } = await api.startGoalLoop(value, { questionMode: ask });
        setActiveGoal(goalId);
      }
      setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="glass border-x-0 border-b-0 border-t border-slate-200 p-3">
      {error && <div className="mb-2 text-xs text-red-600">{error}</div>}
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
          className="flex-1 resize-none rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={busy}
          className="rounded-2xl bg-orange-600 px-5 text-sm font-semibold text-white shadow-sm transition hover:bg-orange-700 disabled:opacity-50"
        >
          {hasOpenGoal ? "Add" : "Start"}
        </button>
      </div>
      {!hasOpenGoal && (
        <label className="mt-2 flex w-fit cursor-pointer items-center gap-1.5 text-xs text-slate-500">
          <input
            type="checkbox"
            checked={ask}
            onChange={(e) => setAsk(e.target.checked)}
            className="accent-orange-500"
          />
          Ask clarifying questions first (like Codex plan mode)
        </label>
      )}
    </div>
  );
}
