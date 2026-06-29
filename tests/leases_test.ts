import { assertEquals } from "@std/assert";
import { BoardStore } from "../src/board/store.ts";

function withStore(fn: (store: BoardStore) => void): void {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    fn(store);
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
}

Deno.test("a lease is exclusive until released", () => {
  withStore((store) => {
    assertEquals(store.acquireLease("merge:x", "A", 60_000, 1_000), true);
    assertEquals(store.acquireLease("merge:x", "B", 60_000, 2_000), false);
    store.releaseLease("merge:x", "A");
    assertEquals(store.acquireLease("merge:x", "B", 60_000, 3_000), true);
  });
});

Deno.test("re-acquiring by the same holder refreshes the lease", () => {
  withStore((store) => {
    assertEquals(store.acquireLease("k", "A", 60_000, 1_000), true);
    assertEquals(store.acquireLease("k", "A", 60_000, 2_000), true);
    assertEquals(store.acquireLease("k", "B", 60_000, 2_500), false);
  });
});

Deno.test("a stale lease can be stolen, a fresh one cannot", () => {
  withStore((store) => {
    assertEquals(store.acquireLease("k", "A", 60_000, 0), true);
    // Within the stale window: B cannot steal.
    assertEquals(store.acquireLease("k", "B", 60_000, 59_000), false);
    // Past the stale window: B steals it.
    assertEquals(store.acquireLease("k", "B", 60_000, 61_000), true);
    // A is no longer the holder, so its heartbeat and release are no-ops.
    assertEquals(store.heartbeatLease("k", "A", 62_000), false);
    store.releaseLease("k", "A");
    assertEquals(store.heartbeatLease("k", "B", 63_000), true);
  });
});

Deno.test("heartbeats keep a lease alive past the stale window", () => {
  withStore((store) => {
    assertEquals(store.acquireLease("k", "A", 60_000, 0), true);
    assertEquals(store.heartbeatLease("k", "A", 50_000), true);
    // 70_000 is >60s after acquisition but only 20s after the last heartbeat.
    assertEquals(store.acquireLease("k", "B", 60_000, 70_000), false);
  });
});

Deno.test("releaseLease only releases the caller's own lease", () => {
  withStore((store) => {
    assertEquals(store.acquireLease("k", "A", 60_000, 0), true);
    store.releaseLease("k", "B"); // wrong holder: no-op
    assertEquals(store.acquireLease("k", "B", 60_000, 1_000), false);
    store.releaseLease("k", "A");
    assertEquals(store.acquireLease("k", "B", 60_000, 2_000), true);
  });
});

Deno.test("a lease is exclusive across two connections to the same board", () => {
  // Two BoardStore connections to one DB file stand in for two LoopForge
  // processes racing to merge into the same root.
  const root = Deno.makeTempDirSync();
  const procA = new BoardStore(root);
  const procB = new BoardStore(root);
  try {
    assertEquals(procA.acquireLease("merge:root", "proc-a", 60_000, 1_000), true);
    assertEquals(procB.acquireLease("merge:root", "proc-b", 60_000, 2_000), false);
    procA.releaseLease("merge:root", "proc-a");
    assertEquals(procB.acquireLease("merge:root", "proc-b", 60_000, 3_000), true);
  } finally {
    procA.close();
    procB.close();
    Deno.removeSync(root, { recursive: true });
  }
});
