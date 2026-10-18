import { FileText } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import type { InputFile } from "@/lib/files";
import { formatPageSet, parsePageSet } from "@/lib/pageRanges";
import type { PdfSource } from "@/lib/pdfjs";
import { EMPTY_SELECTION, selectAll, type Selection } from "@/lib/selection";
import { formatBytes } from "@/lib/utils";
import { describeOptions } from "@/tools/options";
import type { ToolDef } from "@/tools/registry";
import { ThumbnailGrid, type GridItem } from "./ThumbnailGrid";

interface Props {
  tool: ToolDef;
  file: InputFile;
  options: Record<string, unknown>;
  onOptionsChange: (options: Record<string, unknown>) => void;
  onRemove: () => void;
  disabled: boolean;
}

/** A single PDF shown as a selectable page grid; the selection is the tool's page-range option. */
export function PagesPanel({ tool, file, options, onOptionsChange, onRemove, disabled }: Props) {
  const [source, setSource] = useState<PdfSource | null>(null);
  const [failed, setFailed] = useState(false);
  const [landscape, setLandscape] = useState<boolean[] | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let opened: PdfSource | null = null;
    void import("@/lib/pdfjs")
      .then(({ PdfSource: Source }) => Source.open(file.path, file.password))
      .then((res) => {
        if (res.kind !== "ok") {
          if (alive) setFailed(true);
          return;
        }
        if (!alive) {
          void res.source.destroy();
          return;
        }
        opened = res.source;
        setSource(res.source);
        const indices = Array.from({ length: res.source.numPages }, (_, i) => i);
        void Promise.all(indices.map((i) => res.source.pageSize(i))).then((sizes) => {
          if (alive) setLandscape(sizes.map((s) => s.width > s.height));
        });
      });
    return () => {
      alive = false;
      if (opened) void opened.destroy();
    };
  }, [file.path, file.password]);

  const pageCount = source?.numPages ?? file.pages ?? 0;
  const binding = tool.pageSelection;
  const field = describeOptions(tool.optionsSchema).find((f) => f.key === binding?.option);
  const emptyMeansAll = field?.meta.pages?.emptyMeansAll ?? false;
  const text =
    binding && typeof options[binding.option] === "string"
      ? (options[binding.option] as string)
      : "";
  const selectedIdx = useMemo(
    () => (text.trim() ? (parsePageSet(text, pageCount) ?? new Set<number>()) : new Set<number>()),
    [text, pageCount],
  );
  const selection: Selection = {
    selected: new Set([...selectedIdx].map(String)),
    anchor,
  };
  const allImplied = text.trim() === "" && emptyMeansAll;

  const setSelection = (next: Selection) => {
    if (disabled || !binding) return;
    setAnchor(next.anchor);
    onOptionsChange({
      ...options,
      [binding.option]: formatPageSet([...next.selected].map(Number)),
    });
  };

  const items: GridItem[] = useMemo(
    () =>
      source
        ? Array.from({ length: source.numPages }, (_, i) => ({
            key: String(i),
            source,
            pageIndex: i,
            label: String(i + 1),
            rotation:
              tool.previewRotation?.(options, {
                index: i,
                selected: selectedIdx.has(i),
                allImplied,
                landscape: landscape?.[i] ?? null,
              }) ?? 0,
          }))
        : [],
    [source, tool, options, selectedIdx, allImplied, landscape],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-card border bg-surface p-3">
        <FileText className="size-8 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium" title={file.path}>
            {file.name}
          </p>
          <p className="text-xs text-text-muted">
            {pageCount === 1 ? t("file.page") : t("file.pages", { count: pageCount })} ·{" "}
            {formatBytes(file.size)}
          </p>
        </div>
        {binding && (
          <span className="text-sm text-text-muted" aria-live="polite">
            {selectedIdx.size
              ? t("grid.selectedCount", { count: selectedIdx.size, total: pageCount })
              : t("grid.noneSelected")}
          </span>
        )}
        {binding && (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => setSelection(selectAll(items.map((i) => i.key)))}
            >
              {t("grid.selectAll")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled || selectedIdx.size === 0}
              onClick={() => setSelection(EMPTY_SELECTION)}
            >
              {t("grid.clear")}
            </Button>
          </>
        )}
        <Button size="sm" variant="secondary" disabled={disabled} onClick={onRemove}>
          {t("pages.changeFile")}
        </Button>
      </div>
      {failed ? (
        <p className="text-sm text-danger">{t("file.unreadable")}</p>
      ) : source ? (
        <ThumbnailGrid
          items={items}
          selection={selection}
          onSelectionChange={setSelection}
          ariaLabel={t("grid.label", { name: file.name })}
          tone={binding?.tone ?? "select"}
        />
      ) : (
        <p className="text-sm text-text-muted">{t("pages.loading")}</p>
      )}
    </div>
  );
}
