/**
 * Page editor model (Edit PDF E1, later Sign F3): objects in *display fractions* of a page
 * (0..1, origin top-left, as the user sees the page), an undo/redo history, and geometry
 * helpers. The engine receives the same coordinates (engine/tools/editor.py).
 */

export type EditTool =
  | "select"
  | "text"
  | "image"
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "ink"
  | "highlight"
  | "note"
  | "eraser";

export type ObjectKind = Exclude<EditTool, "select" | "eraser">;

export type FontFamily = "helvetica" | "times" | "courier";

export interface Style {
  stroke: string | null;
  fill: string | null;
  width: number;
  opacity: number;
  font: FontFamily;
  size: number;
  bold: boolean;
  italic: boolean;
  align: "left" | "center" | "right";
}

export interface EditObject extends Style {
  id: string;
  page: number;
  kind: ObjectKind;
  x: number;
  y: number;
  w: number;
  h: number;
  points: [number, number][];
  text: string;
  /** Image file on disk (sent to the engine) and its preview URL (UI only). */
  image?: string;
  imageUrl?: string;
}

export const DEFAULT_STYLE: Style = {
  stroke: "#1F2933",
  fill: null,
  width: 2,
  opacity: 1,
  font: "helvetica",
  size: 14,
  bold: false,
  italic: false,
  align: "left",
};

export const HIGHLIGHT_STYLE: Partial<Style> = { stroke: "#FFD43B", width: 14, opacity: 0.45 };

let counter = 0;
export function newId(): string {
  counter += 1;
  return `obj-${Date.now().toString(36)}-${counter}`;
}

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

export function isBoxKind(kind: ObjectKind): boolean {
  return kind === "text" || kind === "image" || kind === "rect" || kind === "ellipse";
}

export function isPathKind(kind: ObjectKind): boolean {
  return kind === "ink" || kind === "highlight" || kind === "line" || kind === "arrow";
}

