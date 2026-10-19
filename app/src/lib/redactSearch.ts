/**
 * Find text to redact (02 F4: "search text, incl. regex presets: email, phone, PAN/Aadhaar").
 * Matches are turned into boxes on the page; the engine then removes everything under them.
 */
import type { TextItemBox } from "./pdfjs";

export interface Preset {
  id: string;
  label: string;
  pattern: RegExp;
}

export const PRESETS: Preset[] = [
  { id: "email", label: "Email addresses", pattern: /[\w.+-]+@[\w-]+(\.[\w-]+)+/g },
  {
    id: "phone",
    label: "Phone numbers",
    pattern: /(\+\d{1,3}[\s-]?)?(\(?\d{2,5}\)?[\s-]?)?\d{3,5}[\s-]?\d{4}\b/g,
  },
  { id: "pan", label: "PAN numbers", pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
  { id: "aadhaar", label: "Aadhaar numbers", pattern: /\b\d{4}\s?\d{4}\s?\d{4}\b/g },
];

export interface Area {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A case-insensitive pattern for a typed search term (whitespace-tolerant). */
export function termPattern(term: string): RegExp | null {
  const cleaned = term.trim();
  if (!cleaned) return null;
  return new RegExp(cleaned.split(/\s+/).map(escapeRegExp).join("\\s+"), "gi");
}

/** Box (display fractions) of characters [start, end) of a text item. */
export function spanBox(item: TextItemBox, start: number, end: number, page: number): Area {
  const len = Math.max(1, item.str.length);
  // Character widths vary: positions are proportional, so widen by 20 % of the font size.
  const slack = item.size * 0.2;
  const from = (item.width * start) / len - slack;
  const to = (item.width * end) / len + slack;
  const [ox, oy] = item.origin;
  const [ax, ay] = item.along;
  const [ux, uy] = item.up;
  const top = item.size * 0.95;
  const bottom = -item.size * 0.28;
  const corners: [number, number][] = [];
  for (const along of [from, to]) {
    for (const up of [bottom, top]) {
      corners.push([ox + ax * along + ux * up, oy + ay * along + uy * up]);
    }
  }
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const pad = 0.002;
  const x = Math.max(0, Math.min(...xs) - pad);
  const y = Math.max(0, Math.min(...ys) - pad);
  return {
    page,
    x,
    y,
    w: Math.min(1 - x, Math.max(...xs) + pad - x),
    h: Math.min(1 - y, Math.max(...ys) + pad - y),
  };
}

/** Every match of the patterns in the page's text items, as redaction boxes. */
export function findAreas(items: TextItemBox[], patterns: RegExp[], page: number): Area[] {
  const areas: Area[] = [];
  for (const item of items) {
    for (const pattern of patterns) {
      const re = new RegExp(
        pattern.source,
        pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
      );
      for (const match of item.str.matchAll(re)) {
        if (!match[0]) continue;
        areas.push(spanBox(item, match.index, match.index + match[0].length, page));
      }
    }
  }
  return areas;
}
