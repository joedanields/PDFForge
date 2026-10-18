// Smoke test for a *built* PDFForge (release exe, frozen engine).
//
//   cd engine; uv run python -m tests.make_e2e_inputs <dir>
//   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"
//   & "app\src-tauri\target\release\pdfforge.exe"     # or the installed app
//   node e2e/release-smoke.mjs <dir> [--tools merge,rotate,...]
//
// Release builds have no file-injection seam, so after the Echo self-test (driven through the
// UI) each tool is submitted through the app's own run_job command — the same path the UI uses —
// and its output is confirmed via recent outputs. This exercises the frozen engine's native
// libraries (qpdf, PDFium, Pillow, libheif, ReportLab) end to end.
import { join } from "node:path";
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const dir = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--tools");
if (!dir) throw new Error("usage: node e2e/release-smoke.mjs <input-dir> [--tools a,b]");
const toolsIdx = args.indexOf("--tools");
const only = toolsIdx >= 0 ? new Set(args[toolsIdx + 1].split(",")) : null;
const f = (name) => join(dir, name);

/** method → params (paths are filled in from the generated e2e inputs). */
const JOBS = {
  merge: { inputs: [f("Chapter 1.pdf"), f("cover.png"), f("phone.heic")] },
  rotate: { inputs: [f("mixed.pdf")], options: { angle: 90, pages: "1-2" } },
  "remove-pages": { inputs: [f("mixed.pdf")], options: { pages: "2" } },
  "extract-pages": { inputs: [f("mixed.pdf")], options: { pages: "1,3", mode: "separate" } },
  split: { inputs: [f("mixed.pdf")], options: { mode: "fixed", every: 2 } },
  organize: {
    inputs: [f("Chapter 1.pdf")],
    options: {
      pages: [
        { src: 0, page: 2, rotate: 90 },
        { blank: true, width: 595, height: 842, rotate: 0 },
      ],
    },
  },
  "image-to-pdf": { inputs: [f("photo.jpg"), f("phone.heic")], options: { page_size: "a4" } },
  "pdf-to-image": { inputs: [f("mixed.pdf")], options: { dpi: 72, format: "png", pages: "1-2" } },
  "page-numbers": { inputs: [f("mixed.pdf")], options: { format: "page_n_of_total" } },
  watermark: { inputs: [f("mixed.pdf")], options: { text: "RELEASE", tile: true } },
  compress: { inputs: [f("bigscan.pdf")], options: { level: "recommended" } },
  protect: { inputs: [f("mixed.pdf")], secrets: { user_password: "release-pw" } },
  unlock: { inputs: [f("secret.pdf")], passwords: { [f("secret.pdf")]: "pw123" } },
};

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = browser
  .contexts()
  .flatMap((c) => c.pages())
  .find((p) => /tauri\.localhost|localhost:1420/.test(p.url()));
if (!page) throw new Error("PDFForge window not found on port 9222");
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const invoke = (cmd, args = {}) =>
  page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);

await page.waitForFunction(
  async () => (await window.__TAURI_INTERNALS__.invoke("engine_status")).state === "ready",
  null,
  { timeout: 90_000 },
);
const status = await invoke("engine_status");
console.log(`engine ${status.engineVersion} (protocol ${status.protocolVersion}) ready`);

// Echo through the real UI.
await page.evaluate(() => (window.location.hash = "#/tool/echo"));
await page.getByLabel("Steps").fill("4");
await page.getByLabel("Delay per step (ms)").fill("50");
await page.getByRole("button", { name: "Run self-test" }).click();
await page.getByText("Done!").waitFor({ timeout: 30_000 });
console.log("  ✓ echo (UI)");

let failed = 0;
for (const [method, params] of Object.entries(JOBS)) {
  if (only && !only.has(method)) continue;
  const id = `job-release-${method}-${Date.now()}`;
  const started = Date.now();
  const before = (await invoke("list_recents", { limit: 1 }))[0]?.createdAt ?? 0;
  await invoke("run_job", { id, method, params });
  let recent = null;
  while (Date.now() - started < 120_000) {
    const [latest] = await invoke("list_recents", { limit: 1 });
    if (latest && latest.createdAt > before && latest.tool === method) {
      recent = latest;
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (recent && recent.exists) {
    console.log(
      `  ✓ ${method.padEnd(14)} ${((Date.now() - started) / 1000).toFixed(1)} s → ${recent.path.split(/[\\/]/).pop()}`,
    );
  } else {
    failed += 1;
    console.log(`  ✗ ${method}: no output within 120 s`);
  }
}
if (errors.length) console.log(`page errors: ${errors.join(" | ")}`);
await browser.close();
if (failed || errors.length) process.exit(1);
console.log("\nRELEASE SMOKE PASSED");
