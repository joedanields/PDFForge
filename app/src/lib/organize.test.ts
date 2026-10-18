import { describe, expect, it } from "vitest";
import {
  deletePages,
  duplicatePages,
  historyOf,
  insertBlank,
  insertPages,
  movePage,
  pagesOf,
  record,
  redo,
  removeFilePages,
  reorderPages,
  rotatePages,
  toPlan,
  undo,
  type BoardPage,
} from "./organize";

const describeBoard = (board: BoardPage[]) =>
  board.map((p) => (p.fileKey === null ? "blank" : `${p.fileKey}${p.page + 1}@${p.rotation}`));

describe("board operations", () => {
  const start = () => [...pagesOf("A", 3), ...pagesOf("B", 2)];

  it("rotates selected pages, wrapping both ways", () => {
    const board = start();
    const keys = new Set([board[0]?.key ?? "", board[3]?.key ?? ""]);
    const right = rotatePages(board, keys, 90);
    const left = rotatePages(rotatePages(board, keys, -90), keys, -90);
    expect(describeBoard(right)).toEqual(["A1@90", "A2@0", "A3@0", "B1@90", "B2@0"]);
    expect(describeBoard(left).slice(0, 1)).toEqual(["A1@180"]);
  });

  it("deletes and duplicates", () => {
    const board = start();
    const deleted = deletePages(board, new Set([board[1]?.key ?? ""]));
    expect(describeBoard(deleted)).toEqual(["A1@0", "A3@0", "B1@0", "B2@0"]);
    const { board: dup, copies } = duplicatePages(board, new Set([board[0]?.key ?? ""]));
    expect(describeBoard(dup).slice(0, 3)).toEqual(["A1@0", "A1@0", "A2@0"]);
    expect(copies).toHaveLength(1);
    expect(new Set(dup.map((p) => p.key)).size).toBe(dup.length);
  });

  it("inserts blank pages and other files' pages after a page", () => {
    const board = pagesOf("A", 2);
    const { board: withBlank } = insertBlank(board, board[0]?.key ?? null);
    expect(describeBoard(withBlank)).toEqual(["A1@0", "blank", "A2@0"]);
    const withB = insertPages(withBlank, null, pagesOf("B", 1));
    expect(describeBoard(withB)).toEqual(["A1@0", "blank", "A2@0", "B1@0"]);
  });

  it("reorders, moves and removes a file's pages", () => {
    const board = start();
    const order = [board[4], board[0], board[1], board[2], board[3]].map((p) => p?.key ?? "");
    expect(describeBoard(reorderPages(board, order))[0]).toBe("B2@0");
    expect(describeBoard(movePage(board, board[0]?.key ?? "", 2)).slice(0, 3)).toEqual([
      "A2@0",
      "A3@0",
      "A1@0",
    ]);
    expect(describeBoard(removeFilePages(board, "A"))).toEqual(["B1@0", "B2@0"]);
  });

  it("builds the engine plan with only the files in use", () => {
    const board = [...pagesOf("B", 1), ...pagesOf("A", 1)];
    const { board: withBlank } = insertBlank(board, null, { width: 612, height: 792 });
    const rotated = rotatePages(withBlank, new Set([withBlank[1]?.key ?? ""]), 270);
    const paths = new Map([
      ["A", "C:/a.pdf"],
      ["B", "C:/b.pdf"],
      ["C", "C:/unused.pdf"],
    ]);
    expect(toPlan(rotated, paths)).toEqual({
      inputs: ["C:/b.pdf", "C:/a.pdf"],
      pages: [
        { src: 0, page: 0, rotate: 0 },
        { src: 1, page: 0, rotate: 270 },
        { blank: true, width: 612, height: 792, rotate: 0 },
      ],
    });
  });
});

describe("history", () => {
  it("undoes and redoes, and a new change clears redo", () => {
    let h = historyOf(1);
    h = record(h, 2);
    h = record(h, 3);
    h = undo(h);
    expect(h.present).toBe(2);
    h = undo(h);
    expect(h.present).toBe(1);
    expect(undo(h)).toBe(h);
    h = redo(h);
    expect(h.present).toBe(2);
    h = record(h, 5);
    expect(h.future).toEqual([]);
    expect(redo(h)).toBe(h);
  });
});
