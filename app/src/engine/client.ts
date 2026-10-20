/**
 * Typed wrapper around the Tauri commands and engine events (docs/03_ARCHITECTURE.md §5).
 * The UI never talks to the engine process directly; Rust forwards everything.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppInfo,
  ContextMenuState,
  DoneEvent,
  EngineEvent,
  EngineStatus,
  ErrorEvent,
  FileStat,
  OcrLanguage,
  OpenRequest,
  UpdateInfo,
  UpdaterStatus,
  ProgressEvent,
  RecentOutput,
  SavedSignature,
  Settings,
} from "./types";
import type { Workflow } from "@/lib/workflows";

export const EVENTS = {
  engine: "engine://event",
  status: "engine://status",
  recentsChanged: "recents://changed",
  openFiles: "app://open-files",
  updateAvailable: "updater://available",
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
  openNotices: () => invoke<undefined>("open_notices"),
  openLicensesFolder: () => invoke<undefined>("open_licenses_folder"),
  fileStats: (paths: string[]) => invoke<FileStat[]>("file_stats", { paths }),
  listFolder: (folder: string, extensions: string[]) =>
    invoke<string[]>("list_folder", { folder, extensions }),
  readInputFile: (path: string) => invoke<ArrayBuffer>("read_input_file", { path }),
  listSignatures: () => invoke<SavedSignature[]>("list_signatures"),
  saveSignature: (kind: string, png: string) =>
    invoke<SavedSignature>("save_signature", { kind, png }),
  deleteSignature: (id: string) => invoke<undefined>("delete_signature", { id }),
  clearSignatures: () => invoke<undefined>("clear_signatures"),
  takeOpenRequests: () => invoke<OpenRequest[]>("take_open_requests"),
  contextMenuState: () => invoke<ContextMenuState>("context_menu_state"),
  updaterStatus: () => invoke<UpdaterStatus>("updater_status"),
  checkForUpdate: () => invoke<UpdateInfo | null>("check_for_update"),
  installUpdate: () => invoke<undefined>("install_update"),
  setContextMenu: (enabled: boolean) => invoke<ContextMenuState>("set_context_menu", { enabled }),
  listWorkflows: () => invoke<Workflow[]>("list_workflows"),
  saveWorkflow: (workflow: Workflow) => invoke<Workflow>("save_workflow", { workflow }),
  deleteWorkflow: (id: string) => invoke<undefined>("delete_workflow", { id }),
  ocrLanguages: () => invoke<OcrLanguage[]>("ocr_languages"),
  addOcrLanguage: (path: string) => invoke<OcrLanguage[]>("add_ocr_language", { path }),
  removeOcrLanguage: (code: string) => invoke<OcrLanguage[]>("remove_ocr_language", { code }),
};

export function onEngineStatus(cb: (status: EngineStatus) => void): Promise<UnlistenFn> {
  return listen<EngineStatus>(EVENTS.status, ({ payload }) => {
    cb(payload);
  });
}

/** A later launch queued an open request ("Open with" / "Merge with PDFForge"): take it. */
export function onOpenFiles(cb: () => void): Promise<UnlistenFn> {
  return listen(EVENTS.openFiles, () => {
    cb();
  });
}

/** A background update check (Settings → Updates) found a newer version. */
export function onUpdateAvailable(cb: (info: UpdateInfo) => void): Promise<UnlistenFn> {
  return listen<UpdateInfo>(EVENTS.updateAvailable, ({ payload }) => {
    cb(payload);
  });
}

export function onRecentsChanged(cb: () => void): Promise<UnlistenFn> {
  return listen(EVENTS.recentsChanged, () => {
    cb();
  });
}
