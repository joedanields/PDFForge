import { open } from "@tauri-apps/plugin-dialog";
import { ArrowLeft, CircleAlert, Copy, Info } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { DropZone } from "@/components/DropZone";
import { FileList } from "@/components/FileList";
import { OptionsForm } from "@/components/OptionsForm";
import { OutputFolderPicker } from "@/components/OutputFolderPicker";
import { OrganizeBoard, type OrganizePlan } from "@/components/OrganizeBoard";
import { PagesPanel } from "@/components/PagesPanel";
import { ProgressOverlay } from "@/components/ProgressOverlay";
import { ResultCard } from "@/components/ResultCard";
import { Button } from "@/components/ui/button";
import { JobError, api, isTauri, runJob, type RunningJob } from "@/engine/client";
import { ERROR_TEXT, type DoneEvent, type ErrorEvent } from "@/engine/types";
import { t } from "@/i18n";
import { fileKey, sortByDate, sortByName, type InputFile } from "@/lib/files";
import { parsePageSet } from "@/lib/pageRanges";
import { useAppStore } from "@/lib/store";
import { useFileDrop } from "@/lib/useFileDrop";
import { cn, fileName } from "@/lib/utils";
import { CATEGORY_META } from "@/tools/categories";
import {
  defaultOptions,
  confirmError,
  describeOptions,
  isVisible,
  pageFieldError,
  splitSecrets,
} from "@/tools/options";
import { acceptsFile, getTool, type ToolDef } from "@/tools/registry";

export function ToolPage() {
  const { toolId } = useParams();
  const tool = getTool(toolId ?? "");

  if (!tool) {
    return (
      <PageShell title="Not found">
        <p className="text-text-muted">This tool doesn't exist.</p>
      </PageShell>
    );
  }
  if (tool.status !== "available" || !tool.engineMethod) {
    return (
      <PageShell tool={tool} title={tool.name}>
        <div className="mx-auto max-w-lg rounded-card border border-dashed p-10 text-center">
          <h2 className="text-lg font-semibold">
            {t("tool.comingSoonTitle", { name: tool.name })}
          </h2>
          <p className="mt-2 text-text-muted">{t("tool.comingSoonBody", { phase: tool.phase })}</p>
        </div>
      </PageShell>
    );
  }
  return <ToolRunner key={tool.id} tool={tool} />;
}

function PageShell({
  tool,
  title,
  children,
}: {
  tool?: ToolDef;
  title: string;
  children: React.ReactNode;
}) {
  const Icon = tool?.icon;
  return (
    <div className="mx-auto max-w-[1600px] px-6 py-6">
      <div className="mb-6 flex items-center gap-3">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/">
            <ArrowLeft aria-hidden />
            {t("nav.back")}
          </Link>
        </Button>
        {tool && Icon && (
          <span
            className={cn(
              "flex size-9 items-center justify-center rounded-md",
              CATEGORY_META[tool.category].iconClass,
            )}
          >
            <Icon className="size-5" aria-hidden />
          </span>
        )}
        <h1 className="text-lg font-semibold">{title}</h1>
      </div>
      {children}
    </div>
  );
}

type Phase =
  | { kind: "edit" }
  | {
      kind: "running";
      percent: number;
      message: string;
      startedAt: number;
      cancelling: boolean;
    }
  | { kind: "done"; result: DoneEvent };

interface Notice {
  tone: "info" | "danger";
  text: string;
  details?: string;
}

