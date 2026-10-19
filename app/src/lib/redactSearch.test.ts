import { describe, expect, it } from "vitest";
import type { TextItemBox } from "./pdfjs";
import { findAreas, PRESETS, spanBox, termPattern } from "./redactSearch";

// A horizontal 10 pt text run on a 600 x 800 pt page, starting at (60, 100) display points.
function item(str: string): TextItemBox {
  return {
    str,
    origin: [60 / 600, 100 / 800],
    along: [1 / 600, 0],
    up: [0, -1 / 800],
    width: str.length * 5,
    size: 10,
  };
}

const preset = (id: string) => {
  const found = PRESETS.find((p) => p.id === id);
  if (!found) throw new Error(id);
  return found.pattern;
};

describe("redaction search", () => {
  it("boxes a matched span proportionally and covers the glyph height", () => {
    const box = spanBox(item("abcdefghij"), 2, 6, 0); // chars 2..6 at 5 pt -> x 70..90 pt
    expect(box.x * 600).toBeCloseTo(70 - 2 - 1.2, 0); // 20 % of 10 pt slack + padding
    expect((box.x + box.w) * 600).toBeCloseTo(90 + 2 + 1.2, 0);
    expect(box.y * 800).toBeLessThan(100 - 9); // above the baseline by ~the font size
    expect((box.y + box.h) * 800).toBeGreaterThan(100 + 2); // below it for descenders
  });

  it("works for rotated text (reading downwards)", () => {
    const rotated: TextItemBox = { ...item("SECRET"), along: [0, 1 / 800], up: [1 / 600, 0] };
    const box = spanBox(rotated, 0, 6, 0);
    expect(box.h * 800).toBeGreaterThan(29);
    expect(box.w * 600).toBeLessThan(15);
  });

  it("finds terms case-insensitively across whitespace", () => {
    const pattern = termPattern("account  number");
    expect(pattern).not.toBeNull();
    const areas = findAreas([item("Your Account Number is 12")], [pattern as RegExp], 3);
    expect(areas).toHaveLength(1);
    expect(areas[0]?.page).toBe(3);
    expect(termPattern("   ")).toBeNull();
  });

  it("presets match Indian identifiers, emails and phone numbers", () => {
    const text =
      "Mail a.b+c@example.co.in, PAN ABCDE1234F, Aadhaar 1234 5678 9012, call +91 98765 43210";
    const found = (id: string) => findAreas([item(text)], [preset(id)], 0).length;
    expect(found("email")).toBe(1);
    expect(found("pan")).toBe(1);
    expect(found("aadhaar")).toBe(1);
    expect(found("phone")).toBeGreaterThanOrEqual(1);
    expect(
      findAreas(
        [item("nothing here")],
        PRESETS.map((p) => p.pattern),
        0,
      ),
    ).toEqual([]);
  });
});
