import { describe, expect, it } from "vitest";
import { JobError, type RunningJob } from "@/engine/client";
import type { DoneEvent } from "@/engine/types";
import { type BatchItem, batchPercent, commonFolder, countBatch, runBatch } from "./batch";

interface FakeJob extends RunningJob {
  finish: () => void;
  fail: (code: "CORRUPT_FILE" | "CANCELLED", message?: string) => void;
}

function fakeJob(path: string, log: string[]): FakeJob {
  let resolve!: (e: DoneEvent) => void;
  let reject!: (e: unknown) => void;
  const result = new Promise<DoneEvent>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const fail: FakeJob["fail"] = (code, message = "") =>
    reject(new JobError({ id: path, event: "error", code, message }));
  return {
    id: path,
    result,
    cancel: () => {
      log.push(`cancel ${path}`);
      fail("CANCELLED");
      return Promise.resolve();
    },
    finish: () =>
      resolve({
        id: path,
        event: "done",
        outputs: [path.replace(".pdf", "_out.pdf")],
        stats: { pages: 1 },
      }),
    fail,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function harness(paths: string[], concurrency = 2) {
  const items = new Map<string, BatchItem>(
    paths.map((path) => [
      path,
      { key: path, path, name: path, state: "queued", percent: 0, outputs: [] },
    ]),
  );
  const jobs = new Map<string, FakeJob>();
  const log: string[] = [];
  const handle = runBatch(
    paths.map((path) => ({ key: path, path })),
    (path) => {
      log.push(`start ${path}`);
      const job = fakeJob(path, log);
      jobs.set(path, job);
      return Promise.resolve(job);
    },
    (key, patch) => {
      const prev = items.get(key);
      if (prev) items.set(key, { ...prev, ...patch });
    },
    concurrency,
  );
  return { items: () => [...items.values()], jobs, log, handle };
}

describe("runBatch", () => {
  it("runs files two at a time and keeps going after a failure", async () => {
    const h = harness(["C:\\in\\a.pdf", "C:\\in\\b.pdf", "C:\\in\\c.pdf"]);
    await flush();
    expect(h.log).toEqual(["start C:\\in\\a.pdf", "start C:\\in\\b.pdf"]);
    h.jobs.get("C:\\in\\a.pdf")?.fail("CORRUPT_FILE", "a.pdf is damaged");
    await flush();
    expect(h.log).toContain("start C:\\in\\c.pdf");
    h.jobs.get("C:\\in\\b.pdf")?.finish();
    h.jobs.get("C:\\in\\c.pdf")?.finish();
    await h.handle.finished;

    const items = h.items();
    expect(items.map((i) => i.state)).toEqual(["failed", "done", "done"]);
    expect(items[0]?.error).toBe("a.pdf is damaged");
    expect(items[1]?.outputs).toEqual(["C:\\in\\b_out.pdf"]);
    expect(countBatch(items)).toMatchObject({ total: 3, done: 2, failed: 1, finished: 3 });
    expect(batchPercent(items)).toBe(100);
    expect(commonFolder(items)).toBe("C:\\in");
  });

  it("cancel stops running jobs and skips the queue", async () => {
    const h = harness(["a.pdf", "b.pdf", "c.pdf", "d.pdf"]);
    await flush();
    h.handle.cancel();
    await h.handle.finished;
    expect(h.log.filter((l) => l.startsWith("start"))).toHaveLength(2);
    expect(h.items().every((i) => i.state === "cancelled")).toBe(true);
  });

  it("reports progress of running files", () => {
    const items: BatchItem[] = [
      { key: "1", path: "1", name: "1", state: "done", percent: 100, outputs: [] },
      { key: "2", path: "2", name: "2", state: "running", percent: 50, outputs: [] },
      { key: "3", path: "3", name: "3", state: "queued", percent: 0, outputs: [] },
      { key: "4", path: "4", name: "4", state: "queued", percent: 0, outputs: [] },
    ];
    expect(batchPercent(items)).toBe(38);
    expect(commonFolder(items)).toBeNull();
  });
});
