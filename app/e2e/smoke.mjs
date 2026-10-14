// E2E smoke test against the running desktop app over WebView2's DevTools port
// (docs/07_TESTING.md §1, "Playwright on WebView2").
//
//   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"; pnpm tauri dev
//   node e2e/smoke.mjs <folder-with-inputs> [--shots <dir>] [--echo-only]
//
// The folder must contain: "Chapter 1.pdf" (3 pages), "Chapter 2.pdf" (2 pages), "cover.png",
// "secret.pdf" (2 pages, password "pw123"). The merge part needs a dev build (file-injection seam);
// --echo-only runs just the engine self-test, which also works on the built .exe.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const inputDir = args.find((a) => !a.startsWith("--"));
const shotsIdx = args.indexOf("--shots");
const shots = shotsIdx >= 0 ? args[shotsIdx + 1] : null;
const echoOnly = args.includes("--echo-only");
if (!inputDir && !echoOnly) throw new Error("usage: node e2e/smoke.mjs <input-dir>");
if (shots) mkdirSync(shots, { recursive: true });

let step = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
async function shot(page, name) {
  if (shots)
    await page.screenshot({ path: join(shots, `${String(++step).padStart(2, "0")}-${name}.png`) });
}
function expect(cond, msg) {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  ok(msg);
}

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = browser
  .contexts()
  .flatMap((c) => c.pages())
  .find((p) => /localhost:1420|tauri\.localhost/.test(p.url()));
if (!page) throw new Error("PDFForge window not found on port 9222");
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
await page.setViewportSize({ width: 1400, height: 900 }).catch(() => {});

const go = async (hash) => {
  await page.evaluate((h) => (window.location.hash = h), hash);
  await page.waitForTimeout(300);
};

console.log("Engine");
await page.reload();
await page.getByText(/Every PDF job/).waitFor();
await page.waitForFunction(
  async () => {
    const s = await window.__TAURI_INTERNALS__.invoke("engine_status");
    return s.state === "ready";
  },
  null,
  { timeout: 60_000 },
);
ok("engine ready");

