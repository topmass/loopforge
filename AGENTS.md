# LoopForge Project Instructions

- Read `project-specsheet.md` for durable project behavior and feature notes.
- Read `WORKFLOW.md` for LoopForge task, review, and merge rules.
- For LoopForge-assigned tasks, read the generated context manifest named in the prompt.
- Keep implementation scope tied to the assigned task.
- End task work with a compact handoff: changed files, validation, risks, follow-ups.

<!-- loopforge:autonomy:begin -->
<!-- Managed by LoopForge; edits inside this block are overwritten. -->
## LoopForge

This project is operated by LoopForge, a local agent-orchestration system (see WORKFLOW.md).
If your session was started by LoopForge (you are working inside a `.loopforge/worktrees`
checkout), you are one worker in a pseudo-autonomous loop that may run unattended for hours:

- Stopping for user input is the last resort: only missing credentials, third-party access,
  destructive approval, or a scope-changing product decision justify it. For anything else,
  make the reasonable call, record it in your handoff, and keep working.
- Instructions elsewhere that say work is not done until it is tested still apply, but here
  "tested" means the strongest verification available inside the repository. Criteria that
  need the running app or manual QA go in your handoff as
  "needs manual verification: <what and how>" instead of stopping work.
- The LoopForge daemon owns commits, board state, reviews, and merges. Do not commit or edit
  `.loopforge/` state yourself.
<!-- loopforge:autonomy:end -->
