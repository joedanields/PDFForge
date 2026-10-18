/// <reference types="vitest/config" />
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Dev server only: when its live-reload socket reconnects, Vite's client pings through a
 * SharedWorker created from a blob URL. That worker lingers in the WebView and breaks the
 * Playwright-over-WebView2 smoke test (it cannot attach to it). Hiding SharedWorker before
 * the client runs makes Vite use its plain polling fallback. Never part of a production build.
 */
function noDevSharedWorker(): Plugin {
  return {
    name: "pdfforge:no-dev-shared-worker",
    apply: "serve",
    transformIndexHtml: () => [
      {
        tag: "script",
        children: "window.SharedWorker = undefined;",
        injectTo: "head-prepend",
      },
    ],
  };
}

const host = process.env.TAURI_DEV_HOST;

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [react(), noDevSharedWorker()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host ?? false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "es2022",
    minify: process.env.TAURI_ENV_DEBUG ? false : "oxc",
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
