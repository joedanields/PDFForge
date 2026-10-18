/** Board model for Organize PDF (docs/02 A5): pure operations + undo/redo history. */

export interface PageSize {
  width: number;
  height: number;
}

export interface BoardPage {
  key: string;
  /** Source file (InputFile.key); null for an inserted blank page. */
  fileKey: string | null;
  /** 0-based page in the source file. */
  page: number;
  /** Extra clockwise rotation, 0/90/180/270. */
  rotation: number;
  /** Size of a blank page, in PDF points. */
  blank?: PageSize;
}

export const A4: PageSize = { width: 595.28, height: 841.89 };

let counter = 0;
export function boardKey(): string {
  counter += 1;
  return `p${counter}`;
}

export function pagesOf(fileKey: string, count: number): BoardPage[] {
  return Array.from({ length: count }, (_, page) => ({
    key: boardKey(),
    fileKey,
    page,
    rotation: 0,
  }));
}

function insertAt(board: BoardPage[], afterKey: string | null, pages: BoardPage[]): BoardPage[] {
  const index = afterKey === null ? board.length : board.findIndex((p) => p.key === afterKey) + 1;
  const at = index <= 0 && afterKey !== null ? board.length : index;
  return [...board.slice(0, at), ...pages, ...board.slice(at)];
}

/** Insert pages after ``afterKey`` (or at the end). */
export function insertPages(board: BoardPage[], afterKey: string | null, pages: BoardPage[]) {
  return insertAt(board, afterKey, pages);
}

export function insertBlank(
  board: BoardPage[],
  afterKey: string | null,
  size: PageSize = A4,
): { board: BoardPage[]; key: string } {
  const page: BoardPage = { key: boardKey(), fileKey: null, page: 0, rotation: 0, blank: size };
  return { board: insertAt(board, afterKey, [page]), key: page.key };
}

export function rotatePages(board: BoardPage[], keys: ReadonlySet<string>, delta: number) {
  return board.map((p) =>
    keys.has(p.key) ? { ...p, rotation: (((p.rotation + delta) % 360) + 360) % 360 } : p,
  );
}

export function deletePages(board: BoardPage[], keys: ReadonlySet<string>) {
  return board.filter((p) => !keys.has(p.key));
}

/** Each selected page gets a copy right after it; returns the copies' keys. */
export function duplicatePages(
  board: BoardPage[],
  keys: ReadonlySet<string>,
): { board: BoardPage[]; copies: string[] } {
  const copies: string[] = [];
  const next: BoardPage[] = [];
  for (const p of board) {
    next.push(p);
    if (keys.has(p.key)) {
      const copy = { ...p, key: boardKey() };
      copies.push(copy.key);
      next.push(copy);
    }
  }
  return { board: next, copies };
}

/** Reorder to the given key order (keys not listed are dropped). */
export function reorderPages(board: BoardPage[], order: readonly string[]) {
  const byKey = new Map(board.map((p) => [p.key, p]));
  return order.map((k) => byKey.get(k)).filter((p): p is BoardPage => p !== undefined);
}

/** Move one page by ``delta`` positions (keyboard-accessible reordering). */
export function movePage(board: BoardPage[], key: string, delta: number) {
  const from = board.findIndex((p) => p.key === key);
  const to = Math.min(board.length - 1, Math.max(0, from + delta));
  if (from < 0 || from === to) return board;
  const next = [...board];
  const [item] = next.splice(from, 1);
  if (item) next.splice(to, 0, item);
  return next;
}

export function removeFilePages(board: BoardPage[], fileKey: string) {
  return board.filter((p) => p.fileKey !== fileKey);
}

export type PlanEntry =
  | { src: number; page: number; rotate: number }
  | { blank: true; width: number; height: number; rotate: number };

/** Engine request for the board: the input files in use (in order) and the page plan. */
export function toPlan(
  board: BoardPage[],
  filePaths: ReadonlyMap<string, string>,
): { inputs: string[]; pages: PlanEntry[] } {
  const inputs: string[] = [];
  const index = new Map<string, number>();
  const pages: PlanEntry[] = board.map((p) => {
    if (p.fileKey === null) {
      const size = p.blank ?? A4;
      return { blank: true, width: size.width, height: size.height, rotate: p.rotation };
    }
    let src = index.get(p.fileKey);
    if (src === undefined) {
      src = inputs.length;
      index.set(p.fileKey, src);
      inputs.push(filePaths.get(p.fileKey) ?? "");
    }
    return { src, page: p.page, rotate: p.rotation };
  });
  return { inputs, pages };
}

// ── undo / redo ──────────────────────────────────────────────────────────────────────────────

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
}

const LIMIT = 100;

export function historyOf<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}

export function record<T>(h: History<T>, next: T): History<T> {
  if (next === h.present) return h;
  return { past: [...h.past.slice(-(LIMIT - 1)), h.present], present: next, future: [] };
}

export function undo<T>(h: History<T>): History<T> {
  const previous = h.past[h.past.length - 1];
  if (previous === undefined) return h;
  return { past: h.past.slice(0, -1), present: previous, future: [h.present, ...h.future] };
}

export function redo<T>(h: History<T>): History<T> {
  const [next, ...rest] = h.future;
  if (next === undefined) return h;
  return { past: [...h.past, h.present], present: next, future: rest };
}
