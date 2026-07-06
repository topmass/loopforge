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

// Turn whatever a user pastes into a folder field into a clean absolute path:
// shell-quoted paths, file:// links, ~ shorthand, and trailing separators all
// resolve; Windows-shaped paths are only meaningful when the server itself is
// on Windows, so anywhere else they raise a clear error instead of resolving
// into a bogus relative path. The os parameter exists for tests.
export function parseFolderInput(raw: string, os: string = Deno.build.os): string {
  let value = raw.trim();
  if (
    value.length > 1 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1).trim();
  }
  if (!value) {
    throw new Error("A folder path is required.");
  }
  if (value.startsWith("file://")) {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(value).pathname);
    } catch {
      throw new Error(`${value} is not a valid file:// link.`);
    }
    // file:///C:/Users/x arrives as /C:/Users/x - drop the slash and use
    // backslashes so the Windows filesystem APIs get their native shape.
    value = os === "windows" && /^\/[A-Za-z]:/.test(pathname)
      ? pathname.slice(1).replaceAll("/", "\\")
      : pathname;
  }
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
    const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
    if (!home) {
      throw new Error("Cannot expand ~ because no HOME is set.");
    }
    value = value === "~" ? home : path.join(home, value.slice(2));
  }
  const windowsShaped = /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
  if (windowsShaped && os !== "windows") {
    throw new Error(
      `That looks like a Windows path, but this LoopForge server is running on ${os}.`,
    );
  }
  if (windowsShaped) {
    // Normalize textually so the os parameter stays honest in tests running on
    // posix hosts; on a real Windows host path.resolve does the same thing.
    const trimmed = value.replaceAll("/", "\\").replace(/\\+$/, "");
    return /^[A-Za-z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed;
  }
  if (!value.startsWith("/")) {
    throw new Error("Paste an absolute folder path (or a file:// link).");
  }
  return path.resolve(value);
}