function ToolRunner({ tool }: { tool: ToolDef }) {
  const settings = useAppStore((s) => s.settings);
  const [files, setFiles] = useState<InputFile[]>([]);
  const [options, setOptions] = useState(() => defaultOptions(tool.optionsSchema));
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "edit" });
  const [notice, setNotice] = useState<Notice | null>(null);
  const jobRef = useRef<RunningJob | null>(null);
  const filesRef = useRef(files);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);
  const needsFiles = tool.accepts.max > 0;
  const pageTool = tool.layout === "pages";
  const organizeTool = tool.layout === "organize";
  const [organizePlan, setOrganizePlan] = useState<OrganizePlan | null>(null);
  const editing = phase.kind === "edit";

  const patchFile = useCallback((key: string, patch: Partial<InputFile>) => {
    setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, ...patch } : f)));
  }, []);

  const loadPreview = useCallback(
    async (file: InputFile, password?: string) => {
      // pdf.js is loaded on first use to keep app start-up light (docs/05 P1).
      const { preview } = await import("@/lib/pdfjs");
      const res = await preview(file.path, password);
      if (res.kind === "ok") {
        patchFile(file.key, {
          status: "ready",
          pages: res.pages,
          thumbnail: res.thumbnail,
          password,
          error: undefined,
        });
      } else if (res.kind === "locked") {
        patchFile(file.key, {
          status: "locked",
          password: undefined,
          error: res.wrongPassword ? t("file.wrongPassword") : undefined,
        });
      } else {
        patchFile(file.key, { status: "error", error: t("file.unreadable") });
      }
    },
    [patchFile],
  );

  const addPaths = useCallback(
    async (paths: string[]) => {
      if (!editing) return;
      const accepted = paths.filter((p) => acceptsFile(tool, p));
      const rejected = paths.filter((p) => !acceptsFile(tool, p));
      const room = tool.accepts.max - filesRef.current.length;
      const taken = accepted.slice(0, Math.max(0, room));
      setNotice(
        rejected.length > 0
          ? {
              tone: "danger",
              text: t("tool.rejected", { names: rejected.map(fileName).join(", ") }),
            }
          : accepted.length > taken.length
            ? { tone: "danger", text: t("tool.tooMany", { count: tool.accepts.max }) }
            : null,
      );
      if (taken.length === 0) return;
      const stats = isTauri() ? await api.fileStats(taken) : [];
      const added: InputFile[] = taken.map((path, i) => ({
        key: fileKey(),
        path,
        name: stats[i]?.name ?? fileName(path),
        size: stats[i]?.size ?? null,
        modified: stats[i]?.modified ?? null,
        status: "loading",
        pages: null,
        thumbnail: null,
      }));
      setFiles((prev) => [...prev, ...added]);
      for (const file of added) void loadPreview(file);
    },
    [editing, loadPreview, tool],
  );

  const over = useFileDrop((paths) => void addPaths(paths), needsFiles && editing);

  // E2E seam (dev builds only): native drag-drop and file dialogs can't be automated over CDP.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const onTestFiles = (e: Event) => void addPaths((e as CustomEvent<string[]>).detail);
    window.addEventListener("pdfforge:test-add-files", onTestFiles);
    return () => window.removeEventListener("pdfforge:test-add-files", onTestFiles);
  }, [addPaths]);

  // Files handed over by another tool (e.g. Merge result → "Protect this file").
  const location = useLocation();
  const navigate = useNavigate();
  const preloaded = useRef(false);
  useEffect(() => {
    if (preloaded.current) return;
    const state: unknown = location.state;
    const preload: unknown =
      state && typeof state === "object" && "preload" in state ? state.preload : null;
    if (!Array.isArray(preload)) return;
    preloaded.current = true;
    void addPaths(preload.filter((p): p is string => typeof p === "string"));
    navigate(location.pathname, { replace: true, state: null }); // don't re-add on refresh
  }, [addPaths, location.pathname, location.state, navigate]);

  const selectFiles = useCallback(async () => {
    if (!isTauri()) return;
    const picked = await open({
      multiple: true,
      filters: [{ name: tool.accepts.label, extensions: [...tool.accepts.extensions] }],
    });
    if (Array.isArray(picked)) await addPaths(picked);
    else if (typeof picked === "string") await addPaths([picked]);
  }, [addPaths, tool]);

  // Page selections belong to one document: clear them when the document goes away.
  const clearPageSelections = useCallback(() => {
    const pageKeys = describeOptions(tool.optionsSchema)
      .filter((f) => f.kind === "pages")
      .map((f) => f.key);
    if (pageKeys.length === 0) return;
    setOptions((prev) => ({ ...prev, ...Object.fromEntries(pageKeys.map((k) => [k, ""])) }));
  }, [tool]);

  const removeFile = (key: string) => {
    setFiles((prev) => {
      const gone = prev.find((f) => f.key === key);
      if (gone?.thumbnail) URL.revokeObjectURL(gone.thumbnail);
      return prev.filter((f) => f.key !== key);
    });
    if (pageTool) clearPageSelections();
  };

  const startOver = () => {
    for (const f of filesRef.current) if (f.thumbnail) URL.revokeObjectURL(f.thumbnail);
    setFiles([]);
    setNotice(null);
    clearPageSelections();
    setPhase({ kind: "edit" });
  };

  // Revoke thumbnails and cancel a running job when leaving the page.
  useEffect(
    () => () => {
      for (const f of filesRef.current) if (f.thumbnail) URL.revokeObjectURL(f.thumbnail);
      void jobRef.current?.cancel();
    },
    [],
  );

  // ── validation ─────────────────────────────────────────────────────────────────────────
  const parsed = tool.optionsSchema.safeParse(options);
  const pageCount = files[0]?.pages ?? null;
  let blocker: string | null = null;
  if (needsFiles && files.length < tool.accepts.min) {
    blocker = t("tool.needMore", { count: tool.accepts.min });
  } else if (files.some((f) => f.status === "error" || f.status === "locked")) {
    blocker = t("tool.fixErrors");
  } else {
    for (const field of describeOptions(tool.optionsSchema)) {
      if (!isVisible(field, options)) continue;
      let error: string | null = null;
      if (field.kind === "pages") {
        const text = typeof options[field.key] === "string" ? (options[field.key] as string) : "";
        error = pageFieldError(field, text, pageCount);
      } else if (field.meta.confirmOf) {
        error = confirmError(field, options);
      }
      if (error) {
        blocker = `${field.meta.label}: ${error}`;
        break;
      }
    }
    if (!blocker && tool.check && parsed.success) {
      const binding = tool.pageSelection;
      const selText = binding ? options[binding.option] : undefined;
      const selectedCount =
        typeof selText === "string" && selText.trim() && pageCount
          ? (parsePageSet(selText, pageCount)?.size ?? 0)
          : 0;
      blocker = tool.check(parsed.data, { pageCount, selectedCount });
    }
  }
  if (!blocker && organizeTool && files.length > 0 && !organizePlan?.pages.length) {
    blocker = t("organize.empty");
  }
  const loading = files.some((f) => f.status === "loading");
  const canRun = editing && parsed.success && !blocker && !loading;

  // ── run ────────────────────────────────────────────────────────────────────────────────
  const handleError = (event: Omit<ErrorEvent, "id">) => {
    setPhase({ kind: "edit" });
    if (event.code === "CANCELLED") {
      setNotice({ tone: "info", text: t("tool.cancelled") });
      return;
    }
    const target = event.file ? filesRef.current.find((f) => f.path === event.file) : undefined;
    if (target) {
      if (event.code === "PASSWORD_REQUIRED" || event.code === "WRONG_PASSWORD") {
        patchFile(target.key, {
          status: "locked",
          password: undefined,
          error: event.code === "WRONG_PASSWORD" ? t("file.wrongPassword") : undefined,
        });
      } else {
        patchFile(target.key, { status: "error", error: event.message });
      }
      setNotice(null);
      return;
    }
    const text = ERROR_TEXT[event.code];
    setNotice({
      tone: "danger",
      text: [text.title, event.message, text.fix].filter(Boolean).join(". "),
      details: `${event.code}: ${event.message}`,
    });
  };

  const execute = async (method: string, params: Record<string, unknown>) => {
    setPhase({
      kind: "running",
      percent: 0,
      message: "",
      startedAt: Date.now(),
      cancelling: false,
    });
    try {
      const job = await runJob(method, params, (p) => {
        setPhase((prev) =>
          prev.kind === "running" ? { ...prev, percent: p.percent, message: p.message } : prev,
        );
      });
      jobRef.current = job;
      const result = await job.result;
      setPhase({ kind: "done", result });
    } catch (err) {
      if (err instanceof JobError) handleError(err.event);
      else handleError({ event: "error", code: "INTERNAL", message: String(err) });
    } finally {
      jobRef.current = null;
    }
  };

  const run = async () => {
    if (!canRun || !tool.engineMethod) return;
    setNotice(null);
    const passwords = Object.fromEntries(
      files.filter((f) => f.password).map((f) => [f.path, f.password ?? ""]),
    );
    if (organizeTool) {
      if (!organizePlan) return;
      const used = new Set(organizePlan.inputs);
      await execute(tool.engineMethod, {
        inputs: organizePlan.inputs,
        options: { pages: organizePlan.pages },
        passwords: Object.fromEntries(Object.entries(passwords).filter(([p]) => used.has(p))),
        ...(outputDir && { output_dir: outputDir }),
      });
      return;
    }
    const { options: plain, secrets } = splitSecrets(tool.optionsSchema, parsed.data);
    const engineOptions = tool.toEngine ? tool.toEngine(plain) : plain;
    await execute(tool.engineMethod, {
      options: engineOptions,
      ...(Object.keys(secrets).length > 0 && { secrets }), // never stored in history
      ...(needsFiles && { inputs: files.map((f) => f.path), passwords }),
      ...(!needsFiles && engineOptions),
      ...(outputDir && { output_dir: outputDir }),
    });
  };

  const cancel = () => {
    setPhase((prev) => (prev.kind === "running" ? { ...prev, cancelling: true } : prev));
    void jobRef.current?.cancel();
  };

  // Keyboard: Ctrl+Enter runs, Ctrl+O adds files (docs/02 §J).
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return;
      if (e.key === "Enter") {
        e.preventDefault();
        void runRef.current();
      } else if (e.key.toLowerCase() === "o" && needsFiles) {
        e.preventDefault();
        void selectFiles();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [needsFiles, selectFiles]);

  if (phase.kind === "done") {
    return (
      <PageShell tool={tool} title={tool.name}>
        <ResultCard
          result={phase.result}
          summary={tool.summary?.(phase.result.stats) ?? null}
          combined={tool.accepts.max > 1 && files.length > 1}
          onStartOver={startOver}
        />
      </PageShell>
    );
  }

  return (
    <PageShell tool={tool} title={tool.name}>
      <div className="relative grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-4">
          {notice && (
            <div
              role="alert"
              className={cn(
                "flex items-start gap-2 rounded-md border px-4 py-3 text-sm",
                notice.tone === "danger"
                  ? "border-danger/40 bg-danger/10 text-danger"
                  : "border-border bg-surface-2 text-text",
              )}
            >
              {notice.tone === "danger" ? (
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              ) : (
                <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
              )}
              <span className="flex-1">{notice.text}</span>
              {notice.details && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void navigator.clipboard.writeText(notice.details ?? "")}
                >
                  <Copy aria-hidden />
                  {t("result.copyDetails")}
                </Button>
              )}
            </div>
          )}
          {needsFiles && files.length === 0 && (
            <DropZone
              over={over}
              acceptedLabel={tool.accepts.label}
              onSelect={() => void selectFiles()}
            />
          )}
          {pageTool && files[0]?.status === "ready" && (
            <PagesPanel
              tool={tool}
              file={files[0]}
              options={options}
              onOptionsChange={setOptions}
              onRemove={() => removeFile(files[0]?.key ?? "")}
              disabled={!editing}
            />
          )}
          {organizeTool && files.some((f) => f.status === "ready") && (
            <OrganizeBoard
              files={files}
              disabled={!editing}
              onPlanChange={setOrganizePlan}
              onAddFiles={() => void selectFiles()}
              onRemoveFile={removeFile}
            />
          )}
          {needsFiles &&
            files.length > 0 &&
            !(pageTool && files[0]?.status === "ready") &&
            !(organizeTool && files.every((f) => f.status === "ready")) && (
              <>
                <FileList
                  files={files}
                  onReorder={setFiles}
                  onRemove={removeFile}
                  onPassword={(key, pw) => {
                    const file = files.find((f) => f.key === key);
                    if (file) void loadPreview(file, pw);
                  }}
                  onSortByName={() => setFiles(sortByName)}
                  onSortByDate={() => setFiles(sortByDate)}
                />
                {files.length < tool.accepts.max && !pageTool && !organizeTool && (
                  <DropZone
                    compact
                    over={over}
                    acceptedLabel={tool.accepts.label}
                    onSelect={() => void selectFiles()}
                  />
                )}
              </>
            )}
          {!needsFiles && (
            <div className="rounded-card border bg-surface-2/50 p-8 text-text-muted">
              {tool.description}
            </div>
          )}
        </div>

        <aside className="h-fit space-y-6 rounded-card border bg-surface p-5 lg:sticky lg:top-24 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted">
            {t("tool.options")}
          </h2>
          <OptionsForm
            schema={tool.optionsSchema}
            value={options}
            onChange={setOptions}
            disabled={!editing}
            pageCount={pageCount}
          />
          {needsFiles && (
            <OutputFolderPicker
              value={outputDir}
              fallbackLabel={settings.defaultOutputDir ?? t("tool.outputDefault")}
              onChange={setOutputDir}
              disabled={!editing}
            />
          )}
          <div className="space-y-2">
            {blocker && <p className="text-xs text-text-muted">{blocker}</p>}
            <Button size="lg" className="w-full" disabled={!canRun} onClick={() => void run()}>
              {tool.actionLabel}
            </Button>
            <p className="text-center text-xs text-text-muted">{t("tool.shortcutRun")}</p>
          </div>
        </aside>

        {phase.kind === "running" && (
          <ProgressOverlay
            toolName={tool.name}
            percent={phase.percent}
            message={phase.message}
            startedAt={phase.startedAt}
            cancelling={phase.cancelling}
            onCancel={cancel}
          />
        )}
      </div>
    </PageShell>
  );
}
