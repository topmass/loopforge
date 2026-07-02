import { assertEquals, assertThrows } from "@std/assert";
import path from "node:path";
import {
  listProjects,
  projectsPath,
  registerProject,
  removeProject,
} from "../src/board/projects.ts";

// Point the registry at a throwaway LOOPFORGE_HOME so each test is isolated;
// loopforgeHome() reads the env lazily on every call.
function withHome(fn: () => void): void {
  const previous = Deno.env.get("LOOPFORGE_HOME");
  const home = Deno.makeTempDirSync();
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

Deno.test("registry registers two roots, lists them normalized, dedupes, and removes", () => {
  withHome(() => {
    const rootA = Deno.makeTempDirSync();
    const rootB = Deno.makeTempDirSync();
    try {
      const a = registerProject(rootA);
      assertEquals(a.root, path.resolve(rootA));
      assertEquals(a.name, path.basename(path.resolve(rootA)));
      registerProject(rootB);
      assertEquals(listProjects().length, 2);

      // Re-registering a known root (even with a trailing separator) dedupes.
      registerProject(`${rootA}${path.sep}`);
      assertEquals(listProjects().length, 2);
      assertEquals(
        listProjects().filter((p) => p.root === path.resolve(rootA)).length,
        1,
      );

      removeProject(rootA);
      assertEquals(listProjects().map((p) => p.root), [path.resolve(rootB)]);
    } finally {
      Deno.removeSync(rootA, { recursive: true });
      Deno.removeSync(rootB, { recursive: true });
    }
  });
});

Deno.test("registry reads a missing, corrupt, or non-array file as empty", () => {
  withHome(() => {
    // Missing file.
    assertEquals(listProjects(), []);
    // Corrupt JSON.
    Deno.writeTextFileSync(projectsPath(), "{ not json");
    assertEquals(listProjects(), []);
    // Valid JSON that is not an array of entries.
    Deno.writeTextFileSync(projectsPath(), JSON.stringify({ root: "x" }));
    assertEquals(listProjects(), []);
  });
});

Deno.test("registering a nonexistent directory throws", () => {
  withHome(() => {
    const missing = path.join(Deno.makeTempDirSync(), "does-not-exist");
    assertThrows(() => registerProject(missing));
  });
});
