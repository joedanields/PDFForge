import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FolderOpen,
  PanelLeft,
  Search,
  Wand2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import "pdfjs-dist/web/pdf_viewer.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import { loadViewer, openDocument } from "@/lib/pdfjs";
import { fileName } from "@/lib/utils";
import { chooseAndView } from "@/lib/viewer";
import { TOOLS } from "@/tools/registry";

type Viewer = InstanceType<Awaited<ReturnType<typeof loadViewer>>["PDFViewer"]>;
type Bus = InstanceType<Awaited<ReturnType<typeof loadViewer>>["EventBus"]>;

const ZOOMS = [
  { value: "page-width", label: "Fit width" },
  { value: "page-fit", label: "Fit page" },
  { value: "0.5", label: "50%" },
  { value: "0.75", label: "75%" },
  { value: "1", label: "100%" },
  { value: "1.25", label: "125%" },
  { value: "1.5", label: "150%" },
  { value: "2", label: "200%" },
  { value: "3", label: "300%" },
] as const;

type LoadState =
  | { kind: "loading" }
  | { kind: "locked"; wrongPassword: boolean }
  | { kind: "error" }
  | { kind: "ready"; doc: PDFDocumentProxy };

/** Built-in viewer (docs/02 §J, 04 §2.6): continuous pages, thumbnails, zoom, find. */
export function ViewerPage() {
  const [params] = useSearchParams();
  const path = params.get("path") ?? "";
  const navigate = useNavigate();
  if (!path) {
    return (
      <div className="mx-auto flex max-w-lg flex-col items-center gap-4 px-6 py-20 text-center">
        <h1 className="text-xl font-semibold">{t("viewer.title")}</h1>
        <p className="text-text-muted">{t("viewer.empty")}</p>
        <Button onClick={() => void chooseAndView(navigate)}>
          <FolderOpen aria-hidden />
          {t("viewer.open")}
        </Button>
      </div>
    );
  }
  return <DocumentLoader key={path} path={path} />;
}

function DocumentLoader({ path }: { path: string }) {
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [password, setPassword] = useState<string | undefined>(undefined);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    let alive = true;
    let opened: PDFDocumentProxy | null = null;
    void openDocument(path, password).then((res) => {
      if (!alive) {
        if (res.kind === "ok") void res.doc.destroy();
        return;
      }
      if (res.kind === "ok") opened = res.doc;
      setState(res.kind === "ok" ? { kind: "ready", doc: res.doc } : res);
    });
    return () => {
      alive = false;
      if (opened) void opened.destroy();
    };
  }, [path, password]);

  if (state.kind === "ready") {
    return <DocumentView doc={state.doc} path={path} />;
  }
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-4 px-6 py-20 text-center">
      {state.kind === "loading" && <p className="text-text-muted">{t("viewer.loading")}</p>}
      {state.kind === "error" && (
        <>
          <p className="text-danger" role="alert">
            {t("viewer.error", { name: fileName(path) })}
          </p>
          <Button variant="secondary" onClick={() => void chooseAndView(navigate)}>
            {t("viewer.openOther")}
          </Button>
        </>
      )}
      {state.kind === "locked" && (
        <form
          className="flex w-full flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setState({ kind: "loading" });
            setPassword(typed);
          }}
        >
          <p>{t("viewer.locked", { name: fileName(path) })}</p>
          <Input
            type="password"
            aria-label={t("viewer.password")}
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          {state.wrongPassword && (
            <p className="text-sm text-danger" role="alert">
              {t("file.wrongPassword")}
            </p>
          )}
          <Button type="submit">{t("viewer.unlockView")}</Button>
        </form>
      )}
    </div>
  );
}

