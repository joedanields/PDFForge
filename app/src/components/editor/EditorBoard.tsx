import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  ArrowUpRight,
  Circle,
  Eraser,
  Highlighter,
  ImagePlus,
  Minus,
  MousePointer2,
  PenLine,
  Redo2,
  Square,
  StickyNote,
  Trash2,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, isTauri } from "@/engine/client";
import { t } from "@/i18n";
import {
  boxFrom,
  bounds,
  DEFAULT_STYLE,
  type EditObject,
  type EditTool,
  EMPTY_HISTORY,
  HIGHLIGHT_STYLE,
  historyReducer,
  hitTest,
  isBoxKind,
  moved,
  newId,
  resized,
  simplify,
  type Style,
} from "@/lib/editor";
import type { InputFile } from "@/lib/files";
import { PdfSource, type PageSize } from "@/lib/pdfjs";
import { cn, extension } from "@/lib/utils";

const PREVIEW_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

const TOOLS: { id: EditTool; label: string; icon: ReactNode }[] = [
  { id: "select", label: "Select and move", icon: <MousePointer2 /> },
  { id: "text", label: "Text box", icon: <Type /> },
  { id: "image", label: "Picture", icon: <ImagePlus /> },
  { id: "rect", label: "Rectangle", icon: <Square /> },
  { id: "ellipse", label: "Ellipse", icon: <Circle /> },
  { id: "line", label: "Line", icon: <Minus /> },
  { id: "arrow", label: "Arrow", icon: <ArrowUpRight /> },
  { id: "ink", label: "Pen", icon: <PenLine /> },
  { id: "highlight", label: "Highlighter", icon: <Highlighter /> },
  { id: "note", label: "Note", icon: <StickyNote /> },
  { id: "eraser", label: "Eraser (removes added objects)", icon: <Eraser /> },
];

const FONT_CSS: Record<Style["font"], string> = {
  helvetica: "Arial, Helvetica, sans-serif",
  times: "'Times New Roman', Times, serif",
  courier: "'Courier New', Courier, monospace",
};

interface Props {
  file: InputFile;
  disabled?: boolean;
  /** Called with the current objects after every change. */
  onChange: (objects: EditObject[]) => void;
  /** Extra tools (Sign) and the tool list to show. */
  tools?: EditTool[];
  /** Objects to place on the next click (Sign: a saved signature). */
  stamp?: Omit<EditObject, "id" | "page" | "x" | "y"> | null;
  onStampPlaced?: () => void;
}

type Drag =
  | { kind: "create"; tool: EditTool; start: [number, number]; current: [number, number] }
  | { kind: "draw"; tool: "ink" | "highlight"; points: [number, number][] }
  | { kind: "move"; id: string; start: [number, number]; original: EditObject }
  | { kind: "resize"; id: string; start: [number, number]; original: EditObject };

