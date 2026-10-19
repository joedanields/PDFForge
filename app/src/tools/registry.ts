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
  layout?: "files" | "pages" | "organize" | "editor" | "sign" | "crop" | "redact" | "compare";
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
  /** Files that cannot be previewed are still accepted (Repair works on damaged PDFs). */
  acceptsDamaged?: boolean;
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
/** Conversions take up to 100 files at a time (engine CONVERT_MAX). */
const convertPdfs: AcceptSpec = { extensions: PDF, min: 1, max: 100, label: "PDF files" };
const twoPdfs: AcceptSpec = {
  extensions: PDF,
  min: 2,
  max: 2,
  label: "Two PDF files: the old version first",
};

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

export const POSITIONS = [
  { value: "top-left", label: "Top left" },
  { value: "top-center", label: "Top center" },
  { value: "top-right", label: "Top right" },
  { value: "middle-left", label: "Middle left" },
  { value: "middle-center", label: "Center" },
  { value: "middle-right", label: "Middle right" },
  { value: "bottom-left", label: "Bottom left" },
  { value: "bottom-center", label: "Bottom center" },
  { value: "bottom-right", label: "Bottom right" },
] as const;

const MARGIN_POINTS: Record<string, number> = { small: 18, medium: 28, large: 48 };

const FONT_CHOICES = [
  { value: "helvetica", label: "Sans (Helvetica)" },
  { value: "times", label: "Serif (Times)" },
  { value: "courier", label: "Monospace (Courier)" },
] as const;

export const pageNumberOptions = z.object({
  position: opt.choice("Position", POSITIONS, "bottom-center", undefined, { grid: true }),
  format: opt.choice(
    "Format",
    [
      { value: "n", label: "1" },
      { value: "page_n", label: "Page 1" },
      { value: "n_of_total", label: "1 of 10" },
      { value: "page_n_of_total", label: "Page 1 of 10" },
      { value: "custom", label: "Custom…" },
    ],
    "n",
  ),
  template: opt.text(
    "Custom format",
    "{n} / {total}",
    "Use {n} for the number and {total} for the last number.",
    {
      showWhen: { key: "format", values: ["custom"] },
    },
  ),
  first_number: opt.int("Start at", 0, 1_000_000, 1),
  pages: opt.pages("Pages to number", "Leave empty to number every page.", true),
  skip_first: opt.bool("Don't number the first page", false, "For a cover page."),
  facing: opt.bool(
    "Facing pages",
    false,
    "Mirror left/right positions on even pages, like a printed book.",
  ),
  margin: opt.choice(
    "Margin",
    [
      { value: "small", label: "Small" },
      { value: "medium", label: "Medium" },
      { value: "large", label: "Large" },
    ],
    "medium",
    undefined,
    { segmented: true },
  ),
  font: opt.choice("Font", FONT_CHOICES, "helvetica"),
  bold: opt.bool("Bold", false),
  size: opt.int("Size", 6, 72, 11),
  color: opt.color("Color", "#000000"),
});

export const watermarkOptions = z.object({
  kind: opt.choice(
    "Watermark",
    [
      { value: "text", label: "Text" },
      { value: "image", label: "Image" },
    ],
    "text",
    undefined,
    { segmented: true },
  ),
  text: opt.text("Text", "CONFIDENTIAL", undefined, {
    showWhen: { key: "kind", values: ["text"] },
  }),
  font: opt.choice("Font", FONT_CHOICES, "helvetica", undefined, {
    showWhen: { key: "kind", values: ["text"] },
  }),
  bold: opt.bool("Bold", true, undefined, { showWhen: { key: "kind", values: ["text"] } }),
  size: opt.int("Size", 6, 200, 48, undefined, { showWhen: { key: "kind", values: ["text"] } }),
  color: opt.color("Color", "#808080", undefined, {
    showWhen: { key: "kind", values: ["text"] },
  }),
  image: opt.text("Image", "", "PNG with transparency works best.", {
    showWhen: { key: "kind", values: ["image"] },
    file: {
      name: "Images",
      extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff"],
    },
  }),
  scale: opt.int("Width (% of the page)", 5, 100, 40, undefined, {
    showWhen: { key: "kind", values: ["image"] },
  }),
  opacity: opt.int("Opacity (%)", 5, 100, 30),
  rotation: opt.int("Rotation (degrees)", -180, 180, 45),
  tile: opt.bool("Repeat across the page", false),
  position: opt.choice("Position", POSITIONS, "middle-center", undefined, {
    grid: true,
    showWhen: { key: "tile", values: ["false"] },
  }),
  layer: opt.choice(
    "Layer",
    [
      { value: "over", label: "Over content" },
      { value: "under", label: "Under content" },
    ],
    "over",
    "“Under” can be hidden by pages that have a solid background (such as scans).",
    { segmented: true },
  ),
  pages: opt.pages("Pages", "Leave empty to watermark every page.", true),
});

