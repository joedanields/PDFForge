import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, isTauri } from "@/engine/client";
import type { EngineState } from "@/engine/types";
import { t, type MessageKey } from "@/i18n";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";

const DOT: Record<EngineState, string> = {
  starting: "bg-warning animate-pulse",
  restarting: "bg-warning animate-pulse",
  ready: "bg-success",
  failed: "bg-danger",
  incompatible: "bg-danger",
  stopped: "bg-text-muted",
};

/** Small status indicator in the top bar; turns into a banner action when the engine is down. */
export function EngineStatusPill() {
  const engine = useAppStore((s) => s.engine);
  if (!isTauri()) {
    return <span className="text-xs text-text-muted">{t("engine.noTauri")}</span>;
  }
  if (!engine) return null;
  const label = t(`engine.${engine.state}` as MessageKey);
  return (
    <span className="flex items-center gap-2 text-xs text-text-muted" role="status">
      <span className={cn("size-2 rounded-full", DOT[engine.state])} aria-hidden />
      <span className={cn(engine.state === "ready" && "sr-only")}>{label}</span>
      {engine.state === "failed" && (
        <Button size="sm" variant="secondary" onClick={() => void api.restartEngine()}>
          <RefreshCw aria-hidden />
          {t("engine.retry")}
        </Button>
      )}
    </span>
  );
}
