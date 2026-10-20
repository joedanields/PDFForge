import { create } from "zustand";
import { api, isTauri, onEngineStatus, onRecentsChanged } from "@/engine/client";
import type { AppInfo, EngineStatus, RecentOutput, Settings } from "@/engine/types";
import { applyTheme } from "./theme";

interface AppStore {
  settings: Settings;
  engine: EngineStatus | null;
  recents: RecentOutput[];
  appInfo: AppInfo | null;
  /** Off by default (docs/02 §I); there is no setting to enable it in v1. */
  intelligenceEnabled: boolean;
  /** Files handed to a tool from outside (Explorer "Merge with PDFForge"), by tool id. */
  incoming: Record<string, string[]>;
  queueIncoming: (tool: string, files: string[]) => void;
  takeIncoming: (tool: string) => string[];
  saveSettings: (patch: Partial<Settings>) => Promise<void>;
  refreshRecents: () => Promise<void>;
  setEngine: (status: EngineStatus) => void;
}

export const DEFAULT_SETTINGS: Settings = { theme: "system", defaultOutputDir: null };

export const useAppStore = create<AppStore>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  engine: null,
  recents: [],
  appInfo: null,
  intelligenceEnabled: false,
  incoming: {},

  queueIncoming(tool, files) {
    set((state) => ({
      incoming: { ...state.incoming, [tool]: [...(state.incoming[tool] ?? []), ...files] },
    }));
  },

  takeIncoming(tool) {
    const files = get().incoming[tool] ?? [];
    if (files.length > 0) set((state) => ({ incoming: { ...state.incoming, [tool]: [] } }));
    return files;
  },

  async saveSettings(patch) {
    const next = { ...get().settings, ...patch };
    const saved = isTauri() ? await api.setSettings(next) : next;
    set({ settings: saved });
    applyTheme(saved.theme);
  },

  async refreshRecents() {
    if (!isTauri()) return;
    set({ recents: await api.listRecents(8) });
  },

  setEngine(status) {
    set({ engine: status });
  },
}));

let initialised = false;

/** Load persisted state and subscribe to backend events. Safe to call more than once. */
export async function initAppStore(): Promise<void> {
  if (initialised) return;
  initialised = true;
  if (!isTauri()) {
    applyTheme(useAppStore.getState().settings.theme);
    return;
  }
  const store = useAppStore.getState();
  await onEngineStatus(store.setEngine);
  await onRecentsChanged(() => void useAppStore.getState().refreshRecents());
  const [settings, engine, appInfo] = await Promise.all([
    api.getSettings(),
    api.engineStatus(),
    api.appInfo(),
  ]);
  // A status event may have arrived while we were fetching; never overwrite it with older data.
  useAppStore.setState((state) => ({ settings, appInfo, engine: state.engine ?? engine }));
  applyTheme(settings.theme);
  await store.refreshRecents();
}