/** Box from two drag corners, any direction, kept inside the page. */
export function boxFrom(a: [number, number], b: [number, number]) {
  const x0 = clamp(Math.min(a[0], b[0]));
  const y0 = clamp(Math.min(a[1], b[1]));
  const x1 = clamp(Math.max(a[0], b[0]));
  const y1 = clamp(Math.max(a[1], b[1]));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Bounding box (fractions) of any object. */
export function bounds(obj: EditObject): { x: number; y: number; w: number; h: number } {
  if (obj.kind === "note") return { x: obj.x, y: obj.y, w: 0.03, h: 0.03 };
  if (isPathKind(obj.kind) && obj.points.length > 0) {
    const xs = obj.points.map((p) => p[0]);
    const ys = obj.points.map((p) => p[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  return { x: obj.x, y: obj.y, w: obj.w, h: obj.h };
}

/** Topmost object under a point; ``tolerance`` is in page fractions. */
export function hitTest(
  objects: EditObject[],
  page: number,
  point: [number, number],
  tolerance = 0.01,
): EditObject | null {
  for (let i = objects.length - 1; i >= 0; i -= 1) {
    const obj = objects[i];
    if (!obj || obj.page !== page) continue;
    if (isPathKind(obj.kind)) {
      for (let k = 1; k < obj.points.length; k += 1) {
        const a = obj.points[k - 1];
        const b = obj.points[k];
        if (a && b && distanceToSegment(point, a, b) <= tolerance + 0.004) return obj;
      }
      continue;
    }
    const b = bounds(obj);
    if (
      point[0] >= b.x - tolerance &&
      point[0] <= b.x + b.w + tolerance &&
      point[1] >= b.y - tolerance &&
      point[1] <= b.y + b.h + tolerance
    ) {
      return obj;
    }
  }
  return null;
}

export function distanceToSegment(
  p: [number, number],
  a: [number, number],
  b: [number, number],
): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2);
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Move an object by (dx, dy), keeping it on the page. */
export function moved(obj: EditObject, dx: number, dy: number): EditObject {
  const b = bounds(obj);
  const mx = clamp(dx, -b.x, 1 - (b.x + b.w));
  const my = clamp(dy, -b.y, 1 - (b.y + b.h));
  return {
    ...obj,
    x: obj.x + mx,
    y: obj.y + my,
    points: obj.points.map(([x, y]) => [x + mx, y + my]),
  };
}

/** Resize a box object by dragging its bottom-right corner (min 1 % of the page). */
export function resized(obj: EditObject, w: number, h: number, keepAspect: boolean): EditObject {
  let nw = clamp(w, 0.01, 1 - obj.x);
  let nh = clamp(h, 0.01, 1 - obj.y);
  if (keepAspect && obj.w > 0 && obj.h > 0) {
    const ratio = obj.h / obj.w;
    nh = nw * ratio;
    if (obj.y + nh > 1) {
      nh = 1 - obj.y;
      nw = nh / ratio;
    }
  }
  return { ...obj, w: nw, h: nh };
}

/** Drop points closer than ``minStep`` to the previous one (smaller payload, smoother ink). */
export function simplify(points: [number, number][], minStep = 0.002): [number, number][] {
  const out: [number, number][] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= minStep) out.push(p);
  }
  const final = points[points.length - 1];
  if (final && out[out.length - 1] !== final) out.push(final);
  return out;
}

/** What the engine receives (no ids or preview URLs). */
export function toEngine(obj: EditObject): Record<string, unknown> {
  const base = {
    page: obj.page,
    kind: obj.kind,
    stroke: obj.stroke,
    fill: obj.fill,
    width: obj.width,
    opacity: obj.opacity,
  };
  if (
    obj.kind === "line" ||
    obj.kind === "arrow" ||
    obj.kind === "ink" ||
    obj.kind === "highlight"
  ) {
    return { ...base, points: obj.points };
  }
  if (obj.kind === "note") return { ...base, x: obj.x, y: obj.y, text: obj.text };
  const box = { ...base, x: obj.x, y: obj.y, w: obj.w, h: obj.h };
  if (obj.kind === "text") {
    return {
      ...box,
      text: obj.text,
      font: obj.font,
      size: obj.size,
      bold: obj.bold,
      italic: obj.italic,
      align: obj.align,
    };
  }
  if (obj.kind === "image") return { ...box, image: obj.image };
  return box;
}

// ── history ───────────────────────────────────────────────────────────────────────────────

export interface History {
  past: EditObject[][];
  present: EditObject[];
  future: EditObject[][];
}

export const EMPTY_HISTORY: History = { past: [], present: [], future: [] };

export type HistoryAction =
  | { type: "set"; objects: EditObject[] }
  | { type: "preview"; objects: EditObject[] }
  | { type: "commit" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "reset" };

/**
 * ``set`` records an undo step; ``preview`` changes the objects without one (live dragging),
 * and the following ``commit`` records the drag as a single step.
 */
export function historyReducer(
  state: History & { pending?: EditObject[] | null },
  action: HistoryAction,
): History & { pending?: EditObject[] | null } {
  switch (action.type) {
    case "set":
      return {
        past: [...state.past, state.present],
        present: action.objects,
        future: [],
        pending: null,
      };
    case "preview":
      return { ...state, pending: state.pending ?? state.present, present: action.objects };
    case "commit":
      if (!state.pending) return state;
      return {
        past: [...state.past, state.pending],
        present: state.present,
        future: [],
        pending: null,
      };
    case "undo": {
      const previous = state.past[state.past.length - 1];
      if (!previous) return state;
      return {
        past: state.past.slice(0, -1),
        present: previous,
        future: [state.present, ...state.future],
        pending: null,
      };
    }
    case "redo": {
      const [next, ...rest] = state.future;
      if (!next) return state;
      return { past: [...state.past, state.present], present: next, future: rest, pending: null };
    }
    case "reset":
      return { ...EMPTY_HISTORY, pending: null };
  }
}

// ── crop ──────────────────────────────────────────────────────────────────────────────────

/** Crop area as fractions of the displayed page: [left, top, right, bottom]. */
export type CropBox = [number, number, number, number];

export const DEFAULT_CROP_BOX: CropBox = [0.05, 0.05, 0.95, 0.95];

/** Redaction marks preview as translucent black, so the user can still check what is under. */
export const REDACT_STYLE: Partial<Style> = {
  fill: "#000000",
  stroke: "#E03131",
  width: 1,
  opacity: 0.55,
};
