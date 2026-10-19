import {
  CircleCheck,
  Eye,
  FileText,
  FolderOpen,
  Info,
  Lock,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { api } from "@/engine/client";
import type { DoneEvent } from "@/engine/types";
import { t } from "@/i18n";
import { dirName, fileName, formatBytes } from "@/lib/utils";
import { viewerPath } from "@/lib/viewer";
import { getTool } from "@/tools/registry";

interface Props {
  result: DoneEvent;
  /** Tool-specific one-liner (ToolDef.summary). */
  summary?: string | null;
  /** Several inputs combined into one output (changes the protection warning wording). */
  combined?: boolean;
  onStartOver: () => void;
}

const MAX_LISTED = 4;

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Result screen: Open / Show in folder / Start over (docs/04 §2.4), plus tool-specific notes. */
export function ResultCard({ result, summary = null, combined = false, onStartOver }: Props) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const { stats, outputs } = result;
  const first = outputs[0];
  const folder = typeof stats.folder === "string" ? stats.folder : null;
  const pages = num(stats.pages);
  const bytes = num(stats.bytes);
  const originalBytes = num(stats.original_bytes);
  const keptOriginal = stats.kept_original === true;
  const noOutputReason = typeof stats.no_output_reason === "string" ? stats.no_output_reason : null;
  const protectedInputs = num(stats.protected_inputs) ?? 0;
  const echo = typeof stats.echo === "string" ? stats.echo : null;
  const protectAvailable = getTool("protect")?.status === "available";

  const run = (action: (path: string) => Promise<unknown>, path: string | undefined) => {
    if (!path) return;
    setError(null);
    action(path).catch((err: unknown) => setError(typeof err === "string" ? err : String(err)));
  };

  const saved =
    originalBytes != null && bytes != null && originalBytes > 0 && !keptOriginal
      ? Math.round((1 - bytes / originalBytes) * 100)
      : null;

  return (
    <section
      className="mx-auto flex max-w-xl flex-col items-center rounded-card border bg-surface p-10 text-center shadow-sm"
      aria-live="polite"
    >
      <span className="flex size-16 items-center justify-center rounded-full bg-success/15 text-success">
        <CircleCheck className="size-9" aria-hidden />
      </span>
      <h2 className="mt-4 text-xl font-semibold">{t("result.title")}</h2>
      {summary && (
        <p className="mt-1 text-base text-text" data-testid="result-summary">
          {summary}
        </p>
      )}

      {keptOriginal && (
        <p className="mt-4 flex items-start gap-2 rounded-md bg-surface-2 px-4 py-3 text-left text-sm">
          <Info className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          {t("result.keptOriginal", { size: formatBytes(originalBytes) })}
        </p>
      )}

      {noOutputReason && (
        <p className="mt-4 flex items-start gap-2 rounded-md bg-surface-2 px-4 py-3 text-left text-sm">
          <Info className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          {noOutputReason}
        </p>
      )}

      {folder && (
        <div className="mt-4 w-full rounded-md bg-surface-2 px-4 py-3 text-left">
          <p className="truncate font-medium" title={folder}>
            {t("result.filesInFolder", { count: outputs.length, folder: fileName(folder) })}
          </p>
          <p className="truncate text-xs text-text-muted" title={dirName(folder)}>
            {dirName(folder)}
          </p>
        </div>
      )}
      {outputs.slice(0, MAX_LISTED).map((path) => (
        <div
          key={path}
          className="mt-2 w-full rounded-md bg-surface-2 px-4 py-2 text-left first-of-type:mt-4"
        >
          <p className="truncate font-medium" title={path}>
            {fileName(path)}
          </p>
          {!folder && (
            <p className="truncate text-xs text-text-muted" title={dirName(path)}>
              {dirName(path)}
            </p>
          )}
        </div>
      ))}
      {outputs.length > MAX_LISTED && (
        <p className="mt-2 text-sm text-text-muted">
          {t("result.andMore", { count: outputs.length - MAX_LISTED })}
        </p>
      )}

      <p className="mt-3 text-sm text-text-muted">
        {[
          pages != null && `${pages} ${pages === 1 ? "page" : "pages"}`,
          originalBytes != null && bytes != null && !keptOriginal
            ? `${formatBytes(originalBytes)} → ${formatBytes(bytes)}`
            : bytes != null && !keptOriginal && formatBytes(bytes),
          saved != null && t("result.saved", { percent: saved }),
          echo != null && `“${echo}”`,
          num(stats.ms) != null && `${((stats.ms ?? 0) / 1000).toFixed(1)} s`,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>

      {protectedInputs > 0 && (
        <div
          role="alert"
          className="mt-4 flex w-full items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-left text-sm"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <span className="flex-1">
            {t(combined ? "result.protectedWarning" : "result.protectedWarningSingle")}
          </span>
          {protectAvailable && first && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => navigate("/tool/protect", { state: { preload: [first] } })}
            >
              <Lock aria-hidden />
              {t("result.protect")}
            </Button>
          )}
        </div>
      )}

      <div className="mt-6 flex flex-wrap justify-center gap-2">
        {folder ? (
          <Button size="lg" onClick={() => run(api.openOutput, folder)}>
            <FolderOpen aria-hidden />
            {t("result.openFolder")}
          </Button>
        ) : (
          first && (
            <>
              <Button size="lg" onClick={() => run(api.openOutput, first)}>
                <FileText aria-hidden />
                {t("result.open")}
              </Button>
              {first.toLowerCase().endsWith(".pdf") && (
                <Button size="lg" variant="secondary" onClick={() => navigate(viewerPath(first))}>
                  <Eye aria-hidden />
                  {t("result.view")}
                </Button>
              )}
              <Button size="lg" variant="secondary" onClick={() => run(api.revealOutput, first)}>
                <FolderOpen aria-hidden />
                {t("result.reveal")}
              </Button>
            </>
          )
        )}
        <Button size="lg" variant="ghost" onClick={onStartOver}>
          <RotateCcw aria-hidden />
          {t("result.startOver")}
        </Button>
      </div>
      {error && (
        <p className="mt-4 text-sm text-danger" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
