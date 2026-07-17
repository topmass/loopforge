import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { BoardStore } from "../src/board/store.ts";
import { dueSchedules, runDueSchedules } from "../src/workers/schedules.ts";

Deno.test("schedules: CRUD validates and dueSchedules respects enabled + interval", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    assertThrows(() => store.createSchedule("probe-recheck", 5), Error, "at least 15");
    const schedule = store.createSchedule("probe-recheck", 30);
    assertEquals(schedule.enabled, true);

    // Never run -> due immediately.
    assertEquals(dueSchedules(store).map((s) => s.id), [schedule.id]);
    store.stampScheduleRun(schedule.id);
    assertEquals(dueSchedules(store).length, 0);
    // Past the interval -> due again.
    assertEquals(dueSchedules(store, Date.now() + 31 * 60_000).length, 1);

    const disabled = store.updateSchedule(schedule.id, { enabled: false });
    assertEquals(disabled.enabled, false);
    assertEquals(dueSchedules(store, Date.now() + 31 * 60_000).length, 0);

    store.deleteSchedule(schedule.id);
    assertEquals(store.listSchedules().length, 0);
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("probe-recheck schedule reruns probes, reports regressions, skips active loops", async () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal } = store.createGoal("Regression watch");
    const [probe] = store.addProbes(goal.id, [{
      label: "flag exists",
      command: "test -f flag.txt",
    }]);
    // The probe passed once upon a time...
    store.recordProbeResult(probe.id, "passed", "");
    // ...but the flag no longer exists, so a recheck must regress it.
    store.createSchedule("probe-recheck", 15);

    const reports: string[] = [];
    // First tick: the goal's loop is "running" - its probes must be skipped.
    await runDueSchedules(store, {
      listActiveLoops: () => [goal.id],
      report: (message) => reports.push(message),
    });
    assertEquals(store.listProbes(goal.id)[0].lastStatus, "passed");
    assertEquals(reports.length, 0);

    // Second tick (past the interval), loop idle: the recheck runs and the
    // regression is reported.
    await runDueSchedules(store, {
      listActiveLoops: () => [],
      report: (message) => reports.push(message),
    }, Date.now() + 16 * 60_000);
    assertEquals(store.listProbes(goal.id)[0].lastStatus, "failed");
    assertEquals(reports.length, 1);
    assertStringIncludes(reports[0], "probe regression");
    assertStringIncludes(reports[0], goal.id);
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("scout schedules dispatch the pass and stamp before running", async () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const schedule = store.createSchedule("scout", 60);
    let passes = 0;
    const reports: string[] = [];
    await runDueSchedules(store, {
      listActiveLoops: () => [],
      report: (message) => reports.push(message),
      runScoutPass: () => {
        passes++;
        return Promise.reject(new Error("scout backend offline"));
      },
    });
    assertEquals(passes, 1);
    // The failure was reported, and the stamp landed BEFORE the action so the
    // failing pass cannot machine-gun every tick.
    assertStringIncludes(reports[0], "schedule scout failed");
    assert(store.listSchedules()[0].lastRunAt !== null);
    await runDueSchedules(store, {
      listActiveLoops: () => [],
      report: (message) => reports.push(message),
      runScoutPass: () => {
        passes++;
        return Promise.resolve();
      },
    });
    assertEquals(passes, 1);
    assertEquals(schedule.kind, "scout");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});
