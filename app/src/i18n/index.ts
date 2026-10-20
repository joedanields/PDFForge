/**
 * UI text (docs/05: all text externalised; docs/02 §J: English first, Tamil and Hindi).
 *
 * - `t(key)`: app strings by key (en.ts, ta.ts, hi.ts).
 * - `tx(text)`: text written in English elsewhere — the tool registry's names, descriptions
 *   and option labels, error titles, editor tool names — translated by its English wording
 *   (ta.text.ts, hi.text.ts). Unknown text is shown in English.
 *
 * Missing translations fall back to English; i18n.test.ts keeps them complete.
 */
import { en, type MessageKey } from "./en";
import { hi } from "./hi";
import { hiText } from "./hi.text";
import { ta } from "./ta";
import { taText } from "./ta.text";

export type { MessageKey };

export const LOCALES = ["en", "ta", "hi"] as const;
export type Locale = (typeof LOCALES)[number];

/** Each language's own name, for the language picker. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  ta: "தமிழ்",
  hi: "हिन्दी",
};

const KEYS: Record<Locale, Partial<Record<MessageKey, string>>> = { en, ta, hi };
const TEXT: Record<Locale, Readonly<Record<string, string>>> = { en: {}, ta: taText, hi: hiText };

let current: Locale = "en";

export function getLocale(): Locale {
  return current;
}

export function setLocale(locale: Locale): void {
  current = LOCALES.includes(locale) ? locale : "en";
  if (typeof document !== "undefined") document.documentElement.lang = current;
}

function fill(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

/** Look up a UI string and fill `{placeholders}`. */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  return fill(KEYS[current][key] ?? en[key], vars);
}

/** Translate English text from the registry and similar sources (see above). */
export function tx(text: string, vars?: Record<string, string | number>): string {
  return fill(TEXT[current][text] ?? text, vars);
}
