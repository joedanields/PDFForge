import { open } from "@tauri-apps/plugin-dialog";
import { ArrowLeft, ChevronRight, FolderPlus, Pencil } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { BatchView } from "@/components/BatchView";
import { DropZone } from "@/components/DropZone";
import { FileList } from "@/components/FileList";
import { OptionsForm } from "@/components/OptionsForm";
import { OutputFolderPicker } from "@/components/OutputFolderPicker";
import { Button } from "@/components/ui/button";
import { api, isTauri, runJob } from "@/engine/client";
import { t, tx } from "@/i18n";
import { type BatchHandle, type BatchItem, runBatch } from "@/lib/batch";
import { fileKey, sortByDate, sortByName, type InputFile } from "@/lib/files";
import { useAppStore } from "@/lib/store";
import { useFileDrop } from "@/lib/useFileDrop";
import { fileName } from "@/lib/utils";
import {
  chainProblems,
  runsOnAllFiles,
  secretKeys,
  stepForEngine,
  workflowAccepts,
  type Workflow,
} from "@/lib/workflows";
import { confirmError, defaultOptions, describeOptions, isVisible } from "@/tools/options";
import { acceptsFile, getTool } from "@/tools/registry";

/** Run a saved workflow on files or a folder (docs/02 §G, 04 §2.8). */
export function WorkflowRunPage() {
  const { workflowId = "" } = useParams();
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    void api.listWorkflows().then((all) => {
      const found = all.find((w) => w.id === workflowId);
      if (found) setWorkflow(found);
      else setMissing(true);
    });
  }, [workflowId]);

  if (missing) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10 text-center text-text-muted">
        {t("workflows.missing")}
      </div>
    );
  }
  if (!workflow) return null;
  return <Runner key={workflow.id} workflow={workflow} />;
}

