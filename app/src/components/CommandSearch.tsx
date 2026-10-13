import { Command } from "cmdk";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { CATEGORY_META } from "@/tools/categories";
import { searchTools, visibleTools } from "@/tools/registry";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Ctrl+K tool search (docs/02 §J, 04 §2.1). */
export function CommandSearch({ open, onOpenChange }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle className="sr-only">{t("nav.search")}</DialogTitle>
        {/* Mounted only while open, so the query resets every time. */}
        <SearchBody onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function SearchBody({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const intelligence = useAppStore((s) => s.intelligenceEnabled);
  const [query, setQuery] = useState("");
  const results = useMemo(
    () => searchTools(query, visibleTools({ dev: import.meta.env.DEV, intelligence })),
    [query, intelligence],
  );

  return (
    <Command shouldFilter={false} label={t("nav.search")}>
      <div className="flex items-center gap-2 border-b px-4">
        <Search className="size-4 text-text-muted" aria-hidden />
        <Command.Input
          value={query}
          onValueChange={setQuery}
          placeholder={t("home.searchPlaceholder")}
          className="h-12 w-full bg-transparent text-base outline-none placeholder:text-text-muted"
        />
      </div>
      <Command.List className="max-h-96 overflow-y-auto p-2">
        <Command.Empty className="p-6 text-center text-text-muted">
          {t("home.noResults", { query })}
        </Command.Empty>
        {results.map((tool) => {
          const Icon = tool.icon;
          const soon = tool.status !== "available";
          return (
            <Command.Item
              key={tool.id}
              value={tool.id}
              disabled={soon}
              onSelect={() => {
                onClose();
                navigate(`/tool/${tool.id}`);
              }}
              className={cn(
                "flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 data-[selected=true]:bg-surface-2",
                soon && "cursor-default opacity-60",
              )}
            >
              <span
                className={cn(
                  "flex size-8 items-center justify-center rounded-md",
                  CATEGORY_META[tool.category].iconClass,
                )}
              >
                <Icon className="size-4" aria-hidden />
              </span>
              <span className="flex-1">
                <span className="block font-medium">{tool.name}</span>
                <span className="block truncate text-xs text-text-muted">{tool.description}</span>
              </span>
              {soon && <Badge variant="soon">{t("badge.comingSoon")}</Badge>}
            </Command.Item>
          );
        })}
      </Command.List>
    </Command>
  );
}
