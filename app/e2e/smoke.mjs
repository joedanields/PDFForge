// E2E smoke test against the running desktop app over WebView2's DevTools port
// (docs/07_TESTING.md §1, "Playwright on WebView2").
//
//   cd engine; uv run python -m tests.make_e2e_inputs <dir>
//   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"; pnpm tauri dev
//   node e2e/smoke.mjs <dir> [--shots <dir>] [--only home,merge,...] [--echo-only]
//
// File-based sections need a dev build (file-injection seam). --echo-only runs just the engine
// self-test, which also works against the built .exe.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
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
  "pdf-to-image",
  "protect",
  "unlock",
  "page-numbers",
  "watermark",
  "compress",
  "word-to-pdf",
  "powerpoint-to-pdf",
  "excel-to-pdf",
  "pdf-to-word",
  "pdf-to-powerpoint",
  "pdf-to-excel",
  "pdf-to-text",
  "text-to-pdf",
  "repair",
  "html-to-pdf",
  "pdf-to-pdfa",
  "ocr",
  "edit-pdf",
  "sign",
  "crop",
  "redact",
  "compare",
  "fill-forms",
  "url-to-pdf",
];
const TOTAL_TOOLS = 32;

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
  await page.waitForTimeout(250); // let CSS transitions settle
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
  return page.locator("main section[aria-live=polite]").innerText();
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

if (section("toimage")) {
  console.log("PDF to Image");
  await go("#/tool/pdf-to-image");
  await addFiles("mixed.pdf");
  await waitForTiles(5);
  await tile(2).click();
  await tile(3).click({ modifiers: ["Shift"] });
  await page.getByRole("radio", { name: "PNG" }).click();
  await page.getByRole("radio", { name: "72 dpi" }).click();
  const text = await runAndWait("Convert to images");
  expect(text.includes("2 pages → PNG at 72 dpi"), "2 selected pages rendered as PNG");
  expect(/2 files in “mixed_images( \(\d+\))?”/.test(text), "images delivered in a new folder");
  await startOver();
  await addFiles("scan.pdf");
  await waitForTiles(2);
  await page.getByRole("radio", { name: "Extract pictures" }).click();
  expect(!(await page.getByText("Resolution").isVisible()), "render options hidden for extraction");
  const text2 = await runAndWait("Convert to images");
  expect(text2.includes("Extracted 2 images"), "embedded pictures extracted");
}

if (section("protect")) {
  console.log("Protect (from a merge with a protected input)");
  await go("#/tool/merge");
  await addFiles("Chapter 2.pdf", "secret.pdf");
  await page.getByLabel("Password: secret.pdf").fill("pw123");
  await page.getByRole("button", { name: "Unlock" }).click();
  await page.waitForFunction(() => !document.body.innerText.includes("Password protected"));
  await runAndWait("Merge PDF");
  const merged = await page.locator("main section p.truncate").first().getAttribute("title");
  await page.getByRole("button", { name: "Protect this file" }).click();
  await page.waitForURL(/#\/tool\/protect/);
  await page.getByText(merged.split(/[\\/]/).pop()).first().waitFor();
  ok("'Protect this file' opens Protect with the merged file pre-loaded");
  const run = page.getByRole("button", { name: "Protect PDF", exact: true });
  await page.getByText("Set a password to open the file").waitFor();
  expect(await run.isDisabled(), "Run disabled until a password is set");
  await page.getByLabel("Password to open", { exact: true }).fill("password1");
  await page.getByText("Very weak").waitFor();
  await page.getByLabel("Password to open", { exact: true }).fill("Correct-Horse-7");
  await page.getByText("Strong").first().waitFor();
  ok("strength meter: Very weak → Strong");
  await page.getByLabel("Repeat the password", { exact: true }).fill("Correct-Horse-8");
  await page.locator("#opt-user_password_confirm-error").waitFor();
  expect(await run.isDisabled(), "mismatched confirmation blocks Run");
  await page.getByLabel("Repeat the password", { exact: true }).fill("Correct-Horse-7");
  await page.getByRole("switch", { name: "Allow copying text and images" }).click();
  await page.getByRole("radio", { name: "Low quality" }).click();
  await shot("protect-ready");
  const text = await runAndWait("Protect PDF");
  expect(text.includes("Password protected (AES-256)"), "result: Password protected (AES-256)");
  expect(/_protect( \(\d+\))?\.pdf/.test(text), "output named *_protect.pdf");
  const history = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("list_recents", { limit: 1 }),
  );
  expect(history[0]?.tool === "protect", "recorded in recent outputs");
}

