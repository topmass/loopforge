import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/space-grotesk/index.css";
import "@fontsource/jetbrains-mono/index.css";
import "./index.css";
import { App } from "./App";
import { api, subscribe } from "./api";
import { maybeStartTauriServer } from "./tauri";
import { useStore } from "./store";

// Bootstrap: in the native app, spawn the server first; then seed runtime + the
// lifecycle backlog, and stay live over SSE.
async function bootstrap() {
  const store = useStore.getState();
  try {
    await maybeStartTauriServer();
  } catch {
    // Native server spawn is best-effort; the browser path skips it entirely.
  }
  try {
    store.setRuntime(await api.runtime());
  } catch {
    // runtime is best-effort; the server may still be starting
  }
  try {
    const seed = await api.lifecycle();
    for (const event of seed.events) {
      store.applyActivity(
        {
          id: 0,
          taskId: event.taskId,
          role: "lifecycle",
          kind: event.kind,
          message: event.summary,
          createdAt: "",
          rawJson: JSON.stringify({
            goalId: event.goalId,
            taskRef: event.taskId,
            data: event.data,
          }),
        } as Parameters<typeof store.applyActivity>[0],
      );
    }
  } catch {
    // no backlog yet
  }

  subscribe({
    onOpen: () => useStore.getState().setConn("live"),
    onError: () => useStore.getState().setConn("down"),
    onBoard: (b) => useStore.getState().applyBoard(b),
    onActivity: (e) => useStore.getState().applyActivity(e),
  });
}

bootstrap();

// Seed the theme onto <html> before first paint to avoid a flash (the store
// resolved it synchronously from localStorage / prefers-color-scheme).
document.documentElement.dataset.theme = useStore.getState().theme;
document.documentElement.style.colorScheme = useStore.getState().theme;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
