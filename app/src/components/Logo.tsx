import logoUrl from "@/assets/logo.svg";
import { t } from "@/i18n";

export function Logo() {
  return (
    <span className="flex items-center gap-2">
      <img src={logoUrl} alt="" className="size-8" draggable={false} />
      <span className="text-lg font-semibold tracking-tight text-text">{t("app.name")}</span>
    </span>
  );
}
