import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { api, subscribe } from "./api";
import { useStore } from "./store";

// Bootstrap: seed runtime + the lifecycle backlog, then stay live over SSE.
async function bootstrap() {
  const store = useStore.getState();
  try {
    store.setRuntime(await api.runtime());
  } catch {
    // runtime is best-effort; the server may still be starting
  }
  try {
    const seed = await api.lifecycle();
    for (const event of seed.events) {
      store.applyActivity({
        id: 0,
        taskId: event.taskId,
        role: "lifecycle",
        kind: event.kind,
        message: event.summary,
        createdAt: "",
        rawJson: JSON.stringify({ goalId: event.goalId, data: event.data }),
      } as Parameters<typeof store.applyActivity>[0]);
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
