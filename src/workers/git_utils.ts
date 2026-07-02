import path from "node:path";
import { Task } from "../board/types.ts";
import { worktreesPath } from "../paths.ts";

export interface WorktreeAssignment {
  branchName: string;
  worktreePath: string;
  created: boolean;
}

export async function prepareGoalWorktree(
  root: string,
  goalId: string,
  configuredWorktreesDir = worktreesPath(root),
): Promise<WorktreeAssignment> {
  return await prepareTaskWorktree(root, { id: goalId } as Task, configuredWorktreesDir);
}

// A fan-out sub-worktree branches off the goal's loop branch (not the repo
// HEAD), so the sub-agent starts from the loop's in-progress state and its
// branch merges cleanly back into the loop branch.
export async function prepareFanoutWorktree(
  root: string,
  baseBranch: string,
  subId: string,
  configuredWorktreesDir = worktreesPath(root),
): Promise<WorktreeAssignment> {
  const branchName = `loopforge/fanout-${subId.toLowerCase()}`;
  const worktreeRoot = path.isAbsolute(configuredWorktreesDir)
    ? configuredWorktreesDir
    : path.join(root, configuredWorktreesDir);
  const worktreePath = path.join(worktreeRoot, `fanout-${subId}`);
  await Deno.mkdir(worktreeRoot, { recursive: true });
  await runCommand(root, ["git", "worktree", "prune"]);
  await runCommand(root, [
    "git",
    "worktree",
    "add",
    "--force",
    "-B",
    branchName,
    worktreePath,
    baseBranch,
  ]);
  await ensureWorktreeExcludes(worktreePath);
  return { branchName, worktreePath, created: true };
}

export async function prepareTaskWorktree(
  root: string,
  task: Task,
  configuredWorktreesDir = worktreesPath(root),
): Promise<WorktreeAssignment> {
  const branchName = `loopforge/${task.id.toLowerCase()}`;
  const worktreeRoot = path.isAbsolute(configuredWorktreesDir)
    ? configuredWorktreesDir
    : path.join(root, configuredWorktreesDir);
  const worktreePath = path.join(worktreeRoot, task.id);

  if (!await isGitRepo(root)) {
    throw new Error("LoopForge workers require a git repository. Run loopforge init first.");
  }

  try {
    await Deno.stat(path.join(worktreePath, ".git"));
    await ensureWorktreeExcludes(worktreePath);
    return { branchName, worktreePath, created: false };
  } catch {
    await Deno.mkdir(worktreeRoot, { recursive: true });
    await runCommand(root, ["git", "worktree", "prune"]);
    await runCommand(root, [
      "git",
      "worktree",
      "add",
      "--force",
      "-B",
      branchName,
      worktreePath,
      "HEAD",
    ]);
    await ensureWorktreeExcludes(worktreePath);
    return { branchName, worktreePath, created: true };
  }
}

// Best-effort teardown after a task's branch has merged into root: remove the
// worktree and delete its loopforge/<task> branch so long unattended runs do
// not accumulate worktrees and branches without bound. Never throws - cleanup
// failure must not fail an already-completed merge.
export async function removeTaskWorktree(
  root: string,
  worktreePath: string,
  branchName: string,
): Promise<void> {
  try {
    await runCommand(root, ["git", "worktree", "remove", "--force", worktreePath]);
  } catch {
    // The worktree may already be gone; prune clears any stale metadata next.
  }
  try {
    await runCommand(root, ["git", "worktree", "prune"]);
  } catch {
    // Best effort.
  }
  try {
    await runCommand(root, ["git", "branch", "-D", branchName]);
  } catch {
    // The branch may not exist (PR path) or may already be deleted.
  }
}

export async function gitStatus(cwd: string): Promise<string> {
  return await runCommand(cwd, ["git", "status", "--short"]);
}

export async function gitDiffStat(cwd: string): Promise<string> {
  return await runCommand(cwd, ["git", "diff", "--stat"]);
}

export async function gitChangedFiles(cwd: string): Promise<string[]> {
  const output = await runCommand(cwd, ["git", "status", "--short"]);
  return output.split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .map((file) => file.includes(" -> ") ? file.split(" -> ").at(-1) ?? file : file);
}

