/**
 * Page-range syntax, identical to engine/utils/ranges.py so ranges are validated live
 * (docs/02 A2): "5", "1-3", "8-" (to the end), "-3" (first three), "all". 1-based.
 */
import { tx } from "@/i18n";

export interface PageRange {
  first: number;
  last: number;
}

export type ParseResult = { ok: true; ranges: PageRange[] } | { ok: false; error: string };

const PART = /^(\d*)\s*-\s*(\d*)$|^(\d+)$/;

export function parseRanges(text: string, pageCount: number): ParseResult {
  const cleaned = text.trim().toLowerCase();
  if (cleaned === "" || cleaned === "all" || cleaned === "*") {
    return { ok: true, ranges: pageCount > 0 ? [{ first: 1, last: pageCount }] : [] };
  }
  const ranges: PageRange[] = [];
  for (const raw of cleaned.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    const match = PART.exec(part);
    if (!match) return { ok: false, error: tx("“{part}” is not a page or range", { part }) };
    let first: number;
    let last: number;
    if (match[3]) {
      first = last = Number(match[3]);
    } else {
      first = match[1] ? Number(match[1]) : 1;
      last = match[2] ? Number(match[2]) : pageCount;
    }
    if (first < 1 || last < 1) return { ok: false, error: tx("Page numbers start at 1") };
    if (first > last) {
      return {
        ok: false,
        error: tx("“{part}” runs backwards; write it as {last}-{first}", { part, last, first }),
      };
    }
    if (last > pageCount) {
      return {
        ok: false,
        error: tx("Page {last} doesn't exist — this document has {count} pages", {
          last,
          count: pageCount,
        }),
      };
    }
    ranges.push({ first, last });
  }
  if (ranges.length === 0) return { ok: false, error: tx("No pages selected") };
  return { ok: true, ranges };
}

/** Selected pages as a sorted set of 0-based indices, or null when the text is invalid. */
export function parsePageSet(text: string, pageCount: number): Set<number> | null {
  const result = parseRanges(text, pageCount);
  if (!result.ok) return null;
  const set = new Set<number>();
  for (const r of result.ranges) for (let p = r.first; p <= r.last; p++) set.add(p - 1);
  return set;
}

/** 0-based indices → compact 1-based text: {0,1,2,4} → "1-3,5". */
export function formatPageSet(indices: Iterable<number>): string {
  const pages = [...new Set(indices)].sort((a, b) => a - b).map((i) => i + 1);
  const parts: string[] = [];
  for (let i = 0; i < pages.length;) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === (pages[j] ?? 0) + 1) j++;
    parts.push(i === j ? String(pages[i]) : `${pages[i]}-${pages[j]}`);
    i = j + 1;
  }
  return parts.join(",");
}