export const compressOptions = z.object({
  level: opt.choice(
    "Compression",
    [
      { value: "extreme", label: "Extreme — smallest file (72 dpi images)" },
      { value: "recommended", label: "Recommended — good quality (150 dpi)" },
      { value: "low", label: "Low — best quality (300 dpi)" },
      { value: "custom", label: "Custom…" },
    ],
    "recommended",
    "Only pictures are compressed; text and drawings stay sharp.",
  ),
  dpi: opt.int("Image resolution (dpi)", 36, 600, 150, undefined, {
    showWhen: { key: "level", values: ["custom"] },
  }),
  quality: opt.int("JPEG quality", 10, 95, 60, "Lower is smaller.", {
    showWhen: { key: "level", values: ["custom"] },
  }),
  grayscale: opt.bool("Convert images to grayscale", false, undefined, {
    showWhen: { key: "level", values: ["custom"] },
  }),
  remove_metadata: opt.bool(
    "Remove metadata",
    false,
    "Author, title and other document properties.",
    { showWhen: { key: "level", values: ["custom"] } },
  ),
});

export const powerpointToPdfOptions = z.object({
  include_notes: opt.bool(
    "Include speaker notes",
    false,
    "Adds a notes page after the slides, one per slide.",
  ),
});

export const excelToPdfOptions = z.object({
  sheets: opt.choice(
    "Sheets",
    [
      { value: "all", label: "All sheets" },
      { value: "active", label: "Active sheet only" },
    ],
    "all",
    "The active sheet is the one that was open when the file was last saved.",
    { segmented: true },
  ),
  fit_width: opt.bool(
    "Fit each sheet to the page width",
    false,
    "Wide sheets are scaled down instead of being split across pages.",
  ),
});

export const pdfToWordOptions = z.object({
  ocr: opt.bool(
    "Recognise text in scanned pages (OCR)",
    false,
    "Scanned pages become editable text instead of pictures. Slower.",
  ),
  languages: opt.languages("Document language", undefined, {
    showWhen: { key: "ocr", values: ["true"] },
  }),
});

export const pdfToExcelOptions = z.object({
  layout: opt.choice(
    "What to export",
    [
      { value: "tables", label: "Detected tables — one sheet per table" },
      { value: "pages", label: "Everything — one sheet per page" },
      { value: "single", label: "Everything — one sheet in total" },
    ],
    "tables",
    "Tables are found by their ruling lines. Without any, the text is split into columns.",
  ),
});

export const pdfToTextOptions = z.object({
  keep_layout: opt.bool(
    "Keep the page layout",
    false,
    "Pads lines with spaces so columns stay aligned. Off: plain reading order.",
  ),
});

export const textToPdfOptions = z.object({
  font: opt.choice(
    "Font",
    [
      { value: "helvetica", label: "Sans serif" },
      { value: "times", label: "Serif" },
      { value: "courier", label: "Monospace" },
    ],
    "helvetica",
    undefined,
    { segmented: true },
  ),
  size: opt.int("Font size (pt)", 6, 36, 11),
  page_size: opt.choice(
    "Page size",
    [
      { value: "a4", label: "A4" },
      { value: "letter", label: "Letter" },
    ],
    "a4",
    undefined,
    { segmented: true },
  ),
  margins: opt.choice(
    "Margins",
    [
      { value: "narrow", label: "Narrow" },
      { value: "normal", label: "Normal" },
      { value: "wide", label: "Wide" },
    ],
    "normal",
    undefined,
    { segmented: true },
  ),
});

