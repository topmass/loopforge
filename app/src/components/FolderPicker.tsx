import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { api } from "../api";
import type { DirEntry, ProjectEntry } from "../types";
import { spring } from "./ui";

// Server-backed folder picker (a browser file input cannot give an absolute
// path). Lists directories from the localhost filesystem via /api/fs/dirs, lets
// the user navigate in/out, and adds the CURRENT directory as a project.
export function FolderPicker(
  { initialPath, onAdded, onClose }: {
    initialPath: string;
    onAdded: (projects: ProjectEntry[]) => void;
    onClose: () => void;
  },
) {
  const [dir, setDir] = useState(initialPath);
  const [parent, setParent] = useState<string | null>(null);
  const [dirs, setDirs] = useState<DirEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // New-folder inline input: null = hidden, string = the name being typed.
  const [newName, setNewName] = useState<string | null>(null);

  const load = async (target?: string) => {
    setError(null);
    try {
      const res = await api.listDirs(target);
      setDir(res.path);
      setParent(res.parent);
      setDirs(res.dirs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Start at the initial path (or HOME when blank, resolved server-side).
  useEffect(() => {
    void load(initialPath || undefined);
  }, []);

  // Escape closes, matching the settings modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const use = async () => {
    if (!dir || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { projects } = await api.addProject(dir);
      onAdded(projects);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Create a new folder in the current dir, then navigate into it so "Use this
  // folder" immediately adds it.
  const createFolder = async () => {
    const name = (newName ?? "").trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { path } = await api.makeDir(dir, name);
      setNewName(null);
      await load(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 z-50 flex items-center justify-center bg-scrim backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.94, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96 }}
        transition={spring}
        className="glass flex max-h-[80vh] w-[460px] flex-col rounded-3xl p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="text-base font-semibold">Choose a folder</span>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-muted transition-colors hover:text-ink"
          >
            ✕
          </button>
        </div>
        {/* Current path: truncate on the left so the folder name (tail) stays readable. */}
        <div
          dir="rtl"
          title={dir}
          className="mb-2 truncate rounded-xl bg-surface-sunken px-2.5 py-1.5 text-left text-xs text-ink-muted"
        >
          {dir || "..."}
        </div>
        {error && <div className="mb-2 text-xs text-danger">{error}</div>}

        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
          {parent && (
            <button
              type="button"
              onClick={() => void load(parent)}
              className="flex w-full items-center gap-2 rounded-xl border border-line bg-surface-sunken px-3 py-2 text-left text-sm text-ink-muted transition hover:bg-surface-sunken"
            >
              <span className="text-ink-faint">↑</span> ..
            </button>
          )}
          {dirs.map((entry) => (
            <button
              key={entry.path}
              type="button"
              onClick={() => void load(entry.path)}
              className="flex w-full items-center gap-2 rounded-xl border border-line bg-surface-raised px-3 py-2 text-left text-sm text-ink transition hover:bg-surface-sunken"
            >
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              {entry.hasGit && (
                <span className="shrink-0 rounded-full bg-surface-sunken px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-ink-muted">
                  git
                </span>
              )}
            </button>
          ))}
          {dirs.length === 0 && !error && (
            <div className="px-2 py-2 text-xs text-ink-faint">No sub-folders here.</div>
          )}
        </div>

        <div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
          {newName === null
            ? (
              <button
                type="button"
                onClick={() => setNewName("")}
                className="mr-auto rounded-xl border border-line px-3 py-1.5 text-xs text-ink-muted transition hover:bg-surface-sunken"
              >
                New folder
              </button>
            )
            : (
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void createFolder();
                  } else if (e.key === "Escape") {
                    // Cancel the input without letting Escape close the picker.
                    e.preventDefault();
                    e.stopPropagation();
                    setNewName(null);
                  }
                }}
                placeholder="new folder name"
                className="mr-auto min-w-0 flex-1 rounded-xl border border-line bg-surface-overlay px-2.5 py-1.5 text-xs text-ink outline-none transition placeholder:text-ink-faint focus:border-accent"
              />
            )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-line px-3 py-1.5 text-xs text-ink-muted transition hover:bg-surface-sunken"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void use()}
            disabled={busy || !dir}
            className="rounded-xl bg-accent px-3 py-1.5 text-xs font-semibold text-on-accent transition hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Adding..." : "Use this folder"}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
