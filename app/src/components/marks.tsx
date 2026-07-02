// One inline line-mark per empty state - a quiet ~48px SVG stroked in
// currentColor (callers set text-ink-faint and the box size via className). No
// icon library, no asset files: just four hand-drawn variants.
export function LineMark(
  { variant, className }: {
    variant: "board" | "thread" | "diff" | "loops";
    className?: string;
  },
) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {variant === "board" && (
        <>
          {/* a hub with three branch nodes - the loop's fan-out */}
          <circle cx="24" cy="24" r="4" />
          <path d="M24 20V9" />
          <circle cx="24" cy="7" r="2" />
          <path d="M27.2 26.8 34.6 34.2" />
          <circle cx="36.5" cy="36" r="2" />
          <path d="M20.8 26.8 13.4 34.2" />
          <circle cx="11.5" cy="36" r="2" />
        </>
      )}
      {variant === "thread" && (
        // a chat outline with a tail
        <path d="M40 29a3 3 0 0 1-3 3H22l-8 6v-6h-3a3 3 0 0 1-3-3V15a3 3 0 0 1 3-3h26a3 3 0 0 1 3 3z" />
      )}
      {variant === "diff" && (
        <>
          {/* two files side by side - a split view */}
          <rect x="9" y="8" width="13" height="32" rx="2" />
          <rect x="26" y="8" width="13" height="32" rx="2" />
          <path d="M12.5 16h6M12.5 22h6M29.5 16h6M29.5 28h6" />
        </>
      )}
      {variant === "loops" && (
        <>
          {/* a small orbit */}
          <ellipse cx="24" cy="24" rx="16" ry="8" />
          <circle cx="24" cy="24" r="3" />
          <circle cx="40" cy="24" r="2" />
        </>
      )}
    </svg>
  );
}