if (section("unlock")) {
  console.log("Unlock");
  await go("#/tool/unlock");
  await addFiles("secret.pdf");
  await page.getByText("Password protected").waitFor();
  const run = page.getByRole("button", { name: "Unlock PDF", exact: true });
  expect(await run.isDisabled(), "Run disabled until the password is entered");
  await page.getByLabel("Password: secret.pdf").fill("pw123");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await page.waitForFunction(() => !document.body.innerText.includes("Password protected"));
  const text = await runAndWait("Unlock PDF");
  expect(/Password (and restrictions )?removed/.test(text), "result: password removed");
  expect(/secret_unlock( \(\d+\))?\.pdf/.test(text), "output named secret_unlock.pdf");
  await startOver();
  await addFiles("mixed.pdf");
  await page.waitForFunction(() => document.querySelectorAll("main ol img").length === 1);
  await page.getByRole("button", { name: "Unlock PDF", exact: true }).click();
  await page.getByText("mixed.pdf has no password or restrictions to remove").waitFor();
  ok("unprotected file: explained inline on the file card");
}

if (section("numbers")) {
  console.log("Page numbers");
  await go("#/tool/page-numbers");
  await addFiles("mixed.pdf");
  await page.waitForFunction(() => document.querySelectorAll("main ol img").length === 1);
  await page.getByRole("radio", { name: "Bottom right" }).click();
  await page.getByLabel("Format", { exact: true }).click();
  await page.getByRole("option", { name: "Custom…" }).click();
  await page.getByLabel("Custom format").fill("Page {n} / {total}");
  await page.getByLabel("Pages to number").fill("2-9");
  await page.locator("#opt-pages-error").waitFor();
  expect(
    await page.getByRole("button", { name: "Add page numbers" }).isDisabled(),
    "invalid page range blocks Run",
  );
  await page.getByLabel("Pages to number").fill("2-5");
  await page.getByLabel("Color").fill("#1a73e8");
  await shot("numbers-ready");
  const text = await runAndWait("Add page numbers");
  expect(text.includes("Numbered 4 pages (1–4)"), "result: Numbered 4 pages (1–4)");
  expect(/mixed_numbered( \(\d+\))?\.pdf/.test(text), "output named mixed_numbered.pdf");
}

if (section("watermark")) {
  console.log("Watermark");
  await go("#/tool/watermark");
  await addFiles("mixed.pdf");
  await page.waitForFunction(() => document.querySelectorAll("main ol img").length === 1);
  const text = page.getByLabel("Text", { exact: true });
  await text.fill("");
  await page.getByText("Enter the watermark text.").waitFor();
  expect(
    await page.getByRole("button", { name: "Add watermark" }).isDisabled(),
    "empty text blocks Run",
  );
  await text.fill("DRAFT");
  await page.getByRole("switch", { name: "Repeat across the page" }).click();
  expect(
    !(await page.getByRole("radiogroup", { name: "Position" }).isVisible()),
    "position hidden when tiled",
  );
  await page.getByRole("radio", { name: "Image" }).click();
  await page.getByText("No file chosen").waitFor();
  expect(
    await page.getByRole("button", { name: "Add watermark" }).isDisabled(),
    "image mode needs an image",
  );
  await page.getByRole("radio", { name: "Text" }).click();
  await shot("watermark-ready");
  const result = await runAndWait("Add watermark");
  expect(result.includes("Watermarked 5 pages"), "result: Watermarked 5 pages");
  expect(/mixed_watermark( \(\d+\))?\.pdf/.test(result), "output named mixed_watermark.pdf");
}

