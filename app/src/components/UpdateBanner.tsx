import { Download, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, isTauri, onUpdateAvailable } from "@/engine/client";
import type { UpdateInfo } from "@/engine/types";
import { t } from "@/i18n";

/** Shown when the opt-in start-up check (Settings → Updates) found a newer version (D-044). */
export function UpdateBanner() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = onUpdateAvailable(setInfo);
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  if (!info) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 border-b bg-primary/10 px-6 py-2 text-sm"
    >
      <span className="flex-1">
        {installing ? t("updates.installing") : t("updates.banner", { version: info.version })}
        {error && <span className="ml-2 text-danger">{error}</span>}
      </span>
      <Button
        size="sm"
        disabled={installing}
        onClick={() => {
          setInstalling(true);
          setError(null);
          api.installUpdate().catch((err: unknown) => {
            setInstalling(false);
            setError(String(err));
          });
        }}
      >
        <Download aria-hidden />
        {t("updates.install", { version: info.version })}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setInfo(null)} disabled={installing}>
        <X aria-hidden />
        {t("updates.later")}
      </Button>
    </div>
  );
}
