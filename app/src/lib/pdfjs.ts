/**
 * Thumbnails and page counts with pdf.js (docs/03 §5). Rendering happens in the UI; files are
 * read through the `read_input_file` command (no file:// access, no network).
 */
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { api } from "@/engine/client";
import { extension } from "./utils";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const THUMB_WIDTH = 132;
const MAX_CONCURRENT = 2;

export type PreviewResult =
  | { kind: "ok"; pages: number | null; thumbnail: string | null }
  | { kind: "locked"; wrongPassword: boolean }
  | { kind: "error"; message: string };

const IMAGE_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  bmp: "image/bmp",
  gif: "image/gif",
  webp: "image/webp",
  tif: "image/tiff",
  tiff: "image/tiff",
};

let active = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(task: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  active += 1;
  try {
    return await task();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

/** pdf.js 4 does not export PasswordException; it is identified by name. */
function isPasswordError(err: unknown): err is { name: string; code: number } {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "PasswordException" &&
    typeof (err as { code?: unknown }).code === "number"
  );
}

async function renderPdf(bytes: ArrayBuffer, password?: string): Promise<PreviewResult> {
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    password,
    isEvalSupported: false,
    enableXfa: false,
    disableAutoFetch: true,
    disableFontFace: false,
  });
  try {
    const doc = await task.promise;
    try {
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const scale = (THUMB_WIDTH * window.devicePixelRatio) / base.width;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d");
      if (!context) return { kind: "ok", pages: doc.numPages, thumbnail: null };
      await page.render({ canvasContext: context, viewport }).promise;
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, "image/png");
      });
      return {
        kind: "ok",
        pages: doc.numPages,
        thumbnail: blob ? URL.createObjectURL(blob) : null,
      };
    } finally {
      await doc.destroy();
    }
  } catch (err) {
    if (isPasswordError(err)) {
      return {
        kind: "locked",
        wrongPassword: err.code === pdfjs.PasswordResponses.INCORRECT_PASSWORD,
      };
    }
    return { kind: "error", message: "unreadable" };
  } finally {
    await task.destroy();
  }
}

const PREVIEW_TIMEOUT_MS = 20_000;

/** Page count + first-page thumbnail (PDF) or the image itself (images). Never hangs: after
 * PREVIEW_TIMEOUT_MS the file is treated as usable without a thumbnail. */
export function preview(path: string, password?: string): Promise<PreviewResult> {
  const fallback = new Promise<PreviewResult>((resolve) => {
    window.setTimeout(() => {
      resolve({ kind: "ok", pages: null, thumbnail: null });
    }, PREVIEW_TIMEOUT_MS);
  });
  return Promise.race([loadPreview(path, password), fallback]);
}

function loadPreview(path: string, password?: string): Promise<PreviewResult> {
  return withSlot(async () => {
    let bytes: ArrayBuffer;
    try {
      bytes = await api.readInputFile(path);
    } catch {
      // Too large or unreadable for preview: still usable, just without a thumbnail.
      return { kind: "ok", pages: null, thumbnail: null };
    }
    const ext = extension(path);
    if (ext !== "pdf") {
      const mime = IMAGE_MIME[ext];
      const thumb = mime ? URL.createObjectURL(new Blob([bytes], { type: mime })) : null;
      return { kind: "ok", pages: 1, thumbnail: thumb };
    }
    return renderPdf(bytes, password);
  });
}
