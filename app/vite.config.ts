import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The LoopForge server the GUI talks to; overridable for dev against any port.
const API = process.env.LOOPFORGE_API ?? "http://127.0.0.1:4733";

// Built assets are served by the LoopForge server under /app, so use a matching base.
export default defineConfig({
  base: "/app/",
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: API, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
