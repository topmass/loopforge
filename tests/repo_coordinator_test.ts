import { assert, assertEquals, assertRejects } from "@std/assert";
import { BoardStore } from "../src/board/store.ts";
import { repoLockKey, withRepoLock } from "../src/workers/repo_coordinator.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

Deno.test("withRepoLock serializes concurrent root mutations", async () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const order: string[] = [];
    const a = withRepoLock(store, root, "a", async () => {
      order.push("a-start");
      await wait(150);
      order.push("a-end");
    }, { pollMs: 20 });
    await wait(20); // a acquires first
    const b = withRepoLock(store, root, "b", async () => {
      order.push("b-start");
      await wait(30);
      order.push("b-end");
    }, { pollMs: 20 });
    await Promise.all([a, b]);
    assertEquals(order, ["a-start", "a-end", "b-start", "b-end"]);
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("a heartbeating holder is never stolen, even past the stale window", async () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const order: string[] = [];
    // Holder runs 400ms with a 100ms stale window but 40ms heartbeats: a
    // non-heartbeated lease WOULD be stolen; the heartbeat must prevent it.
    const holder = withRepoLock(store, root, "long", async () => {
      order.push("long-start");
      await wait(400);
      order.push("long-end");
    }, { staleMs: 100, heartbeatMs: 40, pollMs: 20 });
    await wait(30);
    const rival = withRepoLock(store, root, "rival", async () => {
      order.push("rival-start");
    }, { staleMs: 100, heartbeatMs: 40, pollMs: 20, timeoutMs: 2000 });
    await Promise.all([holder, rival]);
    assertEquals(order, ["long-start", "long-end", "rival-start"]);
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("a crashed holder's lease goes stale and is taken over", async () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    // Simulate a crash: a lease acquired directly with an old heartbeat and
    // never released or heartbeated again.
    assert(store.acquireLease(repoLockKey(root), "dead-holder", 60_000, Date.now() - 10_000));
    let ran = false;
    await withRepoLock(store, root, "successor", async () => {
      ran = true;
      await wait(5);
    }, { staleMs: 200, pollMs: 20, timeoutMs: 2000 });
    assert(ran);
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("the lock releases when the work throws, and waiting times out cleanly", async () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    await assertRejects(
      () => withRepoLock(store, root, "boom", () => Promise.reject(new Error("kaboom"))),
      Error,
      "kaboom",
    );
    // The failed holder released; the next acquire succeeds immediately.
    let ran = false;
    await withRepoLock(store, root, "after", async () => {
      ran = true;
      await wait(1);
    }, { timeoutMs: 500 });
    assert(ran);

    // A held lock plus a tiny timeout produces the timeout error, not a hang.
    const blocker = withRepoLock(store, root, "blocker", () => wait(300), { pollMs: 20 });
    await wait(20);
    await assertRejects(
      () => withRepoLock(store, root, "impatient", async () => {}, { timeoutMs: 80, pollMs: 20 }),
      Error,
      "Timed out waiting for the repository lock",
    );
    await blocker;
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});
