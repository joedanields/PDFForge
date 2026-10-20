import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { t, tx } from "@/i18n";
import { CATEGORY_META } from "@/tools/categories";
import type { ToolDef } from "@/tools/registry";
import { cn } from "@/lib/utils";

export function ToolCard({ tool }: { tool: ToolDef }) {
  const Icon = tool.icon;
  const available = tool.status === "available";
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span
          className={cn(
            "flex size-11 items-center justify-center rounded-card",
            CATEGORY_META[tool.category].iconClass,
          )}
        >
          <Icon className="size-6" aria-hidden />
        </span>
        {!available && <Badge variant="soon">{t("badge.comingSoon")}</Badge>}
      </div>
      <h3 className="mt-4 text-base font-semibold text-text">{tx(tool.name)}</h3>
      <p className="mt-1 line-clamp-2 text-sm text-text-muted">{tx(tool.description)}</p>
    </>
  );
  const base = "block h-full rounded-card border bg-surface p-5 text-left";
  if (!available) {
    return (
      <div
        className={cn(base, "opacity-70")}
        aria-disabled="true"
        tabIndex={0}
        title={t("tool.comingSoonBody", { phase: tool.phase })}
      >
        {body}
      </div>
    );
  }
  return (
    <Link
      to={`/tool/${tool.id}`}
      className={cn(
        base,
        "transition-[transform,box-shadow] hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg",
      )}
    >
      {body}
    </Link>
  );
}