function DocumentView({ doc, path }: { doc: PDFDocumentProxy; path: string }) {
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const busRef = useRef<Bus | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [zoom, setZoom] = useState<string>("page-width");
  const [scalePercent, setScalePercent] = useState(100);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<{ current: number; total: number } | null>(null);
  const [sidebar, setSidebar] = useState(true);
  const [toolsOpen, setToolsOpen] = useState(false);

  useEffect(() => {
    let disposed = false;
    void loadViewer().then((lib) => {
      const container = containerRef.current;
      if (disposed || !container) return;
      const eventBus = new lib.EventBus();
      const linkService = new lib.PDFLinkService({ eventBus });
      const findController = new lib.PDFFindController({ eventBus, linkService });
      const viewer = new lib.PDFViewer({
        container,
        eventBus,
        linkService,
        findController,
        removePageBorders: false,
      });
      linkService.setViewer(viewer);
      eventBus.on("pagesinit", () => {
        viewer.currentScaleValue = "page-width";
      });
      eventBus.on("pagechanging", (e: { pageNumber: number }) => {
        setPage(e.pageNumber);
        setPageInput(String(e.pageNumber));
      });
      eventBus.on("scalechanging", (e: { scale: number }) => {
        setScalePercent(Math.round(e.scale * 100));
      });
      eventBus.on(
        "updatefindmatchescount",
        (e: { matchesCount: { current: number; total: number } }) => setMatches(e.matchesCount),
      );
      eventBus.on(
        "updatefindcontrolstate",
        (e: { matchesCount: { current: number; total: number } }) => setMatches(e.matchesCount),
      );
      viewer.setDocument(doc);
      linkService.setDocument(doc, null);
      viewerRef.current = viewer;
      busRef.current = eventBus;
    });
    return () => {
      disposed = true;
      viewerRef.current?.setDocument(null as unknown as PDFDocumentProxy);
      viewerRef.current = null;
    };
  }, [doc]);

  const goTo = (n: number) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const target = Math.min(doc.numPages, Math.max(1, n));
    viewer.currentPageNumber = target;
  };

  const setScale = (value: string) => {
    setZoom(value);
    if (viewerRef.current) viewerRef.current.currentScaleValue = value;
  };

  const step = (factor: number) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const next = Math.min(5, Math.max(0.25, viewer.currentScale * factor));
    viewer.currentScale = next;
    setZoom(String(next));
  };

  const find = (again: boolean, previous = false) => {
    busRef.current?.dispatch("find", {
      source: null,
      type: again ? "again" : "",
      query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: previous,
      matchDiacritics: false,
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.ctrlKey && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        step(1.25);
      } else if (e.ctrlKey && e.key === "-") {
        e.preventDefault();
        step(0.8);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const pdfTools = useMemo(
    () =>
      TOOLS.filter(
        (tool) =>
          tool.status === "available" && !tool.devOnly && tool.accepts.extensions.includes("pdf"),
      ).sort((a, b) => a.name.localeCompare(b.name)),
    [],
  );

  const zoomLabel = ZOOMS.some((z) => z.value === zoom) ? zoom : "custom";

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b bg-surface px-4 py-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("viewer.thumbnails")}
          aria-pressed={sidebar}
          onClick={() => setSidebar((s) => !s)}
        >
          <PanelLeft />
        </Button>
        <span className="max-w-[260px] truncate font-medium" title={path}>
          {fileName(path)}
        </span>
        <div className="mx-2 flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("viewer.prevPage")}
            disabled={page <= 1}
            onClick={() => goTo(page - 1)}
          >
            <ChevronLeft />
          </Button>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              goTo(Number(pageInput) || 1);
            }}
          >
            <Input
              aria-label={t("viewer.pageNumber")}
              className="h-8 w-14 text-center"
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ""))}
            />
          </form>
          <span className="text-sm text-text-muted">/ {doc.numPages}</span>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("viewer.nextPage")}
            disabled={page >= doc.numPages}
            onClick={() => goTo(page + 1)}
          >
            <ChevronRight />
          </Button>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("viewer.zoomOut")}
            onClick={() => step(0.8)}
          >
            <ZoomOut />
          </Button>
          <select
            aria-label={t("viewer.zoom")}
            className="h-8 rounded-md border bg-surface px-2 text-sm"
            value={zoomLabel}
            onChange={(e) => setScale(e.target.value)}
          >
            {zoomLabel === "custom" && <option value="custom">{scalePercent}%</option>}
            {ZOOMS.map((z) => (
              <option key={z.value} value={z.value}>
                {z.label}
              </option>
            ))}
          </select>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("viewer.zoomIn")}
            onClick={() => step(1.25)}
          >
            <ZoomIn />
          </Button>
        </div>
        <form
          className="ml-auto flex items-center gap-1"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            find(true);
          }}
        >
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2 top-2 size-4 text-text-muted"
              aria-hidden
            />
            <Input
              ref={searchRef}
              aria-label={t("viewer.search")}
              placeholder={t("viewer.searchPlaceholder")}
              className="h-8 w-56 pl-8"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setMatches(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && e.shiftKey) {
                  e.preventDefault();
                  find(true, true);
                }
              }}
            />
          </div>
          <span className="min-w-[72px] text-xs text-text-muted" aria-live="polite">
            {query && matches
              ? matches.total
                ? t("viewer.matches", { current: matches.current, total: matches.total })
                : t("viewer.noMatches")
              : ""}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("viewer.prevMatch")}
            disabled={!query}
            onClick={() => find(true, true)}
          >
            <ChevronUp />
          </Button>
          <Button
            type="submit"
            variant="ghost"
            size="icon"
            aria-label={t("viewer.nextMatch")}
            disabled={!query}
          >
            <ChevronDown />
          </Button>
        </form>
        <div className="relative">
          <Button variant="secondary" size="sm" onClick={() => setToolsOpen((o) => !o)}>
            <Wand2 aria-hidden />
            {t("viewer.useInTool")}
          </Button>
          {toolsOpen && (
            <ul
              className="absolute right-0 z-50 mt-1 max-h-96 w-64 overflow-auto rounded-md border bg-surface py-1 shadow-lg"
              aria-label={t("viewer.useInTool")}
            >
              {pdfTools.map((tool) => (
                <li key={tool.id}>
                  <button
                    type="button"
                    className="w-full px-3 py-1.5 text-left text-sm hover:bg-surface-2"
                    onClick={() => navigate(`/tool/${tool.id}`, { state: { preload: [path] } })}
                  >
                    {tool.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("viewer.openOther")}
          onClick={() => void chooseAndView(navigate)}
        >
          <FolderOpen />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1">
        {sidebar && <Thumbnails doc={doc} current={page} onSelect={goTo} />}
        <div className="relative min-w-0 flex-1 bg-surface-2">
          <div
            ref={containerRef}
            className="absolute inset-0 overflow-auto"
            data-testid="viewer-container"
          >
            <div className="pdfViewer" />
          </div>
        </div>
      </div>
    </div>
  );
}

function Thumbnails({
  doc,
  current,
  onSelect,
}: {
  doc: PDFDocumentProxy;
  current: number;
  onSelect: (page: number) => void;
}) {
  const pages = Array.from({ length: doc.numPages }, (_, i) => i + 1);
  return (
    <nav
      aria-label={t("viewer.thumbnails")}
      className="w-40 shrink-0 overflow-y-auto border-r bg-surface p-3"
    >
      <ol className="space-y-3">
        {pages.map((n) => (
          <li key={n}>
            <button
              type="button"
              aria-label={t("viewer.goToPage", { page: n })}
              aria-current={n === current ? "page" : undefined}
              onClick={() => onSelect(n)}
              className={
                "block w-full rounded-md border-2 p-1 " +
                (n === current ? "border-primary" : "border-transparent hover:border-border")
              }
            >
              <Thumb doc={doc} page={n} />
              <span className="mt-1 block text-center text-xs text-text-muted">{n}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function Thumb({ doc, page }: { doc: PDFDocumentProxy; page: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      observer.disconnect();
      void doc.getPage(page).then((p) => {
        if (cancelled) return;
        const base = p.getViewport({ scale: 1 });
        const viewport = p.getViewport({ scale: (120 * window.devicePixelRatio) / base.width });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext("2d");
        if (!context) return;
        const render = p.render({ canvasContext: context, viewport });
        task = render;
        render.promise.catch(() => undefined);
      });
    });
    observer.observe(canvas);
    return () => {
      cancelled = true;
      observer.disconnect();
      task?.cancel();
    };
  }, [doc, page]);
  return <canvas ref={ref} className="h-auto w-full bg-white shadow-sm" />;
}
