import { describe, expect, it } from "vitest";
import { TOOL_CATEGORIES, filterChips } from "./categories";
import { defaultOptions, describeOptions } from "./options";
import {
  TOOLS,
  acceptsFile,
  getTool,
  mergeOptions,
  searchTools,
  toolsInCategory,
  visibleTools,
} from "./registry";

/** docs/02_FEATURES.md sections A–F (31 tools) and I (3 tools). */
const FEATURE_REFS = [
  "A1", "A2", "A3", "A4", "A5", "A6",
  "B1", "B2", "B3",
  "C1", "C2", "C3", "C4", "C5", "C6",
  "D1", "D2", "D3", "D4", "D5", "D6",
  "E1", "E2", "E3", "E4", "E5",
  "F1", "F2", "F3", "F4", "F5",
]; // prettier-ignore

const product = TOOLS.filter((t) => !t.devOnly);

/** Tools with a working engine method, in registry order (grows through Phase 1). */
const IMPLEMENTED = ["merge", "remove-pages", "rotate"];

describe("tool registry contents", () => {
  it("covers every tool of sections A–F exactly once", () => {
    const refs = product.filter((t) => t.ref !== "I").map((t) => t.ref);
    expect(refs.sort()).toEqual([...FEATURE_REFS].sort());
  });

  it("has the three Intelligence tools from section I", () => {
    const intel = product.filter((t) => t.ref === "I");
    expect(intel.map((t) => t.id).sort()).toEqual(["chat-pdf", "summarize", "translate"]);
    expect(intel.every((t) => t.requiresIntelligence && t.category === "intelligence")).toBe(true);
  });

  it("uses unique, url-safe ids", () => {
    const ids = TOOLS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  it("assigns every tool to a known category", () => {
    for (const tool of TOOLS) expect(TOOL_CATEGORIES).toContain(tool.category);
  });

  it("has a name, description and icon for every tool", () => {
    for (const tool of TOOLS) {
      expect(tool.name.length).toBeGreaterThan(2);
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.icon).toBeTruthy();
    }
  });

  it("never mentions another product's brand", () => {
    const text = JSON.stringify(TOOLS.map((t) => [t.name, t.description, t.keywords]));
    expect(text.toLowerCase()).not.toContain("ilovepdf");
  });

  it("only marks tools with an engine method as available", () => {
    for (const tool of TOOLS.filter((t) => t.status === "available")) {
      expect(tool.engineMethod).toBeTruthy();
    }
    expect(product.filter((t) => t.status === "available").map((t) => t.id)).toEqual(IMPLEMENTED);
  });

  it("keeps input limits consistent", () => {
    for (const tool of TOOLS) {
      expect(tool.accepts.min).toBeLessThanOrEqual(tool.accepts.max);
      for (const ext of tool.accepts.extensions) expect(ext).toMatch(/^[a-z0-9]+$/);
    }
  });
});

describe("merge entry (A1)", () => {
  const merge = getTool("merge");

  it("accepts 2–500 PDFs and images", () => {
    expect(merge?.accepts.min).toBe(2);
    expect(merge?.accepts.max).toBe(500);
    expect(merge && acceptsFile(merge, "C:\\docs\\Report.PDF")).toBe(true);
    expect(merge && acceptsFile(merge, "photo.jpeg")).toBe(true);
    expect(merge && acceptsFile(merge, "notes.docx")).toBe(false);
    expect(merge && acceptsFile(merge, "no-extension")).toBe(false);
  });

  it("defaults: keep bookmarks, no per-file bookmark", () => {
    expect(defaultOptions(mergeOptions)).toEqual({ bookmarks: true, bookmark_per_file: false });
  });

  it("describes its options for the generated form", () => {
    const fields = describeOptions(mergeOptions);
    expect(fields.map((f) => [f.key, f.kind, f.defaultValue])).toEqual([
      ["bookmarks", "boolean", true],
      ["bookmark_per_file", "boolean", false],
    ]);
    expect(fields[0]?.meta.label).toBe("Keep bookmarks");
  });

  it("rejects wrongly typed options", () => {
    expect(mergeOptions.safeParse({ bookmarks: "yes" }).success).toBe(false);
  });
});

describe("visibility", () => {
  it("hides dev-only and Intelligence tools by default", () => {
    const visible = visibleTools({ dev: false, intelligence: false });
    expect(visible.some((t) => t.devOnly)).toBe(false);
    expect(visible.some((t) => t.requiresIntelligence)).toBe(false);
    expect(visible).toHaveLength(31);
  });

  it("shows Intelligence tools and chip when enabled", () => {
    expect(visibleTools({ dev: false, intelligence: true })).toHaveLength(34);
    expect(filterChips(true)).toContain("intelligence");
    expect(filterChips(false)).not.toContain("intelligence");
  });

  it("shows the self-test in dev builds", () => {
    expect(visibleTools({ dev: true, intelligence: false }).map((t) => t.id)).toContain("echo");
  });
});

describe("category filter", () => {
  const visible = visibleTools({ dev: false, intelligence: false });

  it("'all' returns everything, 'workflows' returns no tools", () => {
    expect(toolsInCategory(visible, "all")).toHaveLength(visible.length);
    expect(toolsInCategory(visible, "workflows")).toEqual([]);
  });

  it.each([
    ["organize", 6],
    ["optimize", 3],
    ["convert", 12],
    ["edit", 5],
    ["security", 5],
  ] as const)("%s has %i tools", (category, count) => {
    expect(toolsInCategory(visible, category)).toHaveLength(count);
  });
});

describe("search", () => {
  const visible = visibleTools({ dev: false, intelligence: false });

  it("finds by name, case-insensitively", () => {
    expect(searchTools("MERGE", visible)[0]?.id).toBe("merge");
  });

  it("finds by keyword", () => {
    expect(searchTools("password", visible).map((t) => t.id)).toEqual(
      expect.arrayContaining(["protect", "unlock"]),
    );
    expect(searchTools("combine", visible)[0]?.id).toBe("merge");
  });

  it("requires every word to match and ranks name matches first", () => {
    const results = searchTools("pdf word", visible).map((t) => t.id);
    expect(results.slice(0, 2).sort()).toEqual(["pdf-to-word", "word-to-pdf"]);
  });

  it("returns everything for an empty query and nothing for nonsense", () => {
    expect(searchTools("  ", visible)).toHaveLength(visible.length);
    expect(searchTools("zzzz-not-a-tool", visible)).toEqual([]);
  });
});