/** Page editor (docs/04 §2.6): thumbnails, page canvas with added objects, properties. */
export function EditorBoard({
  file,
  disabled = false,
  onChange,
  tools,
  stamp,
  onStampPlaced,
}: Props) {
  const [source, setSource] = useState<PdfSource | null>(null);
  const [page, setPage] = useState(0);
  const [tool, setTool] = useState<EditTool>("select");
  const [zoom, setZoom] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [style, setStyle] = useState<Style>(DEFAULT_STYLE);
  const [pendingImage, setPendingImage] = useState<{
    path: string;
    url: string;
    ratio: number;
  } | null>(null);
  const [history, dispatch] = useReducer(historyReducer, { ...EMPTY_HISTORY, pending: null });
  const objects = history.present;
  const areaRef = useRef<HTMLDivElement>(null);
  const [areaWidth, setAreaWidth] = useState(640);

  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setAreaWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(area);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let alive = true;
    let opened: PdfSource | null = null;
    void PdfSource.open(file.path, file.password).then((res) => {
      if (res.kind !== "ok") return;
      if (!alive) {
        void res.source.destroy();
        return;
      }
      opened = res.source;
      setSource(res.source);
    });
    return () => {
      alive = false;
      void opened?.destroy();
    };
  }, [file.path, file.password]);

  useEffect(() => {
    onChange(objects);
  }, [objects, onChange]);

  const selectedObject = objects.find((o) => o.id === selected) ?? null;

  const update = useCallback(
    (id: string, patch: Partial<EditObject>) => {
      dispatch({
        type: "set",
        objects: objects.map((o) => (o.id === id ? { ...o, ...patch } : o)),
      });
    },
    [objects],
  );

  const remove = useCallback(
    (id: string) => {
      dispatch({ type: "set", objects: objects.filter((o) => o.id !== id) });
      setSelected(null);
    },
    [objects],
  );

  // Keyboard: Delete, Ctrl+Z / Ctrl+Y, Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing =
        e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.ctrlKey && e.key.toLowerCase() === "z" && !typing) {
        e.preventDefault();
        dispatch({ type: e.shiftKey ? "redo" : "undo" });
      } else if (e.ctrlKey && e.key.toLowerCase() === "y" && !typing) {
        e.preventDefault();
        dispatch({ type: "redo" });
      } else if ((e.key === "Delete" || e.key === "Backspace") && selected && !typing) {
        e.preventDefault();
        remove(selected);
      } else if (e.key === "Escape") {
        setSelected(null);
        setTool("select");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [remove, selected]);

  const chooseImage = async () => {
    if (!isTauri()) return;
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "Pictures", extensions: Object.keys(PREVIEW_TYPES) }],
    });
    if (typeof picked !== "string") {
      setTool("select");
      return;
    }
    const url = await imageUrl(picked);
    const ratio = await imageRatio(url);
    setPendingImage({ path: picked, url, ratio });
  };

  const pickTool = (next: EditTool) => {
    setTool(next);
    setSelected(null);
    if (next === "image") void chooseImage();
  };

  const visibleTools = TOOLS.filter((x) => !tools || tools.includes(x.id));

  return (
    <div className="flex flex-col gap-3">
      <div
        role="toolbar"
        aria-label={t("editor.tools")}
        className="flex flex-wrap items-center gap-1 rounded-card border bg-surface p-2"
      >
        {visibleTools.map((x) => (
          <Button
            key={x.id}
            size="icon"
            variant={tool === x.id ? "primary" : "ghost"}
            aria-label={x.label}
            aria-pressed={tool === x.id}
            title={x.label}
            disabled={disabled}
            onClick={() => pickTool(x.id)}
          >
            {x.icon}
          </Button>
        ))}
        <span className="mx-2 h-6 w-px bg-border" aria-hidden />
        <Button
          size="icon"
          variant="ghost"
          aria-label={t("editor.undo")}
          disabled={disabled || history.past.length === 0}
          onClick={() => dispatch({ type: "undo" })}
        >
          <Undo2 />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label={t("editor.redo")}
          disabled={disabled || history.future.length === 0}
          onClick={() => dispatch({ type: "redo" })}
        >
          <Redo2 />
        </Button>
        <span className="mx-2 h-6 w-px bg-border" aria-hidden />
        <Button
          size="icon"
          variant="ghost"
          aria-label={t("viewer.zoomOut")}
          onClick={() => setZoom((z) => Math.max(0.5, z / 1.25))}
        >
          <ZoomOut />
        </Button>
        <span className="w-12 text-center text-xs text-text-muted">{Math.round(zoom * 100)}%</span>
        <Button
          size="icon"
          variant="ghost"
          aria-label={t("viewer.zoomIn")}
          onClick={() => setZoom((z) => Math.min(4, z * 1.25))}
        >
          <ZoomIn />
        </Button>
        <span className="ml-auto text-xs text-text-muted">
          {t("editor.objectCount", { count: objects.length })}
        </span>
      </div>
      <div className="grid grid-cols-[96px_minmax(0,1fr)_200px] gap-3">
        {source ? (
          <PageStrip source={source} page={page} objects={objects} onSelect={setPage} />
        ) : (
          <div />
        )}
        <div
          ref={areaRef}
          className="max-h-[75vh] min-h-[60vh] overflow-auto rounded-card border bg-surface-2 p-4"
        >
          {source && (
            <PageCanvas
              source={source}
              page={page}
              zoom={zoom}
              fitWidth={areaWidth}
              tool={tool}
              style={style}
              objects={objects}
              selected={selected}
              disabled={disabled}
              pendingImage={pendingImage}
              stamp={stamp ?? null}
              onSelect={setSelected}
              onCommit={(next, newSelection) => {
                dispatch({ type: "set", objects: next });
                if (newSelection !== undefined) setSelected(newSelection);
              }}
              onPreview={(next) => dispatch({ type: "preview", objects: next })}
              onEndPreview={() => dispatch({ type: "commit" })}
              onImagePlaced={() => {
                setPendingImage(null);
                setTool("select");
              }}
              onStampPlaced={() => {
                setTool("select");
                onStampPlaced?.();
              }}
              onErase={remove}
              onToolDone={(next) => setTool(next)}
            />
          )}
        </div>
        <Properties
          object={selectedObject}
          style={style}
          disabled={disabled}
          onStyle={(patch) => {
            setStyle((s) => ({ ...s, ...patch }));
            if (selectedObject) update(selectedObject.id, patch);
          }}
          onText={(text) => selectedObject && update(selectedObject.id, { text })}
          onDelete={() => selectedObject && remove(selectedObject.id)}
        />
      </div>
    </div>
  );
}

