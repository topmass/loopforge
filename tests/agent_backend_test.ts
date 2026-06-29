import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  defaultGlobalConfig,
  describeBackend,
  readGlobalConfig,
  updateGlobalConfig,
} from "../src/board/global_config.ts";
import {
  createAgentClient,
  createPlannerClient,
  createReviewerClient,
  ensureLocalPiProvider,
  LOCAL_PI_PROVIDER_ID,
} from "../src/workers/agent_backend.ts";
import { CodexAppServerClient } from "../src/workers/codex_app_server.ts";
import { PiRpcClient } from "../src/workers/pi_rpc_client.ts";

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

Deno.test("global config defaults to codex and persists backend updates", () => {
  withTempHome(() => {
    assertEquals(readGlobalConfig().backend, "codex");
    const updated = updateGlobalConfig({
      backend: "local",
      local: { endpoint: "http://100.1.2.3:8080/v1", model: "qwen3-coder" },
    });
    assertEquals(updated.backend, "local");
    const reread = readGlobalConfig();
    assertEquals(reread.local.endpoint, "http://100.1.2.3:8080/v1");
    assertEquals(reread.local.model, "qwen3-coder");
    assertEquals(reread.claude.model, defaultGlobalConfig().claude.model);
    assertStringIncludes(describeBackend(reread), "qwen3-coder");

    const next = updateGlobalConfig({ backend: "codex" });
    assertEquals(next.local.endpoint, "http://100.1.2.3:8080/v1");
  });
});

Deno.test("agent client factory selects the configured backend", () => {
  withTempHome(() => {
    const root = Deno.makeTempDirSync();
    try {
      assert(createAgentClient(root, () => {}) instanceof CodexAppServerClient);
      updateGlobalConfig({ backend: "pi" });
      assert(createAgentClient(root, () => {}) instanceof PiRpcClient);
      const modelsPath = `${root}/models.json`;
      Deno.env.set("LOOPFORGE_PI_MODELS_PATH", modelsPath);
      try {
        updateGlobalConfig({ backend: "local" });
        assert(createAgentClient(root, () => {}) instanceof PiRpcClient);
        const models = JSON.parse(Deno.readTextFileSync(modelsPath));
        assertEquals(
          models.providers[LOCAL_PI_PROVIDER_ID].baseUrl,
          readGlobalConfig().local.endpoint,
        );
      } finally {
        Deno.env.delete("LOOPFORGE_PI_MODELS_PATH");
      }
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });
});

Deno.test("planner config persists and routes the planner client independently", () => {
  withTempHome(() => {
    const root = Deno.makeTempDirSync();
    try {
      assertEquals(readGlobalConfig().planner, { enabled: false, backend: "codex" });
      updateGlobalConfig({ backend: "pi" });
      assert(createPlannerClient(root, () => {}) instanceof PiRpcClient);

      updateGlobalConfig({ planner: { enabled: true, backend: "codex" } });
      assert(createPlannerClient(root, () => {}) instanceof CodexAppServerClient);
      assert(createAgentClient(root, () => {}) instanceof PiRpcClient);
      assertEquals(readGlobalConfig().planner, { enabled: true, backend: "codex" });

      updateGlobalConfig({ planner: { enabled: false } });
      assert(createPlannerClient(root, () => {}) instanceof PiRpcClient);
      assertEquals(readGlobalConfig().planner.backend, "codex");
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });
});

Deno.test("reviewer config routes review to its own backend (implement on pi, review on codex)", () => {
  withTempHome(() => {
    const root = Deno.makeTempDirSync();
    try {
      assertEquals(readGlobalConfig().reviewer, { enabled: false, backend: "codex" });
      // Disabled reviewer follows the execution backend.
      updateGlobalConfig({ backend: "pi" });
      assert(createReviewerClient(root, () => {}) instanceof PiRpcClient);

      // Enabled reviewer runs on its own backend while the loop still grinds on pi.
      updateGlobalConfig({ reviewer: { enabled: true, backend: "codex" } });
      assert(createReviewerClient(root, () => {}) instanceof CodexAppServerClient);
      assert(createAgentClient(root, () => {}) instanceof PiRpcClient);
      assertEquals(readGlobalConfig().reviewer, { enabled: true, backend: "codex" });

      updateGlobalConfig({ reviewer: { enabled: false } });
      assert(createReviewerClient(root, () => {}) instanceof PiRpcClient);
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });
});

Deno.test("ensureLocalPiProvider merges idempotently and preserves other providers", () => {
  const dir = Deno.makeTempDirSync();
  const modelsPath = `${dir}/models.json`;
  try {
    Deno.writeTextFileSync(
      modelsPath,
      JSON.stringify({
        providers: {
          ollama: { baseUrl: "http://localhost:11434/v1", api: "openai-completions" },
        },
      }),
    );
    const config = {
      ...defaultGlobalConfig(),
      local: { endpoint: "http://100.1.2.3:8080/v1", model: "qwen3-coder", apiKey: "none" },
    };
    assertEquals(ensureLocalPiProvider(config, modelsPath, null), true);
    assertEquals(ensureLocalPiProvider(config, modelsPath, null), false);
    const written = JSON.parse(Deno.readTextFileSync(modelsPath));
    assertEquals(written.providers.ollama.baseUrl, "http://localhost:11434/v1");
    assertEquals(written.providers[LOCAL_PI_PROVIDER_ID].models, [{ id: "qwen3-coder" }]);

    assertEquals(ensureLocalPiProvider(config, modelsPath, 32768), true);
    const sized = JSON.parse(Deno.readTextFileSync(modelsPath));
    assertEquals(sized.providers[LOCAL_PI_PROVIDER_ID].models, [{
      id: "qwen3-coder",
      contextWindow: 32768,
    }]);

    config.local.endpoint = "http://other:9090/v1";
    assertEquals(ensureLocalPiProvider(config, modelsPath, null), true);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});
