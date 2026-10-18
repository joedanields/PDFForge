import { describe, expect, it } from "vitest";
import { formatPageSet, parsePageSet, parseRanges } from "./pageRanges";

/** Same cases as engine/tests/test_ranges.py: both parsers must agree. */
describe("parseRanges", () => {
  it.each([
    ["all", [[1, 10]]],
    ["", [[1, 10]]],
    [
      "1-3, 4-7, 8",
      [
        [1, 3],
        [4, 7],
        [8, 8],
      ],
    ],
    [
      "  2 ,5- 6 ",
      [
        [2, 2],
        [5, 6],
      ],
    ],
    ["8-", [[8, 10]]],
    ["-3", [[1, 3]]],
    [
      "5-6,1-2",
      [
        [5, 6],
        [1, 2],
      ],
    ],
  ] as const)("%s", (text, expected) => {
    const result = parseRanges(text, 10);
    expect(result.ok && result.ranges.map((r) => [r.first, r.last])).toEqual(expected);
  });

  it.each([
    ["11", "doesn't exist"],
    ["5-12", "doesn't exist"],
    ["0", "start at 1"],
    ["7-3", "runs backwards"],
    ["a-b", "not a page"],
    ["1;2", "not a page"],
    [",", "No pages"],
  ])("rejects %s", (text, message) => {
    const result = parseRanges(text, 10);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(message);
  });
});

describe("page sets", () => {
  it("parses to sorted unique 0-based indices", () => {
    expect([...(parsePageSet("5-6,1-2,2", 10) ?? [])].sort((a, b) => a - b)).toEqual([0, 1, 4, 5]);
    expect(parsePageSet("12", 10)).toBeNull();
  });

  it("formats compactly and round-trips", () => {
    expect(formatPageSet([0, 1, 2, 4, 6, 7])).toBe("1-3,5,7-8");
    expect(formatPageSet([])).toBe("");
    expect(formatPageSet(parsePageSet("9,1-3", 10) ?? [])).toBe("1-3,9");
  });
});
