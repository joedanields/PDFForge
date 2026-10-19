import { useEffect, useRef, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n";
import type { InputFile } from "@/lib/files";
import { PdfSource, type PageSize } from "@/lib/pdfjs";
import { cn } from "@/lib/utils";

export interface ChangeBox {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Change {
  kind: "added" | "removed" | "changed";
  old: string;
  new: string;
  old_boxes: ChangeBox[];
  new_boxes: ChangeBox[];
}

const COLORS: Record<Change["kind"], string> = {
  added: "#2F9E44",
  removed: "#E03131",
  changed: "#F08C00",
};

const PANE_WIDTH = 460;
const GAP = 12;

interface Pane {
  source: PdfSource;
  sizes: PageSize[];
  urls: (string | null)[];
}

function useDocument(file: InputFile | undefined): Pane | null {
  const [pane, setPane] = useState<Pane | null>(null);
  useEffect(() => {
    if (!file) return;
    const life = { alive: true };
    // A function, so TypeScript does not narrow the flag across the awaits below.
    const cancelled = () => !life.alive;
    let opened: PdfSource | null = null;
    void PdfSource.open(file.path, file.password).then(async (res) => {
      if (res.kind !== "ok") return;
      if (!life.alive) {
        void res.source.destroy();
        return;
      }
      opened = res.source;
      const pages = Array.from({ length: res.source.numPages }, (_, i) => i);
      const sizes = await Promise.all(pages.map((i) => res.source.pageSize(i)));
      if (cancelled()) return;
      setPane({ source: res.source, sizes, urls: pages.map(() => null) });
      for (const i of pages) {
        const url = await res.source.thumbnail(i, PANE_WIDTH);
        if (cancelled()) return;
        setPane((p) => (p ? { ...p, urls: p.urls.map((u, k) => (k === i ? url : u)) } : p));
      }
    });
    return () => {
      life.alive = false;
      void opened?.destroy();
    };
  }, [file]);
  return pane;
}

/** Top offset (px) of page ``index`` in a pane. */
function pageTop(pane: Pane, index: number): number {
  let top = 0;
  for (let i = 0; i < index; i += 1) {
    const s = pane.sizes[i];
    if (s) top += (PANE_WIDTH * s.height) / s.width + GAP;
  }
  return top;
}

/** Compare PDF (02 F5, 04 §2.7): two synchronised panes, highlights and a change list. */
export function CompareView({ files, changes }: { files: InputFile[]; changes: Change[] }) {
  const oldPane = useDocument(files[0]);
  const newPane = useDocument(files[1]);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);
  const [sync, setSync] = useState(true);
  const [pixels, setPixels] = useState(false);
  const [active, setActive] = useState<number | null>(null);

  const mirror = (from: HTMLDivElement | null, to: HTMLDivElement | null) => {
    if (!sync || !from || !to || syncing.current) return;
    syncing.current = true;
    const ratio = from.scrollTop / Math.max(1, from.scrollHeight - from.clientHeight);
    to.scrollTop = ratio * (to.scrollHeight - to.clientHeight);
    requestAnimationFrame(() => {
      syncing.current = false;
    });
  };

  const jump = (n: number) => {
    setActive(n);
    const change = changes[n];
    if (!change) return;
    const scrollTo = (el: HTMLDivElement | null, pane: Pane | null, box: ChangeBox | undefined) => {
      if (!el || !pane || !box) return;
      const size = pane.sizes[box.page];
      if (!size) return;
      const y = pageTop(pane, box.page) + box.y * ((PANE_WIDTH * size.height) / size.width);
      el.scrollTo({ top: Math.max(0, y - 120), behavior: "smooth" });
    };
    syncing.current = true;
    scrollTo(leftRef.current, oldPane, change.old_boxes[0]);
    scrollTo(rightRef.current, newPane, change.new_boxes[0]);
    window.setTimeout(() => {
      syncing.current = false;
    }, 600);
  };

  return (
    <div className="mx-auto mb-6 max-w-[1400px] space-y-3">
      <div className="flex flex-wrap items-center gap-6 rounded-card border bg-surface px-4 py-2 text-sm">
        <span>
          <b style={{ color: COLORS.added }}>●</b> {t("compare.added")}{" "}
          <b style={{ color: COLORS.removed }}>●</b> {t("compare.removed")}{" "}
          <b style={{ color: COLORS.changed }}>●</b> {t("compare.changed")}
        </span>
        <label className="flex items-center gap-2">
          <Switch checked={sync} onCheckedChange={setSync} aria-label={t("compare.sync")} />
          {t("compare.sync")}
        </label>
        <label className="flex items-center gap-2">
          <Switch checked={pixels} onCheckedChange={setPixels} aria-label={t("compare.pixels")} />
          {t("compare.pixels")}
        </label>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_260px] gap-3">
        {[
          { pane: oldPane, ref: leftRef, other: rightRef, side: "old" as const, file: files[0] },
          { pane: newPane, ref: rightRef, other: leftRef, side: "new" as const, file: files[1] },
        ].map(({ pane, ref, other, side, file }) => (
          <section
            key={side}
            aria-label={t(side === "old" ? "compare.oldPane" : "compare.newPane")}
          >
            <p className="mb-1 truncate text-xs font-medium text-text-muted" title={file?.path}>
              {t(side === "old" ? "compare.old" : "compare.new")}: {file?.name}
            </p>
            <div
              ref={ref}
              data-testid={`compare-${side}`}
              onScroll={() => mirror(ref.current, other.current)}
              className="h-[65vh] overflow-auto rounded-card border bg-surface-2 p-3"
            >
              {pane?.sizes.map((size, i) => (
                <PageView
                  key={i}
                  url={pane.urls[i] ?? null}
                  size={size}
                  boxes={changes.flatMap((c, n) =>
                    (side === "old" ? c.old_boxes : c.new_boxes)
                      .filter((b) => b.page === i)
                      .map((b) => ({ ...b, kind: c.kind, n })),
                  )}
                  active={active}
                  diffAgainst={pixels && side === "new" ? (oldPane?.urls[i] ?? null) : null}
                />
              ))}
            </div>
          </section>
        ))}
        <nav
          aria-label={t("compare.changes")}
          className="h-[65vh] overflow-auto rounded-card border bg-surface p-2"
        >
          <p className="px-1 pb-2 text-sm font-semibold">
            {t("compare.changeCount", { count: changes.length })}
          </p>
          {changes.length === 0 && (
            <p className="px-1 text-sm text-text-muted">{t("compare.same")}</p>
          )}
          <ol className="space-y-1">
            {changes.map((c, n) => (
              <li key={n}>
                <button
                  type="button"
                  onClick={() => jump(n)}
                  className={cn(
                    "w-full rounded-md border-l-4 px-2 py-1 text-left text-xs hover:bg-surface-2",
                    active === n && "bg-surface-2",
                  )}
                  style={{ borderColor: COLORS[c.kind] }}
                >
                  {c.old && (
                    <span className="block truncate text-danger line-through">{c.old}</span>
                  )}
                  {c.new && <span className="block truncate text-success">{c.new}</span>}
                </button>
              </li>
            ))}
          </ol>
        </nav>
      </div>
    </div>
  );
}

