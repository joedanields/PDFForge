import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { t } from "@/i18n";
import { formatDuration } from "@/lib/utils";

interface Props {
  toolName: string;
  percent: number;
  message: string;
  startedAt: number;
  cancelling: boolean;
  onCancel: () => void;
}

/** Inline overlay with progress, current step, elapsed time and Cancel (docs/04 §2.3). */
export function ProgressOverlay({
  toolName,
  percent,
  message,
  startedAt,
  cancelling,
  onCancel,
}: Props) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center bg-surface/80 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="progress-title"
    >
      <div className="w-full max-w-md rounded-card border bg-surface p-6 shadow-2xl">
        <div className="flex items-center gap-3">
          <LoaderCircle className="size-5 animate-spin text-primary" aria-hidden />
          <h2 id="progress-title" className="text-lg font-semibold">
            {toolName}
          </h2>
        </div>
        <Progress value={percent} className="mt-5" aria-label={t("progress.title")} />
        <div className="mt-3 flex justify-between text-sm text-text-muted">
          <span aria-live="polite">{message || t("progress.title")}</span>
          <span>{percent}%</span>
        </div>
        <div className="mt-6 flex items-center justify-between">
          <span className="text-xs text-text-muted">
            {t("progress.elapsed", { time: formatDuration(now - startedAt) })}
          </span>
          <Button variant="secondary" onClick={onCancel} disabled={cancelling}>
            {t("progress.cancel")}
          </Button>
        </div>
      </div>
    </div>
  );
}
