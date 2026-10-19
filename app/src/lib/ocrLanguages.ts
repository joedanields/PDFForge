/**
 * OCR languages: display names, the "eng+tam" option format, and a shared loader.
 * Bundled: English, Tamil, Hindi (D-027); more come from `.traineddata` files added in Settings.
 */
import { useEffect, useState } from "react";
import { api, isTauri } from "@/engine/client";
import type { OcrLanguage } from "@/engine/types";

/** Tesseract model names → English language names (the ones users are likely to add). */
const NAMES: Record<string, string> = {
  afr: "Afrikaans",
  ara: "Arabic",
  asm: "Assamese",
  ben: "Bengali",
  bul: "Bulgarian",
  ces: "Czech",
  chi_sim: "Chinese (Simplified)",
  chi_tra: "Chinese (Traditional)",
  dan: "Danish",
  deu: "German",
  ell: "Greek",
  eng: "English",
  fas: "Persian",
  fin: "Finnish",
  fra: "French",
  guj: "Gujarati",
  heb: "Hebrew",
  hin: "Hindi",
  hun: "Hungarian",
  ind: "Indonesian",
  ita: "Italian",
  jpn: "Japanese",
  kan: "Kannada",
  kor: "Korean",
  mal: "Malayalam",
  mar: "Marathi",
  msa: "Malay",
  nep: "Nepali",
  nld: "Dutch",
  nor: "Norwegian",
  ori: "Odia",
  pan: "Punjabi",
  pol: "Polish",
  por: "Portuguese",
  ron: "Romanian",
  rus: "Russian",
  san: "Sanskrit",
  sin: "Sinhala",
  spa: "Spanish",
  swe: "Swedish",
  tam: "Tamil",
  tel: "Telugu",
  tha: "Thai",
  tur: "Turkish",
  ukr: "Ukrainian",
  urd: "Urdu",
  vie: "Vietnamese",
};

/** What the app ships with; used outside Tauri (tests, browser preview). */
export const BUNDLED_LANGUAGES: OcrLanguage[] = ["eng", "hin", "tam"].map((code) => ({
  code,
  bundled: true,
}));

/** Tesseract runs noticeably slower with every extra model. */
export const MAX_OCR_LANGUAGES = 4;

export function languageName(code: string): string {
  return NAMES[code] ?? code;
}

/** "eng+tam" → ["eng", "tam"] (empty parts dropped). */
export function parseLanguages(value: unknown): string[] {
  return typeof value === "string" ? value.split("+").filter(Boolean) : [];
}

/** Toggle ``code`` in a "eng+tam" value; never leaves it empty, keeps at most the maximum. */
export function toggleLanguage(value: unknown, code: string): string {
  const current = parseLanguages(value);
  if (current.includes(code)) {
    const rest = current.filter((c) => c !== code);
    return (rest.length > 0 ? rest : current).join("+");
  }
  if (current.length >= MAX_OCR_LANGUAGES) return current.join("+");
  return [...current, code].join("+");
}

/** Installed OCR languages, sorted by display name; `setLanguages` after adding or removing. */
export function useOcrLanguages(): {
  languages: OcrLanguage[];
  setLanguages: (languages: OcrLanguage[]) => void;
} {
  const [languages, setLanguages] = useState<OcrLanguage[]>(BUNDLED_LANGUAGES);
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    void api
      .ocrLanguages()
      .then((list) => {
        if (alive) setLanguages(list);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const sorted = [...languages].sort((a, b) =>
    languageName(a.code).localeCompare(languageName(b.code)),
  );
  return { languages: sorted, setLanguages };
}
