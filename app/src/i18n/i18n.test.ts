import { afterEach, describe, expect, it } from "vitest";
import { ERROR_TEXT } from "@/engine/types";
import { PRESETS } from "@/lib/redactSearch";
import { CATEGORY_META } from "@/tools/categories";
import { describeOptions } from "@/tools/options";
import { TOOLS } from "@/tools/registry";
import { en, type MessageKey } from "./en";
import { hi } from "./hi";
import { hiText } from "./hi.text";
import { setLocale, t, tx } from "./index";
import { ta } from "./ta";
import { taText } from "./ta.text";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

/** Every English text the UI passes through tx(). */
function englishTexts(): Set<string> {
  const out = new Set<string>();
  for (const tool of TOOLS) {
    [tool.name, tool.description, tool.actionLabel, tool.accepts.label].forEach((s) => out.add(s));
    for (const f of describeOptions(tool.optionsSchema)) {
      out.add(f.meta.label);
      if (f.meta.help) out.add(f.meta.help);
      if (f.meta.placeholder) out.add(f.meta.placeholder);
      if (f.meta.file) out.add(f.meta.file.name);
      for (const c of f.meta.choices ?? []) out.add(c.label);
    }
  }
  for (const meta of Object.values(CATEGORY_META)) out.add(meta.label);
  for (const text of Object.values(ERROR_TEXT)) {
    out.add(text.title);
    if (text.fix) out.add(text.fix);
  }
  for (const preset of PRESETS) out.add(preset.label);
  ["All", "Workflows", "Very weak", "Weak", "Fair", "Good", "Strong", "Strength"].forEach((s) =>
    out.add(s),
  );
  return out;
}

afterEach(() => setLocale("en"));

describe.each([
  ["ta", ta, taText],
  ["hi", hi, hiText],
] as const)("%s translations", (_code, keys, text) => {
  it("cover every UI key with the same placeholders", () => {
    for (const key of Object.keys(en) as MessageKey[]) {
      expect(keys[key], key).toBeTruthy();
      expect(placeholders(keys[key]), key).toEqual(placeholders(en[key]));
    }
  });

  it("cover every tool, option and message text", () => {
    const missing = [...englishTexts()].filter((s) => !text[s]);
    expect(missing).toEqual([]);
    for (const [english, translated] of Object.entries(text)) {
      expect(placeholders(translated), english).toEqual(placeholders(english));
    }
  });
});

describe("t / tx", () => {
  it("switch language and fall back to English", () => {
    setLocale("ta");
    expect(t("nav.settings")).toBe("அமைப்புகள்");
    expect(tx("Merge PDF")).toBe("PDF இணை");
    expect(tx("Not in any dictionary")).toBe("Not in any dictionary");
    expect(t("file.pages", { count: 3 })).toBe("3 பக்கங்கள்");
    setLocale("hi");
    expect(tx("Page numbers start at 1")).toBe("पृष्ठ संख्या 1 से शुरू होती है");
    expect(document.documentElement.lang).toBe("hi");
    setLocale("en");
    expect(t("nav.settings")).toBe("Settings");
  });
});
