import { Workflow } from "lucide-react";
import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { RecentOutputs } from "@/components/RecentOutputs";
import { ToolCard } from "@/components/ToolCard";
import { t } from "@/i18n";
import { useAppStore } from "@/lib/store";
import { chipLabel, filterChips, type CategoryFilter } from "@/tools/categories";
import { toolsInCategory, visibleTools } from "@/tools/registry";
import { cn } from "@/lib/utils";

export function Home() {
  const [params, setParams] = useSearchParams();
  const intelligence = useAppStore((s) => s.intelligenceEnabled);
  const recentRef = useRef<HTMLElement>(null);
  const chips = filterChips(intelligence);
  const requested = params.get("category") as CategoryFilter | null;
  const category: CategoryFilter = requested && chips.includes(requested) ? requested : "all";

  const tools = toolsInCategory(visibleTools({ dev: import.meta.env.DEV, intelligence }), category);

  useEffect(() => {
    if (params.get("view") === "recent") {
      recentRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [params]);

  const select = (chip: CategoryFilter) => {
    setParams(chip === "all" ? {} : { category: chip }, { replace: true });
  };

  return (
    <div className="mx-auto max-w-[1800px] space-y-10 px-6 py-10">
      <section className="text-center">
        <h1 className="text-2xl font-bold tracking-tight">{t("home.headline")}</h1>
        <p className="mx-auto mt-3 max-w-2xl text-base text-text-muted">{t("home.subheading")}</p>
      </section>

      <div className="flex flex-wrap justify-center gap-2" role="toolbar" aria-label="Categories">
        {chips.map((chip) => (
          <button
            key={chip}
            type="button"
            aria-pressed={chip === category}
            onClick={() => select(chip)}
            className={cn(
              "h-9 rounded-full border px-4 text-sm font-medium transition-colors",
              chip === category
                ? "border-primary bg-primary text-primary-foreground"
                : "bg-surface text-text hover:bg-surface-2",
            )}
          >
            {chipLabel(chip)}
          </button>
        ))}
      </div>

      {category === "workflows" ? (
        <div className="mx-auto flex max-w-lg flex-col items-center gap-3 rounded-card border border-dashed p-10 text-center text-text-muted">
          <Workflow className="size-10" aria-hidden />
          <p>{t("home.workflowsEmpty")}</p>
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-4 min-[900px]:grid-cols-3 min-[1200px]:grid-cols-4 min-[1600px]:grid-cols-5">
          {tools.map((tool) => (
            <li key={tool.id}>
              <ToolCard tool={tool} />
            </li>
          ))}
        </ul>
      )}

      <RecentOutputs ref={recentRef} />
    </div>
  );
}
