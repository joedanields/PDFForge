// E2E smoke test against the running desktop app over WebView2's DevTools port
// (docs/07_TESTING.md §1, "Playwright on WebView2").
//
//   cd engine; uv run python -m tests.make_e2e_inputs <dir>
//   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"; pnpm tauri dev
//   node e2e/smoke.mjs <dir> [--shots <dir>] [--only home,merge,...] [--echo-only]
//
// File-based sections need a dev build (file-injection seam). --echo-only runs just the engine
// self-test, which also works against the built .exe.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

/** Tools that are no longer "Coming soon" (update as Phase 1 lands). */
const AVAILABLE = [
  "merge",
  "rotate",
  "remove-pages",
  "extract-pages",
  "split",
  "organize",
  "image-to-pdf",
];
const TOTAL_TOOLS = 31;

const args = process.argv.slice(2);
const inputDir = args.find(
  (a, i) => !a.startsWith("--") && !["--shots", "--only"].includes(args[i - 1]),
);
const shotsIdx = args.indexOf("--shots");
const shots = shotsIdx >= 0 ? args[shotsIdx + 1] : null;
const onlyIdx = args.indexOf("--only");
const only = onlyIdx >= 0 ? new Set(args[onlyIdx + 1].split(",")) : null;
const echoOnly = args.includes("--echo-only");
if (!inputDir && !echoOnly) throw new Error("usage: node e2e/smoke.mjs <input-dir>");
if (shots) mkdirSync(shots, { recursive: true });

let step = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
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

// ── helpers ──────────────────────────────────────────────────────────────────────────────────
async function shot(name) {
  if (shots)
    await page.screenshot({ path: join(shots, `${String(++step).padStart(2, "0")}-${name}.png`) });
}
async function go(hash) {
  await page.evaluate((h) => (window.location.hash = h), hash);
  await page.waitForTimeout(300);
}
async function addFiles(...names) {
  await page.evaluate(
    (paths) => window.dispatchEvent(new CustomEvent("pdfforge:test-add-files", { detail: paths })),
    names.map((n) => join(inputDir, n)),
  );
}
const tile = (n) => page.getByRole("option", { name: `Page ${n}`, exact: true });
async function waitForTiles(count) {
  await page.waitForFunction(
    (n) => document.querySelectorAll('[role="option"][data-tile]').length === n,
    count,
  );
}
async function waitForThumbs(count) {
  await page.waitForFunction(
    (n) => document.querySelectorAll('[role="listbox"] img').length >= n,
    count,
    { timeout: 20_000 },
  );
}
async function runAndWait(label) {
  await page.getByRole("button", { name: label, exact: true }).click();
  await page.getByText("Done!").waitFor({ timeout: 60_000 });
  return page.locator("main section").innerText();
}
async function startOver() {
  await page.getByRole("button", { name: "Start over" }).click();
  await page.getByRole("button", { name: "Select files" }).waitFor();
}
const section = (name) => !echoOnly && (!only || only.has(name));

// ── engine ───────────────────────────────────────────────────────────────────────────────────
console.log("Engine");
await go("#/");
await page.reload();
await page.getByText(/Every PDF job/).waitFor();
await page.waitForFunction(
  async () => (await window.__TAURI_INTERNALS__.invoke("engine_status")).state === "ready",
  null,
  { timeout: 60_000 },
);
ok("engine ready");

