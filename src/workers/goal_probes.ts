// Executable win conditions. Each goal probe is a shell command with an
// expected outcome (exit 0 plus optional output substring). Probes run
// deterministically at the project root; a goal with probes closes only when
// every probe passes.

import { BoardStore } from "../board/store.ts";
import { withLease } from "./repo_coordinator.ts";
import { GoalProbe } from "../board/types.ts";

export interface ProbeRunResult {
  probe: GoalProbe;
  passed: boolean;
  output: string;
}

export interface ProbeSummary {
  total: number;
  passed: number;
  results: ProbeRunResult[];
}

export async function runGoalProbes(
  root: string,
  store: BoardStore,
  goalId: string,
  cwd = root,
): Promise<ProbeSummary> {
  // Serialize probe execution project-wide: probes bind ports and fixtures,
  // and with per-goal loops running concurrently two goals' checks would
  // otherwise collide. Probes are timeout-bounded, so waits stay short.
  return await withLease(store, `probes:${root}`, `probes-${goalId}`, async () => {
    const probes = store.listProbes(goalId);
    const results: ProbeRunResult[] = [];
    for (const probe of probes) {
      const result = await runProbeCommand(cwd, probe);
      // Probes are editable from the GUI while a run is in flight. Only record
      // the result if the check is still the one we actually ran: an edit mid-
      // run reset the row to pending (don't stamp a stale verdict on the new
      // command), a deleted row drops out of the summary entirely, and an
      // edited probe counts as not-passed this run so a stale green can never
      // satisfy the completion gate before the new command has actually run.
      const current = store.getProbe(probe.id);
      if (!current) {
        continue;
      }
      if (current.command === probe.command && current.expectContains === probe.expectContains) {
        store.recordProbeResult(probe.id, result.passed ? "passed" : "failed", result.output);
        results.push({ ...result, probe: store.getProbe(probe.id) ?? probe });
      } else {
        results.push({
          probe: current,
          passed: false,
          output: "Probe was edited while this run was in flight; result discarded.",
        });
      }
    }
    return {
      total: results.length,
      passed: results.filter((result) => result.passed).length,
      results,
    };
  }, { timeoutMs: 600_000 });
}

// setsid puts each probe in its own process group so a timeout can reap
// everything the probe spawned: SIGKILL on bash alone bypasses trap-EXIT
// cleanup and orphans background servers, which then squat on their ports and
// poison every later run. Cached probe; falls back to plain bash (macOS).
let setsidAvailable: boolean | null = null;
function hasSetsid(): boolean {
  if (setsidAvailable === null) {
    try {
      new Deno.Command("setsid", { args: ["true"], stdout: "null", stderr: "null" }).outputSync();
      setsidAvailable = true;
    } catch {
      setsidAvailable = false;
    }
  }
  return setsidAvailable;
}

async function runProbeCommand(
  root: string,
  probe: GoalProbe,
): Promise<{ probe: GoalProbe; passed: boolean; output: string }> {
  try {
    const grouped = hasSetsid();
    const child = new Deno.Command(grouped ? "setsid" : "bash", {
      args: grouped ? ["bash", "-lc", probe.command] : ["-lc", probe.command],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const timer = setTimeout(() => {
      if (grouped) {
        // Session leader: pgid == pid, so the negative pid kills the group.
        try {
          new Deno.Command("bash", { args: ["-c", `kill -9 -- -${child.pid}`] }).outputSync();
        } catch {
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGKILL");
      }
    }, probe.timeoutMs);
    const output = await child.output();
    clearTimeout(timer);
    const text = [
      new TextDecoder().decode(output.stdout),
      new TextDecoder().decode(output.stderr),
    ].join("\n").trim();
    const passed = output.success &&
      (!probe.expectContains || text.includes(probe.expectContains));
    return { probe, passed, output: text.slice(0, 4000) };
  } catch (error) {
    return {
      probe,
      passed: false,
      output: `probe failed to run: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// A probe whose OUTPUT is a tool/syntax error is broken check plumbing, not a
// red condition: it can never pass no matter how good the work is. Three
// independent live runs burned their whole iteration budget on exactly this.
export function probeLooksBroken(output: string): boolean {
  return /SyntaxError|unexpected EOF while looking|command not found|bad substitution|unexpected character after line continuation|probe failed to run/
    .test(output);
}

export function probeLights(probes: GoalProbe[]): string {
  if (!probes.length) {
    return "";
  }
  return probes
    .map((probe) => probe.lastStatus === "passed" ? "●" : probe.lastStatus === "failed" ? "○" : "◌")
    .join("");
}

export function formatProbeLines(probes: GoalProbe[]): string[] {
  return probes.map((probe) => {
    const mark = probe.lastStatus === "passed"
      ? "PASS"
      : probe.lastStatus === "failed"
      ? "FAIL"
      : "----";
    return `${mark} ${probe.label}`;
  });
}