if (section("compress")) {
  console.log("Compress");
  await go("#/tool/compress");
  await addFiles("bigscan.pdf");
  await page.waitForFunction(() => document.querySelectorAll("main ol img").length === 1);
  expect(!(await page.getByText("JPEG quality").isVisible()), "custom settings hidden for presets");
  await page.getByLabel("Compression", { exact: true }).click();
  await page.getByRole("option", { name: "Custom…" }).click();
  await page.getByText("JPEG quality").waitFor();
  await page.getByLabel("Compression", { exact: true }).click();
  await page.getByRole("option", { name: /Recommended/ }).click();
  const text = await runAndWait("Compress PDF");
  expect(/\d+(\.\d+)? (KB|MB) → \d+(\.\d+)? (KB|MB)/.test(text), "shows original → new size");
  expect(/\d+% smaller/.test(text), "shows % saved");
  expect(text.includes("Recompressed 2 of 2 images"), "both scans recompressed");
  await shot("compress-result");
  const compressed = await page.locator("main section p.truncate").first().getAttribute("title");
  await startOver();
  // Compressing the result again cannot gain anything: the original must be kept.
  await page.evaluate(
    (path) => window.dispatchEvent(new CustomEvent("pdfforge:test-add-files", { detail: [path] })),
    compressed,
  );
  await page.waitForFunction(() => document.querySelectorAll("main ol img").length === 1);
  const kept = await runAndWait("Compress PDF");
  expect(
    kept.includes("already well optimized"),
    "no gain: original kept and the user is told (B1)",
  );
  expect(
    !(await page.getByRole("button", { name: "Open file" }).isVisible()),
    "no new file to open",
  );
}

if (section("office")) {
  console.log("Office to PDF");
  await go("#/tool/word-to-pdf");
  await addFiles("report.docx");
  await page.waitForFunction(() => document.querySelectorAll("main ol li").length === 1);
  const word = await runAndWait("Convert to PDF");
  expect(word.includes("3 pages"), "DOCX → 3 pages");
  expect(/report( \(\d+\))?\.pdf/.test(word), "output named report.pdf");
  await go("#/tool/powerpoint-to-pdf");
  await addFiles("deck.pptx");
  await page.waitForFunction(() => document.querySelectorAll("main ol li").length === 1);
  await page.getByLabel("Include speaker notes").click();
  const deck = await runAndWait("Convert to PDF");
  expect(deck.includes("6 pages"), "PPTX with notes → 3 slides + 3 notes pages");
  await go("#/tool/excel-to-pdf");
  await addFiles("book.xlsx");
  await page.waitForFunction(() => document.querySelectorAll("main ol li").length === 1);
  await page.getByRole("radio", { name: "Active sheet only" }).click();
  await page.getByLabel("Fit each sheet to the page width").click();
  await shot("excel-ready");
  const book = await runAndWait("Convert to PDF");
  expect(/\b1 page\b/.test(book), "active sheet fitted on one page");
}

if (section("frompdf")) {
  console.log("PDF to Word / Excel / PowerPoint / Text");
  await go("#/tool/pdf-to-word");
  await addFiles("invoice-scan.pdf");
  await page.waitForFunction(() => document.querySelectorAll("main ol li").length === 1);
  expect(!(await page.getByText("Document language").isVisible()), "language hidden without OCR");
  await page.getByLabel("Recognise text in scanned pages (OCR)").click();
  await page.getByText("Document language").waitFor();
  const word = await runAndWait("Convert to Word");
  expect(/invoice-scan( \(\d+\))?\.docx/.test(word), "scan → invoice-scan.docx");
  await go("#/tool/pdf-to-excel");
  await addFiles("annual.pdf");
  await page.waitForFunction(() => document.querySelectorAll("main ol img").length === 1);
  const excel = await runAndWait("Convert to Excel");
  expect(excel.includes("1 table found → 1 sheet"), "ruled table → one sheet");
  await go("#/tool/pdf-to-powerpoint");
  await addFiles("annual.pdf");
  await page.waitForFunction(() => document.querySelectorAll("main ol img").length === 1);
  const deck = await runAndWait("Convert to PowerPoint");
  expect(/annual( \(\d+\))?\.pptx/.test(deck) && deck.includes("2 pages"), "2 pages → PPTX");
  await go("#/tool/pdf-to-text");
  await addFiles("annual.pdf");
  await page.waitForFunction(() => document.querySelectorAll("main ol img").length === 1);
  const text = await runAndWait("Extract text");
  expect(/annual( \(\d+\))?\.txt/.test(text), "text extracted to annual.txt");
}

if (section("text")) {
  console.log("Text to PDF");
  await go("#/tool/text-to-pdf");
  await addFiles("notes.md");
  await page.waitForFunction(() => document.querySelectorAll("main ol li").length === 1);
  await page.getByRole("radio", { name: "Serif", exact: true }).click();
  const text = await runAndWait("Convert to PDF");
  expect(/notes( \(\d+\))?\.pdf/.test(text) && text.includes("1 page"), "Markdown → notes.pdf");
}