export const htmlToPdfOptions = z.object({
  page_size: opt.choice(
    "Page size",
    [
      { value: "a4", label: "A4" },
      { value: "letter", label: "Letter" },
      { value: "legal", label: "Legal" },
    ],
    "a4",
    undefined,
    { segmented: true },
  ),
  orientation: opt.choice(
    "Orientation",
    [
      { value: "portrait", label: "Portrait" },
      { value: "landscape", label: "Landscape" },
    ],
    "portrait",
    undefined,
    { segmented: true },
  ),
  margins: opt.choice(
    "Margins",
    [
      { value: "none", label: "None" },
      { value: "small", label: "Small" },
      { value: "normal", label: "Normal" },
      { value: "large", label: "Large" },
    ],
    "normal",
    undefined,
    { segmented: true },
  ),
  background: opt.bool(
    "Include background colours and images",
    true,
    "Scripts never run and nothing is downloaded: online pictures are left out.",
  ),
});

export const pdfToPdfaOptions = z.object({
  level: opt.choice(
    "Conformance level",
    [
      { value: "2b", label: "PDF/A-2b — recommended" },
      { value: "3b", label: "PDF/A-3b — keeps attached files" },
    ],
    "2b",
    "Files that cannot be archived faithfully (e.g. print colours) are refused, never mislabelled.",
  ),
});

export const ocrOptions = z.object({
  languages: opt.languages("Document language"),
  auto_rotate: opt.bool(
    "Turn sideways pages upright",
    true,
    "Detects pages scanned the wrong way round and fixes their rotation (lossless).",
  ),
  deskew: opt.bool(
    "Straighten crooked scans",
    false,
    "Re-saves the scanned picture of tilted pages, slightly straightened.",
  ),
  force: opt.bool(
    "Recognise pages that already have text",
    false,
    "Normally pages with real text are left alone.",
  ),
});

export const editPdfOptions = z.object({
  annotations: opt.bool(
    "Keep added objects editable",
    false,
    "Saves them as annotations other PDF editors can move or delete. Off: they become part of the page.",
  ),
});

export const cropOptions = z.object({
  mode: opt.choice(
    "Crop",
    [
      { value: "box", label: "Area I draw" },
      { value: "auto", label: "Trim white margins" },
    ],
    "box",
    "Cropping hides the rest of the page; nothing is deleted, so it can be undone later.",
    { segmented: true },
  ),
  apply: opt.choice(
    "Apply to",
    [
      { value: "current", label: "This page" },
      { value: "all", label: "All pages" },
    ],
    "all",
    undefined,
    { segmented: true },
  ),
  margin: opt.int("Keep a margin of (pt)", 0, 72, 6, undefined, {
    showWhen: { key: "mode", values: ["auto"] },
  }),
});

