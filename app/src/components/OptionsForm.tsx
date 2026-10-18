import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
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
import { passwordStrength } from "@/lib/passwordStrength";
import { cn } from "@/lib/utils";
import {
  confirmError,
  describeOptions,
  isVisible,
  pageFieldError,
  type FieldDescriptor,
} from "@/tools/options";

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
          values={value}
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
  /** All current option values (for confirmation fields). */
  values: Record<string, unknown>;
}

function Field({ field, value, onChange, disabled, pageCount, values }: FieldProps) {
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

  if (field.kind === "enum" && field.meta.grid) {
    return (
      <fieldset className="space-y-2" disabled={disabled}>
        <legend className="mb-2 text-sm font-medium">{field.meta.label}</legend>
        <div
          role="radiogroup"
          aria-label={field.meta.label}
          className="grid w-36 grid-cols-3 gap-1 rounded-md border bg-surface-2/60 p-1"
        >
          {field.meta.choices?.map((c) => {
            const active = String(value) === c.value;
            return (
              <button
                key={c.value}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={c.label}
                title={c.label}
                onClick={() => onChange(c.value)}
                className={cn(
                  "flex h-9 items-center justify-center rounded transition-colors",
                  active ? "bg-primary" : "hover:bg-surface",
                )}
              >
                <span
                  className={cn(
                    "size-2.5 rounded-full",
                    active ? "bg-primary-foreground" : "bg-text-muted/50",
                  )}
                  aria-hidden
                />
              </button>
            );
          })}
        </div>
        {help}
      </fieldset>
    );
  }

  if (field.kind === "color") {
    const color = typeof value === "string" ? value : "#000000";
    return (
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor={id}>{field.meta.label}</Label>
        <span className="flex items-center gap-2">
          <span className="font-mono text-xs text-text-muted">{color.toUpperCase()}</span>
          <input
            id={id}
            type="color"
            value={color}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            className="h-9 w-12 cursor-pointer rounded border bg-surface p-1"
          />
        </span>
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

  if (field.kind === "password") {
    return (
      <PasswordField
        id={id}
        field={field}
        value={typeof value === "string" ? value : ""}
        onChange={onChange}
        disabled={disabled}
        error={confirmError(field, { ...values, [field.key]: value })}
        help={help}
        helpId={helpId}
      />
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

const METER = ["bg-danger", "bg-danger", "bg-warning", "bg-success", "bg-success"] as const;

function PasswordField({
  id,
  field,
  value,
  onChange,
  disabled,
  error,
  help,
  helpId,
}: {
  id: string;
  field: FieldDescriptor;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  error: string | null;
  help: React.ReactNode;
  helpId: string | undefined;
}) {
  const [visible, setVisible] = useState(false);
  const strength = field.meta.strength && value ? passwordStrength(value) : null;
  const errorId = `${id}-error`;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{field.meta.label}</Label>
      <div className="relative">
        <Input
          id={id}
          type={visible ? "text" : "password"}
          autoComplete="new-password"
          spellCheck={false}
          value={value}
          maxLength={127}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={
            [helpId, error ? errorId : undefined].filter(Boolean).join(" ") || undefined
          }
          className={cn("pr-10", error && "border-danger")}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? `Hide ${field.meta.label}` : `Show ${field.meta.label}`}
          className="absolute right-1 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded text-text-muted hover:text-text"
          disabled={disabled}
        >
          {visible ? (
            <EyeOff className="size-4" aria-hidden />
          ) : (
            <Eye className="size-4" aria-hidden />
          )}
        </button>
      </div>
      {strength && (
        <div className="space-y-1" aria-live="polite">
          <div className="flex gap-1" aria-hidden>
            {[0, 1, 2, 3].map((i) => (
              <span
                key={i}
                className={cn(
                  "h-1.5 flex-1 rounded-full",
                  i < Math.max(1, strength.score) ? METER[strength.score] : "bg-surface-2",
                )}
              />
            ))}
          </div>
          <p className="text-xs text-text-muted">
            Strength: <span className="font-medium text-text">{strength.label}</span>
          </p>
        </div>
      )}
      {error && (
        <p id={errorId} className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}
      {help}
    </div>
  );
}