if (section("home")) {
  console.log("Home");
  await go("#/");
  const soon = await page.getByText("Coming soon").count();
  expect(soon === TOTAL_TOOLS - AVAILABLE.length, `${soon} tools badged 'Coming soon'`);
  await shot("home");
  await page.getByRole("button", { name: "Security", exact: true }).click();
  expect((await page.locator("main > div > ul > li").count()) === 5, "Security chip shows 5 tools");
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.keyboard.press("Control+k");
  await page.getByPlaceholder("Search tools…").first().fill("combine");
  await page.keyboard.press("Enter");
  await page.waitForURL(/#\/tool\/merge/);
  ok("Ctrl+K → 'combine' → Enter opens Merge PDF");
}

if (section("merge")) {
  console.log("Merge");
  await go("#/tool/merge");
  const run = page.getByRole("button", { name: "Merge PDF", exact: true });
  expect(await run.isDisabled(), "Run disabled with no files");
  await addFiles("Chapter 2.pdf", "Chapter 1.pdf", "cover.png", "secret.pdf");
  await page.getByText("3 pages").waitFor();
  await page.getByText("Password protected").waitFor();
  expect(await run.isDisabled(), "Run disabled while a file is locked");
  await page.getByLabel("Password: secret.pdf").fill("wrong");
  await page.getByRole("button", { name: "Unlock" }).click();
  await page.getByText("That password didn't work.").waitFor();
  ok("wrong password rejected inline");
  await page.getByLabel("Password: secret.pdf").fill("pw123");
  await page.getByRole("button", { name: "Unlock" }).click();
  await page.waitForFunction(() => !document.body.innerText.includes("Password protected"));
  ok("correct password unlocks the file");
  await page.waitForFunction(() => document.querySelectorAll("main ol img").length === 4, null, {
    timeout: 20_000,
  });
  ok("4 thumbnails rendered");
  await page.getByRole("button", { name: "Sort by name" }).click();
  const order = await page.locator("main ol li p.truncate").allInnerTexts();
  expect(
    order.join("|") === "Chapter 1.pdf|Chapter 2.pdf|cover.png|secret.pdf",
    `sorted: ${order.join(", ")}`,
  );
  await page.getByRole("switch", { name: "Add a bookmark per file" }).click();
  await shot("merge-ready");
  const text = await runAndWait("Merge PDF");
  expect(/Chapter 1_merge( \(\d+\))?\.pdf/.test(text), "result shows Chapter 1_merge*.pdf");
  expect(text.includes("8 pages"), "merged page count = 3 + 2 + 1 + 2 = 8");
  expect(
    text.includes("Some files were password-protected. The merged file has no protection."),
    "warns that the protected input's protection is not carried over",
  );
  await shot("merge-result");
  const out = await page.locator("main section p.truncate").first().getAttribute("title");
  const recents = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("list_recents", { limit: 8 }),
  );
  expect(
    recents[0]?.path === out && recents[0]?.tool === "merge",
    "output recorded in recent outputs (SQLite)",
  );
  await startOver();
  ok("Start over returns to the drop zone");
  await go("#/");
  await page.getByText(out.split(/[\\/]/).pop()).first().waitFor();
  ok("Home recent strip lists the output");
}

if (section("rotate")) {
  console.log("Rotate");
  await go("#/tool/rotate");
  await addFiles("mixed.pdf");
  await waitForTiles(5);
  await waitForThumbs(5);
  ok("page grid shows 5 lazily rendered thumbnails");
  const pages = page.getByLabel("Pages", { exact: true });
  await tile(2).click();
  await tile(4).click({ modifiers: ["Shift"] });
  expect((await pages.inputValue()) === "2-4", "click + Shift-click selects pages 2-4");
  await tile(3).click({ modifiers: ["Control"] });
  expect((await pages.inputValue()) === "2,4", "Ctrl-click deselects page 3");
  await page.getByText("2 of 5 pages selected").waitFor();
  await pages.fill("9");
  await page.locator("#opt-pages-error").getByText("Page 9 doesn't exist").waitFor();
  expect(
    await page.getByRole("button", { name: "Rotate PDF", exact: true }).isDisabled(),
    "invalid range blocks Run",
  );
  await pages.fill("1, 5");
  expect(
    (await tile(1).getAttribute("aria-selected")) === "true",
    "typed range selects page 1 in the grid",
  );
  // Rubber band: drag across tiles 2 and 3 replaces the selection.
  const a = await tile(2).boundingBox();
  const b = await tile(3).boundingBox();
  await page.mouse.move(a.x - 6, a.y + 20);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + 40, { steps: 6 });
  await page.mouse.up();
  expect(
    (await pages.inputValue()) === "2-3",
    `drag-select picks pages 2-3 (got ${await pages.inputValue()})`,
  );
  await page.getByRole("radio", { name: "180°" }).click();
  const transform = await tile(2)
    .locator("img")
    .evaluate((img) => img.style.transform);
  expect(transform.includes("rotate(180deg)"), "selected pages preview the rotation");
  await shot("rotate-ready");
  const text = await runAndWait("Rotate PDF");
  expect(text.includes("Rotated 2 of 5 pages"), "result summary: Rotated 2 of 5 pages");
  expect(/mixed_rotate( \(\d+\))?\.pdf/.test(text), "output named mixed_rotate.pdf");
  await shot("rotate-result");
  await startOver();
  await addFiles("mixed.pdf");
  await waitForTiles(5);
  await page.getByLabel("Only rotate").click();
  await page.getByRole("option", { name: "Landscape pages" }).click();
  const text2 = await runAndWait("Rotate PDF");
  expect(
    text2.includes("Rotated 2 of 5 pages"),
    "orientation filter: only the 2 landscape pages rotate",
  );
}

