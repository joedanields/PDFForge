import { FileText, FolderOpen } from "lucide-react";
import { forwardRef } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/engine/client";
import { t } from "@/i18n";
import { useAppStore } from "@/lib/store";
import { fileName, formatBytes, timeAgo } from "@/lib/utils";
import { getTool } from "@/tools/registry";
import { cn } from "@/lib/utils";

/** Last 8 outputs (docs/04 §2.1). Missing files are shown dimmed and can't be opened. */
export const RecentOutputs = forwardRef<HTMLElement>(function RecentOutputs(_, ref) {
  const recents = useAppStore((s) => s.recents);
  return (
    <section ref={ref} aria-labelledby="recent-heading" className="scroll-mt-20">
      <h2 id="recent-heading" className="mb-3 text-lg font-semibold">
        {t("home.recent")}
      </h2>
      {recents.length === 0 ? (
        <p className="text-text-muted">{t("home.recentEmpty")}</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 min-[1200px]:grid-cols-4">
          {recents.map((item) => (
            <li
              key={item.path}
              className={cn(
                "flex items-center gap-3 rounded-card border bg-surface p-3",
                !item.exists && "opacity-50",
              )}
            >
              <FileText className="size-8 shrink-0 text-primary" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium" title={item.path}>
                  {fileName(item.path)}
                </p>
                <p className="truncate text-xs text-text-muted">
                  {getTool(item.tool)?.name ?? item.tool} · {formatBytes(item.bytes)} ·{" "}
                  {timeAgo(item.createdAt)}
                </p>
              </div>
              <div className="flex shrink-0">
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={!item.exists}
                  aria-label={`${t("result.open")}: ${fileName(item.path)}`}
                  onClick={() => void api.openOutput(item.path)}
                >
                  <FileText />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={!item.exists}
                  aria-label={`${t("result.reveal")}: ${fileName(item.path)}`}
                  onClick={() => void api.revealOutput(item.path)}
                >
                  <FolderOpen />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
});
