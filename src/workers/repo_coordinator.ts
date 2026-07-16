// The repository coordinator: ONE advisory lock per project root guarding
// every mutation of the shared git repository - merges into root, `git
// worktree add/prune/remove` (which all touch the shared .git metadata), and
// root publishes. Backed by the board's cross-process lease table, so the
// server, the CLI, loops, and fan-out in separate processes all serialize.
//
// The lease is heartbeated while held: a live holder can never be stolen
// mid-operation (the old 60s stale ceiling could be), and a crashed holder
// goes stale within STALE_MS so nothing wedges forever.

import type { LeaseStore } from "./git_utils.ts";

const STALE_MS = 20_000;
const HEARTBEAT_MS = 5_000;

export interface RepoLockOptions {
  timeoutMs?: number;
  pollMs?: number;
  // Test seams: production callers leave these at the defaults.
  staleMs?: number;
  heartbeatMs?: number;
}

export function repoLockKey(root: string): string {
  return `repo:${root}`;
}

// Root git mutations queue on repo:<root>; probe execution queues separately
// on probes:<root> so port-binding probes from concurrent loops never collide
// while merges and probe runs (different resources) stay independent.
export async function withRepoLock<T>(
  store: LeaseStore,
  root: string,
  label: string,
  fn: () => Promise<T>,
  opts: RepoLockOptions = {},
): Promise<T> {
  return await withLease(store, repoLockKey(root), label, fn, opts);
}

export async function withLease<T>(
  store: LeaseStore,
  key: string,
  label: string,
  fn: () => Promise<T>,
  opts: RepoLockOptions = {},
): Promise<T> {
  const holder = `${label}-${Deno.pid}-${crypto.randomUUID()}`;
  const staleMs = opts.staleMs ?? STALE_MS;
  const deadlineAt = Date.now() + (opts.timeoutMs ?? 120_000);
  while (!store.acquireLease(key, holder, staleMs)) {
    if (Date.now() >= deadlineAt) {
      throw new Error(`Timed out waiting for the ${key} lease (${label}).`);
    }
    await new Promise((resolve) => setTimeout(resolve, opts.pollMs ?? 150));
  }
  // Re-acquiring under the same holder refreshes heartbeat_at, so the acquire
  // call doubles as the heartbeat. The timer must never throw: an uncaught
  // error inside setInterval kills the whole process (see specsheet rules).
  const beat = setInterval(() => {
    try {
      store.acquireLease(key, holder, staleMs);
    } catch {
      // A closed store near shutdown is fine; the lease will go stale.
    }
  }, opts.heartbeatMs ?? HEARTBEAT_MS);
  try {
    return await fn();
  } finally {
    clearInterval(beat);
    try {
      store.releaseLease(key, holder);
    } catch {
      // Same shutdown tolerance; stale takeover is the backstop.
    }
  }
}