if (section("remove")) {
  console.log("Remove pages");
  await go("#/tool/remove-pages");
  await addFiles("mixed.pdf");
  await waitForTiles(5);
  const run = page.getByRole("button", { name: "Remove pages", exact: true });
  expect(await run.isDisabled(), "Run disabled until pages are selected");
  await page.getByRole("button", { name: "Select all", exact: true }).click();
  await page.getByText("You can't remove every page — keep at least one.").waitFor();
  expect(await run.isDisabled(), "removing every page is blocked with a message (A3)");
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await tile(2).click();
  await tile(4).click({ modifiers: ["Control"] });
  expect(
    (await tile(2).getAttribute("class")).includes("ring-danger"),
    "pages to remove are marked in red",
  );
  await shot("remove-ready");
  const text = await runAndWait("Remove pages");
  expect(text.includes("Removed 2 pages · 3 left"), "result: Removed 2 pages · 3 left");
  expect(/mixed_remove( \(\d+\))?\.pdf/.test(text), "output named mixed_remove.pdf");
  await startOver();
  await addFiles("secret.pdf");
  await page.getByLabel("Password: secret.pdf").fill("pw123");
  await page.getByRole("button", { name: "Unlock" }).click();
  await waitForTiles(2);
  await tile(1).click();
  const text2 = await runAndWait("Remove pages");
  expect(
    text2.includes("The original file was password-protected. The new file has no protection."),
    "protected input: result warns the new file is unprotected",
  );
}

if (section("extract")) {
  console.log("Extract pages");
  await go("#/tool/extract-pages");
  await addFiles("mixed.pdf");
  await waitForTiles(5);
  await page.getByLabel("Pages to extract").fill("1-3");
  expect(
    !(await page.getByText("Put the files in a .zip").isVisible()),
    "zip option hidden for 'One PDF'",
  );
  const single = await runAndWait("Extract pages");
  expect(single.includes("Extracted 3 pages"), "one PDF with 3 pages");
  expect(/mixed_extract( \(\d+\))?\.pdf/.test(single), "output named mixed_extract.pdf");
  await startOver();
  await addFiles("mixed.pdf");
  await waitForTiles(5);
  await tile(1).click();
  await tile(5).click({ modifiers: ["Control"] });
  await page.getByRole("radio", { name: "One PDF per page" }).click();
  await page.getByText("Put the files in a .zip").waitFor();
  ok("zip option appears for 'One PDF per page'");
  const separate = await runAndWait("Extract pages");
  expect(separate.includes("Extracted 2 pages into 2 files"), "two single-page PDFs");
  expect(/2 files in “mixed_extract( \(\d+\))?”/.test(separate), "files delivered in a new folder");
  expect(
    await page.getByRole("button", { name: "Open folder" }).isVisible(),
    "result offers Open folder",
  );
  await shot("extract-result");
  const recents = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("list_recents", { limit: 1 }),
  );
  expect(
    /mixed_extract( \(\d+\))?$/.test(recents[0]?.path ?? ""),
    "recent outputs remember the folder",
  );
}

if (section("split")) {
  console.log("Split");
  await go("#/tool/split");
  await addFiles("mixed.pdf");
  await waitForTiles(5);
  const ranges = page.getByLabel("Ranges", { exact: true });
  await ranges.fill("1-3, 9");
  expect(
    (await ranges.getAttribute("aria-invalid")) === "true",
    "invalid range highlighted live (A2)",
  );
  await page.locator("#opt-ranges-error").getByText("Page 9 doesn't exist").waitFor();
  expect(
    await page.getByRole("button", { name: "Split PDF", exact: true }).isDisabled(),
    "invalid ranges block Run",
  );
  await ranges.fill("1-3, 5");
  expect((await ranges.getAttribute("aria-invalid")) === null, "valid ranges clear the error");
  expect((await tile(2).innerText()).includes("File 1"), "page 2 badged File 1");
  expect((await tile(5).innerText()).includes("File 2"), "page 5 badged File 2");
  await shot("split-ready");
  const text = await runAndWait("Split PDF");
  expect(text.includes("Split into 2 files"), "split by ranges → 2 files");
  expect(/2 files in “mixed_split( \(\d+\))?”/.test(text), "delivered in a mixed_split folder");
  await startOver();
  await addFiles("mixed.pdf");
  await waitForTiles(5);
  await page.getByLabel("Split", { exact: true }).click();
  await page.getByRole("option", { name: "Every N pages" }).click();
  await page.getByLabel("Pages per file").fill("2");
  expect((await tile(5).innerText()).includes("File 3"), "every 2 pages: page 5 → File 3");
  const text2 = await runAndWait("Split PDF");
  expect(text2.includes("Split into 3 files"), "every 2 pages → 3 files");
}

