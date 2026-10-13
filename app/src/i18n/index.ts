import { en, type MessageKey } from "./en";

export type { MessageKey };

/** Look up a UI string and fill `{placeholders}`. */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const template: string = en[key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}
