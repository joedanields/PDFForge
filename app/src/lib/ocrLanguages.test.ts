import { describe, expect, it } from "vitest";
import { languageName, MAX_OCR_LANGUAGES, parseLanguages, toggleLanguage } from "./ocrLanguages";

describe("OCR languages", () => {
  it("names known codes and falls back to the code", () => {
    expect(languageName("tam")).toBe("Tamil");
    expect(languageName("chi_sim")).toBe("Chinese (Simplified)");
    expect(languageName("xyz")).toBe("xyz");
  });

  it("parses the engine's eng+tam format", () => {
    expect(parseLanguages("eng+tam")).toEqual(["eng", "tam"]);
    expect(parseLanguages("eng++")).toEqual(["eng"]);
    expect(parseLanguages(undefined)).toEqual([]);
  });

  it("toggles languages but never leaves none selected", () => {
    expect(toggleLanguage("eng", "tam")).toBe("eng+tam");
    expect(toggleLanguage("eng+tam", "eng")).toBe("tam");
    expect(toggleLanguage("eng", "eng")).toBe("eng");
  });

  it("caps the number of languages", () => {
    const full = ["eng", "tam", "hin", "deu"].slice(0, MAX_OCR_LANGUAGES).join("+");
    expect(toggleLanguage(full, "fra")).toBe(full);
  });
});
