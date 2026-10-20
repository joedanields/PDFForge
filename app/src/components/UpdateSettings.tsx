import { Download, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, isTauri } from "@/engine/client";
import type { UpdateInfo, UpdaterStatus } from "@/engine/types";
import { t } from "@/i18n";
import { useAppStore } from "@/lib/store";

type Check =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "none" }
  | { kind: "found"; info: UpdateInfo }
  | { kind: "installing" }
  | { kind: "error"; text: string };

/** Settings → Updates (D-044): off by default; only works once the build has an endpoint. */
export function UpdateSettings() {
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const [status, setStatus] = useState<UpdaterStatus | null>(null);
  const [check, setCheck] = useState<Check>({ kind: "idle" });

  useEffect(() => {
    if (!isTauri()) return;
    api.updaterStatus().then(setStatus, () => setStatus(null));
  }, []);

  const checkNow = () => {
    setCheck({ kind: "checking" });
    api.checkForUpdate().then(
      (info) => setCheck(info ? { kind: "found", info } : { kind: "none" }),
      (err: unknown) => setCheck({ kind: "error", text: String(err) }),
    );
  };

  const install = () => {
    setCheck({ kind: "installing" });
    api.installUpdate().catch((err: unknown) => setCheck({ kind: "error", text: String(err) }));
  };

  if (!status?.configured) {
    return (
      <p className="text-sm text-text-muted" data-testid="updates-off">
        {t("updates.notConfigured")}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label htmlFor="auto-update">{t("updates.auto")}</Label>
          <p id="auto-update-help" className="text-xs text-text-muted">
            {t("updates.autoHelp")}
          </p>
        </div>
        <Switch
          id="auto-update"
          checked={settings.autoUpdate}
          onCheckedChange={(on) => void saveSettings({ autoUpdate: on })}
          aria-describedby="auto-update-help"
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          onClick={checkNow}
          disabled={check.kind === "checking" || check.kind === "installing"}
        >
          <RefreshCw aria-hidden />
          {t("updates.checkNow")}
        </Button>
        {check.kind === "found" && (
          <Button onClick={install}>
            <Download aria-hidden />
            {t("updates.install", { version: check.info.version })}
          </Button>
        )}
      </div>
      <p className="text-sm" role="status">
        {check.kind === "checking" && t("updates.checking")}
        {check.kind === "none" && t("updates.upToDate", { version: status.currentVersion })}
        {check.kind === "found" && t("updates.available", { version: check.info.version })}
        {check.kind === "installing" && t("updates.installing")}
        {check.kind === "error" && <span className="text-danger">{check.text}</span>}
      </p>
    </div>
  );
}
