import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api, isTauri } from "@/engine/client";
import { t } from "@/i18n";
import { languageName, useOcrLanguages } from "@/lib/ocrLanguages";

/** Settings → OCR languages: bundled models plus `.traineddata` files the user adds (D-027). */
export function OcrLanguagesSettings() {
  const { languages, setLanguages } = useOcrLanguages();
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    if (!isTauri()) return;
    setError(null);
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: t("settings.ocrFileType"), extensions: ["traineddata"] }],
    });
    if (typeof picked !== "string") return;
    try {
      setLanguages(await api.addOcrLanguage(picked));
    } catch (err) {
      setError(typeof err === "string" ? err : String(err));
    }
  };

  const remove = async (code: string) => {
    setError(null);
    try {
      setLanguages(await api.removeOcrLanguage(code));
    } catch (err) {
      setError(typeof err === "string" ? err : String(err));
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-text-muted">{t("settings.ocrHelp")}</p>
      <ul className="divide-y rounded-md border" aria-label={t("settings.ocrLanguages")}>
        {languages.map((lang) => (
          <li key={lang.code} className="flex items-center gap-3 px-3 py-2 text-sm">
            <span className="flex-1">
              {languageName(lang.code)}
              <span className="ml-2 text-xs text-text-muted">{lang.code}</span>
            </span>
            {lang.bundled ? (
              <span className="text-xs text-text-muted">{t("settings.ocrBundled")}</span>
            ) : (
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                aria-label={t("settings.ocrRemove", { name: languageName(lang.code) })}
                onClick={() => void remove(lang.code)}
              >
                <Trash2 />
              </Button>
            )}
          </li>
        ))}
      </ul>
      {error && (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      )}
      <Button variant="secondary" disabled={!isTauri()} onClick={() => void add()}>
        <Plus aria-hidden />
        {t("settings.ocrAdd")}
      </Button>
    </div>
  );
}