if (section("organize")) {
  console.log("Organize");
  await go("#/tool/organize");
  await addFiles("Chapter 1.pdf");
  await waitForTiles(3);
  const labels = () =>
    page
      .locator('[role="option"][data-tile]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  const button = (name) => page.getByRole("toolbar").getByRole("button", { name, exact: true });
  await tile(1).click();
  await button("Rotate right").click();
  await page.waitForFunction(() =>
    document.querySelector('[aria-label="Page 1"] img')?.style.transform.includes("rotate(90deg)"),
  );
  ok("rotate right previews on the page");
  await tile(3).click();
  await button("Duplicate").click();
  await waitForTiles(4);
  ok("duplicate adds a copy");
  await tile(2).click();
  await button("Delete").click();
  await waitForTiles(3);
  await page.keyboard.press("Control+z");
  await waitForTiles(4);
  await page.keyboard.press("Control+y");
  await waitForTiles(3);
  ok("delete, Ctrl+Z, Ctrl+Y");
  await button("Blank page").click();
  await waitForTiles(4);
  ok("blank page inserted");
  await tile(1).click();
  await addFiles("Chapter 2.pdf");
  await waitForTiles(6);
  const order = await labels();
  expect(
    order.join(",") === "Page A1,Page B1,Page B2,Page A3,Page A3,Page Blank",
    `second PDF inserted after the selected page (${order.join(", ")})`,
  );
  // Drag the blank page to the front.
  const from = await page.getByRole("option", { name: "Page Blank" }).boundingBox();
  const to = await page.getByRole("option", { name: "Page A1" }).boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 - 20, from.y + from.height / 2, { steps: 4 });
  await page.mouse.move(to.x + 10, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction(
    () =>
      document.querySelector('[role="option"][data-tile]')?.getAttribute("aria-label") ===
      "Page Blank",
  );
  ok("drag-to-reorder moves the blank page first");
  await page.getByRole("option", { name: "Page B2" }).hover();
  await page.getByRole("button", { name: "Move page B2 right" }).click();
  expect((await labels()).indexOf("Page B2") === 4, "per-page move button (keyboard accessible)");
  await shot("organize-ready");
  const text = await runAndWait("Save PDF");
  expect(text.includes("6 pages from 2 files"), "saved: 6 pages from 2 files");
  expect(/Chapter 1_organize( \(\d+\))?\.pdf/.test(text), "output named Chapter 1_organize.pdf");
}

if (section("images")) {
  console.log("Image to PDF");
  await go("#/tool/image-to-pdf");
  await addFiles("photo.jpg", "cover.png", "phone.heic");
  await page.waitForFunction(() => document.querySelectorAll("main ol li").length === 3);
  await page.waitForFunction(() => !document.body.innerText.includes("couldn't be read"));
  ok("JPG, PNG and HEIC accepted");
  expect(
    !(await page.getByText("Orientation").isVisible()),
    "orientation only shown for fixed page sizes",
  );
  await page.getByRole("radio", { name: "A4" }).click();
  await page.getByText("Orientation").waitFor();
  await page.getByRole("radio", { name: "Small" }).click();
  await shot("images-ready");
  const text = await runAndWait("Convert to PDF");
  expect(text.includes("3 images → 3 pages"), "3 images → 3 pages");
  expect(/photo_images( \(\d+\))?\.pdf/.test(text), "output named photo_images.pdf");
  await startOver();
  await addFiles("photo.jpg", "cover.png");
  await page.waitForFunction(() => document.querySelectorAll("main ol li").length === 2);
  await page.getByRole("radio", { name: "One PDF per image" }).click();
  const text2 = await runAndWait("Convert to PDF");
  expect(text2.includes("2 images → 2 PDFs"), "one PDF per image");
}

if (!only || only.has("echo") || echoOnly) {
  console.log("Engine self-test (Echo)");
  await go("#/tool/echo");
  await page.getByLabel("Steps").fill("50");
  await page.getByLabel("Delay per step (ms)").fill("100");
  await page.getByRole("button", { name: "Run self-test" }).click();
  await page
    .getByRole("dialog")
    .getByText(/Step \d+ of 50/)
    .waitFor();
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
}

if (section("settings")) {
  console.log("Settings");
  await go("#/settings");
  await page.getByLabel("Theme").click();
  await page.getByRole("option", { name: "Dark" }).click();
  await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
  const saved = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("get_settings"));
  expect(saved.theme === "dark", "dark theme applied and saved to settings.json");
  await go("#/");
  await shot("home-dark");
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
