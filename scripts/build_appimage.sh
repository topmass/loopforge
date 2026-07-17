#!/usr/bin/env bash
# Build a self-contained LoopForge AppImage: the Deno runtime + this repo's
# engine + the built React GUI + the python bridge scripts, launched through
# AppRun so `loopforge.appimage` behaves exactly like the `loopforge` CLI
# (cwd is preserved; bare invocation serves the GUI and opens the browser).
#
# Usage: scripts/build_appimage.sh [output-dir]   (default: dist-appimage/)
# Produces <output-dir>/loopforge.appimage
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/dist-appimage}"
APPDIR="$OUT/LoopForge.AppDir"
DENO_BIN="${DENO_BIN:-$HOME/.deno/bin/deno}"
[ -x "$DENO_BIN" ] || DENO_BIN="$(command -v deno)"

echo "==> building GUI"
(cd "$ROOT/app" && pnpm install --silent && pnpm build >/dev/null)

echo "==> staging AppDir"
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/bin" "$APPDIR/usr/lib/loopforge/app"
cp "$DENO_BIN" "$APPDIR/usr/bin/deno"
rsync -a --exclude node_modules "$ROOT/src" "$ROOT/scripts" "$ROOT/deno.json" \
  "$APPDIR/usr/lib/loopforge/"
rsync -a "$ROOT/app/dist" "$APPDIR/usr/lib/loopforge/app/"

cat > "$APPDIR/AppRun" <<'RUN'
#!/bin/bash
set -euo pipefail
HERE="$(dirname "$(readlink -f "$0")")"
# Writable transpile cache outside the read-only mount; no network deps exist.
export DENO_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/loopforge-appimage-deno"
exec "$HERE/usr/bin/deno" run --no-lock \
  --allow-read --allow-write --allow-run --allow-net --allow-env \
  "$HERE/usr/lib/loopforge/src/cli.ts" "$@"
RUN
chmod +x "$APPDIR/AppRun"

cp "$ROOT/.github/icon.png" "$APPDIR/loopforge.png"
cat > "$APPDIR/loopforge.desktop" <<'DESK'
[Desktop Entry]
Type=Application
Name=LoopForge
Comment=Local Kanban for coding agents - loops that prove they are done
Exec=loopforge
Icon=loopforge
Terminal=false
Categories=Development;
DESK

echo "==> fetching appimagetool (cached)"
TOOLDIR="${XDG_CACHE_HOME:-$HOME/.cache}/loopforge-build"
TOOL="$TOOLDIR/appimagetool"
if [ ! -x "$TOOL" ]; then
  mkdir -p "$TOOLDIR"
  curl -fsSL -o "$TOOL" \
    "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage"
  chmod +x "$TOOL"
fi

echo "==> packing"
mkdir -p "$OUT"
ARCH=x86_64 "$TOOL" --appimage-extract-and-run "$APPDIR" "$OUT/loopforge.appimage" >/dev/null
echo "built: $OUT/loopforge.appimage"
