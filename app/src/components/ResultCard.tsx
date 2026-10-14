import { CircleCheck, FileText, FolderOpen, RotateCcw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/engine/client";
import type { DoneEvent } from "@/engine/types";
import { t } from "@/i18n";
import { dirName, fileName, formatBytes } from "@/lib/utils";

interface Props {
  result: DoneEvent;
  onStartOver: () => void;
}

/** Success screen with Open file / Show in folder / Start over (docs/04 §2.4). */
export function ResultCard({ result, onStartOver }: Props) {
  const [error, setError] = useState<string | null>(null);
  const first = result.outputs[0];
  const pages = typeof result.stats.pages === "number" ? result.stats.pages : null;
  const bytes = typeof result.stats.bytes === "number" ? result.stats.bytes : null;
  const echo = typeof result.stats.echo === "string" ? result.stats.echo : null;

  const run = (action: (path: string) => Promise<unknown>) => {
    if (!first) return;
    setError(null);
    action(first).catch((err: unknown) => setError(typeof err === "string" ? err : String(err)));
  };

  return (
    <section
      className="mx-auto flex max-w-xl flex-col items-center rounded-card border bg-surface p-10 text-center shadow-sm"
      aria-live="polite"
    >
      <span className="flex size-16 items-center justify-center rounded-full bg-success/15 text-success">
        <CircleCheck className="size-9" aria-hidden />
      </span>
      <h2 className="mt-4 text-xl font-semibold">{t("result.title")}</h2>

      {result.outputs.map((path) => (
        <div key={path} className="mt-4 w-full rounded-md bg-surface-2 px-4 py-3 text-left">
          <p className="truncate font-medium" title={path}>
            {fileName(path)}
          </p>
          <p className="truncate text-xs text-text-muted" title={dirName(path)}>
            {dirName(path)}
          </p>
        </div>
      ))}
      <p className="mt-3 text-sm text-text-muted">
        {[
          pages != null && `${pages} ${pages === 1 ? "page" : "pages"}`,
          bytes != null && formatBytes(bytes),
          echo != null && `“${echo}”`,
          typeof result.stats.ms === "number" && `${(result.stats.ms / 1000).toFixed(1)} s`,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>

      <div className="mt-6 flex flex-wrap justify-center gap-2">
        {first && (
          <>
            <Button size="lg" onClick={() => run(api.openOutput)}>
              <FileText aria-hidden />
              {t("result.open")}
            </Button>
            <Button size="lg" variant="secondary" onClick={() => run(api.revealOutput)}>
              <FolderOpen aria-hidden />
              {t("result.reveal")}
            </Button>
          </>
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
