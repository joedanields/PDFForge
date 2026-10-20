import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Eye, EyeOff, File, ImageIcon, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isTauri } from "@/engine/client";
import { tx } from "@/i18n";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  languageName,
  MAX_OCR_LANGUAGES,
  parseLanguages,
  toggleLanguage,
  useOcrLanguages,
} from "@/lib/ocrLanguages";
import { passwordStrength } from "@/lib/passwordStrength";
import { cn, fileName } from "@/lib/utils";
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
  // E2E seam (dev builds only): native file dialogs can't be automated over CDP.
  const latest = useRef({ value, onChange });
  useEffect(() => {
    latest.current = { value, onChange };
  });
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const onPick = (e: Event) => {
      const { key, path } = (e as CustomEvent<{ key: string; path: string }>).detail;
      if (!(key in schema.shape)) return;
      latest.current.onChange({ ...latest.current.value, [key]: path });
    };
    window.addEventListener("pdfforge:test-pick-file", onPick);
    return () => window.removeEventListener("pdfforge:test-pick-file", onPick);
  }, [schema]);

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
      {tx(field.meta.help)}
    </p>
  );

  if (field.kind === "boolean") {
    return (
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label htmlFor={id}>{tx(field.meta.label)}</Label>
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
        <legend className="mb-2 text-sm font-medium">{tx(field.meta.label)}</legend>
        <div
          role="radiogroup"
          aria-label={tx(field.meta.label)}
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
                aria-label={tx(c.label)}
                title={tx(c.label)}
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

  if (field.kind === "languages") {
    return (
      <LanguagePicker
        id={id}
        label={tx(field.meta.label)}
        value={value}
        onChange={onChange}
        disabled={disabled}
        help={help}
      />
    );
  }

  if (field.kind === "file" && field.meta.file) {
    const path = typeof value === "string" ? value : "";
    const spec = field.meta.file;
    const choose = async () => {
      if (!isTauri()) return;
      const picked = await openDialog({
        multiple: false,
        filters: [{ name: tx(spec.name), extensions: [...spec.extensions] }],
      });
      if (typeof picked === "string") onChange(picked);
    };
    return (
      <div className="space-y-2">
        <Label htmlFor={id}>{tx(field.meta.label)}</Label>
        <div className="flex items-center gap-2 rounded-md border bg-surface-2/60 px-3 py-2">
          {spec.extensions.includes("png") ? (
            <ImageIcon className="size-4 shrink-0 text-text-muted" aria-hidden />
          ) : (
            <File className="size-4 shrink-0 text-text-muted" aria-hidden />
          )}
          <span className="flex-1 truncate text-sm" title={path || undefined}>
            {path ? fileName(path) : tx("No file chosen")}
          </span>
          {path && (
            <Button
              size="icon"
              variant="ghost"
              className="size-6"
              aria-label={tx("Clear {label}", { label: tx(field.meta.label) })}
              onClick={() => onChange("")}
              disabled={disabled}
            >
              <X />
            </Button>
          )}
        </div>
        <Button
          id={id}
          size="sm"
          variant="secondary"
          onClick={() => void choose()}
          disabled={disabled}
        >
          {tx("Choose…")}
        </Button>
        {help}
      </div>
    );
  }

  if (field.kind === "color") {
    const color = typeof value === "string" ? value : "#000000";
    return (
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor={id}>{tx(field.meta.label)}</Label>
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
        <legend className="mb-2 text-sm font-medium">{tx(field.meta.label)}</legend>
        <div role="radiogroup" aria-label={tx(field.meta.label)} className="flex flex-wrap gap-1">
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
                {tx(c.label)}
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
        <Label htmlFor={id}>{tx(field.meta.label)}</Label>
        <Select value={String(value)} onValueChange={onChange} disabled={disabled}>
          <SelectTrigger id={id} aria-describedby={helpId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {field.meta.choices?.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {tx(c.label)}
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
        <Label htmlFor={id}>{tx(field.meta.label)}</Label>
        <Input
          id={id}
          value={text}
          placeholder={
            field.meta.placeholder
              ? tx(field.meta.placeholder)
              : tx(field.meta.pages?.emptyMeansAll ? "All pages" : "e.g. 1-3, 5")
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
      <Label htmlFor={id}>{tx(field.meta.label)}</Label>
      <Input
        id={id}
        type={field.meta.secret ? "password" : isNumber ? "number" : "text"}
        autoComplete={field.meta.secret ? "new-password" : undefined}
        min={field.min}
        max={field.max}
        step={isNumber ? (field.integer ? 1 : "any") : undefined}
        placeholder={field.meta.placeholder && tx(field.meta.placeholder)}
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
      <Label htmlFor={id}>{tx(field.meta.label)}</Label>
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
          aria-label={tx(visible ? "Hide {label}" : "Show {label}", {
            label: tx(field.meta.label),
          })}
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
            {tx("Strength")}: <span className="font-medium text-text">{tx(strength.label)}</span>
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

/** OCR language chips: every installed language, several can be on ("eng+tam"). */
function LanguagePicker({
  id,
  label,
  value,
  onChange,
  disabled,
  help,
}: {
  id: string;
  label: string;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
  help: ReactNode;
}) {
  const { languages } = useOcrLanguages();
  const selected = parseLanguages(value);
  return (
    <fieldset className="space-y-2" id={id}>
      <legend className="text-sm font-medium">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {languages.map((lang) => {
          const on = selected.includes(lang.code);
          return (
            <button
              key={lang.code}
              type="button"
              role="checkbox"
              aria-checked={on}
              disabled={disabled}
              onClick={() => onChange(toggleLanguage(value, lang.code))}
              className={cn(
                "h-8 rounded-full border px-3 text-sm transition-colors",
                on
                  ? "border-primary bg-primary text-primary-foreground"
                  : "bg-surface hover:bg-surface-2",
              )}
            >
              {languageName(lang.code)}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-text-muted">
        Pick every language the document is written in (up to {MAX_OCR_LANGUAGES}). More languages
        can be added in Settings.
      </p>
      {help}
    </fieldset>
  );
}
