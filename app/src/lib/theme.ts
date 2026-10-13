import type { Theme } from "@/engine/types";

const STORAGE_KEY = "pdfforge.theme";
let current: Theme = "system";
let mediaListenerAttached = false;

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function render(): void {
  const dark = current === "dark" || (current === "system" && systemPrefersDark());
  document.documentElement.classList.toggle("dark", dark);
}

/** Apply a theme now and follow Windows changes while it is "system". */
export function applyTheme(theme: Theme): void {
  current = theme;
  try {
    // Cache only to avoid a flash before settings load (settings.json is the source of truth).
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* storage unavailable: harmless */
  }
  if (!mediaListenerAttached) {
    mediaListenerAttached = true;
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
  }
  render();
}
