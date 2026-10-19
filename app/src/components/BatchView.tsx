import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  FileText,
  FolderOpen,
  LoaderCircle,
  RotateCcw,
  RotateCw,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { api } from "@/engine/client";
import { t } from "@/i18n";
import { type BatchItem, batchPercent, commonFolder, countBatch, primaryOutput } from "@/lib/batch";
import { cn, fileName } from "@/lib/utils";

interface Props {
  title: string;
  items: readonly BatchItem[];
  running: boolean;
  cancelling: boolean;
  onCancel: () => void;
  onRetryFailed: () => void;
  onStartOver: () => void;
  /** Tool-specific one-liner per file (ToolDef.summary). */
  summary?: (stats: Record<string, unknown>) => string | null;
}

const ICONS = {
  queued: CircleDashed,
  running: LoaderCircle,
  done: CircleCheck,
  failed: CircleAlert,
  cancelled: CircleSlash,
} as const;

/** Per-file status list for batch mode and workflow runs (docs/02 §G, §H; 04 §2.4). */
export function BatchView({
  title,
  items,
  running,
  cancelling,
  onCancel,
  onRetryFailed,
  onStartOver,
  summary,
}: Props) {
  const [error, setError] = useState<string | null>(null);
  const counts = countBatch(items);
  const percent = batchPercent(items);
  const shared = running ? null : commonFolder(items);
  const firstDone = items.map(primaryOutput).find(Boolean);
  const act = (action: (path: string) => Promise<unknown>, path: string) => {
    setError(null);
    action(path).catch((err: unknown) => setError(String(err)));
  };

  return (
    <section className="mx-auto max-w-3xl rounded-card border bg-surface p-6 shadow-sm">
      <div className="flex items-center gap-3">
        {running ? (
          <LoaderCircle className="size-5 animate-spin text-primary" aria-hidden />
        ) : (
          <CircleCheck
            className={cn("size-6", counts.failed ? "text-warning" : "text-success")}
            aria-hidden
          />
        )}
        <h2 className="text-lg font-semibold">
          {running ? title : counts.failed ? t("batch.finishedWithErrors") : t("result.title")}
        </h2>
      </div>
      <Progress value={percent} className="mt-4" aria-label={t("progress.title")} />
      <p className="mt-2 text-sm text-text-muted" aria-live="polite" data-testid="batch-counts">
        {t("batch.counts", {
          finished: counts.finished,
          total: counts.total,
          done: counts.done,
          failed: counts.failed,
        })}
        {counts.cancelled > 0 && ` · ${t("batch.cancelledCount", { count: counts.cancelled })}`}
      </p>

      <ul
        className="mt-4 max-h-[50vh] divide-y overflow-y-auto rounded-md border"
        aria-label={t("batch.files")}
      >
        {items.map((item) => {
          const Icon = ICONS[item.state];
          const first = primaryOutput(item);
          const line =
            item.state === "failed"
              ? item.error
              : item.state === "done"
                ? [summary?.(item.stats ?? {}), first && fileName(first)]
                    .filter(Boolean)
                    .join(" · ")
                : item.state === "running"
                  ? `${item.percent}%`
                  : t(`batch.state.${item.state}`);
          return (
            <li
              key={item.key}
              className="flex items-center gap-3 px-3 py-2 text-sm"
              data-state={item.state}
            >
              <Icon
                className={cn(
                  "size-4 shrink-0",
                  item.state === "running" && "animate-spin text-primary",
                  item.state === "done" && "text-success",
                  item.state === "failed" && "text-danger",
                  (item.state === "queued" || item.state === "cancelled") && "text-text-muted",
                )}
                aria-label={t(`batch.state.${item.state}`)}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium" title={item.path}>
                  {item.name}
                </p>
                <p
                  className={cn(
                    "truncate text-xs",
                    item.state === "failed" ? "text-danger" : "text-text-muted",
                  )}
                  title={line}
                >
                  {line}
                </p>
              </div>
              {item.state === "done" && first && (
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => act(api.openOutput, first)}
                    aria-label={`${t("result.open")}: ${fileName(first)}`}
                  >
                    <FileText aria-hidden />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => act(api.revealOutput, first)}
                    aria-label={`${t("result.reveal")}: ${fileName(first)}`}
                  >
                    <FolderOpen aria-hidden />
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="mt-5 flex flex-wrap justify-end gap-2">
        {running ? (
          <Button variant="secondary" onClick={onCancel} disabled={cancelling}>
            {t("progress.cancel")}
          </Button>
        ) : (
          <>
            {shared && firstDone && (
              <Button onClick={() => act(api.revealOutput, firstDone)}>
                <FolderOpen aria-hidden />
                {t("result.reveal")}
              </Button>
            )}
            {counts.failed + counts.cancelled > 0 && (
              <Button variant="secondary" onClick={onRetryFailed}>
                <RotateCw aria-hidden />
                {t("batch.retry")}
              </Button>
            )}
            <Button variant="ghost" onClick={onStartOver}>
              <RotateCcw aria-hidden />
              {t("result.startOver")}
            </Button>
          </>
        )}
      </div>
      {error && (
        <p className="mt-3 text-sm text-danger" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