export const redactOptions = z.object({
  ocr: opt.bool(
    "Run OCR on non-redacted areas",
    true,
    "Redacted pages are rebuilt as pictures and can't be searched. OCR restores searchable text outside the black boxes.",
  ),
  languages: opt.languages("Document language", undefined, {
    showWhen: { key: "ocr", values: ["true"] },
  }),
  remove_metadata: opt.bool(
    "Remove document information",
    true,
    "Title, author and other properties can contain names too.",
  ),
  dpi: opt.choice(
    "Quality of redacted pages",
    [
      { value: "150", label: "Smaller file (150 dpi)" },
      { value: "200", label: "Standard (200 dpi)" },
      { value: "300", label: "Sharp (300 dpi)" },
    ],
    "200",
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
  {
    id: "compress",
    ref: "B1",
    name: "Compress PDF",
    description: "Shrink file size for email and upload, with a before/after comparison.",
    category: "optimize",
    icon: Minimize2,
    accepts: onePdf,
    optionsSchema: compressOptions,
    status: "available",
    priority: "must",
    phase: 1,
    engineMethod: "compress",
    actionLabel: "Compress PDF",
    keywords: ["reduce", "smaller", "size", "optimize", "shrink", "email"],
    toEngine: (o) =>
      o.level === "custom"
        ? {
            level: "custom",
            dpi: o.dpi,
            quality: o.quality,
            grayscale: o.grayscale,
            remove_metadata: o.remove_metadata,
          }
        : { level: o.level },
    summary: (s) =>
      s.kept_original === true
        ? null
        : typeof s.images_recompressed === "number" && typeof s.images === "number"
          ? `Recompressed ${s.images_recompressed} of ${s.images} images`
          : null,
  },
  {
    id: "repair",
    ref: "B2",
    name: "Repair PDF",
    description: "Rebuild damaged files and recover as many pages as possible.",
    category: "optimize",
    icon: Wrench,
    accepts: { extensions: PDF, min: 1, max: 100, label: "Damaged PDF files" },
    optionsSchema: NO_OPTIONS,
    status: "available",
    priority: "should",
    phase: 2,
    engineMethod: "repair",
    actionLabel: "Repair PDF",
    keywords: ["fix", "broken", "corrupt", "damaged", "recover"],
    acceptsDamaged: true,
    summary: (s) => {
      const reports = Array.isArray(s.reports) ? (s.reports as Record<string, unknown>[]) : [];
      const describe = (r: Record<string, unknown>) =>
        r.status === "partial"
          ? `Partially recovered (${String(r.pages)} of ${String(r.expected_pages)} pages)`
          : r.status === "repaired"
            ? `Repaired — all ${String(r.pages)} pages recovered`
            : `No damage found — a clean copy with ${String(r.pages)} pages was saved`;
      const [only, ...rest] = reports;
      if (!only) return null;
      if (rest.length === 0) return describe(only);
      const partial = reports.filter((r) => r.status === "partial").length;
      return partial
        ? `${reports.length} files repaired, ${partial} only partially`
        : `${reports.length} files repaired`;
    },
  },
  {
    id: "ocr",
    ref: "B3",
    name: "OCR PDF",
    description: "Make scanned documents searchable and selectable.",
    category: "optimize",
    icon: ScanText,
    accepts: convertPdfs,
    optionsSchema: ocrOptions,
    status: "available",
    priority: "should",
    phase: 2,
    engineMethod: "ocr",
    actionLabel: "Make searchable",
    keywords: ["scan", "text recognition", "searchable", "tesseract", "tamil", "hindi"],
    toEngine: (o) => ({
      languages: o.languages,
      auto_rotate: o.auto_rotate,
      deskew: o.deskew,
      force: o.force,
    }),
    summary: (s) => {
      if (typeof s.ocr_pages !== "number") return null;
      const parts = [`Text recognised on ${s.ocr_pages} ${s.ocr_pages === 1 ? "page" : "pages"}`];
      if (typeof s.skipped_pages === "number" && s.skipped_pages > 0) {
        parts.push(`${s.skipped_pages} already had text`);
      }
      if (typeof s.rotated === "number" && s.rotated > 0) parts.push(`${s.rotated} turned upright`);
      if (typeof s.deskewed === "number" && s.deskewed > 0)
        parts.push(`${s.deskewed} straightened`);
      return parts.join(" · ");
    },
  },

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
  {
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
    optionsSchema: NO_OPTIONS,
    status: "available",
    priority: "must",
    phase: 2,
    engineMethod: "word-to-pdf",
    actionLabel: "Convert to PDF",
    keywords: ["docx", "doc", "odt", "rtf", "document"],
    summary: (s) => {
      if (typeof s.pages !== "number") return null;
      const pages = `${s.pages} ${s.pages === 1 ? "page" : "pages"}`;
      return typeof s.files === "number" && s.files > 1 ? `${s.files} PDFs, ${pages}` : pages;
    },
  },
  {
    id: "powerpoint-to-pdf",
    ref: "C3",
    name: "PowerPoint to PDF",
    description: "Convert PPT, PPTX and ODP slide decks, optionally with notes.",
    category: "convert",
    icon: Presentation,
    accepts: { extensions: ["ppt", "pptx", "odp"], min: 1, max: 100, label: "Presentations" },
    optionsSchema: powerpointToPdfOptions,
    status: "available",
    priority: "must",
    phase: 2,
    engineMethod: "powerpoint-to-pdf",
    actionLabel: "Convert to PDF",
    keywords: ["pptx", "ppt", "slides", "deck", "presentation"],
    summary: (s) => {
      if (typeof s.pages !== "number") return null;
      const pages = `${s.pages} ${s.pages === 1 ? "page" : "pages"}`;
      return typeof s.files === "number" && s.files > 1 ? `${s.files} PDFs, ${pages}` : pages;
    },
  },
  {
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
    optionsSchema: excelToPdfOptions,
    status: "available",
    priority: "must",
    phase: 2,
    engineMethod: "excel-to-pdf",
    actionLabel: "Convert to PDF",
    keywords: ["xlsx", "xls", "csv", "spreadsheet", "sheet"],
    summary: (s) => {
      if (typeof s.pages !== "number") return null;
      const pages = `${s.pages} ${s.pages === 1 ? "page" : "pages"}`;
      return typeof s.files === "number" && s.files > 1 ? `${s.files} PDFs, ${pages}` : pages;
    },
  },
  {
    id: "html-to-pdf",
    ref: "C5",
    name: "HTML to PDF",
    description: "Save a local web page as a PDF with your page size and margins.",
    category: "convert",
    icon: Code,
    accepts: { extensions: ["html", "htm"], min: 1, max: 1, label: "One HTML file" },
    optionsSchema: htmlToPdfOptions,
    status: "available",
    priority: "should",
    phase: 2,
    engineMethod: "html-to-pdf",
    actionLabel: "Convert to PDF",
    keywords: ["web page", "htm", "website", "save page"],
    summary: (s) => {
      if (typeof s.pages !== "number") return null;
      const parts = [`${s.pages} ${s.pages === 1 ? "page" : "pages"}`];
      if (typeof s.remote_skipped === "number") {
        parts.push(`${s.remote_skipped} online resources left out (works offline)`);
      }
      if (typeof s.missing_files === "number") {
        parts.push(`${s.missing_files} linked files not found`);
      }
      return parts.join(" · ");
    },
  },
  {
    id: "text-to-pdf",
    ref: "C6",
    name: "Text to PDF",
    description: "Typeset plain text or Markdown files as a clean PDF.",
    category: "convert",
    icon: Type,
    accepts: {
      extensions: ["txt", "md", "markdown"],
      min: 1,
      max: 100,
      label: "Text or Markdown files",
    },
    optionsSchema: textToPdfOptions,
    status: "available",
    priority: "could",
    phase: 2,
    engineMethod: "text-to-pdf",
    actionLabel: "Convert to PDF",
    keywords: ["txt", "markdown", "md", "notes"],
    summary: (s) => {
      if (typeof s.pages !== "number") return null;
      const pages = `${s.pages} ${s.pages === 1 ? "page" : "pages"}`;
      const replaced =
        typeof s.replaced_characters === "number"
          ? ` · ${s.replaced_characters} characters could not be shown and became “?”`
          : "";
      return (
        (typeof s.files === "number" && s.files > 1 ? `${s.files} PDFs, ${pages}` : pages) +
        replaced
      );
    },
  },

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
  {
    id: "pdf-to-word",
    ref: "D2",
    name: "PDF to Word",
    description: "Turn a PDF into an editable DOCX document (best-effort layout).",
    category: "convert",
    icon: FileType,
    accepts: convertPdfs,
    optionsSchema: pdfToWordOptions,
    status: "available",
    priority: "must",
    phase: 2,
    engineMethod: "pdf-to-word",
    actionLabel: "Convert to Word",
    keywords: ["docx", "editable", "doc"],
    toEngine: (o) =>
      o.ocr ? { ocr: true, languages: String(o.languages).split("+") } : { ocr: false },
    summary: (s) => {
      if (typeof s.pages !== "number") return null;
      const pages = `${s.pages} ${s.pages === 1 ? "page" : "pages"}`;
      return typeof s.files === "number" && s.files > 1
        ? `${s.files} files from ${pages}`
        : `${pages} converted`;
    },
  },
  {
    id: "pdf-to-powerpoint",
    ref: "D3",
    name: "PDF to PowerPoint",
    description: "Make a PPTX with one slide per page and editable text boxes.",
    category: "convert",
    icon: Presentation,
    accepts: convertPdfs,
    optionsSchema: NO_OPTIONS,
    status: "available",
    priority: "should",
    phase: 2,
    engineMethod: "pdf-to-powerpoint",
    actionLabel: "Convert to PowerPoint",
    keywords: ["pptx", "slides"],
    summary: (s) => {
      if (typeof s.pages !== "number") return null;
      const pages = `${s.pages} ${s.pages === 1 ? "page" : "pages"}`;
      return typeof s.files === "number" && s.files > 1
        ? `${s.files} files from ${pages}`
        : `${pages} converted`;
    },
  },
  {
    id: "pdf-to-excel",
    ref: "D4",
    name: "PDF to Excel",
    description: "Detect tables and export them to an XLSX workbook.",
    category: "convert",
    icon: Sheet,
    accepts: convertPdfs,
    optionsSchema: pdfToExcelOptions,
    status: "available",
    priority: "should",
    phase: 2,
    engineMethod: "pdf-to-excel",
    actionLabel: "Convert to Excel",
    keywords: ["xlsx", "tables", "spreadsheet"],
    summary: (s) => {
      if (typeof s.sheets !== "number") return null;
      const sheets = `${s.sheets} ${s.sheets === 1 ? "sheet" : "sheets"}`;
      return typeof s.tables === "number" && s.tables > 0
        ? `${s.tables} ${s.tables === 1 ? "table" : "tables"} found → ${sheets}`
        : `No ruled tables found — text exported in columns (${sheets})`;
    },
  },
  {
    id: "pdf-to-pdfa",
    ref: "D5",
    name: "PDF to PDF/A",
    description: "Convert to PDF/A for long-term archiving.",
    category: "convert",
    icon: FileArchive,
    accepts: convertPdfs,
    optionsSchema: pdfToPdfaOptions,
    status: "available",
    priority: "should",
    phase: 2,
    engineMethod: "pdf-to-pdfa",
    actionLabel: "Convert to PDF/A",
    keywords: ["archive", "pdfa", "long-term", "iso 19005"],
    summary: (s) => {
      if (typeof s.level !== "string") return null;
      const fixes =
        s.fixes && typeof s.fixes === "object"
          ? Object.values(s.fixes as Record<string, number>).reduce((a, b) => a + b, 0)
          : 0;
      return `PDF/A-${s.level} · checked by PDFForge${fixes ? ` · ${fixes} fixes applied` : ""}`;
    },
  },
  {
    id: "pdf-to-text",
    ref: "D6",
    name: "PDF to Text",
    description: "Extract the text of a PDF into a plain .txt file.",
    category: "convert",
    icon: TextCursorInput,
    accepts: convertPdfs,
    optionsSchema: pdfToTextOptions,
    status: "available",
    priority: "could",
    phase: 2,
    engineMethod: "pdf-to-text",
    actionLabel: "Extract text",
    keywords: ["txt", "extract text", "copy text"],
    summary: (s) => {
      if (typeof s.pages !== "number") return null;
      const pages = `${s.pages} ${s.pages === 1 ? "page" : "pages"}`;
      return typeof s.files === "number" && s.files > 1
        ? `${s.files} files from ${pages}`
        : `${pages} converted`;
    },
  },

  // ── E. Edit ───────────────────────────────────────────────────────────────────────────────
  {
    id: "edit-pdf",
    ref: "E1",
    name: "Edit PDF",
    description: "Add text, pictures, shapes, drawings and notes to any page.",
    category: "edit",
    icon: PenLine,
    accepts: onePdf,
    optionsSchema: editPdfOptions,
    status: "available",
    priority: "should",
    phase: 3,
    engineMethod: "edit-pdf",
    actionLabel: "Save changes",
    keywords: ["annotate", "draw", "text box", "add image", "shapes", "comment", "sticky note"],
    layout: "editor",
    summary: (s) => {
      if (typeof s.objects !== "number") return null;
      const what = `${s.objects} ${s.objects === 1 ? "object" : "objects"} added`;
      return s.annotations === true ? `${what} as editable annotations` : what;
    },
  },
  {
    id: "page-numbers",
    ref: "E2",
    name: "Add Page Numbers",
    description: "Number pages with your choice of position, format and style.",
    category: "edit",
    icon: Hash,
    accepts: onePdf,
    optionsSchema: pageNumberOptions,
    status: "available",
    priority: "must",
    phase: 1,
    engineMethod: "page-numbers",
    actionLabel: "Add page numbers",
    keywords: ["numbering", "pagination", "footer", "page x of y"],
    toEngine: (o) => ({
      ...o,
      margin: MARGIN_POINTS[String(o.margin)] ?? 28,
      pages: typeof o.pages === "string" && o.pages.trim() ? o.pages : "all",
    }),
    summary: (s) =>
      typeof s.numbered === "number"
        ? `Numbered ${s.numbered} ${s.numbered === 1 ? "page" : "pages"} (${String(s.first)}–${String(s.last)})`
        : null,
  },
  {
    id: "watermark",
    ref: "E3",
    name: "Add Watermark",
    description: "Stamp text or an image over or under your pages.",
    category: "edit",
    icon: Stamp,
    accepts: onePdf,
    optionsSchema: watermarkOptions,
    status: "available",
    priority: "must",
    phase: 1,
    engineMethod: "watermark",
    actionLabel: "Add watermark",
    keywords: ["stamp", "confidential", "draft", "logo", "copy"],
    check: (o) => {
      if (o.kind === "text" && !(typeof o.text === "string" && o.text.trim())) {
        return "Enter the watermark text.";
      }
      if (o.kind === "image" && !(typeof o.image === "string" && o.image)) {
        return "Choose an image for the watermark.";
      }
      return null;
    },
    toEngine: (o) => {
      const common = {
        kind: o.kind,
        opacity: Number(o.opacity) / 100,
        rotation: o.rotation,
        tile: o.tile,
        position: o.position,
        layer: o.layer,
        pages: typeof o.pages === "string" && o.pages.trim() ? o.pages : "all",
      };
      return o.kind === "image"
        ? { ...common, image: o.image, scale: Number(o.scale) / 100 }
        : { ...common, text: o.text, font: o.font, bold: o.bold, size: o.size, color: o.color };
    },
    summary: (s) =>
      typeof s.watermarked === "number"
        ? `Watermarked ${s.watermarked} ${s.watermarked === 1 ? "page" : "pages"}${
            s.layer === "under" ? " (under the content)" : ""
          }`
        : null,
  },
  {
    id: "crop",
    ref: "E4",
    name: "Crop PDF",
    description: "Cut pages down to the area you draw, or trim white margins automatically.",
    category: "edit",
    icon: Crop,
    accepts: onePdf,
    optionsSchema: cropOptions,
    status: "available",
    priority: "should",
    phase: 3,
    engineMethod: "crop",
    actionLabel: "Crop PDF",
    keywords: ["trim", "margins", "cut", "crop box"],
    layout: "crop",
    summary: (s) =>
      typeof s.cropped === "number"
        ? `Cropped ${s.cropped} of ${String(s.pages)} ${s.pages === 1 ? "page" : "pages"}`
        : null,
  },
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
  {
    id: "sign",
    ref: "F3",
    name: "Sign PDF",
    description: "Sign with a typed, drawn or uploaded signature, plus initials and the date.",
    category: "security",
    icon: Signature,
    accepts: onePdf,
    optionsSchema: NO_OPTIONS,
    status: "available",
    priority: "should",
    phase: 3,
    engineMethod: "sign",
    actionLabel: "Sign and save",
    keywords: ["signature", "e-sign", "initials", "fill and sign"],
    layout: "sign",
    summary: (s) =>
      typeof s.objects === "number"
        ? `${s.objects} ${s.objects === 1 ? "item" : "items"} signed onto the document`
        : null,
  },
  {
    id: "redact",
    ref: "F4",
    name: "Redact PDF",
    description: "Permanently remove sensitive text and images — not just cover them.",
    category: "security",
    icon: EyeOff,
    accepts: onePdf,
    optionsSchema: redactOptions,
    status: "available",
    priority: "could",
    phase: 3,
    engineMethod: "redact",
    actionLabel: "Redact permanently",
    keywords: ["black out", "remove text", "privacy", "pan", "aadhaar", "censor"],
    layout: "redact",
    toEngine: (o) => ({
      ocr: o.ocr,
      languages: o.languages,
      remove_metadata: o.remove_metadata,
      dpi: Number(o.dpi),
    }),
    summary: (s) => {
      if (typeof s.areas !== "number") return null;
      const pages = typeof s.pages_redacted === "number" ? s.pages_redacted : 0;
      return `${s.areas} ${s.areas === 1 ? "area" : "areas"} removed on ${pages} ${pages === 1 ? "page" : "pages"}`;
    },
  },
  {
    id: "compare",
    ref: "F5",
    name: "Compare PDF",
    description: "See what changed between two versions, side by side, with a report.",
    category: "security",
    icon: GitCompareArrows,
    accepts: twoPdfs,
    optionsSchema: NO_OPTIONS,
    status: "available",
    priority: "could",
    phase: 3,
    engineMethod: "compare",
    actionLabel: "Compare",
    keywords: ["diff", "difference", "versions", "changes", "redline"],
    layout: "compare",
    summary: (s) =>
      typeof s.added === "number" && typeof s.removed === "number" && typeof s.changed === "number"
        ? s.added + s.removed + s.changed === 0
          ? "The two documents contain the same text"
          : `${s.added} added · ${s.removed} removed · ${s.changed} changed`
        : null,
  },

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
