import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

interface Props {
  over: boolean;
  acceptedLabel: string;
  onSelect: () => void;
  compact?: boolean;
}

/** The biggest element on a tool page (docs/04 §1 "Drop first"). Drops are window-wide. */
export function DropZone({ over, acceptedLabel, onSelect, compact = false }: Props) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-card border-2 border-dashed text-center transition-colors",
        compact ? "gap-2 p-6" : "min-h-[360px] gap-4 p-10",
        over ? "border-primary bg-primary/5" : "border-border bg-surface-2/50",
      )}
    >
      {!compact && (
        <span className="flex size-16 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Upload className="size-8" aria-hidden />
        </span>
      )}
      <div>
        <p className={cn("font-semibold", compact ? "text-base" : "text-lg")}>
          {t("tool.dropHere")}
        </p>
        {!compact && <p className="text-text-muted">{t("tool.dropHint")}</p>}
      </div>
      <Button size={compact ? "md" : "lg"} onClick={onSelect}>
        {compact ? t("tool.addFiles") : t("tool.selectFiles")}
      </Button>
      <p className="text-xs text-text-muted">{t("tool.accepted", { formats: acceptedLabel })}</p>
    </div>
  );
}
