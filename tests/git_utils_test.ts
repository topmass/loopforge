import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { BoardStore } from "../src/board/store.ts";
import {
  gitCommitAll,
  gitPublishRoot,
  prepareTaskWorktree,
  removeTaskWorktree,
} from "../src/workers/git_utils.ts";

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
  } finally {
    await Deno.remove(root, { recursive: true });
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
