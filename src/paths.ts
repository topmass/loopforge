import path from "node:path";

export const RUNTIME_DIR = ".loopforge";

// Projects initialized before the LoopForge rename keep their .goalforge state.
const LEGACY_RUNTIME_DIR = ".goalforge";
const runtimeDirCache = new Map<string, string>();

export function runtimeDirName(root: string): string {
  const cached = runtimeDirCache.get(root);
  if (cached) {
    return cached;
  }
  const name = dirExists(path.join(root, RUNTIME_DIR)) ||
      !dirExists(path.join(root, LEGACY_RUNTIME_DIR))
    ? RUNTIME_DIR
    : LEGACY_RUNTIME_DIR;
  runtimeDirCache.set(root, name);
  return name;
}

function dirExists(target: string): boolean {
  try {
    return Deno.statSync(target).isDirectory;
  } catch {
    return false;
  }
}

export function runtimePath(root: string, ...parts: string[]): string {
  return path.join(root, runtimeDirName(root), ...parts);
}

export function databasePath(root: string): string {
  return runtimePath(root, "board.sqlite");
}

export function configPath(root: string): string {
  return runtimePath(root, "config.json");
}

export function workflowPath(root: string): string {
  return path.join(root, "WORKFLOW.md");
}

export function promptsPath(root: string): string {
  return runtimePath(root, "prompts");
}

export function worktreesPath(root: string): string {
  return runtimePath(root, "worktrees");
}

export function runsPath(root: string): string {
  return runtimePath(root, "runs");
}

export function contextPath(root: string, ...parts: string[]): string {
  return runtimePath(root, "context", ...parts);
}

export function taskArtifactsPath(root: string, ...parts: string[]): string {
  return runtimePath(root, "tasks", ...parts);
}

export function normalizeRoot(root = Deno.cwd()): string {
  return path.resolve(root);
}
