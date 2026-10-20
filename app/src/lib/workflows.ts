/**
 * Workflows (docs/02 §G): saved chains of tools. Mirrors engine/tools/workflow.py STEP_KINDS.
 * Saved workflows never contain passwords; those are asked for each time a workflow runs.
 */
import type { z } from "zod";
import { tx } from "@/i18n";
import { describeOptions, defaultOptions, splitSecrets } from "@/tools/options";
import { getTool, type AcceptSpec, type ToolDef } from "@/tools/registry";
import { BATCH_MAX } from "./batch";

export interface WorkflowStep {
  tool: string;
  /** Form values (as in the tool's options form), without secrets. */
  options: Record<string, unknown>;
}

export interface Workflow {
  id: string;
  name: string;
  steps: WorkflowStep[];
  created: number;
  updated: number;
}

interface StepKind {
  /** "source": the tool's own input formats (first step only). */
  accepts: "pdf" | "source";
  /** "other": not a PDF (last step only). */
  produces: "pdf" | "other";
  /** Takes all files at once (Merge, Image → PDF); otherwise runs once per file. */
  combines?: boolean;
}

export const STEP_KINDS: Record<string, StepKind> = {
  merge: { accepts: "pdf", produces: "pdf", combines: true },
  "image-to-pdf": { accepts: "source", produces: "pdf", combines: true },
  "word-to-pdf": { accepts: "source", produces: "pdf" },
  "powerpoint-to-pdf": { accepts: "source", produces: "pdf" },
  "excel-to-pdf": { accepts: "source", produces: "pdf" },
  "text-to-pdf": { accepts: "source", produces: "pdf" },
  "html-to-pdf": { accepts: "source", produces: "pdf" },
  rotate: { accepts: "pdf", produces: "pdf" },
  "remove-pages": { accepts: "pdf", produces: "pdf" },
  "extract-pages": { accepts: "pdf", produces: "pdf" },
  split: { accepts: "pdf", produces: "pdf" },
  compress: { accepts: "pdf", produces: "pdf" },
  repair: { accepts: "pdf", produces: "pdf" },
  ocr: { accepts: "pdf", produces: "pdf" },
  "pdf-to-pdfa": { accepts: "pdf", produces: "pdf" },
  "page-numbers": { accepts: "pdf", produces: "pdf" },
  watermark: { accepts: "pdf", produces: "pdf" },
  protect: { accepts: "pdf", produces: "pdf" },
  unlock: { accepts: "pdf", produces: "pdf" },
  "pdf-to-image": { accepts: "pdf", produces: "other" },
  "pdf-to-word": { accepts: "pdf", produces: "other" },
  "pdf-to-powerpoint": { accepts: "pdf", produces: "other" },
  "pdf-to-excel": { accepts: "pdf", produces: "other" },
  "pdf-to-text": { accepts: "pdf", produces: "other" },
};

/** Tools that can be a workflow step, in registry order. */
export function stepTools(tools: readonly ToolDef[]): ToolDef[] {
  return tools.filter((tool) => tool.id in STEP_KINDS && tool.status === "available");
}

export function newWorkflowId(): string {
  return crypto.randomUUID();
}

export function newStep(toolId: string): WorkflowStep {
  const tool = getTool(toolId);
  if (!tool) throw new Error(`Unknown tool ${toolId}`);
  return {
    tool: toolId,
    options: withoutSecrets(tool.optionsSchema, defaultOptions(tool.optionsSchema)),
  };
}

/** Form values minus passwords and their confirmations (never saved). */
export function withoutSecrets(
  schema: z.AnyZodObject,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const hidden = new Set(
    describeOptions(schema)
      .filter((f) => f.meta.secret || f.meta.confirmOf)
      .map((f) => f.key),
  );
  return Object.fromEntries(Object.entries(values).filter(([key]) => !hidden.has(key)));
}

/** Keys of the password fields a step asks for when the workflow runs. */
export function secretKeys(schema: z.AnyZodObject): string[] {
  return describeOptions(schema)
    .filter((f) => f.meta.secret || f.meta.confirmOf)
    .map((f) => f.key);
}

/** Why the chain can't run as is, per step index (empty when it can). */
export function chainProblems(steps: readonly WorkflowStep[]): Map<number, string> {
  const problems = new Map<number, string>();
  steps.forEach((step, index) => {
    const kind = STEP_KINDS[step.tool];
    const tool = getTool(step.tool);
    if (!kind || !tool) {
      problems.set(index, tx("This tool can't be used in a workflow."));
      return;
    }
    if (index > 0 && kind.accepts !== "pdf") {
      problems.set(index, tx("{name} can only be the first step.", { name: tx(tool.name) }));
    } else if (index < steps.length - 1 && kind.produces !== "pdf") {
      problems.set(
        index,
        tx("{name} makes no PDF, so it can only be the last step.", { name: tx(tool.name) }),
      );
    }
  });
  return problems;
}

/** Any combining step: the whole workflow runs once over all files, else once per file. */
export function runsOnAllFiles(steps: readonly WorkflowStep[]): boolean {
  return steps.some((s) => STEP_KINDS[s.tool]?.combines === true);
}

/** Files the workflow takes: whatever its first step takes, up to the batch maximum. */
export function workflowAccepts(steps: readonly WorkflowStep[]): AcceptSpec | null {
  const first = steps[0] && getTool(steps[0].tool);
  if (!first) return null;
  return { ...first.accepts, min: 1, max: BATCH_MAX };
}

/** One step as the engine's workflow step plus its secrets (sent outside `options`). */
export function stepForEngine(
  step: WorkflowStep,
  secrets: Record<string, unknown>,
): { step: { tool: string; options: Record<string, unknown> }; secrets: Record<string, unknown> } {
  const tool = getTool(step.tool);
  if (!tool) throw new Error(`Unknown tool ${step.tool}`);
  const values = { ...defaultOptions(tool.optionsSchema), ...step.options, ...secrets };
  const parsed = tool.optionsSchema.safeParse(values);
  const valid = parsed.success ? (parsed.data as Record<string, unknown>) : values;
  const split = splitSecrets(tool.optionsSchema, valid);
  return {
    step: {
      tool: step.tool,
      options: tool.toEngine ? tool.toEngine(split.options) : split.options,
    },
    secrets: split.secrets,
  };
}

/** Problem with a step's saved options (e.g. a tool changed its options since). */
export function stepOptionsError(step: WorkflowStep): string | null {
  const tool = getTool(step.tool);
  if (!tool) return "Unknown tool";
  const parsed = tool.optionsSchema.safeParse({
    ...defaultOptions(tool.optionsSchema),
    ...step.options,
  });
  return parsed.success ? null : tx("Some options are not valid.");
}
