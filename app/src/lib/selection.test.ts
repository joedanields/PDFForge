import { describe, expect, it } from "vitest";
import {
  EMPTY_SELECTION,
  bandSelect,
  clickSelect,
  pruneSelection,
  selectAll,
  type Selection,
} from "./selection";

const order = ["a", "b", "c", "d", "e"];
const none = { ctrl: false, shift: false };
const keys = (s: Selection) => [...s.selected].sort();

describe("clickSelect", () => {
  it("plain click selects only that item", () => {
    const s = clickSelect(order, selectAll(order), "c", none);
    expect(keys(s)).toEqual(["c"]);
    expect(s.anchor).toBe("c");
  });

  it("ctrl-click toggles", () => {
    let s = clickSelect(order, EMPTY_SELECTION, "b", none);
    s = clickSelect(order, s, "d", { ctrl: true, shift: false });
    expect(keys(s)).toEqual(["b", "d"]);
    s = clickSelect(order, s, "b", { ctrl: true, shift: false });
    expect(keys(s)).toEqual(["d"]);
  });

  it("shift-click selects the range from the anchor, in either direction", () => {
    let s = clickSelect(order, EMPTY_SELECTION, "d", none);
    s = clickSelect(order, s, "b", { ctrl: false, shift: true });
    expect(keys(s)).toEqual(["b", "c", "d"]);
    expect(s.anchor).toBe("d");
    s = clickSelect(order, s, "e", { ctrl: false, shift: true });
    expect(keys(s)).toEqual(["d", "e"]);
  });

  it("ctrl+shift adds the range to the selection", () => {
    let s = clickSelect(order, EMPTY_SELECTION, "a", none);
    s = clickSelect(order, s, "d", { ctrl: true, shift: false });
    s = clickSelect(order, s, "e", { ctrl: true, shift: true });
    expect(keys(s)).toEqual(["a", "d", "e"]);
  });

  it("shift-click without an anchor behaves like a plain click", () => {
    expect(keys(clickSelect(order, EMPTY_SELECTION, "c", { ctrl: false, shift: true }))).toEqual([
      "c",
    ]);
  });
});

describe("band, all, prune", () => {
  it("band replaces or (with ctrl) extends", () => {
    const start = clickSelect(order, EMPTY_SELECTION, "a", none);
    expect(keys(bandSelect(start, ["c", "d"], false))).toEqual(["c", "d"]);
    expect(keys(bandSelect(start, ["c", "d"], true))).toEqual(["a", "c", "d"]);
  });

  it("select all and prune", () => {
    const all = selectAll(order);
    expect(keys(all)).toEqual(order);
    const pruned = pruneSelection(["a", "c"], { selected: new Set(["a", "b"]), anchor: "b" });
    expect(keys(pruned)).toEqual(["a"]);
    expect(pruned.anchor).toBeNull();
  });
});