async function imageUrl(path: string): Promise<string> {
  const bytes = await api.readInputFile(path);
  const type = PREVIEW_TYPES[extension(path)] ?? "application/octet-stream";
  return URL.createObjectURL(new Blob([bytes], { type }));
}

function imageRatio(url: string): Promise<number> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalHeight / Math.max(1, img.naturalWidth));
    img.onerror = () => resolve(1);
    img.src = url;
  });
}

// ── page strip ────────────────────────────────────────────────────────────────────────────

export function PageStrip({
  source,
  page,
  objects,
  onSelect,
}: {
  source: PdfSource;
  page: number;
  objects: EditObject[];
  onSelect: (page: number) => void;
}) {
  const counts = useMemo(() => {
    const map = new Map<number, number>();
    for (const o of objects) map.set(o.page, (map.get(o.page) ?? 0) + 1);
    return map;
  }, [objects]);
  return (
    <nav
      aria-label={t("viewer.thumbnails")}
      className="max-h-[70vh] space-y-2 overflow-y-auto pr-1"
    >
      {Array.from({ length: source.numPages }, (_, i) => (
        <button
          key={i}
          type="button"
          aria-label={t("viewer.goToPage", { page: i + 1 })}
          aria-current={i === page ? "page" : undefined}
          onClick={() => onSelect(i)}
          className={cn(
            "relative block w-full rounded-md border-2 bg-white p-0.5",
            i === page ? "border-primary" : "border-transparent hover:border-border",
          )}
        >
          <StripThumb source={source} index={i} />
          <span className="block text-center text-xs text-text-muted">{i + 1}</span>
          {(counts.get(i) ?? 0) > 0 && (
            <span className="absolute right-1 top-1 rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">
              {counts.get(i)}
            </span>
          )}
        </button>
      ))}
    </nav>
  );
}

function StripThumb({ source, index }: { source: PdfSource; index: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void source.thumbnail(index, 88).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [source, index]);
  return url ? <img src={url} alt="" className="w-full" /> : <div className="aspect-[3/4]" />;
}

// ── page canvas ───────────────────────────────────────────────────────────────────────────

interface CanvasProps {
  source: PdfSource;
  page: number;
  zoom: number;
  /** Width available for the page at 100 % zoom (CSS px). */
  fitWidth: number;
  tool: EditTool;
  style: Style;
  objects: EditObject[];
  selected: string | null;
  disabled: boolean;
  pendingImage: { path: string; url: string; ratio: number } | null;
  stamp: Omit<EditObject, "id" | "page" | "x" | "y"> | null;
  onSelect: (id: string | null) => void;
  onCommit: (objects: EditObject[], selection?: string | null) => void;
  onPreview: (objects: EditObject[]) => void;
  onEndPreview: () => void;
  onImagePlaced: () => void;
  onStampPlaced: () => void;
  onErase: (id: string) => void;
  onToolDone: (tool: EditTool) => void;
}

