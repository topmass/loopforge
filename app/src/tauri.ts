// Native-only bootstrap. In the browser this is a no-op (the LoopForge server
// already serves the GUI). In the Tauri window there is no origin server, so we
// ask the Rust shell to spawn one for a chosen project folder, then point the
// API client at it. Guarded on __TAURI_INTERNALS__ so the browser path is
// completely unaffected.

import { setApiBase } from "./api";

const ROOT_KEY = "loopforge.root";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function maybeStartTauriServer(): Promise<void> {
  if (!isTauri()) {
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const { open } = await import("@tauri-apps/plugin-dialog");

  let root = localStorage.getItem(ROOT_KEY);
  if (!root) {
    const picked = await open({
      directory: true,
      multiple: false,
      title: "Choose a project folder for LoopForge",
    });
    if (typeof picked === "string") {
      root = picked;
      localStorage.setItem(ROOT_KEY, root);
    }
  }
  if (!root) {
    return;
  }
  // A stable-per-install port keeps reconnects pointing at the same server.
  const port = 4733;
  await invoke("start_server", { root, port });
  setApiBase(`http://127.0.0.1:${port}`);
  // Give the spawned server a moment to bind before the first fetch.
  await new Promise((resolve) => setTimeout(resolve, 1500));
}
