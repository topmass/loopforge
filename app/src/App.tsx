import { useEffect, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { useStore } from "./store";
import { api, subscribe } from "./api";
import { TopBar } from "./components/TopBar";
import { AlertsBar } from "./components/AlertsBar";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import { type CenterTab, CenterTabs } from "./components/CenterTabs";
import { BoardView } from "./components/BoardView";
import { ThreadView } from "./components/ThreadView";
import { RightPanel, type RightTab } from "./components/RightPanel";
import { ChatBar } from "./components/ChatBar";

// The three-panel shell: TopBar / (Sidebar | center tabs + Board|Thread | right
// panel) / ChatBar. Layout + the project-switch reconnect effect + tab state
// live here; every panel is its own component under components/.
export function App() {
  const board = useStore((s) => s.board);
  const activeGoalId = useStore((s) => s.activeGoalId);
  const apiBase = useStore((s) => s.apiBase);
  const theme = useStore((s) => s.theme);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [centerTab, setCenterTab] = useState<CenterTab>("board");
  const [rightTab, setRightTab] = useState<RightTab>("detail");
  const activeGoal = board?.goals.find((g) => g.id === activeGoalId) ?? null;
  const firstRun = useRef(true);

  // Mirror the theme onto <html> so the token overrides in index.css apply, and
  // set color-scheme so native form controls / scrollbars match. main.tsx seeds
  // the initial value before first paint; this keeps it live on toggle.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  // Project switch: when apiBase changes, re-point the whole client at the newly
  // active server - drop the previous project's live state, refetch its runtime
  // + board + lifecycle backlog (unscoped, so planByGoal covers every goal), and
  // reconnect the SSE stream. main.tsx wires the initial primary-origin
  // connection and seed, so the first run here is a no-op.
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    // Switching projects returns the center to the Board tab.
    setCenterTab("board");
    const store = useStore.getState();
    store.resetLive();
    void (async () => {
      try {
        store.setRuntime(await api.runtime());
      } catch {
        // the switched-to server may still be starting
      }
      try {
        store.applyBoard(await api.board());
      } catch {
        // board comes over SSE too
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
        // no backlog on the new project yet
      }
    })();
    return subscribe({
      onOpen: () => useStore.getState().setConn("live"),
      onError: () => useStore.getState().setConn("down"),
      onBoard: (b) => useStore.getState().applyBoard(b),
      onActivity: (e) => useStore.getState().applyActivity(e),
    });
  }, [apiBase]);

  return (
    <div className="flex h-full w-full flex-col">
      <TopBar
        onSettings={() => setSettingsOpen(true)}
        onActivity={() => setRightTab("activity")}
        activityActive={rightTab === "activity"}
      />
      <AnimatePresence>
        {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      </AnimatePresence>
      <AlertsBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-h-0 flex-1 flex-col">
          <CenterTabs tab={centerTab} onTab={setCenterTab} />
          {centerTab === "board" ? <BoardView /> : <ThreadView goal={activeGoal} />}
        </main>
        <RightPanel tab={rightTab} onTab={setRightTab} />
      </div>
      {/* Board tab keeps the global composer; Thread has its own inline one. */}
      {centerTab === "board" && <ChatBar goal={activeGoal} />}
    </div>
  );
}
