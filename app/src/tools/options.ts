/**
 * Option schemas for tools. Each option is a zod schema with UI metadata attached, so the
 * Tool page can generate its options form straight from a tool's `optionsSchema`.
 */
import { z } from "zod";

export interface Choice {
  value: string;
  label: string;
}

export interface FieldMeta {
  label: string;
  help?: string;
  choices?: Choice[];
}

const META = new WeakMap<z.ZodTypeAny, FieldMeta>();

function withMeta<T extends z.ZodTypeAny>(schema: T, meta: FieldMeta): T {
  META.set(schema, meta);
  return schema;
}

export const opt = {
  bool(label: string, defaultValue: boolean, help?: string) {
    return withMeta(z.boolean().default(defaultValue), { label, help });
  },
  choice<const T extends readonly [Choice, ...Choice[]]>(
    label: string,
    choices: T,
    defaultValue: T[number]["value"],
    help?: string,
  ) {
    const values = choices.map((c) => c.value) as [T[number]["value"], ...T[number]["value"][]];
    return withMeta(z.enum(values).default(defaultValue), {
      label,
      help,
      choices: [...choices],
    });
  },
  int(label: string, min: number, max: number, defaultValue: number, help?: string) {
    return withMeta(z.number().int().min(min).max(max).default(defaultValue), { label, help });
  },
  text(label: string, defaultValue: string, help?: string) {
    return withMeta(z.string().default(defaultValue), { label, help });
  },
};

export type FieldKind = "boolean" | "enum" | "number" | "string";

export interface FieldDescriptor {
  key: string;
  kind: FieldKind;
  meta: FieldMeta;
  defaultValue: unknown;
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
        min: inner.minValue ?? undefined,
        max: inner.maxValue ?? undefined,
      };
    }
    return { key, kind: "string", meta, defaultValue };
  });
}

/** Default option values for a tool (schema parse of an empty object). */
export function defaultOptions(schema: z.AnyZodObject): Record<string, unknown> {
  return schema.parse({});
}