if (section("repair")) {
  console.log("Repair");
  await go("#/tool/repair");
  await addFiles("damaged.pdf");
  await page.waitForFunction(() => document.querySelectorAll("main ol li").length === 1);
  expect(
    !(await page.getByText("This file couldn't be read.").isVisible()),
    "damaged file accepted",
  );
  const text = await runAndWait("Repair PDF");
  expect(text.includes("Repaired — all 3 pages recovered"), "broken xref repaired");
  expect(/damaged_repaired( \(\d+\))?\.pdf/.test(text), "output damaged_repaired.pdf");
}

if (section("html")) {
  console.log("HTML to PDF");
  await go("#/tool/html-to-pdf");
  await addFiles("site/index.html");
  await page.waitForFunction(() => document.querySelectorAll("main ol li").length === 1);
  await page.getByRole("radio", { name: "Landscape" }).click();
  const text = await runAndWait("Convert to PDF");
  expect(/index( \(\d+\))?\.pdf/.test(text), "page → index.pdf");
  expect(text.includes("1 online resources left out"), "online picture left out and reported");
}

if (section("pdfa")) {
  console.log("PDF to PDF/A");
  await go("#/tool/pdf-to-pdfa");
  await addFiles("annual.pdf");
  await page.waitForFunction(() => document.querySelectorAll("main ol img").length === 1);
  const text = await runAndWait("Convert to PDF/A");
  expect(text.includes("PDF/A-2b · checked by PDFForge"), "converted to PDF/A-2b");
  expect(/annual_pdfa( \(\d+\))?\.pdf/.test(text), "output annual_pdfa.pdf");
}

if (section("ocr")) {
  console.log("OCR");
  await go("#/tool/ocr");
  await addFiles("invoice-scan.pdf");
  await page.waitForFunction(() => document.querySelectorAll("main ol img").length === 1);
  await page.getByRole("checkbox", { name: "Tamil" }).click();
  expect(
    (await page.getByRole("checkbox", { name: "English" }).getAttribute("aria-checked")) === "true",
    "English stays selected next to Tamil",
  );
  const text = await runAndWait("Make searchable");
  expect(text.includes("Text recognised on 1 page"), "scan made searchable");
  expect(/invoice-scan_ocr( \(\d+\))?\.pdf/.test(text), "output invoice-scan_ocr.pdf");
  await go("#/settings");
  await page.getByRole("list", { name: "OCR languages" }).waitFor();
  expect(
    (await page.getByRole("list", { name: "OCR languages" }).getByRole("listitem").count()) >= 3,
    "Settings lists the bundled OCR languages",
  );
}

if (section("viewer")) {
  console.log("Viewer");
  await go("#/");
  await page.getByRole("button", { name: "Open PDF" }).click();
  await page.getByRole("button", { name: "Open PDF…" }).waitFor();
  ok("Open PDF shows the viewer's start screen");
  const file = join(inputDir, "mixed.pdf");
  await go(`#/view?path=${encodeURIComponent(file)}`);
  const viewer = page.getByTestId("viewer-container");
  await page.waitForFunction(
    () => document.querySelectorAll("[data-testid=viewer-container] .page canvas").length >= 1,
    null,
    { timeout: 30_000 },
  );
  expect((await viewer.locator(".page").count()) === 5, "5 pages laid out");
  expect(
    (await page
      .getByRole("navigation", { name: "Page thumbnails" })
      .getByRole("listitem")
      .count()) === 5,
    "5 thumbnails",
  );
  await page.getByRole("button", { name: "Next page" }).click();
  await page.waitForFunction(
    () => document.querySelector("input[aria-label='Page number']")?.value === "2",
  );
  ok("next page → page 2");
  await page.getByLabel("Zoom", { exact: true }).selectOption("2");
  await page.waitForFunction(() => {
    const first = document.querySelector("[data-testid=viewer-container] .page");
    return first !== null && first.getBoundingClientRect().width > 1000;
  });
  ok("zoom 200%");
  await page.keyboard.press("Control+f");
  await page.getByLabel("Search in document").fill("page");
  await page.keyboard.press("Enter");
  await page.getByText(/^\d+ of 5$/).waitFor({ timeout: 15_000 });
  ok("find: match counter shown");
  expect(
    (await page.locator(".textLayer .highlight").count()) >= 1,
    "match highlighted in text layer",
  );
  await page.getByRole("button", { name: "Use in a tool" }).click();
  await page.getByRole("button", { name: "Rotate PDF", exact: true }).click();
  await tile(5).waitFor({ timeout: 30_000 });
  ok("Use in a tool → Rotate PDF with the file loaded");
}

