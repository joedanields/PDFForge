import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, isTauri } from "@/engine/client";
import type { ContextMenuState } from "@/engine/types";
import { t } from "@/i18n";

/** Settings → Windows integration: the Explorer right-click entries (per user, no admin). */
export function ContextMenuSetting() {
  const [state, setState] = useState<ContextMenuState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    api.contextMenuState().then(setState, (err: unknown) => setError(String(err)));
  }, []);

  const toggle = (enabled: boolean) => {
    setError(null);
    api.setContextMenu(enabled).then(setState, (err: unknown) => setError(String(err)));
  };

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label htmlFor="context-menu">{t("settings.contextMenu")}</Label>
          <p id="context-menu-help" className="text-xs text-text-muted">
            {t("settings.contextMenuHelp")}
          </p>
        </div>
        <Switch
          id="context-menu"
          checked={state === "on"}
          disabled={state === null}
          onCheckedChange={toggle}
          aria-describedby="context-menu-help"
        />
      </div>
      {state === "elsewhere" && (
        <p className="text-xs text-warning">{t("settings.contextMenuElsewhere")}</p>
      )}
      {error && (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
