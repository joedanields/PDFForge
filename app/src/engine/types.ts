/** Mirrors engine/protocol.py and the Rust command payloads. */

export const ERROR_CODES = [
  "INVALID_INPUT",
  "PASSWORD_REQUIRED",
  "WRONG_PASSWORD",
  "CORRUPT_FILE",
  "UNSUPPORTED",
  "DISK_FULL",
  "TIMEOUT",
  "CANCELLED",
  "INTERNAL",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ProgressEvent {
  id: string;
  event: "progress";
  percent: number;
  message: string;
}

export interface DoneEvent {
  id: string;
  event: "done";
  outputs: string[];
  stats: Record<string, unknown> & { ms?: number; pages?: number; bytes?: number };
}

export interface ErrorEvent {
  id: string | null;
  event: "error";
  code: ErrorCode;
  message: string;
  file?: string;
}

export type EngineEvent = ProgressEvent | DoneEvent | ErrorEvent;

export type EngineState =
  "starting" | "ready" | "restarting" | "failed" | "incompatible" | "stopped";

export interface EngineStatus {
  state: EngineState;
  engineVersion: string | null;
  protocolVersion: number | null;
  restarts: number;
  message: string | null;
}

export type Theme = "system" | "light" | "dark";

export interface Settings {
  theme: Theme;
  defaultOutputDir: string | null;
}

export interface RecentOutput {
  path: string;
  tool: string;
  createdAt: number;
  bytes: number | null;
  exists: boolean;
}

export interface FileStat {
  path: string;
  name: string;
  size: number | null;
  modified: number | null;
  exists: boolean;
}

export interface AppInfo {
  version: string;
  dataDir: string;
}

/** Plain-language messages + suggested fixes (docs/04_UI_UX.md §5). */
export const ERROR_TEXT: Record<ErrorCode, { title: string; fix?: string }> = {
  INVALID_INPUT: { title: "This file can't be used", fix: "Check the file type and try again." },
  PASSWORD_REQUIRED: { title: "This file is password protected", fix: "Enter its password." },
  WRONG_PASSWORD: { title: "The password is incorrect", fix: "Try the password again." },
  CORRUPT_FILE: {
    title: "This file is damaged",
    fix: "Try Repair PDF (coming soon) or use another copy.",
  },
  UNSUPPORTED: { title: "This isn't supported yet" },
  DISK_FULL: { title: "Not enough disk space", fix: "Free up space or choose another folder." },
  TIMEOUT: { title: "The job took too long", fix: "Try fewer or smaller files." },
  CANCELLED: { title: "Cancelled" },
  INTERNAL: { title: "Something went wrong", fix: "Please try again." },
};
