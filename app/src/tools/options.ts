/**
 * Option schemas for tools. Each option is a zod schema with UI metadata attached, so the
 * Tool page can generate its options form straight from a tool's `optionsSchema`.
 */
import { z } from "zod";
import { parseRanges } from "@/lib/pageRanges";

export interface Choice {
  value: string;
  label: string;
}

export interface FieldMeta {
  label: string;
  help?: string;
  choices?: Choice[];
  /** Render choices as a row of buttons instead of a dropdown. */
  segmented?: boolean;
  /** Render a 9-choice option as a 3×3 position picker (top-left … bottom-right). */
  grid?: boolean;
  /** Text option holding a #RRGGBB colour. */
  color?: boolean;
  /** Page-range text bound to the thumbnail grid; empty means "all pages" when set. */
  pages?: { emptyMeansAll: boolean };
  /** Only show this field while another option has one of these values. */
  showWhen?: { key: string; values: readonly string[] };
  /** Secret values (passwords) are sent outside `options` and never stored in history. */
  secret?: boolean;
  /** Password field: show a strength meter. */
  strength?: boolean;
  /** Confirmation of another (secret) field: checked in the UI, never sent to the engine. */
  confirmOf?: string;
  /** Only show this field once another text option is filled in. */
  showWhenFilled?: string;
  placeholder?: string;
}

const META = new WeakMap<z.ZodTypeAny, FieldMeta>();

function withMeta<T extends z.ZodTypeAny>(schema: T, meta: FieldMeta): T {
  META.set(schema, meta);
  return schema;
}

type Extra = Partial<Omit<FieldMeta, "label" | "help" | "choices">>;

export const opt = {
  bool(label: string, defaultValue: boolean, help?: string, extra?: Extra) {
    return withMeta(z.boolean().default(defaultValue), { label, help, ...extra });
  },
  choice<const T extends readonly [Choice, ...Choice[]]>(
    label: string,
    choices: T,
    defaultValue: T[number]["value"],
    help?: string,
    extra?: Extra,
  ) {
    const values = choices.map((c) => c.value) as [T[number]["value"], ...T[number]["value"][]];
    return withMeta(z.enum(values).default(defaultValue), {
      label,
      help,
      choices: [...choices],
      ...extra,
    });
  },
  int(label: string, min: number, max: number, defaultValue: number, help?: string, extra?: Extra) {
    return withMeta(z.number().int().min(min).max(max).default(defaultValue), {
      label,
      help,
      ...extra,
    });
  },
  number(
    label: string,
    min: number,
    max: number,
    defaultValue: number,
    help?: string,
    extra?: Extra,
  ) {
    return withMeta(z.number().min(min).max(max).default(defaultValue), { label, help, ...extra });
  },
  text(label: string, defaultValue: string, help?: string, extra?: Extra) {
    return withMeta(z.string().default(defaultValue), { label, help, ...extra });
  },
  password(label: string, help?: string, extra?: Extra) {
    return withMeta(z.string().max(127).default(""), {
      label,
      help,
      secret: true,
      strength: true,
      ...extra,
    });
  },
  confirm(label: string, of: string, extra?: Extra) {
    return withMeta(z.string().default(""), { label, secret: true, confirmOf: of, ...extra });
  },
  color(label: string, defaultValue: string, help?: string, extra?: Extra) {
    return withMeta(
      z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .default(defaultValue),
      { label, help, color: true, ...extra },
    );
  },
  pages(label: string, help: string, emptyMeansAll: boolean, extra?: Extra) {
    return withMeta(z.string().default(""), { label, help, pages: { emptyMeansAll }, ...extra });
  },
};

export type FieldKind = "boolean" | "enum" | "number" | "string" | "pages" | "password" | "color";

export interface FieldDescriptor {
  key: string;
  kind: FieldKind;
  meta: FieldMeta;
  defaultValue: unknown;
  integer?: boolean;
  min?: number;
  max?: number;
}

function unwrap(schema: z.ZodTypeAny): { inner: z.ZodTypeAny; defaultValue: unknown } {
  let current = schema;
  let defaultValue: unknown = undefined;
  for (;;) {
    if (current instanceof z.ZodDefault) {
      defaultValue ??= (current._def as { defaultValue: () => unknown }).defaultValue();
      current = current.removeDefault() as z.ZodTypeAny;
    } else if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      current = current.unwrap() as z.ZodTypeAny;
    } else {
      return { inner: current, defaultValue };
    }
  }
}

/** Describe each field of an options schema for form generation. */
export function describeOptions(schema: z.AnyZodObject): FieldDescriptor[] {
  return Object.entries(schema.shape as Record<string, z.ZodTypeAny>).map(([key, field]) => {
    const meta = META.get(field) ?? { label: key };
    const { inner, defaultValue } = unwrap(field);
    if (inner instanceof z.ZodBoolean) return { key, kind: "boolean", meta, defaultValue };
    if (inner instanceof z.ZodEnum) return { key, kind: "enum", meta, defaultValue };
    if (inner instanceof z.ZodNumber) {
      return {
        key,
        kind: "number",
        meta,
        defaultValue,
        integer: inner.isInt,
        min: inner.minValue ?? undefined,
        max: inner.maxValue ?? undefined,
      };
    }
    const kind: FieldKind = meta.pages
      ? "pages"
      : meta.secret
        ? "password"
        : meta.color
          ? "color"
          : "string";
    return { key, kind, meta, defaultValue };
  });
}

/** Is this field visible for the current option values? */
export function isVisible(field: FieldDescriptor, values: Record<string, unknown>): boolean {
  const filled = field.meta.showWhenFilled;
  if (filled !== undefined) {
    const value = values[filled];
    if (typeof value !== "string" || value === "") return false;
  }
  const rule = field.meta.showWhen;
  if (!rule) return true;
  return rule.values.includes(String(values[rule.key]));
}

/** Default option values for a tool (schema parse of an empty object). */
export function defaultOptions(schema: z.AnyZodObject): Record<string, unknown> {
  return schema.parse({});
}

/** Split secret fields (passwords) from ordinary options. */
export function splitSecrets(
  schema: z.AnyZodObject,
  values: Record<string, unknown>,
): { options: Record<string, unknown>; secrets: Record<string, unknown> } {
  const options: Record<string, unknown> = {};
  const secrets: Record<string, unknown> = {};
  const fields = describeOptions(schema);
  const secretKeys = new Set(fields.filter((f) => f.meta.secret).map((f) => f.key));
  const confirmKeys = new Set(fields.filter((f) => f.meta.confirmOf).map((f) => f.key));
  for (const [key, value] of Object.entries(values)) {
    if (confirmKeys.has(key)) continue; // UI-only
    (secretKeys.has(key) ? secrets : options)[key] = value;
  }
  return { options, secrets };
}

/** Error for a page-range field, or null when valid (empty = all pages when allowed). */
export function pageFieldError(
  field: FieldDescriptor,
  text: string,
  pageCount: number | null,
): string | null {
  if (!field.meta.pages || pageCount == null) return null;
  if (text.trim() === "") return field.meta.pages.emptyMeansAll ? null : "Select at least one page";
  const result = parseRanges(text, pageCount);
  return result.ok ? null : result.error;
}

/** Message for a confirmation field that doesn't match, or null. */
export function confirmError(
  field: FieldDescriptor,
  values: Record<string, unknown>,
): string | null {
  const of = field.meta.confirmOf;
  if (!of) return null;
  const original = values[of];
  const confirm = values[field.key];
  if (typeof original !== "string" || original === "") return null;
  return confirm === original ? null : "The passwords don't match";
}
