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
  useAppStore.setState({ settings, engine, appInfo });
  applyTheme(settings.theme);
  await store.refreshRecents();
}
