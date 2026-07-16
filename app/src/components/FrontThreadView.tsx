import { useEffect, useRef } from "react";
import { useStore } from "../store";
import type { FrontMessage } from "../types";

// The chief-of-staff conversation - the thread-first default center view.
// User messages right-aligned, front replies left, and receipts (loop
// outcomes, delegation confirmations) as compact system lines. Delegation
// receipts link straight to the new loop's scoped view.

// A receipt is a bracketed system line the server or runner wrote, not prose:
// "[GOAL-7 merged] ..." or "...\n\n[delegated to GOAL-7: ...]".
function isReceipt(message: FrontMessage): boolean {
  return message.role === "front" && message.message.startsWith("[");
}

function ReceiptLine({ text }: { text: string }) {
  const setActiveGoal = useStore((s) => s.setActiveGoal);
  const goalRef =
    text.match(/\[(?:delegated to |steer queued for )?(GOAL-\d+)/)?.[1] ?? null;
  return (
    <div className="flex justify-center px-4 py-1">
      <button
        type="button"
        disabled={!goalRef}
        onClick={() => goalRef && setActiveGoal(goalRef)}
        title={goalRef ? `Open ${goalRef}` : undefined}
        className={`max-w-[80%] truncate rounded-full border border-line bg-surface-sunken px-3 py-1 font-mono text-[11px] text-ink-muted ${
          goalRef
            ? "transition hover:border-accent hover:text-ink"
            : "cursor-default"
        }`}
      >
        {text}
      </button>
    </div>
  );
}

function Bubble({ message }: { message: FrontMessage }) {
  const user = message.role === "user";
  // A front reply may end with an action receipt on its own paragraph; split
  // it out so the receipt renders as a system line under the prose.
  const parts = message.message.split(/\n\n(?=\[)/);
  const prose = user ? message.message : parts[0];
  const trailing = user ? [] : parts.slice(1);
  return (
    <>
      {prose.trim() && (
        <div
          className={`flex px-4 py-1.5 ${
            user ? "justify-end" : "justify-start"
          }`}
        >
          <div
            className={`max-w-[76%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
              user
                ? "bg-accent-soft text-accent-ink"
                : "border border-line bg-surface-raised text-ink"
            }`}
          >
            {prose.trim()}
          </div>
        </div>
      )}
      {trailing.map((line, index) => (
        <ReceiptLine key={index} text={line.trim()} />
      ))}
    </>
  );
}

export function FrontThreadView() {
  const messages = useStore((s) => s.frontMessages);
  const busy = useStore((s) => s.frontBusy);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, busy]);

  if (messages.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
        <div className="text-base font-semibold text-ink">
          Talk to your project
        </div>
        <div className="max-w-md text-sm text-ink-muted">
          The main agent answers from the live project ledger, delegates real
          work to background loops, and reports back with proof. Loops and their
          boards live in the sidebar.
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto py-3">
      {messages.map((message) =>
        isReceipt(message)
          ? <ReceiptLine key={message.id} text={message.message} />
          : <Bubble key={message.id} message={message} />
      )}
      {busy && (
        <div className="flex px-4 py-1.5">
          <div className="rounded-2xl border border-line bg-surface-raised px-4 py-2.5">
            <span className="inline-flex gap-1">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-faint" />
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-faint [animation-delay:150ms]" />
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-faint [animation-delay:300ms]" />
            </span>
          </div>
        </div>
      )}
      <div ref={bottom} />
    </div>
  );
}