if (section("edit")) {
  console.log("Edit PDF");
  await go("#/tool/edit-pdf");
  await addFiles("mixed.pdf");
  const canvas = page.getByTestId("editor-canvas");
  await canvas.waitFor({ timeout: 30_000 });
  const box = await canvas.boundingBox();
  if (!box) throw new Error("editor canvas has no size");
  const at = (u, v) => [box.x + u * box.width, box.y + v * box.height];
  const dragTo = async (from, to) => {
    await page.mouse.move(...at(...from));
    await page.mouse.down();
    await page.mouse.move(...at(...to), { steps: 8 });
    await page.mouse.up();
  };
  await page.getByRole("button", { name: "Rectangle", exact: true }).click();
  await dragTo([0.1, 0.1], [0.4, 0.2]);
  await page.getByText("1 added").waitFor();
  ok("rectangle drawn by dragging");
  await page.getByRole("button", { name: "Text box", exact: true }).click();
  await page.mouse.click(...at(0.1, 0.4));
  await page.getByLabel("Text", { exact: true }).fill("Checked by PDFForge");
  await page.getByText("Checked by PDFForge").first().waitFor();
  ok("text box placed and typed");
  await page.getByRole("button", { name: "Pen", exact: true }).click();
  await dragTo([0.5, 0.6], [0.8, 0.7]);
  await page.getByText("3 added").waitFor();
  await page.getByRole("button", { name: "Undo (Ctrl+Z)" }).click();
  await page.getByText("2 added").waitFor();
  await page.getByRole("button", { name: "Redo (Ctrl+Y)" }).click();
  await page.getByText("3 added").waitFor();
  ok("undo / redo");
  await shot("edit-ready");
  const text = await runAndWait("Save changes");
  expect(text.includes("3 objects added"), "3 objects saved into the page");
  expect(/mixed_edited( \(\d+\))?\.pdf/.test(text), "output mixed_edited.pdf");
}

if (section("sign")) {
  console.log("Sign PDF");
  await go("#/tool/sign");
  await addFiles("mixed.pdf");
  const canvas = page.getByTestId("editor-canvas");
  await canvas.waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Signature", exact: true }).click();
  await page.getByRole("tab", { name: "Draw" }).click();
  const pad = page.getByTestId("signature-pad");
  const padBox = await pad.boundingBox();
  if (!padBox) throw new Error("signature pad has no size");
  await page.mouse.move(padBox.x + 30, padBox.y + 100);
  await page.mouse.down();
  for (const [dx, dy] of [
    [80, -60],
    [160, 40],
    [240, -30],
    [320, 50],
  ]) {
    await page.mouse.move(padBox.x + 30 + dx, padBox.y + 100 + dy, { steps: 5 });
  }
  await page.mouse.up();
  // Do not write a test signature into the real profile.
  await page.getByLabel(/Save on this computer/).uncheck();
  await page.getByRole("button", { name: "Use", exact: true }).click();
  await page.getByText("Click on the page to place it").waitFor();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("editor canvas has no size");
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.3);
  await page.getByText("1 added").waitFor();
  ok("drawn signature placed on the page");
  await page.getByRole("button", { name: "Date", exact: true }).click();
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.4);
  await page.getByText("2 added").waitFor();
  ok("date placed");
  await shot("sign-ready");
  const text = await runAndWait("Sign and save");
  expect(text.includes("2 items signed onto the document"), "signed");
  expect(/mixed_signed( \(\d+\))?\.pdf/.test(text), "output mixed_signed.pdf");
}

