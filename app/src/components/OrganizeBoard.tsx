/**
 * Organize PDF board (docs/02 A5, 04 §2.5): pages of one or more PDFs on one sortable grid.
 * Drag to reorder; rotate, delete, duplicate, insert blank pages or another PDF's pages;
 * undo/redo with Ctrl+Z / Ctrl+Y.
 */
import {
  ArrowLeft,
  ArrowRight,
  Copy,
  FilePlus,
  FolderPlus,
  Redo2,
  RotateCcw,
  RotateCw,
  Trash,
  Undo2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import type { InputFile } from "@/lib/files";
import {
  A4,
  deletePages,
  duplicatePages,
  historyOf,
  insertBlank,
  insertPages,
  movePage,
  pagesOf,
  record,
  redo,
  removeFilePages,
  reorderPages,
  rotatePages,
  toPlan,
  undo,
  type BoardPage,
  type History,
  type PageSize,
  type PlanEntry,
} from "@/lib/organize";
import type { PdfSource } from "@/lib/pdfjs";
import { EMPTY_SELECTION, pruneSelection, type Selection } from "@/lib/selection";
import { cn } from "@/lib/utils";
import { ThumbnailGrid, type GridItem } from "./ThumbnailGrid";

export interface OrganizePlan {
  inputs: string[];
  pages: PlanEntry[];
}

interface Props {
  files: InputFile[];
  disabled: boolean;
  onPlanChange: (plan: OrganizePlan) => void;
  onAddFiles: () => void;
  onRemoveFile: (key: string) => void;
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function OrganizeBoard({ files, disabled, onPlanChange, onAddFiles, onRemoveFile }: Props) {
  const [history, setHistory] = useState<History<BoardPage[]>>(() => historyOf([]));
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [sources, setSources] = useState<ReadonlyMap<string, PdfSource>>(new Map());
  const sizes = useRef(new Map<string, PageSize>());
  const opening = useRef(new Set<string>());
  const selectionRef = useRef(selection);
  // Mounted flag (not per effect run): StrictMode re-runs effects, and a file whose document
  // is already opening must not be dropped by the first run's cleanup.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const sourcesRef = useRef(sources);
  useEffect(() => {
    selectionRef.current = selection;
    sourcesRef.current = sources;
  });
  const board = history.present;

  const change = useCallback((update: (board: BoardPage[]) => BoardPage[]) => {
    setHistory((h) => record(h, update(h.present)));
  }, []);

  // Open newly ready files and put their pages on the board (after the selection, if any).
  const ready = files.filter((f) => f.status === "ready");
  const readyKey = ready.map((f) => `${f.key}:${f.password ?? ""}`).join("|");
  useEffect(() => {
    for (const file of ready) {
      if (opening.current.has(file.key)) continue;
      opening.current.add(file.key);
      void import("@/lib/pdfjs")
        .then(({ PdfSource: Source }) => Source.open(file.path, file.password))
        .then(async (res) => {
          if (res.kind !== "ok") return;
          if (!mounted.current) {
            void res.source.destroy();
            return;
          }
          const source = res.source;
          setSources((prev) => new Map(prev).set(file.key, source));
          const n = source.numPages;
          setHistory((h) => {
            const selected = h.present.filter((p) => selectionRef.current.selected.has(p.key));
            const after = selected[selected.length - 1]?.key ?? null;
            const next = insertPages(h.present, after, pagesOf(file.key, n));
            // The very first file is the starting point, not an undoable step.
            return h.present.length === 0 && h.past.length === 0
              ? historyOf(next)
              : record(h, next);
          });
          const all = await Promise.all(Array.from({ length: n }, (_, i) => source.pageSize(i)));
          all.forEach((size, i) => sizes.current.set(`${file.key}:${i}`, size));
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run only when the ready set changes
  }, [readyKey]);

  // Files removed by the user: drop their pages and close their documents.
  const fileKeys = files.map((f) => f.key).join("|");
  useEffect(() => {
    const present = new Set(files.map((f) => f.key));
    for (const [key, source] of sourcesRef.current) {
      if (present.has(key)) continue;
      opening.current.delete(key);
      void source.destroy();
      setSources((prev) => {
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
      setHistory((h) => record(h, removeFilePages(h.present, key)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the file list only
  }, [fileKeys]);

  useEffect(
    () => () => {
      for (const source of sourcesRef.current.values()) void source.destroy();
    },
    [],
  );

  // Report the engine plan whenever the board changes.
  const paths = useMemo(() => new Map(files.map((f) => [f.key, f.path])), [files]);
  useEffect(() => {
    onPlanChange(toPlan(board, paths));
  }, [board, paths, onPlanChange]);

  // Keep the selection valid after deletions / undo.
  const order = board.map((p) => p.key);
  const validSelection = pruneSelection(order, selection);

  // ── actions ───────────────────────────────────────────────────────────────────────────────
  const selectedKeys = validSelection.selected;
  const hasSelection = selectedKeys.size > 0;
  const lastSelected = board.filter((p) => selectedKeys.has(p.key)).at(-1)?.key ?? null;

  const sizeNear = (key: string | null): PageSize => {
    const page = board.find((p) => p.key === key) ?? board.at(-1);
    if (!page) return A4;
    if (page.blank) return page.blank;
    return sizes.current.get(`${page.fileKey ?? ""}:${page.page}`) ?? A4;
  };

  const actions = {
    rotate: (delta: number, keys: ReadonlySet<string> = selectedKeys) =>
      change((b) => rotatePages(b, keys, delta)),
    remove: (keys: ReadonlySet<string> = selectedKeys) => {
      change((b) => deletePages(b, keys));
      setSelection(EMPTY_SELECTION);
    },
    duplicate: () => {
      const result = duplicatePages(board, selectedKeys);
      change(() => result.board);
      setSelection({ selected: new Set(result.copies), anchor: result.copies[0] ?? null });
    },
    blank: () => {
      const result = insertBlank(board, lastSelected, sizeNear(lastSelected));
      change(() => result.board);
      setSelection({ selected: new Set([result.key]), anchor: result.key });
    },
    undo: () => setHistory(undo),
    redo: () => setHistory(redo),
  };

  // Ctrl+Z / Ctrl+Y / Delete (not while typing in a field).
  const actionsRef = useRef(actions);
  useEffect(() => {
    actionsRef.current = actions;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (disabled) return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const key = e.key.toLowerCase();
      if (e.ctrlKey && key === "z" && !e.shiftKey) {
        e.preventDefault();
        actionsRef.current.undo();
      } else if (e.ctrlKey && (key === "y" || (key === "z" && e.shiftKey))) {
        e.preventDefault();
        actionsRef.current.redo();
      } else if (e.key === "Delete" && selectionRef.current.selected.size > 0) {
        e.preventDefault();
        actionsRef.current.remove(selectionRef.current.selected);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [disabled]);

  // ── rendering ─────────────────────────────────────────────────────────────────────────────
  const usedFiles = ready.filter((f) => board.some((p) => p.fileKey === f.key));
  const letters = new Map(ready.map((f, i) => [f.key, LETTERS[i % LETTERS.length] ?? "?"]));
  const multi = ready.length > 1;
  const items: GridItem[] = board.map((p) => ({
    key: p.key,
    source: p.fileKey ? (sources.get(p.fileKey) ?? null) : null,
    pageIndex: p.page,
    rotation: p.rotation,
    label:
      p.fileKey === null
        ? t("organize.blank")
        : `${multi ? (letters.get(p.fileKey) ?? "") : ""}${p.page + 1}`,
    blankSize: p.blank,
  }));

  const stop = (fn: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  const one = (key: string) => new Set([key]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2" aria-label={t("organize.files")}>
        {ready.map((f) => (
          <span
            key={f.key}
            className="flex items-center gap-2 rounded-full border bg-surface py-1 pl-3 pr-1 text-sm"
          >
            {multi && (
              <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                {letters.get(f.key)}
              </span>
            )}
            <span className="max-w-60 truncate" title={f.path}>
              {f.name}
            </span>
            <Button
              size="icon"
              variant="ghost"
              className="size-6"
              aria-label={t("file.remove", { name: f.name })}
              disabled={disabled}
              onClick={() => onRemoveFile(f.key)}
            >
              <X />
            </Button>
          </span>
        ))}
      </div>

      <div
        role="toolbar"
        aria-label={t("organize.toolbar")}
        className="flex flex-wrap items-center gap-1 rounded-card border bg-surface p-2"
      >
        <ToolButton
          icon={RotateCcw}
          label={t("organize.rotateLeft")}
          disabled={disabled || !hasSelection}
          onClick={() => actions.rotate(-90)}
        />
        <ToolButton
          icon={RotateCw}
          label={t("organize.rotateRight")}
          disabled={disabled || !hasSelection}
          onClick={() => actions.rotate(90)}
        />
        <ToolButton
          icon={Copy}
          label={t("organize.duplicate")}
          disabled={disabled || !hasSelection}
          onClick={actions.duplicate}
        />
        <ToolButton
          icon={Trash}
          label={t("organize.delete")}
          disabled={disabled || !hasSelection}
          onClick={() => actions.remove()}
        />
        <span className="mx-1 h-6 w-px bg-border" aria-hidden />
        <ToolButton
          icon={FilePlus}
          label={t("organize.blankPage")}
          disabled={disabled}
          onClick={actions.blank}
        />
        <ToolButton
          icon={FolderPlus}
          label={t("organize.addPdf")}
          disabled={disabled}
          onClick={onAddFiles}
        />
        <span className="mx-1 h-6 w-px bg-border" aria-hidden />
        <ToolButton
          icon={Undo2}
          label={t("organize.undo")}
          disabled={disabled || history.past.length === 0}
          onClick={actions.undo}
        />
        <ToolButton
          icon={Redo2}
          label={t("organize.redo")}
          disabled={disabled || history.future.length === 0}
          onClick={actions.redo}
        />
        <span className="ml-auto pr-2 text-sm text-text-muted" aria-live="polite">
          {hasSelection
            ? t("grid.selectedCount", { count: selectedKeys.size, total: board.length })
            : t("organize.pageCount", { count: board.length, files: usedFiles.length })}
        </span>
      </div>

      <ThumbnailGrid
        items={items}
        selection={validSelection}
        onSelectionChange={disabled ? () => undefined : setSelection}
        ariaLabel={t("organize.board")}
        sortable={!disabled}
        onReorder={(keys) => change((b) => reorderPages(b, keys))}
        renderActions={(item) =>
          disabled ? null : (
            <>
              <TileButton
                icon={ArrowLeft}
                label={t("organize.moveLeft", { label: item.label })}
                onClick={stop(() => change((b) => movePage(b, item.key, -1)))}
              />
              <TileButton
                icon={RotateCcw}
                label={t("organize.rotateLeftOne", { label: item.label })}
                onClick={stop(() => actions.rotate(-90, one(item.key)))}
              />
              <TileButton
                icon={RotateCw}
                label={t("organize.rotateRightOne", { label: item.label })}
                onClick={stop(() => actions.rotate(90, one(item.key)))}
              />
              <TileButton
                icon={Trash}
                label={t("organize.deleteOne", { label: item.label })}
                onClick={stop(() => actions.remove(one(item.key)))}
                danger
              />
              <TileButton
                icon={ArrowRight}
                label={t("organize.moveRight", { label: item.label })}
                onClick={stop(() => change((b) => movePage(b, item.key, 1)))}
              />
            </>
          )
        }
      />
    </div>
  );
}

function ToolButton({
  icon: Icon,
  label,
  disabled,
  onClick,
}: {
  icon: typeof RotateCw;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button size="sm" variant="ghost" disabled={disabled} onClick={onClick}>
      <Icon aria-hidden />
      {label}
    </Button>
  );
}

function TileButton({
  icon: Icon,
  label,
  onClick,
  danger = false,
}: {
  icon: typeof RotateCw;
  label: string;
  onClick: (e: MouseEvent) => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      onPointerDown={(e) => e.stopPropagation()}
      className={cn(
        "flex size-7 items-center justify-center rounded text-text-muted hover:bg-surface-2 hover:text-text",
        danger && "hover:text-danger",
      )}
    >
      <Icon className="size-4" aria-hidden />
    </button>
  );
}
