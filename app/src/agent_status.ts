// View helper for the live "Active workers" strip: maps a worker's risk to a
// small colored badge.
import type { AgentRisk } from "./types";

const RISK_TONES: Record<Exclude<AgentRisk, "none">, { label: string; className: string }> = {
  test_failed: { label: "tests failed", className: "border-red-300 bg-red-50 text-red-700" },
  conflict: { label: "conflict", className: "border-amber-300 bg-amber-50 text-amber-700" },
  needs_user: { label: "needs you", className: "border-orange-300 bg-orange-50 text-orange-700" },
  stale: { label: "stale", className: "border-slate-300 bg-slate-50 text-slate-600" },
  session: { label: "session", className: "border-slate-300 bg-slate-50 text-slate-600" },
};

// A risk badge for the strip, or null when there is nothing notable to flag.
export function riskTone(risk: AgentRisk): { label: string; className: string } | null {
  return risk === "none" ? null : RISK_TONES[risk];
}
