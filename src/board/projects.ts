// A tiny JSON registry of the projects (repos) opened in this LoopForge command
// center, stored at ~/.loopforge/projects.json (override the directory with
// LOOPFORGE_HOME). The sidebar lists these; each entry is a repo root the hub
// can open its own full server for. Reads are defensive - a malformed or
// missing file is an empty list, mirroring global_config.ts.

import path from "node:path";
import { loopforgeHome } from "./global_config.ts";

export interface ProjectEntry {
  root: string;
  name: string;
  addedAt: string;
}

export function projectsPath(): string {
  return path.join(loopforgeHome(), "projects.json");
}

export function listProjects(): ProjectEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Deno.readTextFileSync(projectsPath()));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.flatMap((raw) => {
    const entry = record(raw);
    const root = typeof entry.root === "string" ? entry.root.trim() : "";
    if (!root) {
      return [];
    }
    // Normalize on read so callers can compare roots without re-resolving.
    const normalized = path.resolve(root);
    return [{
      root: normalized,
      name: typeof entry.name === "string" && entry.name.trim()
        ? entry.name
        : path.basename(normalized),
      addedAt: typeof entry.addedAt === "string" ? entry.addedAt : "",
    }];
  });
}

export function registerProject(root: string): ProjectEntry {
  const normalized = path.resolve(root);
  if (!dirExists(normalized)) {
    throw new Error(`${normalized} is not a directory.`);
  }
  const entries = listProjects();
  const existing = entries.find((entry) => entry.root === normalized);
  if (existing) {
    return existing;
  }
  const entry: ProjectEntry = {
    root: normalized,
    name: path.basename(normalized),
    addedAt: new Date().toISOString(),
  };
  writeProjects([...entries, entry]);
  return entry;
}

export function removeProject(root: string): void {
  const normalized = path.resolve(root);
  writeProjects(listProjects().filter((entry) => entry.root !== normalized));
}

function writeProjects(entries: ProjectEntry[]): void {
  Deno.mkdirSync(loopforgeHome(), { recursive: true });
  Deno.writeTextFileSync(projectsPath(), `${JSON.stringify(entries, null, 2)}\n`);
}

function dirExists(target: string): boolean {
  try {
    return Deno.statSync(target).isDirectory;
  } catch {
    return false;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
