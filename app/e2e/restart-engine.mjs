// Dev helper: restart the engine (e.g. after adding a tool) via the Echo crash hook; the app's
// watchdog starts a fresh engine with the current code.  node e2e/restart-engine.mjs
import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = browser
  .contexts()
  .flatMap((c) => c.pages())
  .find((p) => /localhost:1420|tauri\.localhost/.test(p.url()));
if (!page) throw new Error("PDFForge window not found on port 9222");
const before = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("engine_status"));
await page.evaluate(() =>
  window.__TAURI_INTERNALS__.invoke("run_job", {
    id: `job-restart-${Date.now()}`,
    method: "echo",
    params: { crash: "engine" },
  }),
);
await page.waitForFunction(
  async (restarts) => {
    const s = await window.__TAURI_INTERNALS__.invoke("engine_status");
    return s.state === "ready" && s.restarts > restarts;
  },
  before.restarts,
  { timeout: 60_000 },
);
console.log("engine restarted");
await browser.close();
