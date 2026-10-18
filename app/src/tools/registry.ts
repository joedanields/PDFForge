/**
 * Tool registry: one entry per tool in docs/02_FEATURES.md (sections A–F and I). It drives the
 * Home grid, search, the generic Tool page and its options form. Adding a tool = an entry here
 * + an engine function (docs/05_NON_FUNCTIONAL.md §6).
 */
import {
  Code,
  Combine,
  Crop,
  EyeOff,
  FileArchive,
  FileImage,
  FileMinus,
  FileOutput,
  FileSpreadsheet,
  FileText,
  FileType,
  FlaskConical,
  GitCompareArrows,
  Hash,
  Images,
  Languages,
  LayoutGrid,
  Lock,
  LockOpen,
  MessagesSquare,
  Minimize2,
  PenLine,
  Presentation,
  RotateCw,
  ScanText,
  Scissors,
  Sheet,
  Signature,
  Sparkles,
  Stamp,
  TextCursorInput,
  Type,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { z } from "zod";
import type { ToolCategory } from "./categories";
import { parseRanges } from "@/lib/pageRanges";
import { opt } from "./options";

export type ToolStatus = "available" | "coming-soon";
export type Priority = "must" | "should" | "could" | "wont";

export interface AcceptSpec {
  /** Lower-case extensions without the dot. */
  extensions: readonly string[];
  min: number;
  max: number;
  /** Human description shown in the drop zone. */
  label: string;
}

export interface ToolDef {
  id: string;
  /** Section id in docs/02_FEATURES.md, e.g. "A1". */
  ref: string;
  name: string;
  description: string;
  category: ToolCategory;
  icon: LucideIcon;
  accepts: AcceptSpec;
  optionsSchema: z.AnyZodObject;
  status: ToolStatus;
  priority: Priority;
  /** Roadmap phase that delivers the tool (docs/08_ROADMAP.md). */
  phase: number;
  /** Engine RPC method; required when status is "available". */
  engineMethod?: string;
  /** Label of the primary action button. */
  actionLabel: string;
  keywords?: readonly string[];
  /** Only shown in development builds and via Settings → About. */
  devOnly?: boolean;
  /** Hidden unless PDF Intelligence is enabled (off by default). */
  requiresIntelligence?: boolean;
  /** "files": file cards (default). "pages": one PDF shown as a selectable page grid.
   * "organize": page board built from one or more PDFs. */
  layout?: "files" | "pages" | "organize";
  /** pages layout: the page-range option that mirrors the grid selection. */
  pageSelection?: {
    option: string;
    tone?: "select" | "remove";
    /** The grid only selects while another option has one of these values. */
    activeWhen?: { key: string; values: readonly string[] };
  };
  /** pages layout: small label on a page tile, e.g. which output file it goes to. */
  pageBadge?: (options: Record<string, unknown>, index: number, pageCount: number) => string | null;
  /** pages layout: clockwise rotation to preview on a page, in degrees. */
  previewRotation?: (options: Record<string, unknown>, page: PagePreview) => number;
  /** Turn validated form values into the engine's `options`. */
  toEngine?: (options: Record<string, unknown>) => Record<string, unknown>;
  /** Extra blocker message before Run (e.g. "can't remove every page"). */
  check?: (options: Record<string, unknown>, ctx: CheckContext) => string | null;
  /** One-line, tool-specific result summary built from the job's stats. */
  summary?: (stats: Record<string, unknown>) => string | null;
}

export interface PagePreview {
  index: number;
  selected: boolean;
  /** True when nothing is selected and the tool treats that as "all pages". */
  allImplied: boolean;
  landscape: boolean | null;
}

export interface CheckContext {
  pageCount: number | null;
  selectedCount: number;
}

const PDF = ["pdf"] as const;
const IMAGES = ["jpg", "jpeg", "png", "bmp", "tif", "tiff", "webp", "gif", "heic", "heif"] as const;
const NO_OPTIONS = z.object({});

const onePdf: AcceptSpec = { extensions: PDF, min: 1, max: 1, label: "One PDF file" };
const manyPdfs: AcceptSpec = { extensions: PDF, min: 1, max: 500, label: "PDF files" };
const twoPdfs: AcceptSpec = { extensions: PDF, min: 2, max: 2, label: "Two PDF files" };

function soon(
  def: Omit<ToolDef, "status" | "optionsSchema" | "actionLabel"> &
    Partial<Pick<ToolDef, "optionsSchema" | "actionLabel">>,
): ToolDef {
  return {
    status: "coming-soon",
    optionsSchema: NO_OPTIONS,
    actionLabel: def.name,
    ...def,
  };
}

export const mergeOptions = z.object({
  bookmarks: opt.bool("Keep bookmarks", true, "Copy each file's bookmarks into the merged PDF."),
  bookmark_per_file: opt.bool(
    "Add a bookmark per file",
    false,
    "Adds one top-level bookmark named after each source file.",
  ),
});

export const rotateOptions = z.object({
  angle: opt.choice(
    "Rotate by",
    [
      { value: "90", label: "90° ↻" },
      { value: "180", label: "180°" },
      { value: "270", label: "90° ↺" },
    ],
    "90",
    "Clockwise, half turn, or counter-clockwise. Only the page orientation changes — no quality loss.",
    { segmented: true },
  ),
  pages: opt.pages(
    "Pages",
    "Select pages in the grid or type ranges like 1-3, 5. Leave empty to rotate every page.",
    true,
  ),
  orientation: opt.choice(
    "Only rotate",
    [
      { value: "all", label: "All selected pages" },
      { value: "portrait", label: "Portrait pages" },
      { value: "landscape", label: "Landscape pages" },
    ],
    "all",
  ),
});

export const removeOptions = z.object({
  pages: opt.pages(
    "Pages to remove",
    "Click pages in the grid or type ranges like 2, 5-7. Removed pages are deleted from the file, not just hidden.",
    false,
  ),
});

export const extractOptions = z.object({
  pages: opt.pages(
    "Pages to extract",
    "Click pages in the grid or type ranges like 1-3, 8.",
    false,
  ),
  mode: opt.choice(
    "Save as",
    [
      { value: "single", label: "One PDF" },
      { value: "separate", label: "One PDF per page" },
    ],
    "single",
    undefined,
    { segmented: true },
  ),
  zip: opt.bool("Put the files in a .zip", false, "Otherwise they go into a new folder.", {
    showWhen: { key: "mode", values: ["separate"] },
  }),
});

export const splitOptions = z.object({
  mode: opt.choice(
    "Split",
    [
      { value: "ranges", label: "By page ranges" },
      { value: "fixed", label: "Every N pages" },
      { value: "all", label: "Into single pages" },
      { value: "size", label: "By file size" },
      { value: "bookmarks", label: "By bookmarks (chapters)" },
    ],
    "ranges",
  ),
  ranges: opt.pages(
    "Ranges",
    "Each range becomes its own file, e.g. 1-3, 4-7, 8. Selecting pages in the grid adds them.",
    false,
    { showWhen: { key: "mode", values: ["ranges"] }, placeholder: "e.g. 1-3, 4-7, 8" },
  ),
  merge_ranges: opt.bool("Combine the ranges into one file", false, undefined, {
    showWhen: { key: "mode", values: ["ranges"] },
  }),
  every: opt.int("Pages per file", 1, 10_000, 2, undefined, {
    showWhen: { key: "mode", values: ["fixed"] },
  }),
  max_mb: opt.number(
    "Maximum file size (MB)",
    0.1,
    2000,
    5,
    "Pages are grouped so that no file is larger than this. A single page that is already larger gets its own file.",
    { showWhen: { key: "mode", values: ["size"] } },
  ),
  zip: opt.bool("Put the files in a .zip", false, "Otherwise they go into a new folder."),
});

/** Which output file each page goes to, for the modes where that is known up front. */
function splitBadge(
  options: Record<string, unknown>,
  index: number,
  pageCount: number,
): string | null {
  const mode = options.mode;
  if (mode === "all") return `File ${index + 1}`;
  if (mode === "fixed") {
    const every = typeof options.every === "number" && options.every > 0 ? options.every : 1;
    return `File ${Math.floor(index / every) + 1}`;
  }
  if (mode !== "ranges" || typeof options.ranges !== "string" || !options.ranges.trim()) {
    return null;
  }
  const result = parseRanges(options.ranges, pageCount);
  if (!result.ok) return null;
  const page = index + 1;
  const files = result.ranges
    .map((r, n) => (page >= r.first && page <= r.last ? n + 1 : 0))
    .filter((n) => n > 0);
  if (files.length === 0) return null;
  if (options.merge_ranges === true) return "Included";
  return files.length === 1 ? `File ${files[0]}` : `Files ${files.join(", ")}`;
}

export const imageToPdfOptions = z.object({
  page_size: opt.choice(
    "Page size",
    [
      { value: "fit", label: "Fit image" },
      { value: "a4", label: "A4" },
      { value: "letter", label: "Letter" },
    ],
    "fit",
    "“Fit image” makes each page exactly the size of its picture.",
    { segmented: true },
  ),
  orientation: opt.choice(
    "Orientation",
    [
      { value: "auto", label: "Auto" },
      { value: "portrait", label: "Portrait" },
      { value: "landscape", label: "Landscape" },
    ],
    "auto",
    "Auto turns the page to match each picture.",
    { segmented: true, showWhen: { key: "page_size", values: ["a4", "letter"] } },
  ),
  margin: opt.choice(
    "Margin",
    [
      { value: "none", label: "None" },
      { value: "small", label: "Small" },
      { value: "large", label: "Large" },
    ],
    "none",
    undefined,
    { segmented: true },
  ),
  mode: opt.choice(
    "Create",
    [
      { value: "merge", label: "One PDF" },
      { value: "separate", label: "One PDF per image" },
    ],
    "merge",
    "The order of the images above is the page order.",
    { segmented: true },
  ),
});

export const pdfToImageOptions = z.object({
  mode: opt.choice(
    "Convert",
    [
      { value: "pages", label: "Pages to images" },
      { value: "extract", label: "Extract pictures" },
    ],
    "pages",
    undefined,
    { segmented: true },
  ),
  format: opt.choice(
    "Format",
    [
      { value: "jpg", label: "JPG" },
      { value: "png", label: "PNG" },
    ],
    "jpg",
    "JPG is smaller; PNG keeps text perfectly sharp.",
    { segmented: true, showWhen: { key: "mode", values: ["pages"] } },
  ),
  dpi: opt.choice(
    "Resolution",
    [
      { value: "72", label: "72 dpi" },
      { value: "150", label: "150 dpi" },
      { value: "300", label: "300 dpi" },
    ],
    "150",
    "72 for screens, 150 for most uses, 300 for printing.",
    { segmented: true, showWhen: { key: "mode", values: ["pages"] } },
  ),
  pages: opt.pages(
    "Pages",
    "Select pages in the grid or type ranges. Leave empty for every page.",
    true,
    { showWhen: { key: "mode", values: ["pages"] } },
  ),
  zip: opt.bool("Put the images in a .zip", false, "Otherwise they go into a new folder."),
});

const PERMISSION_HELP = "Viewers enforce these; a permissions password is needed to change them.";

export const protectOptions = z.object({
  user_password: opt.password(
    "Password to open",
    "Anyone opening the PDF will need it. Leave empty to only restrict what people can do.",
  ),
  user_password_confirm: opt.confirm("Repeat the password", "user_password", {
    showWhenFilled: "user_password",
  }),
  allow_print: opt.choice(
    "Printing",
    [
      { value: "high", label: "Allowed" },
      { value: "low", label: "Low quality" },
      { value: "none", label: "No" },
    ],
    "high",
    PERMISSION_HELP,
    { segmented: true },
  ),
  allow_copy: opt.bool("Allow copying text and images", true),
  allow_edit: opt.bool("Allow editing and page changes", true),
  allow_forms: opt.bool("Allow filling in forms", true),
  allow_annotate: opt.bool("Allow comments and annotations", true),
  owner_password: opt.password(
    "Permissions password",
    "Optional. Needed later to lift the restrictions. Must differ from the open password.",
  ),
  owner_password_confirm: opt.confirm("Repeat the permissions password", "owner_password", {
    showWhenFilled: "owner_password",
  }),
  encryption: opt.choice(
    "Encryption",
    [
      { value: "aes256", label: "AES-256" },
      { value: "aes128", label: "AES-128" },
    ],
    "aes256",
    "AES-256 is the strongest; AES-128 only for very old PDF readers.",
    { segmented: true },
  ),
});

export const echoOptions = z.object({
  message: opt.text("Message", "Hello from PDFForge", "Returned by the engine unchanged."),
  steps: opt.int("Steps", 1, 50, 10),
  delay_ms: opt.int("Delay per step (ms)", 0, 2000, 200),
});

export const TOOLS: readonly ToolDef[] = [
  // ── A. Organize ───────────────────────────────────────────────────────────────────────────
  {
    id: "merge",
    ref: "A1",
    name: "Merge PDF",
    description: "Combine several PDFs or images into one document, in the order you choose.",
    category: "organize",
    icon: Combine,
    accepts: {
      extensions: [...PDF, ...IMAGES],
      min: 2,
      max: 500,
      label: "PDFs or images (JPG, PNG, BMP, TIFF, WEBP, GIF, HEIC) — at least 2 files",
    },
    optionsSchema: mergeOptions,
    status: "available",
    priority: "must",
    phase: 0,
    engineMethod: "merge",
    actionLabel: "Merge PDF",
    keywords: ["combine", "join", "append"],
  },
  {
    id: "split",
    ref: "A2",
    name: "Split PDF",
    description: "Break a PDF into parts by page ranges, fixed size, file size or bookmarks.",
    category: "organize",
    icon: Scissors,
    accepts: onePdf,
    optionsSchema: splitOptions,
    status: "available",
    priority: "must",
    phase: 1,
    engineMethod: "split",
    actionLabel: "Split PDF",
    keywords: ["separate", "ranges", "divide", "chapters"],
    layout: "pages",
    pageSelection: { option: "ranges", activeWhen: { key: "mode", values: ["ranges"] } },
    pageBadge: splitBadge,
    toEngine: (o) => ({
      mode: o.mode,
      ranges: o.ranges,
      merge_ranges: o.merge_ranges,
      every: o.every,
      max_mb: o.max_mb,
      zip: o.zip,
    }),
    summary: (s) => {
      if (typeof s.files !== "number") return null;
      if (s.files === 1 && typeof s.ranges === "number") {
        return `Combined ${s.ranges} ranges into one file`;
      }
      const big =
        typeof s.oversized_pages === "number"
          ? ` · ${s.oversized_pages} ${s.oversized_pages === 1 ? "page is" : "pages are"} larger than the limit on their own`
          : "";
      return `Split into ${s.files} files${big}`;
    },
  },
  {
    id: "remove-pages",
    ref: "A3",
    name: "Remove Pages",
    description: "Delete the pages you don't need and keep the rest.",
    category: "organize",
    icon: FileMinus,
    accepts: onePdf,
    optionsSchema: removeOptions,
    status: "available",
    priority: "must",
    phase: 1,
    engineMethod: "remove-pages",
    actionLabel: "Remove pages",
    keywords: ["delete", "drop", "cut"],
    layout: "pages",
    pageSelection: { option: "pages", tone: "remove" },
    check: (_options, { pageCount, selectedCount }) =>
      pageCount !== null && selectedCount >= pageCount
        ? "You can't remove every page — keep at least one."
        : null,
    summary: (s) =>
      typeof s.removed === "number" && typeof s.pages === "number"
        ? `Removed ${s.removed} ${s.removed === 1 ? "page" : "pages"} · ${s.pages} left`
        : null,
  },
  {
    id: "extract-pages",
    ref: "A4",
    name: "Extract Pages",
    description: "Pull selected pages out into a new PDF or one file per page.",
    category: "organize",
    icon: FileOutput,
    accepts: onePdf,
    optionsSchema: extractOptions,
    status: "available",
    priority: "must",
    phase: 1,
    engineMethod: "extract-pages",
    actionLabel: "Extract pages",
    keywords: ["select", "copy pages", "save pages"],
    layout: "pages",
    pageSelection: { option: "pages" },
    summary: (s) => {
      if (typeof s.pages !== "number") return null;
      const pages = `${s.pages} ${s.pages === 1 ? "page" : "pages"}`;
      return typeof s.files === "number" && s.files > 1
        ? `Extracted ${pages} into ${s.files} files`
        : `Extracted ${pages}`;
    },
  },
  {
    id: "organize",
    ref: "A5",
    name: "Organize PDF",
    description: "Reorder, rotate, duplicate, insert or delete pages on a thumbnail board.",
    category: "organize",
    icon: LayoutGrid,
    accepts: { extensions: PDF, min: 1, max: 50, label: "PDF files — add more any time" },
    optionsSchema: NO_OPTIONS,
    status: "available",
    priority: "must",
    phase: 1,
    engineMethod: "organize",
    actionLabel: "Save PDF",
    keywords: ["reorder", "sort", "arrange", "move pages", "duplicate", "blank page"],
    layout: "organize",
    summary: (s) =>
      typeof s.pages === "number"
        ? `${s.pages} ${s.pages === 1 ? "page" : "pages"}${
            typeof s.files === "number" && s.files > 1 ? ` from ${s.files} files` : ""
          }`
        : null,
  },
  {
    id: "rotate",
    ref: "A6",
    name: "Rotate PDF",
    description: "Turn all or selected pages by 90°, 180° or 270° without quality loss.",
    category: "organize",
    icon: RotateCw,
    accepts: onePdf,
    optionsSchema: rotateOptions,
    status: "available",
    priority: "must",
    phase: 1,
    engineMethod: "rotate",
    actionLabel: "Rotate PDF",
    keywords: ["turn", "orientation", "landscape", "portrait"],
    layout: "pages",
    pageSelection: { option: "pages" },
    previewRotation: (options, page) => {
      if (!page.selected && !page.allImplied) return 0;
      const only = options.orientation;
      if (only !== "all" && page.landscape !== null && page.landscape !== (only === "landscape")) {
        return 0;
      }
      return Number(options.angle);
    },
    toEngine: (o) => ({
      angle: Number(o.angle),
      pages: typeof o.pages === "string" && o.pages.trim() ? o.pages : "all",
      orientation: o.orientation,
    }),
    summary: (s) =>
      typeof s.rotated === "number" && typeof s.pages === "number"
        ? `Rotated ${s.rotated} of ${s.pages} pages`
        : null,
  },

  // ── B. Optimize ───────────────────────────────────────────────────────────────────────────
  soon({
    id: "compress",
    ref: "B1",
    name: "Compress PDF",
    description: "Shrink file size for email and upload, with a before/after comparison.",
    category: "optimize",
    icon: Minimize2,
    accepts: manyPdfs,
    priority: "must",
    phase: 1,
    keywords: ["reduce", "smaller", "size", "optimize"],
  }),
  soon({
    id: "repair",
    ref: "B2",
    name: "Repair PDF",
    description: "Rebuild damaged files and recover as many pages as possible.",
    category: "optimize",
    icon: Wrench,
    accepts: manyPdfs,
    priority: "should",
    phase: 2,
    keywords: ["fix", "broken", "corrupt"],
  }),
  soon({
    id: "ocr",
    ref: "B3",
    name: "OCR PDF",
    description: "Make scanned documents searchable and selectable.",
    category: "optimize",
    icon: ScanText,
    accepts: manyPdfs,
    priority: "should",
    phase: 2,
    keywords: ["scan", "text recognition", "searchable"],
  }),

  // ── C. Convert to PDF ─────────────────────────────────────────────────────────────────────
  {
    id: "image-to-pdf",
    ref: "C1",
    name: "Image to PDF",
    description: "Turn JPG, PNG, TIFF, WEBP or HEIC images into a PDF.",
    category: "convert",
    icon: FileImage,
    accepts: {
      extensions: IMAGES,
      min: 1,
      max: 500,
      label: "Images (JPG, PNG, BMP, TIFF, WEBP, GIF, HEIC)",
    },
    optionsSchema: imageToPdfOptions,
    status: "available",
    priority: "must",
    phase: 1,
    engineMethod: "image-to-pdf",
    actionLabel: "Convert to PDF",
    keywords: ["jpg to pdf", "png", "photo", "scan", "heic", "picture"],
    summary: (s) => {
      if (typeof s.images !== "number") return null;
      const images = `${s.images} ${s.images === 1 ? "image" : "images"}`;
      return typeof s.files === "number" && s.files > 1
        ? `${images} → ${s.files} PDFs`
        : `${images} → ${String(s.pages)} ${s.pages === 1 ? "page" : "pages"}`;
    },
  },
  soon({
    id: "word-to-pdf",
    ref: "C2",
    name: "Word to PDF",
    description: "Convert DOC, DOCX, ODT and RTF documents — no Office needed.",
    category: "convert",
    icon: FileText,
    accepts: {
      extensions: ["doc", "docx", "odt", "rtf"],
      min: 1,
      max: 100,
      label: "Word documents",
    },
    priority: "must",
    phase: 2,
    keywords: ["docx"],
  }),
  soon({
    id: "powerpoint-to-pdf",
    ref: "C3",
    name: "PowerPoint to PDF",
    description: "Convert PPT, PPTX and ODP slide decks, optionally with notes.",
    category: "convert",
    icon: Presentation,
    accepts: { extensions: ["ppt", "pptx", "odp"], min: 1, max: 100, label: "Presentations" },
    priority: "must",
    phase: 2,
    keywords: ["pptx", "slides"],
  }),
  soon({
    id: "excel-to-pdf",
    ref: "C4",
    name: "Excel to PDF",
    description: "Convert XLS, XLSX, ODS and CSV spreadsheets to printable pages.",
    category: "convert",
    icon: FileSpreadsheet,
    accepts: {
      extensions: ["xls", "xlsx", "ods", "csv"],
      min: 1,
      max: 100,
      label: "Spreadsheets",
    },
    priority: "must",
    phase: 2,
    keywords: ["xlsx", "spreadsheet"],
  }),
  soon({
    id: "html-to-pdf",
    ref: "C5",
    name: "HTML to PDF",
    description: "Save a local web page as a PDF with your page size and margins.",
    category: "convert",
    icon: Code,
    accepts: { extensions: ["html", "htm"], min: 1, max: 1, label: "One HTML file" },
    priority: "should",
    phase: 2,
    keywords: ["web page"],
  }),
  soon({
    id: "text-to-pdf",
    ref: "C6",
    name: "Text to PDF",
    description: "Typeset plain text or Markdown files as a clean PDF.",
    category: "convert",
    icon: Type,
    accepts: { extensions: ["txt", "md"], min: 1, max: 100, label: "Text or Markdown files" },
    priority: "could",
    phase: 2,
  }),

  // ── D. Convert from PDF ───────────────────────────────────────────────────────────────────
  {
    id: "pdf-to-image",
    ref: "D1",
    name: "PDF to Image",
    description: "Export pages as JPG or PNG, or pull out the embedded pictures.",
    category: "convert",
    icon: Images,
    accepts: onePdf,
    optionsSchema: pdfToImageOptions,
    status: "available",
    priority: "must",
    phase: 1,
    engineMethod: "pdf-to-image",
    actionLabel: "Convert to images",
    keywords: ["pdf to jpg", "png", "export images", "screenshot", "pictures"],
    layout: "pages",
    pageSelection: { option: "pages", activeWhen: { key: "mode", values: ["pages"] } },
    toEngine: (o) =>
      o.mode === "extract"
        ? { mode: "extract", zip: o.zip }
        : {
            mode: "pages",
            format: o.format,
            dpi: Number(o.dpi),
            pages: typeof o.pages === "string" && o.pages.trim() ? o.pages : "all",
            zip: o.zip,
          },
    summary: (s) => {
      if (typeof s.images === "number") {
        return `Extracted ${s.images} ${s.images === 1 ? "image" : "images"}`;
      }
      if (typeof s.pages !== "number") return null;
      const fmt = typeof s.format === "string" ? s.format.toUpperCase() : "image";
      return `${s.pages} ${s.pages === 1 ? "page" : "pages"} → ${fmt} at ${String(s.dpi)} dpi`;
    },
  },
  soon({
    id: "pdf-to-word",
    ref: "D2",
    name: "PDF to Word",
    description: "Turn a PDF into an editable DOCX document (best-effort layout).",
    category: "convert",
    icon: FileType,
    accepts: manyPdfs,
    priority: "must",
    phase: 2,
    keywords: ["docx", "editable"],
  }),
  soon({
    id: "pdf-to-powerpoint",
    ref: "D3",
    name: "PDF to PowerPoint",
    description: "Make a PPTX with one slide per page.",
    category: "convert",
    icon: Presentation,
    accepts: manyPdfs,
    priority: "should",
    phase: 2,
    keywords: ["pptx", "slides"],
  }),
  soon({
    id: "pdf-to-excel",
    ref: "D4",
    name: "PDF to Excel",
    description: "Detect tables and export them to an XLSX workbook.",
    category: "convert",
    icon: Sheet,
    accepts: manyPdfs,
    priority: "should",
    phase: 2,
    keywords: ["xlsx", "tables"],
  }),
  soon({
    id: "pdf-to-pdfa",
    ref: "D5",
    name: "PDF to PDF/A",
    description: "Convert to PDF/A for long-term archiving.",
    category: "convert",
    icon: FileArchive,
    accepts: manyPdfs,
    priority: "should",
    phase: 2,
    keywords: ["archive", "pdfa"],
  }),
  soon({
    id: "pdf-to-text",
    ref: "D6",
    name: "PDF to Text",
    description: "Extract the text of a PDF into a plain .txt file.",
    category: "convert",
    icon: TextCursorInput,
    accepts: manyPdfs,
    priority: "could",
    phase: 2,
    keywords: ["txt", "extract text"],
  }),

  // ── E. Edit ───────────────────────────────────────────────────────────────────────────────
  soon({
    id: "edit-pdf",
    ref: "E1",
    name: "Edit PDF",
    description: "Add text, images, shapes, drawings and notes to your pages.",
    category: "edit",
    icon: PenLine,
    accepts: onePdf,
    priority: "should",
    phase: 3,
    keywords: ["annotate", "draw", "write"],
  }),
  soon({
    id: "page-numbers",
    ref: "E2",
    name: "Add Page Numbers",
    description: "Number pages with your choice of position, format and style.",
    category: "edit",
    icon: Hash,
    accepts: manyPdfs,
    priority: "must",
    phase: 1,
    keywords: ["numbering", "pagination"],
  }),
  soon({
    id: "watermark",
    ref: "E3",
    name: "Add Watermark",
    description: "Stamp text or an image over or under your pages.",
    category: "edit",
    icon: Stamp,
    accepts: manyPdfs,
    priority: "must",
    phase: 1,
    keywords: ["stamp", "confidential"],
  }),
  soon({
    id: "crop",
    ref: "E4",
    name: "Crop PDF",
    description: "Trim margins or crop pages to a selected area.",
    category: "edit",
    icon: Crop,
    accepts: onePdf,
    priority: "should",
    phase: 3,
    keywords: ["trim", "margins"],
  }),
  soon({
    id: "fill-forms",
    ref: "E5",
    name: "Fill PDF Forms",
    description: "Fill in form fields and optionally flatten them.",
    category: "edit",
    icon: TextCursorInput,
    accepts: onePdf,
    priority: "could",
    phase: 4,
    keywords: ["acroform", "fields"],
  }),

  // ── F. Security ───────────────────────────────────────────────────────────────────────────
  {
    id: "protect",
    ref: "F1",
    name: "Protect PDF",
    description: "Add a password and control printing, copying and editing.",
    category: "security",
    icon: Lock,
    accepts: onePdf,
    optionsSchema: protectOptions,
    status: "available",
    priority: "must",
    phase: 1,
    engineMethod: "protect",
    actionLabel: "Protect PDF",
    keywords: ["password", "encrypt", "lock", "permissions", "secure"],
    check: (o) => {
      const user = typeof o.user_password === "string" ? o.user_password : "";
      const owner = typeof o.owner_password === "string" ? o.owner_password : "";
      if (!user && !owner)
        return "Set a password to open the file, a permissions password, or both.";
      if (user && owner && user === owner) {
        return "Use a different permissions password than the open password.";
      }
      return null;
    },
    summary: (s) => {
      const method = s.encryption === "aes128" ? "AES-128" : "AES-256";
      return s.open_password === true
        ? `Password protected (${method})`
        : `Permissions restricted (${method})`;
    },
  },
  {
    id: "unlock",
    ref: "F2",
    name: "Unlock PDF",
    description: "Remove a password you know, or lift owner restrictions.",
    category: "security",
    icon: LockOpen,
    accepts: {
      extensions: PDF,
      min: 1,
      max: 1,
      label: "One protected PDF — you'll need its password if it asks for one to open",
    },
    optionsSchema: NO_OPTIONS,
    status: "available",
    priority: "must",
    phase: 1,
    engineMethod: "unlock",
    actionLabel: "Unlock PDF",
    keywords: ["decrypt", "remove password", "unprotect", "restrictions"],
    summary: (s) =>
      s.removed_open_password === true
        ? s.removed_restrictions === true
          ? "Password and restrictions removed"
          : "Password removed"
        : "Restrictions removed",
  },
  soon({
    id: "sign",
    ref: "F3",
    name: "Sign PDF",
    description: "Place a typed, drawn or image signature on your document.",
    category: "security",
    icon: Signature,
    accepts: onePdf,
    priority: "should",
    phase: 3,
    keywords: ["signature", "e-sign"],
  }),
  soon({
    id: "redact",
    ref: "F4",
    name: "Redact PDF",
    description: "Permanently remove sensitive text and areas, not just cover them.",
    category: "security",
    icon: EyeOff,
    accepts: onePdf,
    priority: "could",
    phase: 3,
    keywords: ["black out", "censor", "privacy"],
  }),
  soon({
    id: "compare",
    ref: "F5",
    name: "Compare PDF",
    description: "See what changed between two versions, side by side.",
    category: "security",
    icon: GitCompareArrows,
    accepts: twoPdfs,
    priority: "could",
    phase: 3,
    keywords: ["diff", "versions"],
  }),

  // ── I. Intelligence (v2, off by default) ──────────────────────────────────────────────────
  soon({
    id: "summarize",
    ref: "I",
    name: "Summarize PDF",
    description: "Get a short summary of a long document.",
    category: "intelligence",
    icon: Sparkles,
    accepts: onePdf,
    priority: "wont",
    phase: 5,
    requiresIntelligence: true,
  }),
  soon({
    id: "translate",
    ref: "I",
    name: "Translate PDF",
    description: "Translate a document's text into another language.",
    category: "intelligence",
    icon: Languages,
    accepts: onePdf,
    priority: "wont",
    phase: 5,
    requiresIntelligence: true,
  }),
  soon({
    id: "chat-pdf",
    ref: "I",
    name: "Chat with PDF",
    description: "Ask questions about a document and get cited answers.",
    category: "intelligence",
    icon: MessagesSquare,
    accepts: onePdf,
    priority: "wont",
    phase: 5,
    requiresIntelligence: true,
  }),

  // ── Developer ─────────────────────────────────────────────────────────────────────────────
  {
    id: "echo",
    ref: "—",
    name: "Engine Self-Test",
    description: "Runs the Echo job through the engine to check progress, cancel and results.",
    category: "optimize",
    icon: FlaskConical,
    accepts: { extensions: [], min: 0, max: 0, label: "No files needed" },
    optionsSchema: echoOptions,
    status: "available",
    priority: "must",
    phase: 0,
    engineMethod: "echo",
    actionLabel: "Run self-test",
    devOnly: true,
  },
];

export interface VisibilityOptions {
  dev: boolean;
  intelligence: boolean;
}

/** Tools shown on Home and in search. */
export function visibleTools(
  { dev, intelligence }: VisibilityOptions,
  tools: readonly ToolDef[] = TOOLS,
): ToolDef[] {
  return tools.filter((t) => (dev || !t.devOnly) && (intelligence || !t.requiresIntelligence));
}

export function getTool(id: string, tools: readonly ToolDef[] = TOOLS): ToolDef | undefined {
  return tools.find((t) => t.id === id);
}

export function toolsInCategory(
  tools: readonly ToolDef[],
  filter: "all" | "workflows" | ToolCategory,
): ToolDef[] {
  if (filter === "all") return [...tools];
  if (filter === "workflows") return [];
  return tools.filter((t) => t.category === filter);
}

function normalise(text: string): string {
  return text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

/** Case-insensitive search over name, description and keywords; every word must match. */
export function searchTools(query: string, tools: readonly ToolDef[]): ToolDef[] {
  const words = normalise(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...tools];
  const scored = tools
    .map((tool) => {
      const name = normalise(tool.name);
      const haystack = normalise([tool.name, tool.description, ...(tool.keywords ?? [])].join(" "));
      if (!words.every((w) => haystack.includes(w))) return null;
      const score =
        (name.startsWith(words[0] ?? "") ? 2 : 0) + (words.every((w) => name.includes(w)) ? 1 : 0);
      return { tool, score };
    })
    .filter((x): x is { tool: ToolDef; score: number } => x !== null);
  return scored.sort((a, b) => b.score - a.score).map((x) => x.tool);
}

/** Does `path` have an extension this tool accepts? */
export function acceptsFile(tool: ToolDef, path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return tool.accepts.extensions.includes(ext);
}
