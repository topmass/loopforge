import { LOOP_FANOUT_TOKEN } from "./fanout.ts";
// The goal-loop plan contract: the loop owner tracks its plan as DB-backed
// items through the per-worktree ./lf-task CLI, so every mutation lands on the
// board (and its plan.updated feed) the moment it happens. parseLoopPlan stays
// for reading legacy LOOP_PLAN.md checklists still found in older repos.

export const LOOP_PLAN_FILE = "LOOP_PLAN.md";
export const LOOP_COMPLETE_TOKEN = "LOOP_COMPLETE";
export const LOOP_BLOCKED_TOKEN = "LOOP_BLOCKED";

export type LoopPlanStatus = "todo" | "doing" | "done";

export interface LoopPlanItem {
  title: string;
  status: LoopPlanStatus;
  note: string;
}

// Lines like:
//   - [ ] Add the config gate -- needs ConfigEntry wiring
//   - [~] Patch the rebuy handler
//   - [x] Fix soil planting -- proven by `dotnet build` + grep
export function parseLoopPlan(markdown: string): LoopPlanItem[] {
  const items: LoopPlanItem[] = [];
  for (const rawLine of markdown.split(/\r?\n/)) {
    const match = rawLine.match(/^\s*[-*]\s*\[([ xX~])\]\s+(.*)$/);
    if (!match) {
      continue;
    }
    const status: LoopPlanStatus = match[1] === "~" ? "doing" : match[1] === " " ? "todo" : "done";
    const body = match[2].trim();
    const separator = body.indexOf(" -- ");
    const title = (separator >= 0 ? body.slice(0, separator) : body).trim();
    const note = separator >= 0 ? body.slice(separator + 4).trim() : "";
    if (title) {
      items.push({ title, status, note });
    }
  }
  return items;
}

export function loopPlanComplete(items: LoopPlanItem[]): boolean {
  return items.length > 0 && items.every((item) => item.status === "done");
}

// Plan text + worktree commit make a cheap stall fingerprint: if neither moved
// across iterations, the loop is spinning.
export function loopPlanFingerprint(items: LoopPlanItem[], headCommit: string): string {
  return `${headCommit}:${items.map((item) => `${item.status}|${item.title}`).join(";")}`;
}

export function extractBlockedAsk(responseText: string): string | null {
  const match = responseText.match(/^LOOP_BLOCKED:?\s*(.+)$/m);
  return match ? match[1].trim() : null;
}

export function signalsComplete(responseText: string): boolean {
  return new RegExp(`^${LOOP_COMPLETE_TOKEN}\\b`, "m").test(responseText.trim());
}

export function loopPlanContract(
  maxParallel = 5,
  opts: { worktrees?: boolean } = {},
): string {
  const worktrees = opts.worktrees ?? true;
  // Without isolated worktrees there is no LoopForge-owned git and no safe
  // parallelism, so the commit and fan-out clauses flip to their serial forms.
  const gitClause = worktrees
    ? "- Do not create commits; LoopForge commits the worktree after every turn."
    : "- You are working directly in the user's project folder on their current branch. Do not\n" +
      "  create commits or branches unless the goal explicitly asks for them; the user owns git here.";
  const fanoutClause = worktrees
    ? `- DEFAULT TO FAN-OUT. As soon as your plan has 2+ items that touch DIFFERENT files or areas
  (disjoint write scopes, no shared files), your FIRST action is to delegate them to parallel
  sub-agents - do NOT build independent pieces yourself one item per turn. Building things that
  could run in parallel inline is the wrong default and wastes the loop. Spin up one sub-agent per
  independent piece, up to ${maxParallel} at once, by ending your reply with:
  ${LOOP_FANOUT_TOKEN}
  {"subtasks":[{"title":"...","instruction":"...","writeScope":["src/api/**"]}, ...]}
  Give each sub-agent a precise instruction and an exclusive writeScope. LoopForge runs them in
  parallel in isolated worktrees, enforces the scopes, merges the results back, and reports a
  summary on your next turn. Keep work inline ONLY when the remaining pieces genuinely share the
  same files (a true conflict) or there is just one piece left.`
    : "- Work the items yourself, serially. Parallel fan-out is unavailable for this project\n" +
      "  (isolated worktrees are disabled).";
  return `Plan contract:
- Track ALL work with the ./lf-task CLI at the worktree root:
  ./lf-task list | ./lf-task add "title" [--spec "one-line what/why/acceptance"] |
  ./lf-task start <id> | ./lf-task done <id> --evidence "proof" | ./lf-task note <id> "text".
- If no tasks exist yet, plan this goal into 3-10 concrete items with ./lf-task add, each
  completable in one focused working session.
- BEFORE you start building in a turn: make sure every remaining piece of work already exists as a
  task, and ./lf-task start the ONE item you begin. The user watches this live as a Kanban board -
  it must always show truthfully what is queued, what you are doing right now, and what is done.
- Work ONE item per turn (finish a small one and start the next if time allows). Run real
  commands to verify your work; done requires proof: ./lf-task done <id> --evidence "proof".
- Never batch-mark items done at the end of a turn - mark each item done the moment its
  evidence exists.
- Record decisions, discoveries, and anything the next iteration must know with ./lf-task note.
  This plus the repo is your memory - ./lf-task list restores your state after any interruption.
${gitClause}
${fanoutClause}
- When every item is done and you believe the win conditions pass, end your reply with the
  single line ${LOOP_COMPLETE_TOKEN}.
- Only when truly blocked by an absolute blocker (credentials, third-party access, destructive
  approval, or a scope-changing product decision), end with:
  ${LOOP_BLOCKED_TOKEN}: <one prepared sentence: the exact decision or item you need>`;
}
