/**
 * Page thumbnail grid with multi-select (docs/04 §2.5) shared by Rotate, Remove, Extract, Split
 * and Organize: click, Shift-click, Ctrl-click, rubber-band drag-select, keyboard, zoom slider,
 * lazily rendered thumbnails, and (Organize) drag-to-reorder.
 */
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Check, LoaderCircle, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { t } from "@/i18n";
import type { PageSize, PdfSource } from "@/lib/pdfjs";
import {
  EMPTY_SELECTION,
  bandSelect,
  clickSelect,
  selectAll,
  type Selection,
} from "@/lib/selection";
import { cn } from "@/lib/utils";

export interface GridItem {
  key: string;
  /** null for an inserted blank page. */
  source: PdfSource | null;
  pageIndex: number;
  /** Extra clockwise rotation to preview, in degrees. */
  rotation?: number;
  label: string;
  /** Small label in the tile corner (e.g. "File 2"). */
  badge?: string | null;
  /** Size of a blank page (portrait A4 if omitted). */
  blankSize?: PageSize;
}

interface Props {
  items: GridItem[];
  selection: Selection;
  onSelectionChange: (selection: Selection) => void;
  ariaLabel: string;
  /** "remove": selected pages are shown struck out. */
  tone?: "select" | "remove";
  sortable?: boolean;
  onReorder?: (keys: string[]) => void;
  renderActions?: (item: GridItem) => ReactNode;
}

const ZOOM_KEY = "pdfforge.thumbZoom";
const MIN_ZOOM = 96;
const MAX_ZOOM = 320;
const BAND_THRESHOLD = 4;

function initialZoom(): number {
  try {
    const stored = Number(localStorage.getItem(ZOOM_KEY));
    if (stored >= MIN_ZOOM && stored <= MAX_ZOOM) return stored;
  } catch {
    /* storage unavailable */
  }
  return 150;
}

