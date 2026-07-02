import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  AGENT_BACKENDS,
  defaultGlobalConfig,
  describeBackend,
  globalConfigPath,
  normalizeBackend,
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

Deno.test("claude effort defaults to high, round-trips, and normalizes invalid values", () => {
  withTempHome(() => {
    assertEquals(defaultGlobalConfig().claude.effort, "high");
    assertEquals(readGlobalConfig().claude.effort, "high");

    // A valid patch round-trips through persistence.
    assertEquals(updateGlobalConfig({ claude: { effort: "xhigh" } }).claude.effort, "xhigh");
    assertEquals(readGlobalConfig().claude.effort, "xhigh");
    // "max" is a real CLI level.
    assertEquals(updateGlobalConfig({ claude: { effort: "max" } }).claude.effort, "max");

    // An invalid patched value normalizes back to the default instead of persisting.
    assertEquals(updateGlobalConfig({ claude: { effort: "turbo" } }).claude.effort, "high");
    assertEquals(readGlobalConfig().claude.effort, "high");
    // An effort-only patch leaves the model untouched.
    assertEquals(readGlobalConfig().claude.model, defaultGlobalConfig().claude.model);

    // A malformed value on disk also normalizes to the default on read.
    Deno.writeTextFileSync(
      globalConfigPath(),
      JSON.stringify({ claude: { model: "claude-x", effort: "bogus" } }),
    );
    assertEquals(readGlobalConfig().claude.effort, "high");
    assertEquals(readGlobalConfig().claude.model, "claude-x");
  });
});

Deno.test("AGENT_BACKENDS lists the three coding agents and normalizeBackend folds pi into local", () => {
  assertEquals(AGENT_BACKENDS, ["codex", "claude", "local"]);
  assertEquals(defaultGlobalConfig().local.piProvider, "");
  // pi merged into local: a legacy "pi" value (main or role backend) resolves
  // to local; unknown values fall back; real backends pass through.
  assertEquals(normalizeBackend("pi", "codex"), "local");
  assertEquals(normalizeBackend("bogus", "codex"), "codex");
  assertEquals(normalizeBackend("claude", "codex"), "claude");
});

Deno.test("a legacy pi backend config migrates to local with its provider seeded", () => {
  withTempHome(() => {
    // An old config from before pi merged into local: the standalone "pi"
    // backend with its own provider block.
    Deno.writeTextFileSync(
      globalConfigPath(),
      JSON.stringify({ backend: "pi", pi: { provider: "anthropic", model: "claude-x" } }),
    );
    const config = readGlobalConfig();
    assertEquals(config.backend, "local");
    assertEquals(config.local.piProvider, "anthropic");
    assertEquals(config.local.piModel, "claude-x");
    // describeBackend reflects the migrated pi routing on one line.
    assertStringIncludes(describeBackend(config), "local via pi (anthropic/claude-x)");
  });
});

Deno.test("localPiProvider round-trips and drives describeBackend", () => {
  withTempHome(() => {
    // On the local backend with no override, it is described as the pi agent on
    // the local endpoint.
    updateGlobalConfig({ backend: "local" });
    assertStringIncludes(describeBackend(readGlobalConfig()), "pi agent, local model");
    const updated = updateGlobalConfig({ local: { piProvider: "openrouter", piModel: "glm" } });
    assertEquals(updated.local.piProvider, "openrouter");
    assertEquals(readGlobalConfig().local.piModel, "glm");
    assertStringIncludes(describeBackend(readGlobalConfig()), "local via pi (openrouter/glm)");
  });
});

Deno.test("loopPlanContract tells the agent the parallel cap and defaults to fan-out", () => {
  const contract = loopPlanContract(5);
  assertStringIncludes(contract, "up to 5 at once");
  assert(/DEFAULT TO FAN-OUT/i.test(contract));
});