function Runner({ workflow }: { workflow: Workflow }) {
  const settings = useAppStore((s) => s.settings);
  const accepts = workflowAccepts(workflow.steps);
  const firstTool = getTool(workflow.steps[0]?.tool ?? "");
  const [files, setFiles] = useState<InputFile[]>([]);
  const filesRef = useRef(files);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [items, setItems] = useState<BatchItem[] | null>(null);
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const handleRef = useRef<BatchHandle | null>(null);
  const startRef = useRef<((path: string) => Record<string, unknown>) | null>(null);
  const allFiles = runsOnAllFiles(workflow.steps);

  // Passwords each step needs (Protect, …): asked here, never saved with the workflow.
  const secretSteps = useMemo(
    () =>
      workflow.steps.flatMap((step, index) => {
        const tool = getTool(step.tool);
        const keys = tool ? secretKeys(tool.optionsSchema) : [];
        if (!tool || keys.length === 0) return [];
        const schema = tool.optionsSchema.pick(
          Object.fromEntries(keys.map((k) => [k, true] as const)),
        );
        return [{ index, tool, schema }];
      }),
    [workflow],
  );
  const [secrets, setSecrets] = useState<Record<number, Record<string, unknown>>>(() =>
    Object.fromEntries(secretSteps.map((s) => [s.index, defaultOptions(s.schema)])),
  );

  const loadPreview = useCallback(async (file: InputFile, password?: string) => {
    const patch = (p: Partial<InputFile>) =>
      setFiles((prev) => prev.map((f) => (f.key === file.key ? { ...f, ...p } : f)));
    if (!file.path.toLowerCase().endsWith(".pdf")) {
      patch({ status: "ready" });
      return;
    }
    const { preview } = await import("@/lib/pdfjs");
    const res = await preview(file.path, password);
    if (res.kind === "ok") {
      patch({ status: "ready", pages: res.pages, thumbnail: res.thumbnail, password });
    } else if (res.kind === "locked") {
      patch({
        status: "locked",
        password: undefined,
        error: res.wrongPassword ? t("file.wrongPassword") : undefined,
      });
    } else {
      patch({ status: "error", error: t("file.unreadable") });
    }
  }, []);

  const addPaths = useCallback(
    async (paths: string[]) => {
      if (!accepts || !firstTool || items) return;
      const ok = paths.filter((p) => acceptsFile({ ...firstTool, accepts }, p));
      const rejected = paths.filter((p) => !ok.includes(p));
      const taken = ok.slice(0, Math.max(0, accepts.max - filesRef.current.length));
      setNotice(
        rejected.length > 0
          ? t("tool.rejected", { names: rejected.map(fileName).join(", ") })
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
      for (const f of added) void loadPreview(f);
    },
    [accepts, firstTool, items, loadPreview],
  );

  const over = useFileDrop((paths) => void addPaths(paths), items === null);

  // E2E seam (dev builds only), as on tool pages.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const onTestFiles = (e: Event) => void addPaths((e as CustomEvent<string[]>).detail);
    window.addEventListener("pdfforge:test-add-files", onTestFiles);
    return () => window.removeEventListener("pdfforge:test-add-files", onTestFiles);
  }, [addPaths]);

  useEffect(
    () => () => {
      for (const f of filesRef.current) if (f.thumbnail) URL.revokeObjectURL(f.thumbnail);
      handleRef.current?.cancel();
    },
    [],
  );

  const selectFiles = async () => {
    if (!isTauri() || !accepts) return;
    const picked = await open({
      multiple: true,
      filters: [{ name: tx(accepts.label), extensions: [...accepts.extensions] }],
    });
    if (Array.isArray(picked)) await addPaths(picked);
    else if (typeof picked === "string") await addPaths([picked]);
  };

  const addFolder = async () => {
    if (!isTauri() || !accepts) return;
    const folder = await open({ directory: true, multiple: false });
    if (typeof folder !== "string") return;
    const found = await api.listFolder(folder, [...accepts.extensions]);
    if (found.length === 0) setNotice(t("batch.folderEmpty"));
    else await addPaths(found);
  };

  // ── validation ─────────────────────────────────────────────────────────────────────────
  let blocker: string | null = null;
  if (chainProblems(workflow.steps).size > 0) blocker = t("workflows.fixSteps");
  else if (files.length === 0) blocker = t("tool.needMore", { count: 1 });
  else if (files.some((f) => f.status === "loading")) blocker = t("workflows.loading");
  else if (files.some((f) => f.status === "error" || f.status === "locked"))
    blocker = t("tool.fixErrors");
  else {
    for (const { index, tool, schema } of secretSteps) {
      const values = secrets[index] ?? {};
      for (const field of describeOptions(schema)) {
        if (!isVisible(field, values) || !field.meta.confirmOf) continue;
        const error = confirmError(field, values);
        if (error) blocker = `${tx(tool.name)}: ${tx(field.meta.label)}: ${error}`;
      }
      const full = { ...defaultOptions(tool.optionsSchema), ...workflow.steps[index]?.options };
      const parsed = tool.optionsSchema.safeParse({ ...full, ...values });
      const problem =
        parsed.success && tool.check?.(parsed.data, { pageCount: null, selectedCount: 0 });
      if (problem) blocker = `${tx(tool.name)}: ${tx(problem)}`;
    }
  }

  // ── run ────────────────────────────────────────────────────────────────────────────────
  const start = (list: BatchItem[], keep: BatchItem[] = []) => {
    const paramsFor = startRef.current;
    if (!paramsFor) return;
    const order = new Map([...keep, ...list].map((i) => [i.key, i]));
    setItems((prev) => (prev ?? list).map((i) => order.get(i.key) ?? i));
    setRunning(true);
    setCancelling(false);
    const handle = runBatch(
      list,
      (path, onProgress) => runJob("workflow", paramsFor(path), (p) => onProgress(p.percent)),
      (key, patch) =>
        setItems((prev) => prev?.map((i) => (i.key === key ? { ...i, ...patch } : i)) ?? prev),
    );
    handleRef.current = handle;
    void handle.finished.then(() => {
      handleRef.current = null;
      setRunning(false);
    });
  };

  const run = () => {
    if (blocker) return;
    const engineSteps = workflow.steps.map((step, index) =>
      stepForEngine(step, secrets[index] ?? {}),
    );
    const passwords = Object.fromEntries(
      files.filter((f) => f.password).map((f) => [f.path, f.password ?? ""]),
    );
    const paramsFor = (inputs: string[]) => ({
      options: { name: workflow.name, steps: engineSteps.map((s) => s.step) },
      secrets: { steps: engineSteps.map((s) => s.secrets) }, // never stored in history
      inputs,
      passwords: Object.fromEntries(
        Object.entries(passwords).filter(([path]) => inputs.includes(path)),
      ),
      ...(outputDir && { output_dir: outputDir }),
      timeout_s: 60 * 60,
    });
    const paths = files.map((f) => f.path);
    // One job over every file when a step combines them (Merge), else one job per file.
    startRef.current = allFiles ? () => paramsFor(paths) : (path) => paramsFor([path]);
    const list: BatchItem[] = allFiles
      ? [
          {
            key: "all",
            path: paths[0] ?? "",
            name: t("workflows.allFiles", { count: paths.length }),
            state: "queued",
            percent: 0,
            outputs: [],
          },
        ]
      : files.map((f) => ({
          key: f.key,
          path: f.path,
          name: f.name,
          state: "queued",
          percent: 0,
          outputs: [],
        }));
    setItems(list);
    start(list);
  };

  const retryFailed = () => {
    if (!items) return;
    const retry = (i: BatchItem) => i.state === "failed" || i.state === "cancelled";
    start(
      items.filter(retry).map((i) => ({ ...i, state: "queued" as const, percent: 0 })),
      items.filter((i) => !retry(i)),
    );
  };

  const startOver = () => {
    for (const f of filesRef.current) if (f.thumbnail) URL.revokeObjectURL(f.thumbnail);
    setFiles([]);
    setItems(null);
    setNotice(null);
  };

  const header = (
    <div className="mb-6 space-y-2">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/?category=workflows">
            <ArrowLeft aria-hidden />
            {t("nav.back")}
          </Link>
        </Button>
        <h1 className="text-lg font-semibold">{workflow.name}</h1>
        <Button variant="ghost" size="sm" asChild className="ml-auto">
          <Link to={`/workflows/${workflow.id}`}>
            <Pencil aria-hidden />
            {t("workflows.edit")}
          </Link>
        </Button>
      </div>
      <p className="flex flex-wrap items-center gap-1 text-sm text-text-muted">
        {workflow.steps.map((s, i) => (
          <span key={i} className="inline-flex items-center gap-1">
            {i > 0 && <ChevronRight className="size-3.5" aria-hidden />}
            {tx(getTool(s.tool)?.name ?? s.tool)}
          </span>
        ))}
      </p>
    </div>
  );

  if (items) {
    return (
      <div className="mx-auto max-w-[1600px] px-6 py-6">
        {header}
        <BatchView
          title={workflow.name}
          items={items}
          running={running}
          cancelling={cancelling}
          onCancel={() => {
            setCancelling(true);
            handleRef.current?.cancel();
          }}
          onRetryFailed={retryFailed}
          onStartOver={startOver}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1600px] px-6 py-6">
      {header}
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-4">
          {notice && (
            <p
              role="alert"
              className="rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger"
            >
              {notice}
            </p>
          )}
          {files.length === 0 ? (
            <DropZone
              over={over}
              acceptedLabel={tx(accepts?.label ?? "")}
              onSelect={() => void selectFiles()}
            />
          ) : (
            <>
              <FileList
                files={files}
                onReorder={setFiles}
                onRemove={(key) => setFiles((prev) => prev.filter((f) => f.key !== key))}
                onPassword={(key, pw) => {
                  const file = files.find((f) => f.key === key);
                  if (file) void loadPreview(file, pw);
                }}
                onSortByName={() => setFiles(sortByName)}
                onSortByDate={() => setFiles(sortByDate)}
              />
              <DropZone
                compact
                over={over}
                acceptedLabel={tx(accepts?.label ?? "")}
                onSelect={() => void selectFiles()}
              />
            </>
          )}
          <Button variant="secondary" size="sm" onClick={() => void addFolder()}>
            <FolderPlus aria-hidden />
            {t("batch.addFolder")}
          </Button>
        </div>

        <aside className="h-fit space-y-6 rounded-card border bg-surface p-5 lg:sticky lg:top-24">
          <p className="text-sm text-text-muted">
            {allFiles ? t("workflows.runsOnce") : t("workflows.runsEach")}
          </p>
          {secretSteps.map(({ index, tool, schema }) => (
            <div key={index} className="space-y-3">
              <h2 className="text-sm font-semibold">
                {t("workflows.step", { n: index + 1 })}: {tx(tool.name)}
              </h2>
              <OptionsForm
                schema={schema}
                value={secrets[index] ?? {}}
                onChange={(value) => setSecrets((prev) => ({ ...prev, [index]: value }))}
                pageCount={null}
              />
            </div>
          ))}
          <OutputFolderPicker
            value={outputDir}
            fallbackLabel={settings.defaultOutputDir ?? t("tool.outputDefault")}
            onChange={setOutputDir}
          />
          <div className="space-y-2">
            {blocker && <p className="text-xs text-text-muted">{blocker}</p>}
            <Button size="lg" className="w-full" disabled={!!blocker} onClick={run}>
              {t("workflows.runNow")}
            </Button>
          </div>
        </aside>
      </div>
    </div>
  );
}
