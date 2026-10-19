import { useEffect, useRef, useState } from "react";
import { t } from "@/i18n";
import type { CropBox } from "@/lib/editor";
import type { InputFile } from "@/lib/files";
import { PdfSource, type PageSize } from "@/lib/pdfjs";
import { PageStrip } from "./EditorBoard";

interface Props {
  file: InputFile;
  box: CropBox;
  onBox: (box: CropBox) => void;
  page: number;
  onPage: (page: number) => void;
  /** False in auto-trim mode: the page is shown without a crop frame. */
  showBox: boolean;
  disabled?: boolean;
}

type Drag =
  | { kind: "new"; start: [number, number] }
  | { kind: "move"; start: [number, number]; original: CropBox }
  | { kind: "resize"; corner: Corner; original: CropBox };

type Corner = "tl" | "tr" | "bl" | "br";
const CORNERS: Corner[] = ["tl", "tr", "bl", "br"];
const MIN = 0.03;

const clamp = (v: number) => Math.min(1, Math.max(0, v));

/** Crop PDF (02 E4): draw the area to keep on a page preview. */
export function CropBoard({ file, box, onBox, page, onPage, showBox, disabled = false }: Props) {
  const [source, setSource] = useState<PdfSource | null>(null);
  const [size, setSize] = useState<PageSize | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(560);

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
    const area = areaRef.current;
    if (!area) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(240, Math.min(720, Math.floor(entry.contentRect.width))));
    });
    observer.observe(area);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!source) return;
    let alive = true;
    void source.pageSize(page).then((s) => alive && setSize(s));
    void source.thumbnail(page, width).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [source, page, width]);

  const point = (e: React.PointerEvent): [number, number] => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return [0, 0];
    return [
      clamp((e.clientX - rect.left) / rect.width),
      clamp((e.clientY - rect.top) / rect.height),
    ];
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled || !showBox || e.button !== 0) return;
    svgRef.current?.setPointerCapture(e.pointerId);
    const p = point(e);
    const corner = (e.target as Element).getAttribute("data-handle") as Corner | null;
    if (corner) {
      setDrag({ kind: "resize", corner, original: box });
      return;
    }
    const inside = p[0] > box[0] && p[0] < box[2] && p[1] > box[1] && p[1] < box[3];
    setDrag(inside ? { kind: "move", start: p, original: box } : { kind: "new", start: p });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const p = point(e);
    if (drag.kind === "new") {
      onBox([
        Math.min(drag.start[0], p[0]),
        Math.min(drag.start[1], p[1]),
        Math.max(drag.start[0], p[0]),
        Math.max(drag.start[1], p[1]),
      ]);
    } else if (drag.kind === "move") {
      const [l, tp, r, b] = drag.original;
      const dx = Math.min(1 - r, Math.max(-l, p[0] - drag.start[0]));
      const dy = Math.min(1 - b, Math.max(-tp, p[1] - drag.start[1]));
      onBox([l + dx, tp + dy, r + dx, b + dy]);
    } else {
      let [l, tp, r, b] = drag.original;
      if (drag.corner.includes("l")) l = Math.min(p[0], r - MIN);
      if (drag.corner.includes("r")) r = Math.max(p[0], l + MIN);
      if (drag.corner.startsWith("t")) tp = Math.min(p[1], b - MIN);
      if (drag.corner.startsWith("b")) b = Math.max(p[1], tp + MIN);
      onBox([l, tp, r, b]);
    }
  };

  // Whole page in view: limited by the column width and ~72 % of the window height.
  const shown = size
    ? Math.min(width, (window.innerHeight * 0.72 * size.width) / size.height)
    : width;
  const height = size ? (shown * size.height) / size.width : 0;
  const W = size?.width ?? 1;
  const H = size?.height ?? 1;
  const [l, tp, r, b] = box;

  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-3">
      {source ? <PageStrip source={source} page={page} objects={[]} onSelect={onPage} /> : <div />}
      <div ref={areaRef} className="overflow-auto rounded-card border bg-surface-2 p-4">
        {size && (
          <div className="relative mx-auto bg-white shadow-md" style={{ width: shown, height }}>
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
              aria-label={t("crop.canvas", { page: page + 1 })}
              data-testid="crop-canvas"
              className="absolute inset-0 size-full touch-none select-none"
              viewBox={`0 0 ${W} ${H}`}
              preserveAspectRatio="none"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={() => setDrag(null)}
            >
              {showBox && (
                <>
                  <path
                    d={`M0 0H${W}V${H}H0Z M${l * W} ${tp * H}V${b * H}H${r * W}V${tp * H}Z`}
                    fill="rgba(15,23,42,0.45)"
                    fillRule="evenodd"
                    pointerEvents="none"
                  />
                  <rect
                    x={l * W}
                    y={tp * H}
                    width={(r - l) * W}
                    height={(b - tp) * H}
                    fill="transparent"
                    stroke="#2563eb"
                    strokeWidth={1.5}
                    className="cursor-move"
                  />
                  {CORNERS.map((c) => (
                    <rect
                      key={c}
                      data-handle={c}
                      data-testid={`crop-handle-${c}`}
                      x={(c.includes("l") ? l : r) * W - 6}
                      y={(c.startsWith("t") ? tp : b) * H - 6}
                      width={12}
                      height={12}
                      fill="#2563eb"
                      className={
                        c === "tl" || c === "br" ? "cursor-nwse-resize" : "cursor-nesw-resize"
                      }
                    />
                  ))}
                </>
              )}
            </svg>
          </div>
        )}
      </div>
    </div>
  );
}
