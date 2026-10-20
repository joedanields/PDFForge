import {
  ChevronRight,
  Copy,
  Pencil,
  Play,
  Plus,
  Trash2,
  Workflow as WorkflowIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { api, isTauri } from "@/engine/client";
import { t } from "@/i18n";
import { newStep, newWorkflowId, type Workflow } from "@/lib/workflows";
import { getTool } from "@/tools/registry";

/** Saved workflows (docs/02 §G, 04 §2.8): run, edit, duplicate, delete, or start a new one. */
export function WorkflowList() {
  const navigate = useNavigate();
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = (): Promise<Workflow[]> => (isTauri() ? api.listWorkflows() : Promise.resolve([]));
  const reload = () => load().then(setWorkflows);

  useEffect(() => {
    load().then(setWorkflows, (err: unknown) => setError(String(err)));
  }, []);

  const act = (action: () => Promise<unknown>) => {
    setError(null);
    action()
      .then(reload)
      .catch((err: unknown) => setError(String(err)));
  };

  const duplicate = (w: Workflow) =>
    act(() =>
      api.saveWorkflow({
        ...w,
        id: newWorkflowId(),
        name: t("workflows.copyOf", { name: w.name }).slice(0, 100),
        created: 0,
        updated: 0,
      }),
    );

  const createExample = () =>
    act(async () => {
      const saved = await api.saveWorkflow({
        id: newWorkflowId(),
        name: t("workflows.exampleName"),
        steps: ["merge", "compress", "page-numbers", "protect"].map(newStep),
        created: 0,
        updated: 0,
      });
      navigate(`/workflows/${saved.id}`);
    });

  if (workflows === null) return null;

  return (
    <section className="mx-auto max-w-4xl space-y-4" aria-labelledby="workflows-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="workflows-title" className="text-lg font-semibold">
            {t("workflows.title")}
          </h2>
          <p className="text-sm text-text-muted">{t("workflows.intro")}</p>
        </div>
        <Button onClick={() => navigate("/workflows/new")} disabled={!isTauri()}>
          <Plus aria-hidden />
          {t("workflows.new")}
        </Button>
      </div>

      {workflows.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-card border border-dashed p-10 text-center text-text-muted">
          <WorkflowIcon className="size-10" aria-hidden />
          <p>{t("workflows.empty")}</p>
          <Button variant="secondary" onClick={createExample} disabled={!isTauri()}>
            {t("workflows.example")}
          </Button>
        </div>
      ) : (
        <ul className="space-y-3">
          {workflows.map((w) => (
            <li
              key={w.id}
              className="flex flex-wrap items-center gap-4 rounded-card border bg-surface p-4"
              aria-label={w.name}
            >
              <div className="min-w-0 flex-1">
                <h3 className="truncate font-semibold">{w.name}</h3>
                <p className="mt-1 flex flex-wrap items-center gap-1 text-sm text-text-muted">
                  {w.steps.map((s, i) => (
                    <span key={i} className="inline-flex items-center gap-1">
                      {i > 0 && <ChevronRight className="size-3.5" aria-hidden />}
                      {getTool(s.tool)?.name ?? s.tool}
                    </span>
                  ))}
                </p>
              </div>
              <div className="flex flex-wrap gap-1">
                <Button size="sm" onClick={() => navigate(`/workflows/${w.id}/run`)}>
                  <Play aria-hidden />
                  {t("workflows.run")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => navigate(`/workflows/${w.id}`)}>
                  <Pencil aria-hidden />
                  {t("workflows.edit")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => duplicate(w)}>
                  <Copy aria-hidden />
                  {t("workflows.duplicate")}
                </Button>
                {confirmDelete === w.id ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="text-danger"
                    onClick={() => {
                      setConfirmDelete(null);
                      act(() => api.deleteWorkflow(w.id));
                    }}
                  >
                    <Trash2 aria-hidden />
                    {t("workflows.confirmDelete")}
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(w.id)}>
                    <Trash2 aria-hidden />
                    {t("workflows.delete")}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