export async function gitCommitAll(cwd: string, message: string): Promise<string | null> {
  if (!await isGitRepo(cwd)) {
    return null;
  }

  const nestedCommits = await gitCommitNestedRepos(cwd, message);
  const status = await gitStatus(cwd);
  if (!status.trim()) {
    return nestedCommits.length ? nestedCommits.join(", ") : null;
  }

  await ensureWorktreeExcludes(cwd);
  await runCommand(cwd, ["git", "add", "-A"]);
  await runCommand(cwd, [
    "git",
    "-c",
    "user.email=loopforge@local",
    "-c",
    "user.name=LoopForge",
    "commit",
    "-m",
    message,
  ]);
  const commit = (await runCommand(cwd, ["git", "rev-parse", "--short", "HEAD"])).trim();
  return nestedCommits.length ? [...nestedCommits, `.:${commit}`].join(", ") : commit;
}

async function gitCommitNestedRepos(cwd: string, message: string): Promise<string[]> {
  const nestedRepos = await dirtyNestedRepos(cwd);
  const commits: string[] = [];
  for (const repo of nestedRepos) {
    await ensureWorktreeExcludes(repo);
    await runCommand(repo, ["git", "add", "-A"]);
    await runCommand(repo, [
      "git",
      "-c",
      "user.email=loopforge@local",
      "-c",
      "user.name=LoopForge",
      "commit",
      "-m",
      message,
    ]);
    const relative = path.relative(cwd, repo) || ".";
    const hash = (await runCommand(repo, ["git", "rev-parse", "--short", "HEAD"])).trim();
    commits.push(`${relative}:${hash}`);
  }
  return commits;
}

async function dirtyNestedRepos(cwd: string): Promise<string[]> {
  const root = await gitTopLevel(cwd);
  const status = await gitStatus(cwd);
  const repos = new Set<string>();
  for (const line of status.split(/\r?\n/)) {
    const changedPath = statusPath(line);
    if (!changedPath) {
      continue;
    }
    const nested = await findNestedRepoForPath(root, changedPath);
    if (nested && nested !== root && (await gitStatus(nested)).trim()) {
      repos.add(nested);
    }
  }
  return [...repos].sort();
}

async function gitTopLevel(cwd: string): Promise<string> {
  return (await runCommand(cwd, ["git", "rev-parse", "--show-toplevel"])).trim();
}

function statusPath(line: string): string | null {
  if (line.length < 4) {
    return null;
  }
  const text = line.slice(3).trim();
  if (!text) {
    return null;
  }
  return text.includes(" -> ") ? text.split(" -> ").at(-1) ?? text : text;
}

