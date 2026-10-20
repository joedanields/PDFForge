import { open } from "@tauri-apps/plugin-dialog";
import { ArrowLeft, CircleAlert, Copy, FolderPlus, Info } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { BatchView } from "@/components/BatchView";
import { DropZone } from "@/components/DropZone";
import { FileList } from "@/components/FileList";
import { OptionsForm } from "@/components/OptionsForm";
import { OutputFolderPicker } from "@/components/OutputFolderPicker";
import { type Change, CompareView } from "@/components/CompareView";
import { CropBoard } from "@/components/editor/CropBoard";
import { EditorBoard } from "@/components/editor/EditorBoard";
import { FormBoard } from "@/components/FormBoard";
import { RedactBoard } from "@/components/editor/RedactBoard";
import { SignBoard } from "@/components/editor/SignBoard";
import { OrganizeBoard, type OrganizePlan } from "@/components/OrganizeBoard";
import { PagesPanel } from "@/components/PagesPanel";
import { ProgressOverlay } from "@/components/ProgressOverlay";
import { ResultCard } from "@/components/ResultCard";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { JobError, api, isTauri, runJob, type RunningJob } from "@/engine/client";
import { ERROR_TEXT, type DoneEvent, type ErrorEvent } from "@/engine/types";
import { BATCH_MAX, type BatchHandle, type BatchItem, runBatch } from "@/lib/batch";
import { t, tx } from "@/i18n";
import {
  type CropBox,
  DEFAULT_CROP_BOX,
  type EditObject,
  toEngine as editorToEngine,
} from "@/lib/editor";
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
      <PageShell tool={tool} title={tx(tool.name)}>
        <div className="mx-auto max-w-lg rounded-card border border-dashed p-10 text-center">
          <h2 className="text-lg font-semibold">
            {t("tool.comingSoonTitle", { name: tx(tool.name) })}
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
  // Batch mode (docs/02 §H): many files, one job each, same options; plain file list.
  const [batchMode, setBatchMode] = useState(false);
  const [batchItems, setBatchItems] = useState<BatchItem[] | null>(null);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchCancelling, setBatchCancelling] = useState(false);
  const batchRef = useRef<BatchHandle | null>(null);
  const batchParamsRef = useRef<((path: string) => Record<string, unknown>) | null>(null);
  const maxFiles = batchMode ? BATCH_MAX : tool.accepts.max;
  const layout = batchMode ? "files" : (tool.layout ?? "files");
  const needsFiles = tool.accepts.max > 0;
  const pageTool = layout === "pages";
  const organizeTool = layout === "organize";
  const [organizePlan, setOrganizePlan] = useState<OrganizePlan | null>(null);
  const cropTool = layout === "crop";
  const [cropBox, setCropBox] = useState<CropBox>(DEFAULT_CROP_BOX);
  const [cropPage, setCropPage] = useState(0);
  const signTool = layout === "sign";
  const redactTool = layout === "redact";
  const editorTool = layout === "editor" || signTool || redactTool;
  const formTool = layout === "form";
  const [formValues, setFormValues] = useState<Record<string, string | boolean>>({});
  const [formFieldCount, setFormFieldCount] = useState<number | null>(null);
  const [editorObjects, setEditorObjects] = useState<EditObject[]>([]);
  const [signImages, setSignImages] = useState<Record<string, string>>({});
  const editing = phase.kind === "edit" && batchItems === null;

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
      } else if (tool.acceptsDamaged) {
        patchFile(file.key, { status: "ready", pages: null, thumbnail: null });
      } else {
        patchFile(file.key, { status: "error", error: t("file.unreadable") });
      }
    },
    [patchFile, tool.acceptsDamaged],
  );

  const addPaths = useCallback(
    async (paths: string[]) => {
      if (!editing) return;
      const accepted = paths.filter((p) => acceptsFile(tool, p));
      const rejected = paths.filter((p) => !acceptsFile(tool, p));
      const room = maxFiles - filesRef.current.length;
      const taken = accepted.slice(0, Math.max(0, room));
      setNotice(
        rejected.length > 0
          ? {
              tone: "danger",
              text: t("tool.rejected", { names: rejected.map(fileName).join(", ") }),
            }
          : accepted.length > taken.length
            ? { tone: "danger", text: t("tool.tooMany", { count: maxFiles }) }
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
    [editing, loadPreview, maxFiles, tool],
  );

  const over = useFileDrop((paths) => void addPaths(paths), needsFiles && editing);

  // E2E seam (dev builds only): native drag-drop and file dialogs can't be automated over CDP.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const onTestFiles = (e: Event) => void addPaths((e as CustomEvent<string[]>).detail);
    window.addEventListener("pdfforge:test-add-files", onTestFiles);
    return () => window.removeEventListener("pdfforge:test-add-files", onTestFiles);
  }, [addPaths]);

  // Files from outside the app (Explorer "Merge with PDFForge"), arriving one launch at a time.
  const incoming = useAppStore((s) => s.incoming[tool.id]?.length ?? 0);
  useEffect(() => {
    if (incoming === 0 || !editing) return;
    void addPaths(useAppStore.getState().takeIncoming(tool.id));
  }, [addPaths, editing, incoming, tool.id]);

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
      filters: [{ name: tx(tool.accepts.label), extensions: [...tool.accepts.extensions] }],
    });
    if (Array.isArray(picked)) await addPaths(picked);
    else if (typeof picked === "string") await addPaths([picked]);
  }, [addPaths, tool]);

  const addFolder = useCallback(async () => {
    if (!isTauri()) return;
    const folder = await open({ directory: true, multiple: false });
    if (typeof folder !== "string") return;
    const found = await api.listFolder(folder, [...tool.accepts.extensions]);
    if (found.length === 0) setNotice({ tone: "info", text: t("batch.folderEmpty") });
    else await addPaths(found);
  }, [addPaths, tool]);

  const toggleBatch = (on: boolean) => {
    setBatchMode(on);
    if (on) return;
    // Back to one file: keep the first, drop the rest.
    setFiles((prev) => {
      for (const f of prev.slice(tool.accepts.max))
        if (f.thumbnail) URL.revokeObjectURL(f.thumbnail);
      return prev.slice(0, tool.accepts.max);
    });
    clearPageSelections();
  };

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
    setBatchItems(null);
    setNotice(null);
    clearPageSelections();
    setPhase({ kind: "edit" });
  };

  // Revoke thumbnails and cancel a running job when leaving the page.
  useEffect(
    () => () => {
      for (const f of filesRef.current) if (f.thumbnail) URL.revokeObjectURL(f.thumbnail);
      void jobRef.current?.cancel();
      batchRef.current?.cancel();
    },
    [],
  );

  // ── validation ─────────────────────────────────────────────────────────────────────────
  const parsed = tool.optionsSchema.safeParse(options);
  const pageCount = batchMode ? null : (files[0]?.pages ?? null);
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
        blocker = `${tx(field.meta.label)}: ${error}`;
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
      const problem = tool.check(parsed.data, { pageCount, selectedCount });
      blocker = problem && tx(problem);
    }
  }
  const certificateOnly = signTool && options.digital === true;
  if (
    !blocker &&
    editorTool &&
    files.length > 0 &&
    editorObjects.length === 0 &&
    !certificateOnly
  ) {
    blocker = t(signTool ? "sign.empty" : redactTool ? "redact.empty" : "editor.empty");
  }
  if (!blocker && formTool && files[0]?.status === "ready") {
    if (formFieldCount === null) blocker = t("forms.reading");
    else if (formFieldCount === 0) blocker = t("forms.none");
    else if (Object.keys(formValues).length === 0 && options.flatten !== true)
      blocker = t("forms.empty");
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
      text: [tx(text.title), event.message, text.fix && tx(text.fix)].filter(Boolean).join(". "),
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
    const { options: plain, secrets: formSecrets } = splitSecrets(tool.optionsSchema, parsed.data);
    // Signature pictures are secrets: sent to the engine, never stored in job history.
    const used = new Set(
      editorObjects
        .map((o) => o.image)
        .filter((ref): ref is string => typeof ref === "string" && ref.startsWith("secret:"))
        .map((ref) => ref.slice("secret:".length)),
    );
    const images = Object.fromEntries(Object.entries(signImages).filter(([id]) => used.has(id)));
    const secrets =
      signTool && Object.keys(images).length > 0 ? { ...formSecrets, images } : formSecrets;
    const converted = tool.toEngine ? tool.toEngine(plain) : plain;
    const engineOptions = formTool
      ? { ...converted, values: formValues }
      : redactTool
        ? {
            ...converted,
            areas: editorObjects
              .filter((o) => o.kind === "rect")
              .map((o) => ({ page: o.page, x: o.x, y: o.y, w: o.w, h: o.h })),
          }
        : editorTool
          ? { ...converted, objects: editorObjects.map(editorToEngine) }
          : cropTool
            ? {
                mode: converted.mode,
                margin: converted.margin,
                box: cropBox,
                pages: converted.apply === "current" ? String(cropPage + 1) : "all",
              }
            : converted;
    const paramsFor = (inputs: string[]) => ({
      options: engineOptions,
      ...(Object.keys(secrets).length > 0 && { secrets }), // never stored in history
      ...(needsFiles && {
        inputs,
        passwords: Object.fromEntries(
          Object.entries(passwords).filter(([path]) => inputs.includes(path)),
        ),
      }),
      ...(!needsFiles && engineOptions),
      ...(outputDir && { output_dir: outputDir }),
    });
    if (batchMode) {
      batchParamsRef.current = (path) => paramsFor([path]);
      startBatch(
        files.map((f) => ({
          key: f.key,
          path: f.path,
          name: f.name,
          state: "queued",
          percent: 0,
          outputs: [],
        })),
      );
      return;
    }
    await execute(tool.engineMethod, paramsFor(files.map((f) => f.path)));
  };

  const patchBatch = (key: string, patch: Partial<BatchItem>) =>
    setBatchItems((prev) => prev?.map((i) => (i.key === key ? { ...i, ...patch } : i)) ?? prev);

  /** Run (or re-run) the given items; the others keep their state. */
  const startBatch = (items: BatchItem[], keep: BatchItem[] = []) => {
    const method = tool.engineMethod;
    const paramsFor = batchParamsRef.current;
    if (!method || !paramsFor) return;
    const order = new Map([...keep, ...items].map((i) => [i.key, i]));
    setBatchItems(files.map((f) => order.get(f.key)).filter((i): i is BatchItem => !!i));
    setBatchRunning(true);
    setBatchCancelling(false);
    const handle = runBatch(
      items,
      (path, onProgress) => runJob(method, paramsFor(path), (p) => onProgress(p.percent)),
      patchBatch,
    );
    batchRef.current = handle;
    void handle.finished.then(() => {
      batchRef.current = null;
      setBatchRunning(false);
    });
  };

  const retryFailed = () => {
    if (!batchItems) return;
    const retry = (i: BatchItem) => i.state === "failed" || i.state === "cancelled";
    startBatch(
      batchItems.filter(retry).map((i) => ({ ...i, state: "queued" as const, percent: 0 })),
      batchItems.filter((i) => !retry(i)),
    );
  };

  const cancelBatch = () => {
    setBatchCancelling(true);
    batchRef.current?.cancel();
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

  if (batchItems) {
    return (
      <PageShell tool={tool} title={tx(tool.name)}>
        <BatchView
          title={t("batch.running", { tool: tx(tool.name) })}
          items={batchItems}
          running={batchRunning}
          cancelling={batchCancelling}
          onCancel={cancelBatch}
          onRetryFailed={retryFailed}
          onStartOver={startOver}
          summary={tool.summary}
        />
      </PageShell>
    );
  }

  if (phase.kind === "done") {
    return (
      <PageShell tool={tool} title={tx(tool.name)}>
        {tool.layout === "compare" && (
          <CompareView
            files={files}
            changes={
              Array.isArray(phase.result.stats.changes)
                ? (phase.result.stats.changes as Change[])
                : []
            }
          />
        )}
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
    <PageShell tool={tool} title={tx(tool.name)}>
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
              acceptedLabel={
                batchMode ? t("batch.accepted", { count: BATCH_MAX }) : tx(tool.accepts.label)
              }
              onSelect={() => void selectFiles()}
            />
          )}
          {batchMode && editing && (
            <Button variant="secondary" size="sm" onClick={() => void addFolder()}>
              <FolderPlus aria-hidden />
              {t("batch.addFolder")}
            </Button>
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
          {cropTool && files[0]?.status === "ready" && (
            <CropBoard
              key={files[0].key}
              file={files[0]}
              box={cropBox}
              onBox={setCropBox}
              page={cropPage}
              onPage={setCropPage}
              showBox={options.mode !== "auto"}
              disabled={!editing}
            />
          )}
          {signTool && files[0]?.status === "ready" && (
            <SignBoard
              key={files[0].key}
              file={files[0]}
              disabled={!editing}
              onChange={setEditorObjects}
              onImages={setSignImages}
            />
          )}
          {redactTool && files[0]?.status === "ready" && (
            <RedactBoard
              key={files[0].key}
              file={files[0]}
              disabled={!editing}
              onChange={setEditorObjects}
            />
          )}
          {editorTool && !signTool && !redactTool && files[0]?.status === "ready" && (
            <EditorBoard
              key={files[0].key}
              file={files[0]}
              disabled={!editing}
              onChange={setEditorObjects}
            />
          )}
          {formTool && files[0]?.status === "ready" && (
            <FormBoard
              key={files[0].key}
              file={files[0]}
              disabled={!editing}
              onRemove={() => {
                removeFile(files[0]?.key ?? "");
                setFormValues({});
                setFormFieldCount(null);
              }}
              onChange={(values, count) => {
                setFormValues(values);
                setFormFieldCount(count);
              }}
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
            !((pageTool || editorTool || cropTool || formTool) && files[0]?.status === "ready") &&
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
                {files.length < maxFiles &&
                  !pageTool &&
                  !organizeTool &&
                  !editorTool &&
                  !formTool &&
                  !cropTool && (
                    <DropZone
                      compact
                      over={over}
                      acceptedLabel={tx(tool.accepts.label)}
                      onSelect={() => void selectFiles()}
                    />
                  )}
              </>
            )}
          {!needsFiles && (
            <div className="rounded-card border bg-surface-2/50 p-8 text-text-muted">
              {tx(tool.description)}
            </div>
          )}
        </div>

        <aside className="h-fit space-y-6 rounded-card border bg-surface p-5 lg:sticky lg:top-24 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto">
          {tool.batch && (
            <div className="flex items-start justify-between gap-4 rounded-md bg-surface-2/60 p-3">
              <div className="space-y-1">
                <Label htmlFor="batch-mode">{t("batch.toggle")}</Label>
                <p id="batch-mode-help" className="text-xs text-text-muted">
                  {t("batch.toggleHelp")}
                </p>
              </div>
              <Switch
                id="batch-mode"
                checked={batchMode}
                onCheckedChange={toggleBatch}
                disabled={!editing}
                aria-describedby="batch-mode-help"
              />
            </div>
          )}
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
              {tx(tool.actionLabel)}
            </Button>
            <p className="text-center text-xs text-text-muted">{t("tool.shortcutRun")}</p>
          </div>
        </aside>

        {phase.kind === "running" && (
          <ProgressOverlay
            toolName={tx(tool.name)}
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
