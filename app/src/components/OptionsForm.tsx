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
import { describeOptions, type FieldDescriptor } from "@/tools/options";

interface Props {
  schema: z.AnyZodObject;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  disabled?: boolean;
}

/** Options panel generated from a tool's zod schema (docs/03 §5). */
export function OptionsForm({ schema, value, onChange, disabled = false }: Props) {
  const fields = describeOptions(schema);
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
}

function Field({ field, value, onChange, disabled }: FieldProps) {
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

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{field.meta.label}</Label>
      <Input
        id={id}
        type={field.kind === "number" ? "number" : "text"}
        min={field.min}
        max={field.max}
        value={typeof value === "number" || typeof value === "string" ? value : ""}
        onChange={(e) =>
          onChange(field.kind === "number" ? e.target.valueAsNumber : e.target.value)
        }
        disabled={disabled}
        aria-describedby={helpId}
      />
      {help}
    </div>
  );
}
