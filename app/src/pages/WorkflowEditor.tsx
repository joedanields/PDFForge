import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  GripVertical,
  KeyRound,
  Plus,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { OptionsForm } from "@/components/OptionsForm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, isTauri } from "@/engine/client";
import { t, tx } from "@/i18n";
import { moveItem } from "@/lib/files";
import { cn } from "@/lib/utils";
import {
  chainProblems,
  newStep,
  newWorkflowId,
  secretKeys,
  stepOptionsError,
  stepTools,
  type Workflow,
  type WorkflowStep,
} from "@/lib/workflows";
import { CATEGORY_META } from "@/tools/categories";
import { defaultOptions } from "@/tools/options";
import { getTool, TOOLS } from "@/tools/registry";

interface EditStep extends WorkflowStep {
  key: string;
}

let stepCounter = 0;
const keyed = (step: WorkflowStep): EditStep => {
  stepCounter += 1;
  return { ...step, key: `s${stepCounter}` };
};

/** Workflow builder (docs/04 §2.8): steps as cards, drag to reorder, options inline. */
export function WorkflowEditorPage() {
  const { workflowId = "new" } = useParams();
  const navigate = useNavigate();
  const isNew = workflowId === "new";
  const [loaded, setLoaded] = useState<Workflow | null>(null);
  const [name, setName] = useState("");
  const [steps, setSteps] = useState<EditStep[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (isNew || !isTauri()) return;
    void api.listWorkflows().then((all) => {
      const found = all.find((w) => w.id === workflowId);
      if (!found) {
        setMissing(true);
        return;
      }
      setLoaded(found);
      setName(found.name);
      setSteps(found.steps.map(keyed));
    });
  }, [isNew, workflowId]);

  const problems = useMemo(() => chainProblems(steps), [steps]);
  const available = useMemo(() => stepTools(TOOLS), []);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const blocker = !name.trim()
    ? t("workflows.needName")
    : steps.length === 0
      ? t("workflows.needStep")
      : problems.size > 0 || steps.some((s) => stepOptionsError(s))
        ? t("workflows.fixSteps")
        : null;

  const save = async (thenRun: boolean) => {
    if (blocker) return;
    setError(null);
    try {
      const saved = await api.saveWorkflow({
        id: loaded?.id ?? newWorkflowId(),
        name: name.trim(),
        steps: steps.map(({ tool, options }) => ({ tool, options })),
        created: loaded?.created ?? 0,
        updated: 0,
      });
      navigate(thenRun ? `/workflows/${saved.id}/run` : "/?category=workflows");
    } catch (err) {
      setError(String(err));
    }
  };

  const addStep = (toolId: string) => {
    const step = keyed(newStep(toolId));
    setSteps((prev) => [...prev, step]);
    setOpen(step.key);
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    setSteps((prev) =>
      moveItem(
        prev,
        prev.findIndex((s) => s.key === active.id),
        prev.findIndex((s) => s.key === over.id),
      ),
    );
  };

  if (missing) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10 text-center text-text-muted">
        {t("workflows.missing")}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/?category=workflows">
            <ArrowLeft aria-hidden />
            {t("nav.back")}
          </Link>
        </Button>
        <h1 className="text-lg font-semibold">
          {isNew ? t("workflows.new") : t("workflows.editTitle")}
        </h1>
      </div>

      <div className="space-y-2">
        <Label htmlFor="workflow-name">{t("workflows.name")}</Label>
        <Input
          id="workflow-name"
          value={name}
          maxLength={100}
          placeholder={t("workflows.namePlaceholder")}
          onChange={(e) => setName(e.target.value)}
        />
        <p className="text-xs text-text-muted">{t("workflows.nameHelp")}</p>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={steps.map((s) => s.key)} strategy={verticalListSortingStrategy}>
          <ol className="space-y-3" aria-label={t("workflows.steps")}>
            {steps.map((step, index) => (
              <StepCard
                key={step.key}
                step={step}
                index={index}
                last={index === steps.length - 1}
                problem={problems.get(index) ?? stepOptionsError(step)}
                open={open === step.key}
                onToggle={() => setOpen((o) => (o === step.key ? null : step.key))}
                onChange={(options) =>
                  setSteps((prev) => prev.map((s) => (s.key === step.key ? { ...s, options } : s)))
                }
                onMove={(delta) => setSteps((prev) => moveItem(prev, index, index + delta))}
                onRemove={() => setSteps((prev) => prev.filter((s) => s.key !== step.key))}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>

      <div className="flex flex-wrap items-center gap-3 rounded-card border border-dashed p-4">
        <Plus className="size-4 text-text-muted" aria-hidden />
        <span className="text-sm font-medium">{t("workflows.addStep")}</span>
        <Select value="" onValueChange={addStep} disabled={steps.length >= 20}>
          <SelectTrigger className="w-64" aria-label={t("workflows.addStep")}>
            <SelectValue placeholder={t("workflows.chooseTool")} />
          </SelectTrigger>
          <SelectContent>
            {available.map((tool) => (
              <SelectItem key={tool.id} value={tool.id}>
                {tx(tool.name)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
        {blocker && <p className="mr-auto text-sm text-text-muted">{blocker}</p>}
        <Button variant="ghost" onClick={() => navigate("/?category=workflows")}>
          {t("workflows.cancel")}
        </Button>
        <Button variant="secondary" disabled={!!blocker} onClick={() => void save(false)}>
          {t("workflows.save")}
        </Button>
        <Button disabled={!!blocker} onClick={() => void save(true)}>
          {t("workflows.saveAndRun")}
        </Button>
      </div>
      {error && (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

interface StepCardProps {
  step: EditStep;
  index: number;
  last: boolean;
  problem: string | null;
  open: boolean;
  onToggle: () => void;
  onChange: (options: Record<string, unknown>) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}

function StepCard({
  step,
  index,
  last,
  problem,
  open,
  onToggle,
  onChange,
  onMove,
  onRemove,
}: StepCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: step.key,
  });
  const tool = getTool(step.tool);
  const secrets = useMemo(() => (tool ? secretKeys(tool.optionsSchema) : []), [tool]);
  const schema = useMemo(
    () =>
      tool?.optionsSchema.omit(Object.fromEntries(secrets.map((k) => [k, true] as const))) ?? null,
    [tool, secrets],
  );
  if (!tool || !schema) return null;
  const Icon = tool.icon;
  const values = { ...defaultOptions(schema), ...step.options };
  const hasOptions = Object.keys(schema.shape).length > 0;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "rounded-card border bg-surface shadow-sm",
        isDragging && "z-10 shadow-xl",
        problem && "border-danger",
      )}
      aria-label={`${t("workflows.step", { n: index + 1 })}: ${tx(tool.name)}`}
    >
      <div className="flex items-center gap-3 p-3">
        <button
          type="button"
          className="cursor-grab text-text-muted"
          aria-label={t("workflows.dragStep")}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" aria-hidden />
        </button>
        <span className="w-5 text-center text-xs font-medium text-text-muted">{index + 1}</span>
        <span
          className={cn(
            "flex size-8 items-center justify-center rounded-md",
            CATEGORY_META[tool.category].iconClass,
          )}
        >
          <Icon className="size-4" aria-hidden />
        </span>
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={onToggle}
          aria-expanded={open}
          disabled={!hasOptions}
        >
          <span className="block truncate font-medium">{tx(tool.name)}</span>
          {problem ? (
            <span className="flex items-center gap-1 text-xs text-danger">
              <CircleAlert className="size-3.5" aria-hidden />
              {problem}
            </span>
          ) : (
            hasOptions && (
              <span className="text-xs text-text-muted">
                {open ? t("workflows.hideOptions") : t("workflows.showOptions")}
              </span>
            )
          )}
        </button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onMove(-1)}
          disabled={index === 0}
          aria-label={t("workflows.moveUp")}
        >
          <ChevronUp aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onMove(1)}
          disabled={last}
          aria-label={t("workflows.moveDown")}
        >
          <ChevronDown aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRemove}
          aria-label={t("workflows.removeStep", { name: tx(tool.name) })}
        >
          <X aria-hidden />
        </Button>
      </div>
      {open && hasOptions && (
        <div className="space-y-4 border-t p-4">
          <OptionsForm schema={schema} value={values} onChange={onChange} pageCount={null} />
          {secrets.length > 0 && (
            <p className="flex items-center gap-2 text-xs text-text-muted">
              <KeyRound className="size-3.5" aria-hidden />
              {t("workflows.passwordsAtRun")}
            </p>
          )}
        </div>
      )}
      {!open && secrets.length > 0 && !hasOptions && (
        <p className="px-4 pb-3 text-xs text-text-muted">{t("workflows.passwordsAtRun")}</p>
      )}
    </li>
  );
}
