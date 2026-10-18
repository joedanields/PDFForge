import type { z } from "zod";
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
import { cn } from "@/lib/utils";
import { describeOptions, isVisible, pageFieldError, type FieldDescriptor } from "@/tools/options";

interface Props {
  schema: z.AnyZodObject;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  disabled?: boolean;
  /** Page count of the open document, for live page-range validation. */
  pageCount?: number | null;
}

/** Options panel generated from a tool's zod schema (docs/03 §5). */
export function OptionsForm({ schema, value, onChange, disabled = false, pageCount }: Props) {
  const fields = describeOptions(schema).filter((f) => isVisible(f, value));
  if (fields.length === 0) return null;
  const set = (key: string, v: unknown) => onChange({ ...value, [key]: v });
  return (
    <div className="space-y-5">
      {fields.map((field) => (
        <Field
          key={field.key}
          field={field}
          value={value[field.key] ?? field.defaultValue}
          onChange={(v) => set(field.key, v)}
          disabled={disabled}
          pageCount={pageCount ?? null}
        />
      ))}
    </div>
  );
}

interface FieldProps {
  field: FieldDescriptor;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
  pageCount: number | null;
}

function Field({ field, value, onChange, disabled, pageCount }: FieldProps) {
  const id = `opt-${field.key}`;
  const helpId = field.meta.help ? `${id}-help` : undefined;
  const help = field.meta.help && (
    <p id={helpId} className="text-xs text-text-muted">
      {field.meta.help}
    </p>
  );

  if (field.kind === "boolean") {
    return (
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label htmlFor={id}>{field.meta.label}</Label>
          {help}
        </div>
        <Switch
          id={id}
          checked={value === true}
          onCheckedChange={onChange}
          disabled={disabled}
          aria-describedby={helpId}
        />
      </div>
    );
  }

  if (field.kind === "enum" && field.meta.segmented) {
    return (
      <fieldset className="space-y-2" disabled={disabled}>
        <legend className="mb-2 text-sm font-medium">{field.meta.label}</legend>
        <div role="radiogroup" aria-label={field.meta.label} className="flex flex-wrap gap-1">
          {field.meta.choices?.map((c) => {
            const active = String(value) === c.value;
            return (
              <button
                key={c.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onChange(c.value)}
                className={cn(
                  "h-9 flex-1 rounded-md border px-3 text-sm font-medium transition-colors",
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "bg-surface hover:bg-surface-2",
                )}
              >
                {c.label}
              </button>
            );
          })}
        </div>
        {help}
      </fieldset>
    );
  }

  if (field.kind === "enum") {
    return (
      <div className="space-y-2">
        <Label htmlFor={id}>{field.meta.label}</Label>
        <Select value={String(value)} onValueChange={onChange} disabled={disabled}>
          <SelectTrigger id={id} aria-describedby={helpId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {field.meta.choices?.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {help}
      </div>
    );
  }

  if (field.kind === "pages") {
    const text = typeof value === "string" ? value : "";
    const error = pageFieldError(field, text, pageCount);
    const errorId = `${id}-error`;
    return (
      <div className="space-y-2">
        <Label htmlFor={id}>{field.meta.label}</Label>
        <Input
          id={id}
          value={text}
          placeholder={
            field.meta.placeholder ??
            (field.meta.pages?.emptyMeansAll ? "All pages" : "e.g. 1-3, 5")
          }
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={[helpId, error ? errorId : undefined].filter(Boolean).join(" ")}
          className={cn(error && "border-danger focus-visible:ring-danger")}
        />
        {error && (
          <p id={errorId} className="text-xs text-danger" role="alert">
            {error}
          </p>
        )}
        {help}
      </div>
    );
  }

  const isNumber = field.kind === "number";
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{field.meta.label}</Label>
      <Input
        id={id}
        type={field.meta.secret ? "password" : isNumber ? "number" : "text"}
        autoComplete={field.meta.secret ? "new-password" : undefined}
        min={field.min}
        max={field.max}
        step={isNumber ? (field.integer ? 1 : "any") : undefined}
        placeholder={field.meta.placeholder}
        value={typeof value === "number" || typeof value === "string" ? value : ""}
        onChange={(e) => {
          if (!isNumber) {
            onChange(e.target.value);
          } else if (!Number.isNaN(e.target.valueAsNumber)) {
            onChange(e.target.valueAsNumber);
          }
        }}
        disabled={disabled}
        aria-describedby={helpId}
      />
      {help}
    </div>
  );
}
