/**
 * Batch mode (docs/02 §H): run a single-file tool on many files, each as its own engine job,
 * with a per-file status list. A failing file never stops the others.
 */
import { JobError, type RunningJob } from "@/engine/client";
import type { DoneEvent } from "@/engine/types";
import { ERROR_TEXT } from "@/engine/types";
import { tx } from "@/i18n";

/** Most files one batch takes. */
export const BATCH_MAX = 500;
/** Jobs running at the same time (the engine runs up to 4; leave room for the viewer etc.). */
export const BATCH_CONCURRENCY = 2;

export type BatchState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface BatchItem {
  key: string;
  path: string;
  name: string;
  state: BatchState;
  percent: number;
  outputs: string[];
  stats?: DoneEvent["stats"];
  error?: string;
}

export interface BatchCounts {
  total: number;
  done: number;
  failed: number;
  cancelled: number;
  finished: number;
}

export function countBatch(items: readonly BatchItem[]): BatchCounts {
  const done = items.filter((i) => i.state === "done").length;
  const failed = items.filter((i) => i.state === "failed").length;
  const cancelled = items.filter((i) => i.state === "cancelled").length;
  return { total: items.length, done, failed, cancelled, finished: done + failed + cancelled };
}

/** Overall progress, 0–100: finished files count fully, running ones by their own percent. */
export function batchPercent(items: readonly BatchItem[]): number {
  if (items.length === 0) return 0;
  const sum = items.reduce(
    (acc, i) => acc + (i.state === "running" ? i.percent : i.state === "queued" ? 0 : 100),
    0,
  );
  return Math.round(sum / items.length);
}

/** The folder all outputs went to, if they share one (for "Open folder"). */
export function commonFolder(items: readonly BatchItem[]): string | null {
  const folders = new Set(
    items
      .flatMap((i) => i.outputs)
      .map((p) => p.slice(0, Math.max(0, p.lastIndexOf("\\"), p.lastIndexOf("/")))),
  );
  if (folders.size !== 1) return null;
  const [only] = folders;
  return only || null;
}

export function errorText(err: unknown): string {
  if (err instanceof JobError) {
    const { code, message } = err.event;
    if (code === "CANCELLED") return tx(ERROR_TEXT.CANCELLED.title);
    return message || tx(ERROR_TEXT[code].title);
  }
  return String(err);
}

export interface BatchHandle {
  cancel: () => void;
  /** Settles when every file has finished, failed or been cancelled. */
  finished: Promise<void>;
}

/**
 * Run `start(path)` for each queued item, `concurrency` at a time. `onUpdate` receives
 * per-item patches; the caller owns the item list (React state).
 */
export function runBatch(
  items: readonly Pick<BatchItem, "key" | "path">[],
  start: (path: string, onProgress: (percent: number) => void) => Promise<RunningJob>,
  onUpdate: (key: string, patch: Partial<BatchItem>) => void,
  concurrency = BATCH_CONCURRENCY,
): BatchHandle {
  const queue = [...items];
  const running = new Set<RunningJob>();
  const state = { cancelled: false };
  // A function, so the check after an await is not narrowed away.
  const cancelled = () => state.cancelled;

  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      if (cancelled()) {
        onUpdate(item.key, { state: "cancelled" });
        continue;
      }
      const { key, path } = item;
      onUpdate(key, { state: "running", percent: 0, error: undefined });
      let job: RunningJob | null = null;
      try {
        job = await start(path, (percent) => onUpdate(key, { percent }));
        running.add(job);
        if (cancelled()) void job.cancel(); // cancelled while it was starting
        const result = await job.result;
        onUpdate(key, {
          state: "done",
          percent: 100,
          outputs: result.outputs,
          stats: result.stats,
        });
      } catch (err) {
        const wasCancel = err instanceof JobError && err.event.code === "CANCELLED";
        onUpdate(
          key,
          wasCancel ? { state: "cancelled" } : { state: "failed", error: errorText(err) },
        );
      } finally {
        if (job) running.delete(job);
      }
    }
  };

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker);
  return {
    cancel: () => {
      state.cancelled = true;
      for (const job of running) void job.cancel();
    },
    finished: Promise.all(workers).then(() => undefined),
  };
}

/** What to open for a finished item: the new folder of a multi-file result, else its file
 * (only these are recorded as outputs, see src-tauri/src/lib.rs). */
export function primaryOutput(item: BatchItem): string | undefined {
  const folder = item.stats?.folder;
  return typeof folder === "string" ? folder : item.outputs[0];
}