export function ThumbnailGrid({
  items,
  selection,
  onSelectionChange,
  ariaLabel,
  tone = "select",
  sortable = false,
  onReorder,
  renderActions,
}: Props) {
  const [zoom, setZoom] = useState(initialZoom);
  const [band, setBand] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const tileRefs = useRef(new Map<string, HTMLElement>());
  const dragStart = useRef<{ x: number; y: number; ctrl: boolean; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const order = items.map((i) => i.key);

  // Pointer only: Space/Enter stay free for keyboard selection; Organize offers move buttons.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const changeZoom = (value: number) => {
    setZoom(value);
    try {
      localStorage.setItem(ZOOM_KEY, String(value));
    } catch {
      /* storage unavailable */
    }
  };

  const registerTile = useCallback((key: string, el: HTMLElement | null) => {
    if (el) tileRefs.current.set(key, el);
    else tileRefs.current.delete(key);
  }, []);

  // ── rubber-band selection ────────────────────────────────────────────────────────────────
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, input, [data-no-band]")) return;
    // In sortable mode tiles are dragged to reorder, so the band only starts on empty space.
    if (sortable && target.closest("[data-tile]")) return;
    const box = containerRef.current?.getBoundingClientRect();
    if (!box) return;
    dragStart.current = { x: e.clientX, y: e.clientY, ctrl: e.ctrlKey || e.metaKey, moved: false };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const start = dragStart.current;
    if (!start) return;
    if (!start.moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) < BAND_THRESHOLD) {
      return;
    }
    const box = containerRef.current?.getBoundingClientRect();
    if (!box) return;
    if (!start.moved) containerRef.current?.setPointerCapture(e.pointerId);
    start.moved = true;
    setBand({
      x0: start.x - box.left,
      y0: start.y - box.top,
      x1: e.clientX - box.left,
      y1: e.clientY - box.top,
    });
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const start = dragStart.current;
    dragStart.current = null;
    if (!start?.moved || !band) {
      setBand(null);
      return;
    }
    const left = Math.min(start.x, e.clientX);
    const right = Math.max(start.x, e.clientX);
    const top = Math.min(start.y, e.clientY);
    const bottom = Math.max(start.y, e.clientY);
    const hit = order.filter((key) => {
      const r = tileRefs.current.get(key)?.getBoundingClientRect();
      return r && r.left < right && r.right > left && r.top < bottom && r.bottom > top;
    });
    setBand(null);
    suppressClick.current = true; // the pointerup also produces a click on a tile
    onSelectionChange(bandSelect(selection, hit, start.ctrl));
  };

  // ── clicks & keyboard ────────────────────────────────────────────────────────────────────
  const onTileClick = (
    key: string,
    e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  ) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    setFocusKey(key);
    onSelectionChange(
      clickSelect(order, selection, key, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey }),
    );
  };

  const columns = (): number => {
    const tops = [...tileRefs.current.values()].map((el) => el.offsetTop);
    const first = tops[0];
    return Math.max(1, tops.filter((top) => top === first).length);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      onSelectionChange(selectAll(order));
      return;
    }
    if (e.key === "Escape") {
      onSelectionChange(EMPTY_SELECTION);
      return;
    }
    const current = focusKey ?? order[0];
    if (current === undefined) return;
    const index = order.indexOf(current);
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      onSelectionChange(
        clickSelect(order, selection, current, { ctrl: !e.shiftKey, shift: e.shiftKey }),
      );
      return;
    }
    const step: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: columns(),
      ArrowUp: -columns(),
      Home: -index,
      End: order.length - 1 - index,
    };
    const delta = step[e.key];
    if (delta === undefined) return;
    e.preventDefault();
    const next = order[Math.min(order.length - 1, Math.max(0, index + delta))];
    if (next === undefined) return;
    setFocusKey(next);
    tileRefs.current.get(next)?.focus();
    if (e.shiftKey) {
      onSelectionChange(
        clickSelect(order, { ...selection, anchor: selection.anchor ?? current }, next, {
          ctrl: false,
          shift: true,
        }),
      );
    }
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!onReorder || !over || active.id === over.id) return;
    const moving = selection.selected.has(String(active.id))
      ? order.filter((k) => selection.selected.has(k))
      : [String(active.id)];
    const rest = order.filter((k) => !moving.includes(k));
    const overIndex = rest.indexOf(String(over.id));
    const activeIndex = order.indexOf(String(active.id));
    const targetIndex = order.indexOf(String(over.id));
    const insertAt =
      overIndex < 0 ? rest.length : activeIndex < targetIndex ? overIndex + 1 : overIndex;
    onReorder([...rest.slice(0, insertAt), ...moving, ...rest.slice(insertAt)]);
  };

  const tiles = items.map((item) => (
    <Tile
      key={item.key}
      item={item}
      width={zoom}
      selected={selection.selected.has(item.key)}
      focused={focusKey === item.key}
      tone={tone}
      sortable={sortable}
      register={registerTile}
      onClick={(e) => onTileClick(item.key, e)}
      onFocus={() => setFocusKey(item.key)}
      actions={renderActions?.(item)}
    />
  ));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-text-muted">
        <span>{t("grid.hint")}</span>
        <label className="flex items-center gap-2">
          {t("grid.zoom")}
          <input
            type="range"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={8}
            value={zoom}
            onChange={(e) => changeZoom(Number(e.target.value))}
            className="w-32 accent-[hsl(var(--primary))]"
          />
        </label>
      </div>
      <div
        ref={containerRef}
        role="listbox"
        aria-multiselectable="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={onKeyDown}
        className="relative grid select-none gap-4 rounded-card border bg-surface-2/40 p-4"
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${zoom}px, 1fr))` }}
      >
        {sortable ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={order} strategy={rectSortingStrategy}>
              {tiles}
            </SortableContext>
          </DndContext>
        ) : (
          tiles
        )}
        {band && <BandOverlay band={band} />}
      </div>
    </div>
  );
}

/** Rubber band, in coordinates relative to the grid container. */
function BandOverlay({ band }: { band: { x0: number; y0: number; x1: number; y1: number } }) {
  const style: CSSProperties = {
    left: Math.min(band.x0, band.x1),
    top: Math.min(band.y0, band.y1),
    width: Math.abs(band.x1 - band.x0),
    height: Math.abs(band.y1 - band.y0),
  };
  return (
    <div
      className="pointer-events-none absolute z-20 rounded-sm border border-primary bg-primary/10"
      style={style}
      aria-hidden
    />
  );
}

interface TileProps {
  item: GridItem;
  width: number;
  selected: boolean;
  focused: boolean;
  tone: "select" | "remove";
  sortable: boolean;
  register: (key: string, el: HTMLElement | null) => void;
  onClick: (e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => void;
  onFocus: () => void;
  actions?: ReactNode;
}

function Tile(props: TileProps) {
  return props.sortable ? <SortableTile {...props} /> : <TileBody {...props} />;
}

function SortableTile(props: TileProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.item.key,
  });
  const style: CSSProperties = { transform: CSS.Transform.toString(transform), transition };
  return (
    <TileBody
      {...props}
      dragRef={setNodeRef}
      dragStyle={style}
      dragging={isDragging}
      dragProps={{ ...attributes, ...listeners }}
    />
  );
}

function TileBody({
  item,
  width,
  selected,
  focused,
  tone,
  register,
  onClick,
  onFocus,
  actions,
  dragRef,
  dragStyle,
  dragging,
  dragProps,
}: TileProps & {
  dragRef?: (el: HTMLElement | null) => void;
  dragStyle?: CSSProperties;
  dragging?: boolean;
  dragProps?: Record<string, unknown>;
}) {
  const setRef = (el: HTMLDivElement | null) => {
    register(item.key, el);
    dragRef?.(el);
  };
  const remove = tone === "remove" && selected;
  return (
    <div
      // dnd-kit's attributes come first: the tile keeps its listbox role and roving tabIndex.
      {...dragProps}
      ref={setRef}
      data-tile
      role="option"
      aria-selected={selected}
      aria-label={t("grid.page", { label: item.label })}
      tabIndex={focused ? 0 : -1}
      onClick={onClick}
      onFocus={onFocus}
      style={dragStyle}
      className={cn(
        "group relative flex cursor-pointer flex-col items-center gap-2 rounded-card p-2 outline-none transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring",
        selected
          ? remove
            ? "bg-danger/10 ring-2 ring-danger"
            : "bg-primary/10 ring-2 ring-primary"
          : "hover:bg-surface-2",
        dragging && "z-30 opacity-80 shadow-xl",
      )}
    >
      <PageImage item={item} width={width} dimmed={remove} />
      <span className="text-xs font-medium text-text-muted">{item.label}</span>
      {item.badge && (
        <span className="absolute bottom-8 left-3 rounded-full bg-surface/95 px-2 py-0.5 text-xs font-medium text-text shadow">
          {item.badge}
        </span>
      )}
      {selected && (
        <span
          className={cn(
            "absolute right-3 top-3 flex size-6 items-center justify-center rounded-full text-primary-foreground shadow",
            remove ? "bg-danger" : "bg-primary",
          )}
          aria-hidden
        >
          {remove ? <X className="size-4" /> : <Check className="size-4" />}
        </span>
      )}
      {actions && (
        <div
          data-no-band
          className="absolute bottom-8 left-1/2 flex -translate-x-1/2 gap-1 rounded-md bg-surface/95 p-1 opacity-0 shadow transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
        >
          {actions}
        </div>
      )}
    </div>
  );
}

function PageImage({ item, width, dimmed }: { item: GridItem; width: number; dimmed: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  // Without IntersectionObserver (tests, old WebView) render everything immediately.
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const boxWidth = width;
  const boxHeight = Math.round(width * 1.3);
  const rotation = (((item.rotation ?? 0) % 360) + 360) % 360;
  const sideways = rotation === 90 || rotation === 270;

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "300px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !item.source) return;
    let cancelled = false;
    item.source
      .thumbnail(item.pageIndex, width)
      .then((u) => {
        if (!cancelled) setUrl(u);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, item.source, item.pageIndex, width]);

  const blank = item.source === null;
  const blankRatio = item.blankSize ? item.blankSize.width / item.blankSize.height : 1 / 1.414;

  return (
    <div
      ref={ref}
      className="flex items-center justify-center"
      style={{ width: boxWidth, height: boxHeight }}
    >
      {blank ? (
        <div
          className="border bg-white shadow"
          style={{
            width: blankRatio <= 1 ? boxHeight * blankRatio * 0.9 : boxWidth * 0.9,
            height: blankRatio <= 1 ? boxHeight * 0.9 : (boxWidth * 0.9) / blankRatio,
            transform: `rotate(${rotation}deg)`,
          }}
        />
      ) : url ? (
        <img
          src={url}
          alt=""
          draggable={false}
          className={cn(
            "bg-white object-contain shadow transition-transform duration-200",
            dimmed && "opacity-40",
          )}
          style={{
            maxWidth: sideways ? boxHeight : boxWidth,
            maxHeight: sideways ? boxWidth : boxHeight,
            transform: `rotate(${rotation}deg)`,
          }}
        />
      ) : failed ? (
        <span className="text-xs text-text-muted">{t("grid.noPreview")}</span>
      ) : (
        <LoaderCircle className="size-5 animate-spin text-text-muted" aria-hidden />
      )}
    </div>
  );
}
