# LoopForge GUI

The desktop/web dashboard for LoopForge. React + Vite + TypeScript + Tailwind, with
react-three-fiber for the planet/node view. It is a pure client of the LoopForge server API
(REST + the SSE /api/events stream + /api/lifecycle) - no orchestration logic lives here.

## Run it (verified path)

One command starts the server and opens the GUI in your browser:

    loopforge gui            # in your project folder; starts the server + opens /app
    loopforge gui --no-open  # just serve it; open the printed URL yourself

Dev with hot reload (server on one port, Vite proxying /api to it):

    loopforge -C ~/your/project serve --port 4733   # terminal 1
    cd app && pnpm install && pnpm dev               # terminal 2 (proxies to 4733)

pnpm build emits dist/, which the LoopForge server serves under /app/.

## Native desktop app (Tauri)

src-tauri/ is the Tauri v2 shell that wraps the same frontend into a native window and manages
the server lifecycle (spawn on launch, kill on quit). Building it needs the Tauri Linux webview
dependencies on the build machine:

    # Fedora/Nobara
    sudo dnf install webkit2gtk4.1-devel gtk3-devel libsoup3-devel
    cd app && pnpm tauri build      # or: pnpm tauri dev

Until those libs are present, use `loopforge gui` (above) - identical UI, browser-hosted.

## Layout

- src/api.ts - REST + SSE client.
- src/store.ts - Zustand store fed by SSE; the single source for every view.
- src/types.ts - board + lifecycle shapes.
- src/App.tsx - top bar, spaces sidebar, Kanban/Node views, detail panel, chat bar.
- src-tauri/ - native window shell (optional).