if (!echoOnly) {
  console.log("Home");
  await go("#/");
  const cards = await page.locator("main ul li").count();
  expect(cards >= 31, `tool grid shows ${cards} cards (31 tools + recents)`);
  expect((await page.getByText("Coming soon").count()) === 30, "30 tools badged 'Coming soon'");
  await shot(page, "home");
  await page.getByRole("button", { name: "Security", exact: true }).click();
  expect((await page.locator("main > div > ul > li").count()) === 5, "Security chip shows 5 tools");
  await page.getByRole("button", { name: "All", exact: true }).click();

  await page.keyboard.press("Control+k");
  await page.getByPlaceholder("Search tools…").first().fill("combine");
  await shot(page, "ctrl-k");
  await page.keyboard.press("Enter");
  await page.waitForURL(/#\/tool\/merge/);
  ok("Ctrl+K → 'combine' → Enter opens Merge PDF");

  console.log("Merge");
  const run = page.getByRole("button", { name: "Merge PDF", exact: true });
  expect(await run.isDisabled(), "Run disabled with no files");
  const names = ["Chapter 2.pdf", "Chapter 1.pdf", "cover.png", "secret.pdf"];
  await page.evaluate(
    (paths) => window.dispatchEvent(new CustomEvent("pdfforge:test-add-files", { detail: paths })),
    names.map((n) => join(inputDir, n)),
  );
  await page.getByText("3 pages").waitFor();
  await page.getByText("Password protected").waitFor();
  expect(await run.isDisabled(), "Run disabled while a file is locked");
  await shot(page, "merge-locked");
  await page.getByLabel("Password: secret.pdf").fill("wrong");
  await page.getByRole("button", { name: "Unlock" }).click();
  await page.getByText("That password didn't work.").waitFor();
  ok("wrong password rejected inline");
  await page.getByLabel("Password: secret.pdf").fill("pw123");
  await page.getByRole("button", { name: "Unlock" }).click();
  await page.waitForFunction(() => !document.body.innerText.includes("Password protected"));
  ok("correct password unlocks the file");
  try {
    await page.waitForFunction(() => document.querySelectorAll("main ol img").length === 4, null, {
      timeout: 15_000,
    });
  } catch {
    console.log("    card states:", await page.locator("main ol li").allInnerTexts());
  }
  const thumbs = await page.locator("main ol img").count();
  expect(thumbs === 4, `4 thumbnails rendered (got ${thumbs})`);
  await page.getByRole("button", { name: "Sort by name" }).click();
  const order = await page.locator("main ol li p.truncate").allInnerTexts();
  expect(
    order.join("|") === "Chapter 1.pdf|Chapter 2.pdf|cover.png|secret.pdf",
    `sorted: ${order.join(", ")}`,
  );
  await page.getByRole("switch", { name: "Add a bookmark per file" }).click();
  await shot(page, "merge-ready");
  await run.click();
  await page.getByText("Done!").waitFor({ timeout: 30_000 });
  const resultText = await page.locator("main section").innerText();
  expect(/Chapter 1_merge( \(\d+\))?\.pdf/.test(resultText), "result shows Chapter 1_merge*.pdf");
  expect(resultText.includes("8 pages"), "merged page count = 3 + 2 + 1 + 2 = 8");
  await shot(page, "merge-result");
  const out = await page.locator("main section p.truncate").first().getAttribute("title");
  const recents = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("list_recents", { limit: 8 }),
  );
  expect(
    recents[0]?.path === out && recents[0]?.tool === "merge",
    "output recorded in recent outputs (SQLite)",
  );
  await page.getByRole("button", { name: "Start over" }).click();
  await page.getByRole("button", { name: "Select files" }).waitFor();
  ok("Start over returns to the drop zone");
  await go("#/");
  await page.getByText(out.split(/[\\/]/).pop()).first().waitFor();
  ok("Home recent strip lists the output");
  await shot(page, "home-recent");
}

console.log("Engine self-test (Echo)");
await go("#/tool/echo");
await page.getByLabel("Steps").fill("50");
await page.getByLabel("Delay per step (ms)").fill("100");
await page.getByRole("button", { name: "Run self-test" }).click();
await page
  .getByRole("dialog")
  .getByText(/Step \d+ of 50/)
  .waitFor();
await shot(page, "echo-progress");
await page.getByRole("button", { name: "Cancel" }).click();
await page.getByText("Cancelled. Nothing was saved.").waitFor();
ok("progress overlay + Cancel → 'Cancelled'");
await page.getByLabel("Steps").fill("5");
await page.getByLabel("Delay per step (ms)").fill("50");
await page.keyboard.press("Control+Enter");
await page.getByText("Done!").waitFor();
expect(
  (await page.locator("main section").innerText()).includes("Hello from PDFForge"),
  "Ctrl+Enter runs Echo end to end",
);
await shot(page, "echo-done");

if (!echoOnly) {
  console.log("Settings");
  await go("#/settings");
  await page.getByLabel("Theme").click();
  await page.getByRole("option", { name: "Dark" }).click();
  await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
  const saved = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("get_settings"));
  expect(saved.theme === "dark", "dark theme applied and saved to settings.json");
  await shot(page, "settings-dark");
  await go("#/");
  await shot(page, "home-dark");
  await go("#/settings");
  await page.getByLabel("Theme").click();
  await page.getByRole("option", { name: "Match Windows" }).click();
}

const relevant = errors.filter((e) => !/Download the React DevTools/.test(e));
expect(
  relevant.length === 0,
  `no console errors${relevant.length ? `: ${relevant.join(" | ")}` : ""}`,
);
console.log("\nSMOKE PASSED");
await browser.close();