if (section("crop")) {
  console.log("Crop PDF");
  await go("#/tool/crop");
  await addFiles("mixed.pdf");
  const canvas = page.getByTestId("crop-canvas");
  await canvas.waitFor({ timeout: 30_000 });
  const box = await canvas.boundingBox();
  if (!box) throw new Error("crop canvas has no size");
  const handle = await page.getByTestId("crop-handle-tl").boundingBox();
  if (!handle) throw new Error("crop handle missing");
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.2, { steps: 8 });
  await page.mouse.up();
  await page.getByRole("radio", { name: "This page" }).click();
  await shot("crop-ready");
  const one = await runAndWait("Crop PDF");
  expect(one.includes("Cropped 1 of 5 pages"), "drawn area applied to this page");
  await startOver();
  await addFiles("mixed.pdf");
  await canvas.waitFor({ timeout: 30_000 });
  await page.getByRole("radio", { name: "Trim white margins" }).click();
  await page.getByRole("radio", { name: "All pages" }).click();
  await page.getByText("Keep a margin of (pt)").waitFor();
  const all = await runAndWait("Crop PDF");
  expect(all.includes("Cropped 5 of 5 pages"), "white margins trimmed on every page");
}

if (section("redact")) {
  console.log("Redact PDF");
  await go("#/tool/redact");
  await addFiles("statement.pdf");
  await page.getByTestId("editor-canvas").waitFor({ timeout: 30_000 });
  await page.getByLabel("Email addresses").check();
  await page.getByLabel("PAN numbers").check();
  await page.getByRole("button", { name: "Mark all matches" }).click();
  await page.getByText("2 matches marked").waitFor();
  ok("email and PAN found and marked");
  await page.getByLabel("Word or phrase", { exact: true }).fill("Balance");
  await page.getByLabel("Email addresses").uncheck();
  await page.getByLabel("PAN numbers").uncheck();
  await page.getByRole("button", { name: "Mark all matches" }).click();
  await page.getByText("1 matches marked").waitFor();
  await page.getByText("3 added").waitFor();
  ok("typed word marked too");
  await shot("redact-ready");
  expect(
    await page.getByLabel("Run OCR on non-redacted areas").isChecked(),
    "OCR on non-redacted areas is on by default",
  );
  const text = await runAndWait("Redact permanently");
  expect(text.includes("3 areas removed on 1 page"), "3 areas removed");
  expect(
    text.includes("rebuilt as an image") && text.includes("OCR restored searchable text"),
    "result explains rebuilt pages and restored text",
  );
  expect(/statement_redacted( \(\d+\))?\.pdf/.test(text), "output statement_redacted.pdf");
}