function PageCanvas(props: CanvasProps) {
  const { source, page, zoom, fitWidth, tool, style, objects, selected, disabled } = props;
  const [size, setSize] = useState<PageSize | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const baseWidth = Math.max(240, fitWidth);

  useEffect(() => {
    let alive = true;
    void source.pageSize(page).then((s) => alive && setSize(s));
    void source.thumbnail(page, baseWidth * zoom).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [source, page, zoom, baseWidth]);

  if (!size) return null;
  const width = baseWidth * zoom;
  const height = (width * size.height) / size.width;

  const fraction = (e: React.PointerEvent): [number, number] => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return [0, 0];
    return [
      Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    ];
  };

  const base = (kind: EditObject["kind"]): EditObject => ({
    ...style,
    ...(kind === "highlight" ? HIGHLIGHT_STYLE : {}),
    ...(kind === "text" ? { stroke: style.stroke ?? "#1F2933", fill: style.fill } : {}),
    ...(kind === "note" ? { fill: "#FFD43B" } : {}),
    id: newId(),
    page,
    kind,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    points: [],
    text: "",
  });

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled || e.button !== 0) return;
    const p = fraction(e);
    svgRef.current?.setPointerCapture(e.pointerId);
    if (props.stamp) {
      const w = props.stamp.w;
      // Picture stamps carry their height relative to the page width (keeps the aspect).
      const h =
        props.stamp.kind === "image" ? (props.stamp.h * size.width) / size.height : props.stamp.h;
      const placed: EditObject = {
        ...props.stamp,
        id: newId(),
        page,
        h,
        x: Math.min(1 - w, Math.max(0, p[0] - w / 2)),
        y: Math.min(1 - h, Math.max(0, p[1] - h / 2)),
      };
      props.onCommit([...objects, placed], placed.id);
      props.onStampPlaced();
      return;
    }
    if (tool === "eraser") {
      const hit = hitTest(objects, page, p);
      if (hit) props.onErase(hit.id);
      return;
    }
    if (tool === "select") {
      const handle = (e.target as Element).getAttribute("data-handle");
      if (handle && selected) {
        const original = objects.find((o) => o.id === selected);
        if (original) setDrag({ kind: "resize", id: selected, start: p, original });
        return;
      }
      const hit = hitTest(objects, page, p);
      props.onSelect(hit?.id ?? null);
      if (hit) setDrag({ kind: "move", id: hit.id, start: p, original: hit });
      return;
    }
    if (tool === "note") {
      const note = { ...base("note"), x: Math.min(p[0], 0.97), y: Math.min(p[1], 0.97) };
      props.onCommit([...objects, note], note.id);
      props.onToolDone("select");
      return;
    }
    if (tool === "ink" || tool === "highlight") {
      setDrag({ kind: "draw", tool, points: [p] });
      return;
    }
    if (tool === "image" && !props.pendingImage) return;
    setDrag({ kind: "create", tool, start: p, current: p });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const p = fraction(e);
    if (drag.kind === "create") setDrag({ ...drag, current: p });
    else if (drag.kind === "draw") setDrag({ ...drag, points: [...drag.points, p] });
    else {
      const dx = p[0] - drag.start[0];
      const dy = p[1] - drag.start[1];
      const next =
        drag.kind === "move"
          ? moved(drag.original, dx, dy)
          : resized(
              drag.original,
              drag.original.w + dx,
              drag.original.h + dy,
              drag.original.kind === "image",
            );
      props.onPreview(objects.map((o) => (o.id === drag.id ? next : o)));
    }
  };

  const onPointerUp = () => {
    if (!drag) return;
    setDrag(null);
    if (drag.kind === "move" || drag.kind === "resize") {
      props.onEndPreview();
      return;
    }
    if (drag.kind === "draw") {
      const points = simplify(drag.points);
      if (points.length >= 2) {
        const stroke = { ...base(drag.tool), points };
        props.onCommit([...objects, stroke]);
      }
      return;
    }
    const kind = drag.tool as EditObject["kind"];
    if (kind === "line" || kind === "arrow") {
      if (Math.hypot(drag.current[0] - drag.start[0], drag.current[1] - drag.start[1]) < 0.01)
        return;
      const line = { ...base(kind), points: [drag.start, drag.current] as [number, number][] };
      props.onCommit([...objects, line], line.id);
      return;
    }
    let box = boxFrom(drag.start, drag.current);
    const tiny = box.w < 0.01 || box.h < 0.01;
    if (kind === "image" && props.pendingImage) {
      const aspect = (props.pendingImage.ratio * size.width) / size.height;
      const w = tiny ? 0.3 : box.w;
      box = { x: box.x, y: box.y, w: Math.min(w, 1 - box.x), h: Math.min(w * aspect, 1 - box.y) };
      const image = {
        ...base("image"),
        ...box,
        stroke: null,
        image: props.pendingImage.path,
        imageUrl: props.pendingImage.url,
      };
      props.onCommit([...objects, image], image.id);
      props.onImagePlaced();
      return;
    }
    if (kind === "text" && tiny) {
      box = { x: box.x, y: box.y, w: Math.min(0.4, 1 - box.x), h: Math.min(0.06, 1 - box.y) };
    } else if (tiny) {
      return;
    }
    const created = { ...base(kind), ...box };
    props.onCommit([...objects, created], created.id);
    if (kind === "text") props.onToolDone("select");
  };

  const live =
    drag?.kind === "create"
      ? drag.tool === "line" || drag.tool === "arrow"
        ? {
            ...base(drag.tool),
            id: "live",
            points: [drag.start, drag.current],
          }
        : {
            ...base(drag.tool as EditObject["kind"]),
            id: "live",
            ...boxFrom(drag.start, drag.current),
          }
      : drag?.kind === "draw"
        ? { ...base(drag.tool), id: "live", points: drag.points }
        : null;

  const pageObjects = objects.filter((o) => o.page === page);
  const sel = pageObjects.find((o) => o.id === selected);

  return (
    <div className="relative mx-auto bg-white shadow-md" style={{ width, height }}>
      {url && (
        <img
          src={url}
          alt=""
          className="absolute inset-0 size-full select-none"
          draggable={false}
        />
      )}
      <svg
        ref={svgRef}
        role="application"
        aria-label={t("editor.canvas", { page: page + 1 })}
        data-testid="editor-canvas"
        className={cn(
          "absolute inset-0 size-full touch-none select-none",
          tool !== "select" && "cursor-crosshair",
        )}
        viewBox={`0 0 ${size.width} ${size.height}`}
        preserveAspectRatio="none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {pageObjects.map((o) => (
          <Shape key={o.id} obj={o} size={size} />
        ))}
        {live && <Shape obj={live} size={size} />}
        {sel && <Selection obj={sel} size={size} />}
      </svg>
    </div>
  );
}

