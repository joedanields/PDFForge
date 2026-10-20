/**
 * Fill PDF Forms (docs/02 E5): the form's fields as read by pdf.js `getFieldObjects()`,
 * reduced to what the fill-in list needs. The engine (tools/forms.py) writes the values.
 */

export type FieldKind = "text" | "checkbox" | "radio" | "choice";

export interface FormFieldOption {
  value: string;
  label: string;
}

export interface FormField {
  name: string;
  kind: FieldKind;
  /** 0-based page of the field's first widget. */
  page: number;
  value: string | boolean;
  options: FormFieldOption[];
  multiline: boolean;
  readOnly: boolean;
  maxLength: number | null;
}

/** The parts of a pdf.js field object we read. */
export interface PdfJsField {
  name?: string;
  type?: string;
  value?: unknown;
  page?: number;
  rect?: number[];
  editable?: boolean;
  hidden?: boolean;
  multiline?: boolean;
  password?: boolean;
  charLimit?: number;
  exportValues?: unknown;
  items?: { exportValue?: unknown; displayValue?: unknown }[];
}

const KINDS: Record<string, FieldKind> = {
  text: "text",
  checkbox: "checkbox",
  radiobutton: "radio",
  combobox: "choice",
  listbox: "choice",
};

const str = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "";

/** Fields in reading order (page, then top to bottom, then left to right). Buttons,
 * signatures, password and hidden fields are left out. */
export function normalizeFields(objects: Record<string, PdfJsField[] | undefined>): FormField[] {
  const fields: (FormField & { top: number; left: number })[] = [];
  for (const [name, entries] of Object.entries(objects)) {
    const widgets = (entries ?? []).filter((e) => e.type && KINDS[e.type]);
    const first = widgets[0];
    if (!first?.type || first.hidden || first.password) continue;
    const kind = KINDS[first.type];
    if (!kind) continue;
    const rect = first.rect ?? [0, 0, 0, 0];
    let value: string | boolean = str(first.value);
    let options: FormFieldOption[] = [];
    if (kind === "checkbox") {
      value = value !== "" && value !== "Off";
    } else if (kind === "radio") {
      options = widgets
        .map((w) => str(w.exportValues))
        .filter((v, i, all) => v && all.indexOf(v) === i)
        .map((v) => ({ value: v, label: v }));
      const selected = widgets.map((w) => str(w.value)).find((v) => v && v !== "Off");
      value = selected ?? "";
    } else if (kind === "choice") {
      options = (first.items ?? []).map((item) => ({
        value: str(item.exportValue),
        label: str(item.displayValue ?? item.exportValue),
      }));
      if (Array.isArray(first.value)) value = str(first.value[0]);
    }
    fields.push({
      name: first.name ?? name,
      kind,
      page: first.page ?? 0,
      value,
      options,
      multiline: first.multiline === true,
      readOnly: first.editable === false,
      maxLength:
        typeof first.charLimit === "number" && first.charLimit > 0 ? first.charLimit : null,
      top: -(rect[3] ?? 0),
      left: rect[0] ?? 0,
    });
  }
  fields.sort((a, b) => a.page - b.page || a.top - b.top || a.left - b.left);
  return fields.map((f) => ({
    name: f.name,
    kind: f.kind,
    page: f.page,
    value: f.value,
    options: f.options,
    multiline: f.multiline,
    readOnly: f.readOnly,
    maxLength: f.maxLength,
  }));
}

/** Values the user changed (only these are sent, so untouched fields stay exactly as they were). */
export function changedValues(
  fields: readonly FormField[],
  values: Readonly<Record<string, string | boolean>>,
): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const field of fields) {
    const value = values[field.name];
    if (value !== undefined && value !== field.value && !field.readOnly) out[field.name] = value;
  }
  return out;
}