if (section("compare")) {
  console.log("Compare PDF");
  await go("#/tool/compare");
  await addFiles("contract v1.pdf", "contract v2.pdf");
  await page.waitForFunction(() => document.querySelectorAll("main ol li").length === 2);
  const text = await runAndWait("Compare");
  expect(/\d+ added · \d+ removed · [1-9]\d* changed/.test(text), "changes counted");
  expect(/contract v2_compared( \(\d+\))?\.pdf/.test(text), "report contract v2_compared.pdf");
  const list = page.getByRole("navigation", { name: "Changes" });
  await list.getByText("18000").first().waitFor();
  ok("change list shows the new rent");
  await list.getByRole("button").first().click();
  await page.getByTestId("compare-new").locator("span.border-2").first().waitFor();
  ok("changes highlighted in the panes");
  await page.getByRole("switch", { name: "Show pixel differences" }).click();
  await page.waitForFunction(
    () => document.querySelectorAll("[data-testid=compare-new] img").length >= 2,
    null,
    { timeout: 15_000 },
  );
  ok("pixel difference overlay");
  await shot("compare-result");
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

if (section("forms")) {
  console.log("Fill PDF Forms");
  await go("#/tool/fill-forms");
  await addFiles("application.pdf");
  await page.getByText("6 fields to fill").waitFor({ timeout: 30_000 });
  ok("six fields found on two pages");
  await page.getByLabel("name", { exact: true }).fill("Asha Raman");
  await page.getByLabel("notes", { exact: true }).fill("First line\nSecond line");
  await page.getByLabel("agree", { exact: true }).click();
  await page.getByLabel("large", { exact: true }).check();
  await page.getByLabel("city", { exact: true }).fill("Chennai");
  await page.getByLabel("Flatten the form").click();
  await shot("forms-ready");
  const text = await runAndWait("Save filled form");
  expect(text.includes("5 fields filled · flattened"), "5 fields filled and flattened");
  expect(/application_filled( \(\d+\))?\.pdf/.test(text), "output application_filled.pdf");
}

if (section("explorer")) {
  console.log("Explorer menu: Merge with PDFForge");
  // What Explorer runs, once per selected file; the single-instance plugin forwards each
  // launch to this app. (The registry entries themselves are covered by Rust tests.)
  const exe = join(import.meta.dirname, "..", "src-tauri", "target", "debug", "pdfforge.exe");
  expect(existsSync(exe), "dev build exe found");
  await go("#/");
  for (const name of ["Chapter 1.pdf", "Chapter 2.pdf"]) {
    execFileSync(exe, ["--merge", join(inputDir, name)], { timeout: 30_000 });
  }
  await page.waitForFunction(() => location.hash.startsWith("#/tool/merge"), null, {
    timeout: 15_000,
  });
  await page.waitForFunction(() => document.querySelectorAll("main ol img").length === 2, null, {
    timeout: 30_000,
  });
  ok("both files arrived in Merge PDF");
  await go("#/settings");
  await page.getByLabel("Show PDFForge in Explorer's right-click menu").waitFor();
  ok("Windows integration setting shown");
}

if (section("certsign")) {
  console.log("Sign PDF with a certificate");
  await go("#/"); // leave a previous Sign result screen
  await go("#/tool/sign");
  await addFiles("contract v1.pdf");
  await page.getByTestId("editor-canvas").waitFor({ timeout: 30_000 });
  await page.getByLabel("Add a digital signature").click();
  expect(
    await page.getByRole("button", { name: "Sign and save" }).isDisabled(),
    "certificate required once the digital signature is on",
  );
  await page.evaluate(
    (path) =>
      window.dispatchEvent(
        new CustomEvent("pdfforge:test-pick-file", { detail: { key: "certificate", path } }),
      ),
    join(inputDir, "my-certificate.pfx"),
  );
  await page.getByText("my-certificate.pfx").waitFor();
  await page.getByLabel("Certificate password", { exact: true }).fill("Cert-Pass-1");
  await page.getByLabel("Reason (optional)").fill("Approved");
  await shot("certsign-ready");
  const text = await runAndWait("Sign and save");
  expect(text.includes("Digitally signed as Asha Raman"), "digitally signed as Asha Raman");
  expect(/contract v1_signed( \(\d+\))?\.pdf/.test(text), "output contract v1_signed.pdf");
}

if (section("web")) {
  console.log("Web Page to PDF (the only online tool)");
  // A local web server plays the website; the engine always allows loopback.
  const site = join(inputDir, "site");
  const server = createServer((req, res) => {
    const path = join(site, decodeURIComponent((req.url ?? "/").split("?")[0]));
    if (!existsSync(path) || path.endsWith("site")) {
      res.writeHead(404).end();
      return;
    }
    const type = path.endsWith(".html") ? "text/html" : path.endsWith(".css") ? "text/css" : "";
    res.writeHead(200, type ? { "Content-Type": type } : {}).end(readFileSync(path));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/index.html`;
  try {
    await go("#/");
    await page.getByText("Uses the internet").first().waitFor();
    ok("home card badged 'Uses the internet'");
    await go("#/tool/url-to-pdf");
    await page.getByText("It is the only PDFForge tool that goes online").waitFor();
    await page.evaluate(
      (dir) => window.dispatchEvent(new CustomEvent("pdfforge:test-output-dir", { detail: dir })),
      inputDir,
    );
    await page.getByLabel("Web address", { exact: true }).fill(url);
    await page.getByRole("button", { name: "Download and convert", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("Go online?").waitFor();
    expect((await dialog.innerText()).includes(url), "confirmation names the address");
    await shot("web-confirm");
    await dialog.getByRole("button", { name: "Download and convert" }).click();
    await page.getByText("Done!").waitFor({ timeout: 90_000 });
    const text = await page.locator("main section[aria-live=polite]").innerText();
    expect(text.includes(url), "summary shows the address");
    expect(/\.pdf/.test(text), "PDF saved");
    await shot("web-result");
    await go("#/settings");
    await page.getByRole("button", { name: "Ask before going online again" }).click();
    await page.getByText("PDFForge will ask before going online.").waitFor();
    ok("confirmation can be asked again");
  } finally {
    server.close();
  }
}

if (section("batch")) {
  console.log("Batch mode");
  await go("#/tool/compress");
  await page.getByLabel("Batch mode").click();
  await page.getByText("Up to 500 files").waitFor();
  await addFiles("statement.pdf", "contract v1.pdf", "contract v2.pdf");
  await page.waitForFunction(() => document.querySelectorAll("main ol img").length === 3);
  ok("three files in one compress batch");
  await page.getByRole("button", { name: "Compress PDF", exact: true }).click();
  const counts = page.getByTestId("batch-counts");
  await counts.filter({ hasText: "3 of 3 finished" }).waitFor({ timeout: 90_000 });
  const text = await counts.innerText();
  expect(text.includes("3 done · 0 failed"), "all three files done");
  expect(
    (await page.locator('li[data-state="done"]').count()) === 3,
    "per-file status list shows three done rows",
  );
  await shot("batch-result");
  await page.getByRole("button", { name: "Start over" }).click();
  await page.getByRole("button", { name: "Select files" }).waitFor();
  ok("start over returns to the drop zone");
}

if (section("workflows")) {
  console.log("Workflows");
  await go("#/?category=workflows");
  await page.getByRole("button", { name: "New workflow" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Smoke flow");
  for (const tool of ["Merge PDF", "Add Page Numbers", "Protect PDF"]) {
    await page.getByRole("combobox", { name: "Add a step" }).click();
    await page.getByRole("option", { name: tool, exact: true }).click();
  }
  const steps = page.getByRole("list", { name: "Steps" }).getByRole("listitem");
  expect((await steps.count()) === 3, "three steps added");
  // A non-PDF result in the middle is refused until it is the last step.
  await page.getByRole("combobox", { name: "Add a step" }).click();
  await page.getByRole("option", { name: "PDF to Text", exact: true }).click();
  await page.getByRole("button", { name: "Move up" }).last().click();
  await page.getByText("makes no PDF, so it can only be the last step").waitFor();
  expect(
    await page.getByRole("button", { name: "Save", exact: true }).isDisabled(),
    "bad chain blocks saving",
  );
  await page.getByRole("button", { name: /^Remove PDF to Text/ }).click();
  await shot("workflow-builder");
  await page.getByRole("button", { name: "Save and run" }).click();
  await page.getByRole("heading", { name: "Smoke flow" }).waitFor();
  ok("saved and opened the run page");
  await addFiles("statement.pdf", "contract v1.pdf");
  await page.waitForFunction(() => document.querySelectorAll("main ol img").length === 2);
  await page.getByLabel("Password to open", { exact: true }).fill("Flow-Pass-42");
  await page.getByLabel("Repeat the password", { exact: true }).fill("Flow-Pass-42");
  await page.getByRole("button", { name: "Run workflow" }).click();
  const counts = page.getByTestId("batch-counts");
  await counts.filter({ hasText: "1 of 1 finished" }).waitFor({ timeout: 90_000 });
  expect((await counts.innerText()).includes("1 done"), "workflow finished");
  const row = await page.locator('li[data-state="done"]').innerText();
  expect(/statement_Smoke flow( \(\d+\))?\.pdf/.test(row), "output statement_Smoke flow.pdf");
  await shot("workflow-result");
  await go("#/?category=workflows");
  const card = page.getByRole("listitem", { name: "Smoke flow" });
  await card.getByText("Add Page Numbers").waitFor();
  await card.getByRole("button", { name: "Delete" }).click();
  await card.getByRole("button", { name: "Delete for good" }).click();
  await card.waitFor({ state: "detached" });
  ok("workflow listed and deleted");
}

if (section("language")) {
  console.log("Language: Tamil and Hindi");
  const pick = async (label, name) => {
    await go("#/settings");
    await page.getByLabel(label, { exact: true }).click();
    await page.getByRole("option", { name, exact: true }).click();
  };
  await pick("Language", "தமிழ்");
  await page.getByRole("heading", { name: "அமைப்புகள்", exact: true }).waitFor();
  await go("#/");
  await page.getByText("PDF இணை", { exact: true }).first().waitFor();
  expect((await page.locator("html").getAttribute("lang")) === "ta", "html lang=ta");
  await shot("home-tamil");
  await go("#/tool/compress");
  await page.getByText("சுருக்கம்", { exact: true }).first().waitFor();
  ok("tool page and options in Tamil");
  await shot("compress-tamil");
  await pick("மொழி", "हिन्दी");
  await page.getByRole("heading", { name: "सेटिंग्स", exact: true }).waitFor();
  await go("#/");
  await page.getByText("PDF जोड़ें", { exact: true }).first().waitFor();
  await shot("home-hindi");
  ok("Hindi");
  await pick("भाषा", "English");
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  ok("back to English");
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
