import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isTauri } from "@/engine/client";
import { t } from "@/i18n";

interface Props {
  value: string | null;
  /** Shown when `value` is null (settings default, or "same folder as first file"). */
  fallbackLabel: string;
  onChange: (value: string | null) => void;
  disabled?: boolean;
  label?: string;
}

export function OutputFolderPicker({ value, fallbackLabel, onChange, disabled, label }: Props) {
  const choose = async () => {
    if (!isTauri()) return;
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") onChange(picked);
  };
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{label ?? t("tool.output")}</p>
      <div className="flex items-center gap-2 rounded-md border bg-surface-2/60 px-3 py-2">
        <FolderOpen className="size-4 shrink-0 text-text-muted" aria-hidden />
        <span className="flex-1 truncate text-sm" title={value ?? fallbackLabel}>
          {value ?? fallbackLabel}
        </span>
      </div>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" onClick={() => void choose()} disabled={disabled}>
          {t("tool.change")}
        </Button>
        {value && (
          <Button variant="ghost" size="sm" onClick={() => onChange(null)} disabled={disabled}>
            {t("tool.reset")}
          </Button>
        )}
      </div>
    </div>
  );
}
