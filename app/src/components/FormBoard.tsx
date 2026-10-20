import { FileText, LoaderCircle, X } from "lucide-react";
import { useEffect, useState } from "react";
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
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n";
import type { InputFile } from "@/lib/files";
import { changedValues, normalizeFields, type FormField, type PdfJsField } from "@/lib/formFields";

interface Props {
  file: InputFile;
  disabled: boolean;
  onRemove: () => void;
  /** Changed values (field name → value) and how many fields the form has. */
  onChange: (values: Record<string, string | boolean>, fieldCount: number) => void;
}

type Loaded = { kind: "loading" } | { kind: "error" } | { kind: "ok"; fields: FormField[] };

/** Fill PDF Forms (docs/02 E5): every fillable field of the PDF as a form, page by page. */
export function FormBoard({ file, disabled, onRemove, onChange }: Props) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [values, setValues] = useState<Record<string, string | boolean>>({});

  useEffect(() => {
    const state = { cancelled: false };
    const cancelled = () => state.cancelled;
    void (async () => {
      const { openDocument } = await import("@/lib/pdfjs");
      const res = await openDocument(file.path, file.password);
      if (res.kind !== "ok") {
        if (!cancelled()) setLoaded({ kind: "error" });
        return;
      }
      try {
        const objects: Record<string, PdfJsField[]> | null = await res.doc.getFieldObjects();
        const fields = normalizeFields(objects ?? {});
        if (cancelled()) return;
        setLoaded({ kind: "ok", fields });
        setValues(Object.fromEntries(fields.map((f) => [f.name, f.value])));
        onChange({}, fields.length);
      } finally {
        void res.doc.destroy();
      }
    })();
    return () => {
      state.cancelled = true;
    };
    // The board is keyed by file; onChange is stable (a state setter wrapper).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path, file.password]);

  const set = (name: string, value: string | boolean) => {
    if (loaded.kind !== "ok") return;
    const next = { ...values, [name]: value };
    setValues(next);
    onChange(changedValues(loaded.fields, next), loaded.fields.length);
  };

  const pages = loaded.kind === "ok" ? [...new Set(loaded.fields.map((f) => f.page))] : [];

  return (
    <section className="space-y-4 rounded-card border bg-surface p-5" aria-label={t("forms.title")}>
      <div className="flex items-center gap-3">
        <FileText className="size-5 text-text-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{file.name}</p>
          {loaded.kind === "ok" && (
            <p className="text-xs text-text-muted">
              {t("forms.count", { count: loaded.fields.length })}
            </p>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRemove}
          disabled={disabled}
          aria-label={t("file.remove", { name: file.name })}
        >
          <X aria-hidden />
        </Button>
      </div>

      {loaded.kind === "loading" && (
        <p className="flex items-center gap-2 text-sm text-text-muted">
          <LoaderCircle className="size-4 animate-spin" aria-hidden />
          {t("forms.reading")}
        </p>
      )}
      {loaded.kind === "error" && <p className="text-sm text-danger">{t("file.unreadable")}</p>}
      {loaded.kind === "ok" && loaded.fields.length === 0 && (
        <p className="rounded-md bg-surface-2 px-4 py-3 text-sm">{t("forms.none")}</p>
      )}

      {pages.map((page) => (
        <fieldset key={page} className="space-y-4 border-t pt-4" disabled={disabled}>
          <legend className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            {t("forms.page", { n: page + 1 })}
          </legend>
          {loaded.kind === "ok" &&
            loaded.fields
              .filter((f) => f.page === page)
              .map((field) => (
                <FieldInput
                  key={field.name}
                  field={field}
                  value={values[field.name] ?? field.value}
                  onChange={(v) => set(field.name, v)}
                />
              ))}
        </fieldset>
      ))}
    </section>
  );
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: string | boolean;
  onChange: (value: string | boolean) => void;
}) {
  const id = `field-${field.name}`;
  const label = (
    <Label htmlFor={id}>
      {field.name}
      {field.readOnly && (
        <span className="ml-2 text-xs text-text-muted">{t("forms.readOnly")}</span>
      )}
    </Label>
  );

  if (field.kind === "checkbox") {
    return (
      <div className="flex items-center justify-between gap-4">
        {label}
        <Switch
          id={id}
          checked={value === true}
          onCheckedChange={onChange}
          disabled={field.readOnly}
        />
      </div>
    );
  }
  if (field.kind === "radio") {
    return (
      <div className="space-y-2" role="radiogroup" aria-labelledby={`${id}-label`}>
        <p id={`${id}-label`} className="text-sm font-medium">
          {field.name}
        </p>
        <div className="flex flex-wrap gap-4">
          {field.options.map((opt) => (
            <label key={opt.value} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={id}
                value={opt.value}
                checked={value === opt.value}
                disabled={field.readOnly}
                onChange={() => onChange(opt.value)}
                className="size-4 accent-primary"
              />
              {opt.label}
            </label>
          ))}
        </div>
      </div>
    );
  }
  if (field.kind === "choice") {
    return (
      <div className="space-y-2">
        {label}
        <Select value={String(value)} onValueChange={onChange} disabled={field.readOnly}>
          <SelectTrigger id={id}>
            <SelectValue placeholder={t("forms.choose")} />
          </SelectTrigger>
          <SelectContent>
            {field.options
              .filter((o) => o.value !== "")
              .map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {label}
      {field.multiline ? (
        <textarea
          id={id}
          value={String(value)}
          maxLength={field.maxLength ?? undefined}
          readOnly={field.readOnly}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          className="w-full rounded-md border bg-surface px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        />
      ) : (
        <Input
          id={id}
          value={String(value)}
          maxLength={field.maxLength ?? undefined}
          readOnly={field.readOnly}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}
