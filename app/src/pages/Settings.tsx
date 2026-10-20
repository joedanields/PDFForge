import { FlaskConical, FolderOpen, ScrollText } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ContextMenuSetting } from "@/components/ContextMenuSetting";
import { OcrLanguagesSettings } from "@/components/OcrLanguagesSettings";
import { OutputFolderPicker } from "@/components/OutputFolderPicker";
import { UpdateSettings } from "@/components/UpdateSettings";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, isTauri } from "@/engine/client";
import type { Theme } from "@/engine/types";
import { LOCALE_NAMES, LOCALES, t, type Locale, type MessageKey } from "@/i18n";
import { useAppStore } from "@/lib/store";

const THEMES: { value: Theme; label: MessageKey }[] = [
  { value: "system", label: "settings.themeSystem" },
  { value: "light", label: "settings.themeLight" },
  { value: "dark", label: "settings.themeDark" },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-card border bg-surface p-6">
      <h2 className="mb-5 text-base font-semibold">{title}</h2>
      <div className="space-y-6">{children}</div>
    </section>
  );
}

export function SettingsPage() {
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const refreshRecents = useAppStore((s) => s.refreshRecents);
  const engine = useAppStore((s) => s.engine);
  const appInfo = useAppStore((s) => s.appInfo);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const save = (patch: Parameters<typeof saveSettings>[0]) => {
    setMessage(null);
    saveSettings(patch).catch((err: unknown) =>
      setMessage({ tone: "error", text: typeof err === "string" ? err : String(err) }),
    );
  };

  const clear = async () => {
    if (!isTauri()) return;
    await api.clearHistory();
    await refreshRecents();
    setMessage({ tone: "ok", text: t("settings.cleared") });
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-10">
      <h1 className="text-xl font-bold">{t("settings.title")}</h1>
      {message && (
        <p
          role="status"
          className={message.tone === "error" ? "text-sm text-danger" : "text-sm text-success"}
        >
          {message.text}
        </p>
      )}

      <Section title={t("settings.general")}>
        <div className="space-y-2">
          <Label htmlFor="theme">{t("settings.theme")}</Label>
          <Select value={settings.theme} onValueChange={(v) => save({ theme: v as Theme })}>
            <SelectTrigger id="theme" className="max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THEMES.map((th) => (
                <SelectItem key={th.value} value={th.value}>
                  {t(th.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="language">{t("settings.language")}</Label>
          <Select value={settings.language} onValueChange={(v) => save({ language: v as Locale })}>
            <SelectTrigger id="language" className="max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LOCALES.map((code) => (
                <SelectItem key={code} value={code} lang={code}>
                  {LOCALE_NAMES[code]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-text-muted">{t("settings.languageHelp")}</p>
        </div>
        <div className="space-y-1">
          <OutputFolderPicker
            label={t("settings.outputDir")}
            value={settings.defaultOutputDir}
            fallbackLabel={t("tool.outputDefault")}
            onChange={(dir) => save({ defaultOutputDir: dir })}
          />
          <p className="text-xs text-text-muted">{t("settings.outputDirHelp")}</p>
        </div>
      </Section>

      <Section title={t("settings.ocrLanguages")}>
        <OcrLanguagesSettings />
      </Section>

      <Section title={t("settings.windows")}>
        <ContextMenuSetting />
      </Section>

      <Section title={t("settings.privacy")}>
        <p className="text-sm text-text-muted">{t("settings.offline")}</p>
        <p className="text-sm text-text-muted">{t("settings.onlineNote")}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => void clear()}>
            {t("settings.clearHistory")}
          </Button>
          <Button
            variant="secondary"
            disabled={!isTauri()}
            onClick={() =>
              void api
                .clearSignatures()
                .then(() => setMessage({ tone: "ok", text: t("settings.signaturesCleared") }))
                .catch((err: unknown) => setMessage({ tone: "error", text: String(err) }))
            }
          >
            {t("settings.clearSignatures")}
          </Button>
          {settings.onlineConfirmed && (
            <Button
              variant="secondary"
              onClick={() => {
                save({ onlineConfirmed: false });
                setMessage({ tone: "ok", text: t("settings.onlineResetDone") });
              }}
            >
              {t("settings.onlineReset")}
            </Button>
          )}
        </div>
      </Section>

      <Section title={t("updates.title")}>
        <UpdateSettings />
      </Section>

      <Section title={t("settings.about")}>
        <dl className="grid grid-cols-[180px_1fr] gap-y-2 text-sm">
          <dt className="text-text-muted">{t("app.name")}</dt>
          <dd>{t("settings.version", { version: appInfo?.version ?? "—" })}</dd>
          <dt className="text-text-muted">{t("settings.engine")}</dt>
          <dd>
            {engine
              ? `${engine.state}${engine.engineVersion ? ` · v${engine.engineVersion}` : ""}${
                  engine.protocolVersion ? ` · protocol ${engine.protocolVersion}` : ""
                }`
              : "—"}
            {engine?.message && <span className="block text-danger">{engine.message}</span>}
          </dd>
          <dt className="text-text-muted">{t("settings.dataDir")}</dt>
          <dd className="truncate" title={appInfo?.dataDir}>
            {appInfo?.dataDir ?? "—"}
          </dd>
        </dl>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" asChild>
            <Link to="/tool/echo">
              <FlaskConical aria-hidden />
              {t("settings.selfTest")}
            </Link>
          </Button>
          <Button
            variant="secondary"
            disabled={!isTauri()}
            onClick={() =>
              void api
                .openNotices()
                .catch((err: unknown) => setMessage({ tone: "error", text: String(err) }))
            }
          >
            <ScrollText aria-hidden />
            {t("settings.notices")}
          </Button>
          <Button
            variant="secondary"
            disabled={!isTauri()}
            onClick={() =>
              void api
                .openLicensesFolder()
                .catch((err: unknown) => setMessage({ tone: "error", text: String(err) }))
            }
          >
            <FolderOpen aria-hidden />
            {t("settings.licensesFolder")}
          </Button>
        </div>
        <p className="text-xs text-text-muted">{t("settings.licenceNote")}</p>
      </Section>
    </div>
  );
}
