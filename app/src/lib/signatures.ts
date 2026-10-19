/**
 * Signatures for Sign PDF (02 F3): created by typing, drawing or uploading, stored encrypted by
 * the shell (DPAPI). Pictures are PNGs with a transparent background; they reach the engine as
 * job secrets ("secret:<id>"), never as paths or in job history.
 */
import { api, isTauri } from "@/engine/client";

export type SignatureKind = "signature" | "initials";

export interface Signature {
  id: string;
  kind: SignatureKind;
  /** PNG, base64 (no data: prefix). */
  png: string;
  /** Height / width of the picture. */
  ratio: number;
  /** Kept only for this session (not saved). */
  transient?: boolean;
}

/** Handwriting-style fonts that ship with Windows 10/11. */
export const SIGNATURE_FONTS = [
  { family: "'Segoe Script'", label: "Segoe Script" },
  { family: "'Ink Free'", label: "Ink Free" },
  { family: "'Lucida Handwriting'", label: "Lucida Handwriting" },
  { family: "'Segoe Print'", label: "Segoe Print" },
] as const;

export const INK_COLORS = ["#1F2933", "#1D3D8F", "#0B6E4F"] as const;

export function dataUrl(png: string): string {
  return `data:image/png;base64,${png}`;
}

export function stripDataUrl(url: string): string {
  return url.replace(/^data:image\/png;base64,/, "");
}

/** Crop a canvas to its non-transparent pixels (plus a small margin). */
export function trimCanvas(canvas: HTMLCanvasElement, margin = 6): HTMLCanvasElement | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const { width, height } = canvas;
  const { data } = ctx.getImageData(0, 0, width, height);
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((data[(y * width + x) * 4 + 3] ?? 0) > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - margin);
  y0 = Math.max(0, y0 - margin);
  x1 = Math.min(width - 1, x1 + margin);
  y1 = Math.min(height - 1, y1 + margin);
  const out = document.createElement("canvas");
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out
    .getContext("2d")
    ?.drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

/** Render typed text in a handwriting font to a trimmed, transparent PNG. */
export async function typedSignature(
  text: string,
  family: string,
  color: string,
): Promise<{ png: string; ratio: number } | null> {
  if (!text.trim()) return null;
  await document.fonts.load(`96px ${family}`).catch(() => undefined);
  const canvas = document.createElement("canvas");
  canvas.width = 1600;
  canvas.height = 320;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.font = `120px ${family}`;
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.fillText(text.trim(), 40, 160, 1520);
  return fromCanvas(canvas);
}

export function fromCanvas(canvas: HTMLCanvasElement): { png: string; ratio: number } | null {
  const trimmed = trimCanvas(canvas);
  if (!trimmed) return null;
  return {
    png: stripDataUrl(trimmed.toDataURL("image/png")),
    ratio: trimmed.height / Math.max(1, trimmed.width),
  };
}

/** Load a picture file and turn white-ish background pixels transparent (scanned signatures). */
export async function uploadedSignature(
  path: string,
): Promise<{ png: string; ratio: number } | null> {
  const bytes = await api.readInputFile(path);
  const url = URL.createObjectURL(new Blob([bytes]));
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = url;
    });
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < pixels.data.length; i += 4) {
      const r = pixels.data[i] ?? 0;
      const g = pixels.data[i + 1] ?? 0;
      const b = pixels.data[i + 2] ?? 0;
      if (r > 225 && g > 225 && b > 225) pixels.data[i + 3] = 0;
    }
    ctx.putImageData(pixels, 0, 0);
    return fromCanvas(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function ratioOf(png: string): Promise<number> {
  const img = new Image();
  img.src = dataUrl(png);
  await img.decode().catch(() => undefined);
  return img.naturalHeight / Math.max(1, img.naturalWidth) || 0.33;
}

export async function loadSignatures(): Promise<Signature[]> {
  if (!isTauri()) return [];
  const saved = await api.listSignatures();
  return Promise.all(
    saved.map(async (s) => ({
      id: s.id,
      kind: s.kind === "initials" ? "initials" : "signature",
      png: s.png,
      ratio: await ratioOf(s.png),
    })),
  );
}