async function findNestedRepoForPath(root: string, changedPath: string): Promise<string | null> {
  let current = path.join(root, changedPath);
  try {
    const stat = await Deno.stat(current);
    if (stat.isFile) {
      current = path.dirname(current);
    }
  } catch {
    current = path.dirname(current);
  }
  while (current.startsWith(root) && current !== root) {
    if (await pathExists(path.join(current, ".git"))) {
      return current;
    }
    current = path.dirname(current);
  }
  return null;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await Deno.stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function ensureWorktreeExcludes(cwd: string): Promise<void> {
  // Git reads excludes from the COMMON dir's info/exclude, shared by the root
  // checkout and every linked worktree - the per-worktree git dir
  // (--absolute-git-dir) has an info/exclude git never consults, which is where
  // these entries silently went for worktrees before.
  const gitDir = (await runCommand(cwd, [
    "git",
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ])).trim();
  const excludePath = path.join(gitDir, "info", "exclude");
  const current = await Deno.readTextFile(excludePath).catch(() => "");
  // LOOP_PLAN.md is per-goal working memory that lives on disk in the goal's
  // worktree; committing it made each goal's finished plan merge into main and
  // seed the NEXT goal's board with stale done items.
  const additions = [".omx/", ".loopforge/", "LOOP_PLAN.md"].filter((entry) =>
    !current.split(/\r?\n/).includes(entry)
  );
  if (!additions.length) {
    return;
  }
  await Deno.mkdir(path.join(gitDir, "info"), { recursive: true }).catch(() => {});
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  await Deno.writeTextFile(excludePath, `${current}${prefix}${additions.join("\n")}\n`);
}

export interface PublishResult {
  branch: string;
  remote: string;
  commit: string;
  committed: boolean;
  pushOutput: string;
  ahead: number;
  behind: number;
  status: string;
}

export async function gitPublishRoot(
  root: string,
  message: string,
  remote = "origin",
): Promise<PublishResult> {
  if (!await isGitRepo(root)) {
    throw new Error("LoopForge publish requires a git repository. Run loopforge init first.");
  }
  const remotes = (await runCommand(root, ["git", "remote"])).split(/\r?\n/).map((line) =>
    line.trim()
  );
  if (!remotes.includes(remote)) {
    throw new Error(
      `No '${remote}' remote is configured. Add one with: git remote add ${remote} <url>`,
    );
  }
  const branch = (await runCommand(root, ["git", "rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (!branch || branch === "HEAD") {
    throw new Error("LoopForge publish requires a checked-out branch, not a detached HEAD.");
  }
  const dirtyBefore = Boolean((await gitStatus(root)).trim());
  const commitResult = await gitCommitAll(root, message);
  if (dirtyBefore && commitResult === null) {
    throw new Error("LoopForge publish could not commit the dirty working tree.");
  }
  try {
    await runCommand(root, ["git", "fetch", remote, branch]);
  } catch {
    // The remote branch may not exist yet; the push below creates it.
  }
  const behindRemote = await remoteOnlyCommitCount(root, remote, branch);
  if (behindRemote > 0) {
    throw new Error(
      `${remote}/${branch} has ${behindRemote} commit(s) that are not in the local branch. ` +
        `Local work is committed and safe; pull or rebase onto ${remote}/${branch} (or decide to force-push), then restart the publish.`,
    );
  }
  const pushOutput = await gitPush(root, remote, branch);
  const counts = (await runCommand(root, [
    "git",
    "rev-list",
    "--left-right",
    "--count",
    `${remote}/${branch}...HEAD`,
  ])).trim().split(/\s+/).map(Number);
  const commit = (await runCommand(root, ["git", "rev-parse", "--short", "HEAD"])).trim();
  return {
    branch,
    remote,
    commit,
    committed: dirtyBefore,
    pushOutput,
    behind: counts[0] ?? 0,
    ahead: counts[1] ?? 0,
    status: (await gitStatus(root)).trim(),
  };
}

async function remoteOnlyCommitCount(
  root: string,
  remote: string,
  branch: string,
): Promise<number> {
  try {
    const counts = (await runCommand(root, [
      "git",
      "rev-list",
      "--left-right",
      "--count",
      `${remote}/${branch}...HEAD`,
    ])).trim().split(/\s+/).map(Number);
    return counts[0] ?? 0;
  } catch {
    return 0;
  }
}

async function gitPush(cwd: string, remote: string, branch: string): Promise<string> {
  const child = new Deno.Command("git", {
    args: ["push", "-u", remote, branch],
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await child.output();
  const stdout = new TextDecoder().decode(output.stdout).trim();
  const stderr = new TextDecoder().decode(output.stderr).trim();
  if (!output.success) {
    throw new Error(`git push ${remote} ${branch} failed: ${stderr || stdout}`);
  }
  return [stdout, stderr].filter(Boolean).join("\n");
}

export async function gitMergeBranch(root: string, branchName: string): Promise<string> {
  return await runCommand(root, [
    "git",
    "-c",
    "user.email=loopforge@local",
    "-c",
    "user.name=LoopForge",
    "merge",
    "--no-ff",
    branchName,
    "-m",
    `Merge ${branchName}`,
  ]);
}

// Structural subset of BoardStore that a merge lease needs - lets both the
// dispatcher worker and the goal loop serialize merges into a shared root
// across separate LoopForge processes without importing the whole store.
export interface LeaseStore {
  acquireLease(key: string, holder: string): boolean;
  releaseLease(key: string, holder: string): void;
}

// Serialize `git merge` into `root` across separate LoopForge processes that
// share it, so two workers never merge into the same repo at once.
// ponytail: 60s lease stale-ceiling, not heartbeated during the merge - a merge
// that runs >60s could be stolen mid-flight. Heartbeat the lease during the hold
// if merges ever get that slow.
export async function gitMergeBranchLeased(
  store: LeaseStore,
  root: string,
  branchName: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<string> {
  const key = `merge:${root}`;
  const holder = `merge-${Deno.pid}-${crypto.randomUUID()}`;
  const deadlineAt = Date.now() + (opts.timeoutMs ?? 60_000);
  while (!store.acquireLease(key, holder)) {
    if (Date.now() >= deadlineAt) {
      throw new Error(`Timed out waiting for the ${key} lease.`);
    }
    await new Promise((resolve) => setTimeout(resolve, opts.pollMs ?? 150));
  }
  try {
    return await gitMergeBranch(root, branchName);
  } finally {
    store.releaseLease(key, holder);
  }
}

export async function ensureGitRepository(root: string): Promise<string[]> {
  const actions: string[] = [];
  // The project must be its OWN git repo root. If it merely sits INSIDE a larger
  // repo (e.g. an accidental `git init` in $HOME), adopting that parent would
  // make `git add -A` stage the entire parent tree - gigabytes, and a hang.
  // So init a LOCAL repo right in this directory instead.
  if (!await isOwnRepoRoot(root)) {
    await runCommand(root, ["git", "init", "-b", "main"]);
    actions.push("Initialized a local git repository for this project.");
  }

  if (!await hasHeadCommit(root)) {
    // Keep the baseline fast and clean: never stage heavy build/dependency dirs.
    await writeBaselineExcludes(root);
    await runCommand(root, ["git", "add", "-A"]);
    await runCommand(root, [
      "git",
      "-c",
      "user.email=loopforge@local",
      "-c",
      "user.name=LoopForge",
      "commit",
      "--allow-empty",
      "-m",
      "LoopForge baseline",
    ]);
    actions.push("Created baseline commit.");
  }

  return actions;
}

// True only when `root` is itself the top level of a git repo - not when it is
// a subdirectory of a parent repo, and not when it is outside any repo.
async function isOwnRepoRoot(root: string): Promise<boolean> {
  try {
    const top = (await runCommand(root, ["git", "rev-parse", "--show-toplevel"])).trim();
    return top !== "" && path.resolve(top) === path.resolve(root);
  } catch {
    return false;
  }
}

// Common heavy/noise dirs go into .git/info/exclude so the one-time baseline
// commit does not walk node_modules, build output, virtualenvs, etc.
async function writeBaselineExcludes(root: string): Promise<void> {
  const heavy = [
    "/.loopforge/",
    "/.omx/",
    "node_modules/",
    "dist/",
    "build/",
    "target/",
    ".next/",
    ".venv/",
    "venv/",
    "__pycache__/",
    ".cache/",
    "*.log",
  ];
  try {
    // --absolute-git-dir so the exclude path is correct regardless of the
    // Deno process cwd (relative git-path would resolve against the wrong dir).
    const gitDir = (await runCommand(root, ["git", "rev-parse", "--absolute-git-dir"])).trim();
    const excludePath = path.join(gitDir, "info", "exclude");
    const current = await Deno.readTextFile(excludePath).catch(() => "");
    const additions = heavy.filter((entry) => !current.split(/\r?\n/).includes(entry));
    if (additions.length) {
      await Deno.mkdir(path.join(gitDir, "info"), { recursive: true }).catch(() => {});
      const prefix = current && !current.endsWith("\n") ? "\n" : "";
      await Deno.writeTextFile(excludePath, `${current}${prefix}${additions.join("\n")}\n`);
    }
  } catch {
    // Excludes are best effort; the baseline still works without them.
  }
}

// True if the repo has an 'origin' remote to push to.
export async function hasRemote(cwd: string): Promise<boolean> {
  try {
    const out = (await runCommand(cwd, ["git", "remote", "get-url", "origin"])).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

// Push a branch to origin (best effort). Returns whether it was pushed.
export async function gitPushBranch(cwd: string, branch: string): Promise<boolean> {
  if (!await hasRemote(cwd)) {
    return false;
  }
  try {
    await runCommand(cwd, ["git", "push", "-u", "origin", branch]);
    return true;
  } catch {
    return false;
  }
}

export async function isGitRepo(root: string): Promise<boolean> {
  try {
    await runCommand(root, ["git", "rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

async function hasHeadCommit(root: string): Promise<boolean> {
  try {
    await runCommand(root, ["git", "rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

export async function runCommand(cwd: string, args: string[]): Promise<string> {
  const [command, ...rest] = args;
  const child = new Deno.Command(command, {
    args: rest,
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await child.output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);
  if (!output.success) {
    throw new Error(`${args.join(" ")} failed: ${stderr.trim() || stdout.trim()}`);
  }
  return stdout;
}
