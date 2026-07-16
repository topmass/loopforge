import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import path from "node:path";
import { BoardStore } from "../src/board/store.ts";
import {
  gitCommitAll,
  gitDiffRange,
  gitMergeBranchLeased,
  gitMergeCommitFor,
  gitPublishRoot,
  LeaseStore,
  prepareTaskWorktree,
  removeTaskWorktree,
} from "../src/workers/git_utils.ts";
import { writeTaskWorkspace } from "../src/workers/task_workspace.ts";

// Records the acquire/release sequence so tests can prove the lease brackets the
// merge; acquireLease always grants so the happy/conflict paths reach the merge.
class RecordingLeaseStore implements LeaseStore {
  readonly calls: string[] = [];
  acquireLease(_key: string, _holder: string): boolean {
    this.calls.push("acquire");
    return true;
  }
  releaseLease(_key: string, _holder: string): void {
    this.calls.push("release");
  }
}

// Never grants the lease, so the helper spins until it times out.
class BlockedLeaseStore implements LeaseStore {
  released = false;
  acquireLease(_key: string, _holder: string): boolean {
    return false;
  }
  releaseLease(_key: string, _holder: string): void {
    this.released = true;
  }
}

Deno.test("worktree commits exclude agent runtime folders", async () => {
  const root = Deno.makeTempDirSync();
  try {
    await git(root, ["init", "-b", "main"]);
    await git(root, ["commit", "--allow-empty", "-m", "seed"]);
    const store = new BoardStore(root);
    store.initProject();
    const { task } = store.createGoal("Exclude runtime logs");
    const assignment = await prepareTaskWorktree(root, task);
    await Deno.mkdir(`${assignment.worktreePath}/.omx/logs`, { recursive: true });
    await Deno.writeTextFile(`${assignment.worktreePath}/.omx/logs/turn.jsonl`, "{}\n");
    await Deno.writeTextFile(`${assignment.worktreePath}/result.txt`, "ok\n");

    const commit = await gitCommitAll(assignment.worktreePath, "commit result");
    assertEquals(typeof commit, "string");
    assertEquals(await git(assignment.worktreePath, ["status", "--short"]), "");

    // The task-CLI shim files (task_workspace.ts) must also be excluded so a
    // worktree never commits them into its branch.
    const commonDir = (await git(assignment.worktreePath, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])).trim();
    const excludes = await Deno.readTextFile(`${commonDir}/info/exclude`);
    assertStringIncludes(excludes, ".loopforge-goal.json");
    assertStringIncludes(excludes, "lf-task");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("writeTaskWorkspace writes the goal pointer and an executable lf-task shim", async () => {
  const root = Deno.makeTempDirSync();
  const worktree = Deno.makeTempDirSync();
  try {
    await writeTaskWorkspace(root, "GOAL-1", worktree);

    const pointer = JSON.parse(await Deno.readTextFile(`${worktree}/.loopforge-goal.json`));
    assertEquals(pointer.goalId, "GOAL-1");
    assertEquals(pointer.root, path.resolve(root));

    const shim = await Deno.readTextFile(`${worktree}/lf-task`);
    assertStringIncludes(shim, "#!/usr/bin/env bash");
    assertStringIncludes(shim, "task --root");
    assertStringIncludes(shim, '--goal "GOAL-1"');

    const mode = (await Deno.stat(`${worktree}/lf-task`)).mode ?? 0;
    assertEquals((mode & 0o111) !== 0, true);
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(worktree, { recursive: true });
  }
});

Deno.test("worktree preparation prunes stale task worktree metadata", async () => {
  const root = Deno.makeTempDirSync();
  try {
    await git(root, ["init", "-b", "main"]);
    await git(root, ["commit", "--allow-empty", "-m", "seed"]);
    const store = new BoardStore(root);
    store.initProject();
    const { task } = store.createGoal("Recover stale worktree");
    const first = await prepareTaskWorktree(root, task);
    await Deno.remove(first.worktreePath, { recursive: true });

    const second = await prepareTaskWorktree(root, task);

    assertEquals(second.worktreePath, first.worktreePath);
    assertEquals(second.branchName, first.branchName);
    assertEquals(await git(second.worktreePath, ["status", "--short"]), "");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("removeTaskWorktree reclaims the worktree and deletes its branch", async () => {
  const root = Deno.makeTempDirSync();
  try {
    await git(root, ["init", "-b", "main"]);
    await git(root, ["commit", "--allow-empty", "-m", "seed"]);
    const store = new BoardStore(root);
    store.initProject();
    const { task } = store.createGoal("Reclaim worktree after merge");
    const assignment = await prepareTaskWorktree(root, task);

    assertEquals((await Deno.stat(assignment.worktreePath)).isDirectory, true);
    assertStringIncludes(
      await git(root, ["branch", "--list", assignment.branchName]),
      assignment.branchName,
    );

    await removeTaskWorktree(root, assignment.worktreePath, assignment.branchName);

    await assertRejects(() => Deno.stat(assignment.worktreePath));
    assertEquals(await git(root, ["branch", "--list", assignment.branchName]), "");

    // Idempotent: tearing down an already-removed worktree is a no-op.
    await removeTaskWorktree(root, assignment.worktreePath, assignment.branchName);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("commit all commits dirty nested git repositories first", async () => {
  const root = Deno.makeTempDirSync();
  try {
    await git(root, ["init", "-b", "main"]);
    await Deno.writeTextFile(`${root}/root.txt`, "root\n");
    await git(root, ["add", "root.txt"]);
    await git(root, ["commit", "-m", "root seed"]);

    const nested = `${root}/Autom8er`;
    await Deno.mkdir(nested);
    await git(nested, ["init", "-b", "main"]);
    await Deno.writeTextFile(`${nested}/nested.txt`, "nested\n");
    await git(nested, ["add", "nested.txt"]);
    await git(nested, ["commit", "-m", "nested seed"]);
    await git(root, ["add", "Autom8er"]);
    await git(root, ["commit", "-m", "add nested repo"]);

    await Deno.writeTextFile(`${nested}/nested.txt`, "nested changed\n");
    const commit = await gitCommitAll(root, "commit nested result");
    assertEquals(typeof commit, "string");
    assertEquals(await git(nested, ["status", "--short"]), "");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("gitPublishRoot commits the root tree and pushes to a bare origin", async () => {
  const root = Deno.makeTempDirSync();
  const origin = Deno.makeTempDirSync();
  try {
    await git(origin, ["init", "--bare", "-b", "main"]);
    await git(root, ["init", "-b", "main"]);
    await git(root, ["commit", "--allow-empty", "-m", "seed"]);
    await git(root, ["remote", "add", "origin", origin]);
    await Deno.writeTextFile(`${root}/feature.txt`, "publish me\n");

    const result = await gitPublishRoot(root, "publish current state");
    assertEquals(result.branch, "main");
    assertEquals(result.committed, true);
    assertEquals(result.ahead, 0);
    assertEquals(result.behind, 0);
    assertEquals(result.status, "");
    const remoteHead = (await git(origin, ["rev-parse", "--short", "HEAD"])).trim();
    assertEquals(result.commit, remoteHead);
    assertStringIncludes(
      await git(origin, ["log", "-1", "--format=%s"]),
      "publish current state",
    );

    const clean = await gitPublishRoot(root, "nothing new");
    assertEquals(clean.committed, false);
    assertEquals(clean.ahead, 0);
    assertEquals(clean.commit, remoteHead);
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(origin, { recursive: true });
  }
});

Deno.test("gitPublishRoot refuses to push when the remote branch is ahead", async () => {
  const root = Deno.makeTempDirSync();
  const origin = Deno.makeTempDirSync();
  const other = Deno.makeTempDirSync();
  try {
    await git(origin, ["init", "--bare", "-b", "main"]);
    await git(root, ["init", "-b", "main"]);
    await git(root, ["commit", "--allow-empty", "-m", "seed"]);
    await git(root, ["remote", "add", "origin", origin]);
    await git(root, ["push", "-u", "origin", "main"]);

    await git(other, ["clone", origin, "clone"]);
    await git(`${other}/clone`, ["commit", "--allow-empty", "-m", "remote-only work"]);
    await git(`${other}/clone`, ["push", "origin", "main"]);

    await Deno.writeTextFile(`${root}/local.txt`, "local work\n");
    await assertRejects(
      () => gitPublishRoot(root, "publish behind remote"),
      Error,
      "commit(s) that are not in the local branch",
    );
    assertStringIncludes(await git(root, ["log", "-1", "--format=%s"]), "publish behind remote");
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(origin, { recursive: true });
    await Deno.remove(other, { recursive: true });
  }
});

Deno.test("gitPublishRoot fails clearly without an origin remote", async () => {
  const root = Deno.makeTempDirSync();
  try {
    await git(root, ["init", "-b", "main"]);
    await git(root, ["commit", "--allow-empty", "-m", "seed"]);
    await assertRejects(
      () => gitPublishRoot(root, "no remote"),
      Error,
      "No 'origin' remote is configured",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("gitMergeBranchLeased merges under the lease and releases after", async () => {
  const root = Deno.makeTempDirSync();
  try {
    await git(root, ["init", "-b", "main"]);
    await git(root, ["commit", "--allow-empty", "-m", "base"]);
    await git(root, ["checkout", "-b", "feature"]);
    await Deno.writeTextFile(`${root}/feature.txt`, "feature\n");
    await git(root, ["add", "feature.txt"]);
    await git(root, ["commit", "-m", "feature work"]);
    await git(root, ["checkout", "main"]);
    await Deno.writeTextFile(`${root}/main.txt`, "main\n");
    await git(root, ["add", "main.txt"]);
    await git(root, ["commit", "-m", "main work"]);

    const store = new RecordingLeaseStore();
    const output = await gitMergeBranchLeased(store, root, "feature");

    assertStringIncludes(output, "feature.txt");
    assertEquals((await Deno.stat(`${root}/feature.txt`)).isFile, true);
    // Acquired before merging, released after - even though nothing failed.
    assertEquals(store.calls, ["acquire", "release"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("gitMergeBranchLeased times out without merging when the lease is held", async () => {
  const root = Deno.makeTempDirSync();
  try {
    await git(root, ["init", "-b", "main"]);
    await git(root, ["commit", "--allow-empty", "-m", "base"]);
    await git(root, ["checkout", "-b", "feature"]);
    await Deno.writeTextFile(`${root}/feature.txt`, "feature\n");
    await git(root, ["add", "feature.txt"]);
    await git(root, ["commit", "-m", "feature work"]);
    await git(root, ["checkout", "main"]);

    const store = new BlockedLeaseStore();
    await assertRejects(
      () => gitMergeBranchLeased(store, root, "feature", { timeoutMs: 300, pollMs: 50 }),
      Error,
      `Timed out waiting for the repo:${root} lease (merge).`,
    );
    // Never acquired, so never merged and never released.
    assertEquals(store.released, false);
    await assertRejects(() => Deno.stat(`${root}/feature.txt`));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("gitMergeBranchLeased releases the lease when the merge conflicts", async () => {
  const root = Deno.makeTempDirSync();
  try {
    await git(root, ["init", "-b", "main"]);
    await Deno.writeTextFile(`${root}/shared.txt`, "base\n");
    await git(root, ["add", "shared.txt"]);
    await git(root, ["commit", "-m", "base"]);
    await git(root, ["checkout", "-b", "feature"]);
    await Deno.writeTextFile(`${root}/shared.txt`, "feature\n");
    await git(root, ["add", "shared.txt"]);
    await git(root, ["commit", "-m", "feature edit"]);
    await git(root, ["checkout", "main"]);
    await Deno.writeTextFile(`${root}/shared.txt`, "main\n");
    await git(root, ["add", "shared.txt"]);
    await git(root, ["commit", "-m", "main edit"]);

    const store = new RecordingLeaseStore();
    await assertRejects(() => gitMergeBranchLeased(store, root, "feature"), Error);
    // The failed merge still released the lease in the finally block.
    assertEquals(store.calls, ["acquire", "release"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("gitDiffRange returns per-file patches with numstat counts", async () => {
  const root = Deno.makeTempDirSync();
  try {
    await git(root, ["init", "-b", "main"]);
    await Deno.writeTextFile(`${root}/a.txt`, "one\n");
    await git(root, ["add", "a.txt"]);
    await git(root, ["commit", "-m", "base"]);
    await git(root, ["checkout", "-b", "feature"]);
    await Deno.writeTextFile(`${root}/a.txt`, "one\ntwo\n");
    await Deno.writeTextFile(`${root}/b.txt`, "new\n");
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-m", "feature work"]);
    await git(root, ["checkout", "main"]);

    const result = await gitDiffRange(root, "main", "feature");
    assertEquals(result.truncated, false);
    const byPath = Object.fromEntries(result.files.map((file) => [file.path, file]));
    assertStringIncludes(byPath["a.txt"].patch, "diff --git a/a.txt b/a.txt");
    assertEquals(byPath["a.txt"].additions, 1);
    assertEquals(byPath["a.txt"].deletions, 0);
    assertEquals(byPath["b.txt"].additions, 1);
    assertEquals(byPath["b.txt"].deletions, 0);
    assertStringIncludes(byPath["b.txt"].patch, "+new");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("gitDiffRange marks binary files with zero counts", async () => {
  const root = Deno.makeTempDirSync();
  try {
    await git(root, ["init", "-b", "main"]);
    await git(root, ["commit", "--allow-empty", "-m", "base"]);
    await git(root, ["checkout", "-b", "feature"]);
    await Deno.writeFile(`${root}/blob.bin`, new Uint8Array([0, 1, 2, 0, 255, 0, 7]));
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-m", "add binary"]);
    await git(root, ["checkout", "main"]);

    const result = await gitDiffRange(root, "main", "feature");
    const bin = result.files.find((file) => file.path === "blob.bin");
    assert(bin, "expected the binary file in the diff");
    assertEquals(bin!.binary, true);
    assertEquals(bin!.additions, 0);
    assertEquals(bin!.deletions, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("gitMergeCommitFor finds a merge by branch name", async () => {
  const root = Deno.makeTempDirSync();
  try {
    await git(root, ["init", "-b", "main"]);
    await git(root, ["commit", "--allow-empty", "-m", "base"]);
    await git(root, ["checkout", "-b", "loopforge/goal-4"]);
    await Deno.writeTextFile(`${root}/x.txt`, "x\n");
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-m", "goal work"]);
    await git(root, ["checkout", "main"]);
    await git(root, ["merge", "--no-ff", "loopforge/goal-4", "-m", "Merge loopforge/goal-4"]);

    const hash = await gitMergeCommitFor(root, "loopforge/goal-4");
    assert(hash, "expected a merge commit hash");
    // The merge commit's diff (first-parent to merge) shows the branch's file.
    const result = await gitDiffRange(root, `${hash}^1`, hash!, { threeDot: false });
    assert(result.files.some((file) => file.path === "x.txt"));

    // An unmerged branch name has no merge commit.
    assertEquals(await gitMergeCommitFor(root, "loopforge/goal-999"), null);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

async function git(root: string, args: string[]): Promise<string> {
  const output = await new Deno.Command("git", {
    args: [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      ...args,
    ],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(new TextDecoder().decode(output.stderr));
  }
  return new TextDecoder().decode(output.stdout);
}
