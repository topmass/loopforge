import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  defaultGlobalConfig,
  readGlobalConfig,
  updateGlobalConfig,
} from "../src/board/global_config.ts";
import { loopPlanContract } from "../src/workers/loop_plan.ts";

function withTempHome(fn: () => void): void {
  const home = Deno.makeTempDirSync();
  const previous = Deno.env.get("LOOPFORGE_HOME");
  Deno.env.set("LOOPFORGE_HOME", home);
  try {
    fn();
  } finally {
    if (previous === undefined) {
      Deno.env.delete("LOOPFORGE_HOME");
    } else {
      Deno.env.set("LOOPFORGE_HOME", previous);
    }
    Deno.removeSync(home, { recursive: true });
  }
}

Deno.test("maxParallelAgents defaults to 5", () => {
  assertEquals(defaultGlobalConfig().maxParallelAgents, 5);
  withTempHome(() => {
    assertEquals(readGlobalConfig().maxParallelAgents, 5);
  });
});

Deno.test("updateGlobalConfig clamps the parallel-agent cap to 1-12 and persists it", () => {
  withTempHome(() => {
    assertEquals(updateGlobalConfig({ maxParallelAgents: 8 }).maxParallelAgents, 8);
    assertEquals(readGlobalConfig().maxParallelAgents, 8);
    // Out-of-range values clamp rather than disabling parallelism or exploding it.
    assertEquals(updateGlobalConfig({ maxParallelAgents: 0 }).maxParallelAgents, 1);
    assertEquals(updateGlobalConfig({ maxParallelAgents: 999 }).maxParallelAgents, 12);
    // Other fields are untouched by the cap update.
    assertEquals(readGlobalConfig().backend, defaultGlobalConfig().backend);
  });
});

Deno.test("loopPlanContract tells the agent the parallel cap and prefers fan-out", () => {
  const contract = loopPlanContract(5);
  assertStringIncludes(contract, "up to 5 concurrent");
  assert(/PREFER PARALLELISM/i.test(contract));
});