function Shape({ obj, size }: { obj: EditObject; size: PageSize }) {
  const W = size.width;
  const H = size.height;
  const common = {
    stroke: obj.stroke ?? "none",
    strokeWidth: obj.width,
    fill: obj.fill ?? "none",
    opacity: obj.opacity,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (obj.kind) {
    case "rect":
      return <rect x={obj.x * W} y={obj.y * H} width={obj.w * W} height={obj.h * H} {...common} />;
    case "ellipse":
      return (
        <ellipse
          cx={(obj.x + obj.w / 2) * W}
          cy={(obj.y + obj.h / 2) * H}
          rx={(obj.w / 2) * W}
          ry={(obj.h / 2) * H}
          {...common}
        />
      );
    case "line":
    case "arrow": {
      const [a, b] = obj.points;
      if (!a || !b) return null;
      const angle = Math.atan2((b[1] - a[1]) * H, (b[0] - a[0]) * W);
      const len = Math.max(8, obj.width * 4);
      const head = [angle - 0.44, angle + 0.44]
        .map((t) => `${b[0] * W - len * Math.cos(t)},${b[1] * H - len * Math.sin(t)}`)
        .join(" ");
      return (
        <g opacity={obj.opacity}>
          <line
            x1={a[0] * W}
            y1={a[1] * H}
            x2={b[0] * W}
            y2={b[1] * H}
            stroke={obj.stroke ?? "#000"}
            strokeWidth={obj.width}
            strokeLinecap="round"
          />
          {obj.kind === "arrow" && (
            <polygon points={`${b[0] * W},${b[1] * H} ${head}`} fill={obj.stroke ?? "#000"} />
          )}
        </g>
      );
    }
    case "ink":
    case "highlight":
      return (
        <polyline
          points={obj.points.map(([x, y]) => `${x * W},${y * H}`).join(" ")}
          {...common}
          fill="none"
          style={obj.kind === "highlight" ? { mixBlendMode: "multiply" } : undefined}
        />
      );
    case "text":
      return (
        <foreignObject
          x={obj.x * W}
          y={obj.y * H}
          width={obj.w * W}
          height={obj.h * H}
          opacity={obj.opacity}
        >
          <div
            style={{
              fontFamily: FONT_CSS[obj.font],
              fontSize: obj.size,
              lineHeight: 1.2,
              fontWeight: obj.bold ? 700 : 400,
              fontStyle: obj.italic ? "italic" : "normal",
              textAlign: obj.align,
              color: obj.stroke ?? "#000",
              background: obj.fill ?? "transparent",
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              width: "100%",
              minHeight: "100%",
              outline: obj.text ? "none" : "1px dashed #94a3b8",
            }}
          >
            {obj.text}
          </div>
        </foreignObject>
      );
    case "image":
      return obj.imageUrl ? (
        <image
          href={obj.imageUrl}
          x={obj.x * W}
          y={obj.y * H}
          width={obj.w * W}
          height={obj.h * H}
          preserveAspectRatio="none"
          opacity={obj.opacity}
        />
      ) : null;
    case "note":
      return (
        <g transform={`translate(${obj.x * W},${obj.y * H})`}>
          <rect width={16} height={16} rx={2} fill={obj.fill ?? "#FFD43B"} stroke="#8a6d00" />
          <path d="M4 5h8M4 8h8M4 11h5" stroke="#5c4800" strokeWidth={1} />
        </g>
      );
  }
}

function Selection({ obj, size }: { obj: EditObject; size: PageSize }) {
  const b = bounds(obj);
  const W = size.width;
  const H = size.height;
  const pad = 3;
  return (
    <g>
      <rect
        x={b.x * W - pad}
        y={b.y * H - pad}
        width={b.w * W + pad * 2}
        height={b.h * H + pad * 2}
        fill="none"
        stroke="#2563eb"
        strokeDasharray="4 3"
        strokeWidth={1}
        pointerEvents="none"
      />
      {isBoxKind(obj.kind) && (
        <rect
          data-handle="resize"
          aria-label="Resize"
          x={(b.x + b.w) * W - 4}
          y={(b.y + b.h) * H - 4}
          width={8}
          height={8}
          fill="#2563eb"
          className="cursor-nwse-resize"
        />
      )}
    </g>
  );
}

// ── properties ────────────────────────────────────────────────────────────────────────────

function Properties({
  object,
  style,
  disabled,
  onStyle,
  onText,
  onDelete,
}: {
  object: EditObject | null;
  style: Style;
  disabled: boolean;
  onStyle: (patch: Partial<Style>) => void;
  onText: (text: string) => void;
  onDelete: () => void;
}) {
  const current: Style = object ?? style;
  const kind = object?.kind;
  const showText = kind === "text" || kind === "note";
  const showFont = !object || kind === "text";
  const showFill = !object || kind === "rect" || kind === "ellipse" || kind === "text";
  return (
    <aside
      aria-label={t("editor.properties")}
      className="space-y-4 rounded-card border bg-surface p-3 text-sm"
    >
      <p className="font-medium">
        {object ? t(`editor.kind.${object.kind}`) : t("editor.newObjects")}
      </p>
      {showText && (
        <div className="space-y-1">
          <Label htmlFor="edit-text">{t("editor.text")}</Label>
          <textarea
            id="edit-text"
            className="h-24 w-full rounded-md border bg-surface p-2"
            value={object?.text ?? ""}
            disabled={disabled}
            autoFocus
            onChange={(e) => onText(e.target.value)}
          />
        </div>
      )}
      <ColorRow
        label={kind === "text" ? t("editor.textColour") : t("editor.colour")}
        value={current.stroke}
        allowNone={kind !== "text"}
        disabled={disabled}
        onChange={(stroke) => onStyle({ stroke })}
      />
      {showFill && (
        <ColorRow
          label={kind === "text" ? t("editor.background") : t("editor.fill")}
          value={current.fill}
          allowNone
          disabled={disabled}
          onChange={(fill) => onStyle({ fill })}
        />
      )}
      {kind !== "text" && kind !== "image" && kind !== "note" && (
        <div className="space-y-1">
          <Label htmlFor="edit-width">{t("editor.lineWidth", { width: current.width })}</Label>
          <input
            id="edit-width"
            type="range"
            min={0.5}
            max={24}
            step={0.5}
            value={current.width}
            disabled={disabled}
            onChange={(e) => onStyle({ width: Number(e.target.value) })}
            className="w-full"
          />
        </div>
      )}
      <div className="space-y-1">
        <Label htmlFor="edit-opacity">
          {t("editor.opacity", { percent: Math.round(current.opacity * 100) })}
        </Label>
        <input
          id="edit-opacity"
          type="range"
          min={0.1}
          max={1}
          step={0.05}
          value={current.opacity}
          disabled={disabled}
          onChange={(e) => onStyle({ opacity: Number(e.target.value) })}
          className="w-full"
        />
      </div>
      {showFont && (
        <div className="space-y-2">
          <Label htmlFor="edit-font">{t("editor.font")}</Label>
          <select
            id="edit-font"
            className="h-8 w-full rounded-md border bg-surface px-2"
            value={current.font}
            disabled={disabled}
            onChange={(e) => onStyle({ font: e.target.value as Style["font"] })}
          >
            <option value="helvetica">Sans serif</option>
            <option value="times">Serif</option>
            <option value="courier">Monospace</option>
          </select>
          <div className="flex items-center gap-2">
            <Input
              aria-label={t("editor.fontSize")}
              type="number"
              min={4}
              max={200}
              className="h-8 w-16"
              value={current.size}
              disabled={disabled}
              onChange={(e) =>
                onStyle({ size: Math.max(4, Math.min(200, Number(e.target.value) || 12)) })
              }
            />
            <Button
              size="sm"
              variant={current.bold ? "primary" : "secondary"}
              aria-pressed={current.bold}
              aria-label={t("editor.bold")}
              disabled={disabled}
              onClick={() => onStyle({ bold: !current.bold })}
            >
              B
            </Button>
            <Button
              size="sm"
              variant={current.italic ? "primary" : "secondary"}
              aria-pressed={current.italic}
              aria-label={t("editor.italic")}
              disabled={disabled}
              onClick={() => onStyle({ italic: !current.italic })}
            >
              <i>I</i>
            </Button>
          </div>
        </div>
      )}
      {object && (
        <Button
          variant="secondary"
          size="sm"
          className="w-full"
          disabled={disabled}
          onClick={onDelete}
        >
          <Trash2 aria-hidden />
          {t("editor.delete")}
        </Button>
      )}
    </aside>
  );
}

const SWATCHES = ["#1F2933", "#E03131", "#1C7ED6", "#2F9E44", "#F08C00", "#FFFFFF"];

function ColorRow({
  label,
  value,
  allowNone,
  disabled,
  onChange,
}: {
  label: string;
  value: string | null;
  allowNone: boolean;
  disabled: boolean;
  onChange: (value: string | null) => void;
}) {
  return (
    <fieldset className="space-y-1">
      <legend className="text-sm font-medium">{label}</legend>
      <div className="flex flex-wrap items-center gap-1">
        {allowNone && (
          <button
            type="button"
            aria-label={`${label}: none`}
            aria-pressed={value === null}
            disabled={disabled}
            onClick={() => onChange(null)}
            className={cn(
              "size-6 rounded-full border bg-[linear-gradient(45deg,transparent_45%,#e03131_45%,#e03131_55%,transparent_55%)]",
              value === null && "ring-2 ring-primary",
            )}
          />
        )}
        {SWATCHES.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`${label}: ${c}`}
            aria-pressed={value?.toUpperCase() === c}
            disabled={disabled}
            onClick={() => onChange(c)}
            className={cn(
              "size-6 rounded-full border",
              value?.toUpperCase() === c && "ring-2 ring-primary",
            )}
            style={{ background: c }}
          />
        ))}
        <input
          type="color"
          aria-label={`${label}: custom`}
          value={value ?? "#000000"}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          className="size-6 cursor-pointer rounded border-0 bg-transparent p-0"
        />
      </div>
    </fieldset>
  );
}