function PageView({
  url,
  size,
  boxes,
  active,
  diffAgainst,
}: {
  url: string | null;
  size: PageSize;
  boxes: (ChangeBox & { kind: Change["kind"]; n: number })[];
  active: number | null;
  diffAgainst: string | null;
}) {
  const height = (PANE_WIDTH * size.height) / size.width;
  const diff = usePixelDiff(url, diffAgainst);
  return (
    <div className="relative mx-auto mb-3 bg-white shadow-sm" style={{ width: PANE_WIDTH, height }}>
      {url && <img src={url} alt="" className="absolute inset-0 size-full" />}
      {diff && <img src={diff} alt="" className="absolute inset-0 size-full" />}
      {boxes.map((b, k) => (
        <span
          key={k}
          className={cn("absolute rounded-sm border-2", active === b.n && "ring-2 ring-primary")}
          style={{
            left: `${b.x * 100}%`,
            top: `${b.y * 100}%`,
            width: `${b.w * 100}%`,
            height: `${b.h * 100}%`,
            borderColor: COLORS[b.kind],
            background: `${COLORS[b.kind]}22`,
          }}
        />
      ))}
    </div>
  );
}

/** Red overlay where two renderings of a page differ (02 F5 "optional visual diff"). */
function usePixelDiff(a: string | null, b: string | null): string | null {
  const key = a && b ? `${a}|${b}` : null;
  const [result, setResult] = useState<{ key: string; url: string } | null>(null);
  useEffect(() => {
    if (!a || !b || !key) return;
    const life = { alive: true };
    void Promise.all([loadImage(a), loadImage(b)]).then(([ia, ib]) => {
      if (!life.alive) return;
      const url = diffImage(ia, ib);
      if (url) setResult({ key, url });
    });
    return () => {
      life.alive = false;
    };
  }, [a, b, key]);
  return result && result.key === key ? result.url : null;
}

function diffImage(ia: HTMLImageElement, ib: HTMLImageElement): string | null {
  const w = ia.naturalWidth;
  const h = ia.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(ia, 0, 0, w, h);
  const pa = ctx.getImageData(0, 0, w, h);
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(ib, 0, 0, w, h);
  const pb = ctx.getImageData(0, 0, w, h);
  const out = ctx.createImageData(w, h);
  for (let i = 0; i < pa.data.length; i += 4) {
    const delta =
      Math.abs((pa.data[i] ?? 0) - (pb.data[i] ?? 0)) +
      Math.abs((pa.data[i + 1] ?? 0) - (pb.data[i + 1] ?? 0)) +
      Math.abs((pa.data[i + 2] ?? 0) - (pb.data[i + 2] ?? 0));
    if (delta > 60) {
      out.data[i] = 224;
      out.data[i + 1] = 49;
      out.data[i + 2] = 49;
      out.data[i + 3] = 150;
    }
  }
  ctx.putImageData(out, 0, 0);
  return canvas.toDataURL("image/png");
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
