import { describe, expect, it } from "vitest";
import {
  boxFrom,
  DEFAULT_STYLE,
  type EditObject,
  EMPTY_HISTORY,
  historyReducer,
  hitTest,
  moved,
  resized,
  simplify,
  toEngine,
} from "./editor";

function obj(partial: Partial<EditObject>): EditObject {
  return {
    ...DEFAULT_STYLE,
    id: "a",
    page: 0,
    kind: "rect",
    x: 0.1,
    y: 0.1,
    w: 0.2,
    h: 0.1,
    points: [],
    text: "",
    ...partial,
  };
}

describe("editor geometry", () => {
  it("builds boxes from drags in any direction, clamped to the page", () => {
    expect(boxFrom([0.5, 0.5], [0.2, 0.3])).toEqual({ x: 0.2, y: 0.3, w: 0.3, h: 0.2 });
    const clamped = boxFrom([0.9, 0.9], [1.4, 1.2]);
    expect(clamped.x + clamped.w).toBe(1);
    expect(clamped.y + clamped.h).toBe(1);
  });

  it("hit-tests boxes and strokes, topmost first", () => {
    const below = obj({ id: "below" });
    const above = obj({ id: "above", x: 0.15 });
    const line = obj({
      id: "line",
      kind: "line",
      points: [
        [0.5, 0.5],
        [0.9, 0.5],
      ],
    });
    const objects = [below, above, line];
    expect(hitTest(objects, 0, [0.2, 0.15])?.id).toBe("above");
    expect(hitTest(objects, 0, [0.7, 0.505])?.id).toBe("line");
    expect(hitTest(objects, 0, [0.7, 0.6])).toBeNull();
    expect(hitTest(objects, 1, [0.2, 0.15])).toBeNull();
  });

  it("moves objects without leaving the page", () => {
    const m = moved(obj({}), 2, 0.05);
    expect(m.x).toBeCloseTo(0.8);
    expect(m.y).toBeCloseTo(0.15);
    const ink = moved(
      obj({
        kind: "ink",
        points: [
          [0.1, 0.1],
          [0.2, 0.2],
        ],
      }),
      0.1,
      0,
    );
    expect(ink.points[0]?.[0]).toBeCloseTo(0.2);
  });

  it("resizes, optionally keeping the aspect ratio", () => {
    expect(resized(obj({}), 0.4, 0.05, false)).toMatchObject({ w: 0.4, h: 0.05 });
    const image = resized(obj({ w: 0.2, h: 0.1 }), 0.4, 0.9, true);
    expect(image.h / image.w).toBeCloseTo(0.5);
  });

  it("simplifies pen strokes but keeps the last point", () => {
    const points: [number, number][] = [
      [0, 0],
      [0.0005, 0],
      [0.001, 0],
      [0.01, 0],
      [0.0101, 0],
    ];
    expect(simplify(points)).toEqual([
      [0, 0],
      [0.01, 0],
      [0.0101, 0],
    ]);
  });

  it("sends only what the engine needs", () => {
    expect(
      toEngine(
        obj({
          kind: "line",
          points: [
            [0, 0],
            [1, 1],
          ],
        }),
      ),
    ).not.toHaveProperty("x");
    const text = toEngine(obj({ kind: "text", text: "Hi", imageUrl: "blob:x" }));
    expect(text).toMatchObject({ kind: "text", text: "Hi", font: "helvetica" });
    expect(text).not.toHaveProperty("imageUrl");
    expect(text).not.toHaveProperty("id");
  });
});

describe("editor history", () => {
  it("undoes and redoes steps; a drag is one step", () => {
    let h = historyReducer(EMPTY_HISTORY, { type: "set", objects: [obj({})] });
    h = historyReducer(h, { type: "preview", objects: [obj({ x: 0.2 })] });
    h = historyReducer(h, { type: "preview", objects: [obj({ x: 0.3 })] });
    h = historyReducer(h, { type: "commit" });
    expect(h.present[0]?.x).toBe(0.3);
    h = historyReducer(h, { type: "undo" });
    expect(h.present[0]?.x).toBe(0.1);
    h = historyReducer(h, { type: "undo" });
    expect(h.present).toEqual([]);
    h = historyReducer(h, { type: "redo" });
    h = historyReducer(h, { type: "redo" });
    expect(h.present[0]?.x).toBe(0.3);
    expect(historyReducer(h, { type: "redo" })).toBe(h);
  });
});
