/**
 * Typed wrapper around the Tauri commands and engine events (docs/03_ARCHITECTURE.md §5).
 * The UI never talks to the engine process directly; Rust forwards everything.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppInfo,
  DoneEvent,
  EngineEvent,
  EngineStatus,
  ErrorEvent,
  FileStat,
  ProgressEvent,
  RecentOutput,
  Settings,
} from "./types";

export const EVENTS = {
  engine: "engine://event",
  status: "engine://status",
  recentsChanged: "recents://changed",
} as const;

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// ── job event routing ────────────────────────────────────────────────────────────────────────

type JobListener = (event: EngineEvent) => void;
const jobListeners = new Map<string, JobListener>();
let routing: Promise<UnlistenFn> | null = null;

function ensureRouting(): Promise<UnlistenFn> {
  routing ??= listen<EngineEvent>(EVENTS.engine, ({ payload }) => {
    if (payload.id) jobListeners.get(payload.id)?.(payload);
  });
  return routing;
}

export class JobError extends Error {
  constructor(readonly event: Omit<ErrorEvent, "id"> & { id: string | null }) {
    super(event.message);
    this.name = "JobError";
  }
}

export interface RunningJob {
  id: string;
  result: Promise<DoneEvent>;
  cancel: () => Promise<void>;
}

export function newJobId(): string {
  return `job-${crypto.randomUUID()}`;
}

/** Submit a job; progress is pushed to `onProgress`, the promise settles on done/error. */
export async function runJob(
  method: string,
  params: Record<string, unknown>,
  onProgress?: (event: ProgressEvent) => void,
): Promise<RunningJob> {
  await ensureRouting();
  const id = newJobId();
  const result = new Promise<DoneEvent>((resolve, reject) => {
    jobListeners.set(id, (event) => {
      if (event.event === "progress") {
        onProgress?.(event);
        return;
      }
      jobListeners.delete(id);
      if (event.event === "done") resolve(event);
      else reject(new JobError(event));
    });
  });
  try {
    await invoke("run_job", { id, method, params });
  } catch (err) {
    jobListeners.delete(id);
    throw new JobError({
      id,
      event: "error",
      code: "INTERNAL",
      message: typeof err === "string" ? err : "The PDF engine is not available.",
    });
  }
  return { id, result, cancel: () => invoke("cancel_job", { id }) };
}

// ── commands ─────────────────────────────────────────────────────────────────────────────────

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  engineStatus: () => invoke<EngineStatus>("engine_status"),
  restartEngine: () => invoke<undefined>("restart_engine"),
  getSettings: () => invoke<Settings>("get_settings"),
  setSettings: (value: Settings) => invoke<Settings>("set_settings", { value }),
  listRecents: (limit = 8) => invoke<RecentOutput[]>("list_recents", { limit }),
  clearHistory: () => invoke<undefined>("clear_history"),
  openOutput: (path: string) => invoke<undefined>("open_output", { path }),
  revealOutput: (path: string) => invoke<undefined>("reveal_output", { path }),
  fileStats: (paths: string[]) => invoke<FileStat[]>("file_stats", { paths }),
  readInputFile: (path: string) => invoke<ArrayBuffer>("read_input_file", { path }),
};

export function onEngineStatus(cb: (status: EngineStatus) => void): Promise<UnlistenFn> {
  return listen<EngineStatus>(EVENTS.status, ({ payload }) => {
    cb(payload);
  });
}

export function onRecentsChanged(cb: () => void): Promise<UnlistenFn> {
  return listen(EVENTS.recentsChanged, () => {
    cb();
  });
}
