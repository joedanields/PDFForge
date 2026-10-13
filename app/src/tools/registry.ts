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
}

const PDF = ["pdf"] as const;
const IMAGES = ["jpg", "jpeg", "png", "bmp", "tif", "tiff", "webp", "gif", "heic"] as const;
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
      extensions: [...PDF, ...IMAGES.filter((e) => e !== "heic")],
      min: 2,
      max: 500,
      label: "PDFs or images (JPG, PNG, BMP, TIFF, WEBP, GIF) — at least 2 files",
    },
    optionsSchema: mergeOptions,
    status: "available",
    priority: "must",
    phase: 0,
    engineMethod: "merge",
    actionLabel: "Merge PDF",
    keywords: ["combine", "join", "append"],
  },
  soon({
    id: "split",
    ref: "A2",
    name: "Split PDF",
    description: "Break a PDF into parts by page ranges, fixed size, file size or bookmarks.",
    category: "organize",
    icon: Scissors,
    accepts: onePdf,
    priority: "must",
    phase: 1,
    keywords: ["separate", "ranges", "divide"],
  }),
  soon({
    id: "remove-pages",
    ref: "A3",
    name: "Remove Pages",
    description: "Delete the pages you don't need and keep the rest.",
    category: "organize",
    icon: FileMinus,
    accepts: onePdf,
    priority: "must",
    phase: 1,
    keywords: ["delete"],
  }),
  soon({
    id: "extract-pages",
    ref: "A4",
    name: "Extract Pages",
    description: "Pull selected pages out into a new PDF or one file per page.",
    category: "organize",
    icon: FileOutput,
    accepts: onePdf,
    priority: "must",
    phase: 1,
  }),
  soon({
    id: "organize",
    ref: "A5",
    name: "Organize PDF",
    description: "Reorder, rotate, duplicate, insert or delete pages on a thumbnail board.",
    category: "organize",
    icon: LayoutGrid,
    accepts: manyPdfs,
    priority: "must",
    phase: 1,
    keywords: ["reorder", "sort", "arrange"],
  }),
  soon({
    id: "rotate",
    ref: "A6",
    name: "Rotate PDF",
    description: "Turn all or selected pages by 90°, 180° or 270° without quality loss.",
    category: "organize",
    icon: RotateCw,
    accepts: manyPdfs,
    priority: "must",
    phase: 1,
  }),

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
  soon({
    id: "image-to-pdf",
    ref: "C1",
    name: "Image to PDF",
    description: "Turn JPG, PNG, TIFF, WEBP or HEIC images into a PDF.",
    category: "convert",
    icon: FileImage,
    accepts: { extensions: IMAGES, min: 1, max: 500, label: "Images" },
    priority: "must",
    phase: 1,
    keywords: ["jpg to pdf", "png", "photo"],
  }),
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
  soon({
    id: "pdf-to-image",
    ref: "D1",
    name: "PDF to Image",
    description: "Export pages as JPG or PNG, or pull out the embedded pictures.",
    category: "convert",
    icon: Images,
    accepts: manyPdfs,
    priority: "must",
    phase: 1,
    keywords: ["pdf to jpg", "png", "export images"],
  }),
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
  soon({
    id: "protect",
    ref: "F1",
    name: "Protect PDF",
    description: "Add a password and control printing, copying and editing.",
    category: "security",
    icon: Lock,
    accepts: manyPdfs,
    priority: "must",
    phase: 1,
    keywords: ["password", "encrypt"],
  }),
  soon({
    id: "unlock",
    ref: "F2",
    name: "Unlock PDF",
    description: "Remove a password you know, or lift owner restrictions.",
    category: "security",
    icon: LockOpen,
    accepts: manyPdfs,
    priority: "must",
    phase: 1,
    keywords: ["decrypt", "remove password"],
  }),
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
