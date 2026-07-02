import path from "node:path";

// Per-worktree files that let a model track its goal-loop plan through the CLI
// with zero PATH or env assumptions. Wave 2 calls this from the goal loop after
// preparing the worktree.
//
// 1. .loopforge-goal.json - a pointer the `loopforge task` CLI walks up to find,
//    so `./lf-task <verb>` needs no --root/--goal flags from inside the worktree.
// 2. lf-task - an executable bash shim that runs THIS Deno/binary against the
//    project's src/cli.ts (or compiled binary) with the target already wired in.
export async function writeTaskWorkspace(
  root: string,
  goalId: string,
  worktreePath: string,
): Promise<void> {
  const absoluteRoot = path.resolve(root);
  await Deno.writeTextFile(
    path.join(worktreePath, ".loopforge-goal.json"),
    `${JSON.stringify({ root: absoluteRoot, goalId }, null, 2)}\n`,
  );

  const execPath = Deno.execPath();
  // A `deno` execPath means we run the source CLI; a compiled LoopForge binary
  // ships the `task` subcommand itself and takes no `run <script>` prelude.
  const cliPath = new URL("../cli.ts", import.meta.url).pathname;
  const execLine = path.basename(execPath).startsWith("deno")
    ? `exec "${execPath}" run -A "${cliPath}" task --root "${absoluteRoot}" --goal "${goalId}" "$@"`
    : `exec "${execPath}" task --root "${absoluteRoot}" --goal "${goalId}" "$@"`;
  const shimPath = path.join(worktreePath, "lf-task");
  await Deno.writeTextFile(shimPath, `#!/usr/bin/env bash\n${execLine}\n`);
  await Deno.chmod(shimPath, 0o755);
}
