import { Clock, Search, Settings, Workflow } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { EngineStatusPill } from "./EngineStatusPill";
import { Logo } from "./Logo";

interface Props {
  onSearch: () => void;
}

export function TopBar({ onSearch }: Props) {
  const navigate = useNavigate();
  return (
    <header className="sticky top-0 z-40 border-b bg-surface/95 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-[1800px] items-center gap-4 px-6">
        <Link to="/" className="rounded-md" aria-label={t("app.name")}>
          <Logo />
        </Link>
        <button
          type="button"
          onClick={onSearch}
          className="ml-4 flex h-10 w-full max-w-md items-center gap-2 rounded-full border bg-surface-2 px-4 text-left text-text-muted hover:border-text-muted"
        >
          <Search className="size-4" aria-hidden />
          <span className="flex-1">{t("home.searchPlaceholder")}</span>
          <kbd className="rounded border bg-surface px-1.5 text-xs">Ctrl K</kbd>
        </button>
        <div className="ml-auto flex items-center gap-1">
          <EngineStatusPill />
          <Button variant="ghost" size="sm" onClick={() => navigate("/?view=recent")}>
            <Clock aria-hidden />
            {t("nav.recent")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => navigate("/?category=workflows")}>
            <Workflow aria-hidden />
            {t("nav.workflows")}
          </Button>
          <Button variant="ghost" size="icon" aria-label={t("nav.settings")} asChild>
            <Link to="/settings">
              <Settings />
            </Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
