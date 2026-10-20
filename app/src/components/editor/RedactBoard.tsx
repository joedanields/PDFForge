import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t, tx } from "@/i18n";
import { DEFAULT_STYLE, type EditObject, newId, REDACT_STYLE } from "@/lib/editor";
import type { InputFile } from "@/lib/files";
import { PdfSource } from "@/lib/pdfjs";
import { findAreas, PRESETS, termPattern } from "@/lib/redactSearch";
import { EditorBoard } from "./EditorBoard";

interface Props {
  file: InputFile;
  disabled?: boolean;
  onChange: (objects: EditObject[]) => void;
}

/** Redact PDF (02 F4): mark areas by hand or by searching text and patterns. */
export function RedactBoard({ file, disabled = false, onChange }: Props) {
  const [source, setSource] = useState<PdfSource | null>(null);
  const [term, setTerm] = useState("");
  const [presets, setPresets] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [incoming, setIncoming] = useState<{ nonce: number; objects: EditObject[] } | null>(null);

  useEffect(() => {
    let alive = true;
    let opened: PdfSource | null = null;
    void PdfSource.open(file.path, file.password).then((res) => {
      if (res.kind !== "ok") return;
      if (!alive) {
        void res.source.destroy();
        return;
      }
      opened = res.source;
      setSource(res.source);
    });
    return () => {
      alive = false;
      void opened?.destroy();
    };
  }, [file.path, file.password]);

  const search = async () => {
    if (!source) return;
    const patterns = [
      ...(termPattern(term) ? [termPattern(term) as RegExp] : []),
      ...PRESETS.filter((p) => presets.includes(p.id)).map((p) => p.pattern),
    ];
    if (patterns.length === 0) {
      setStatus(t("redact.nothingToFind"));
      return;
    }
    setBusy(true);
    try {
      const objects: EditObject[] = [];
      for (let page = 0; page < source.numPages; page += 1) {
        const items = await source.textItems(page);
        for (const area of findAreas(items, patterns, page)) {
          objects.push({
            ...DEFAULT_STYLE,
            ...REDACT_STYLE,
            id: newId(),
            kind: "rect",
            points: [],
            text: "",
            ...area,
          });
        }
      }
      setIncoming({ nonce: Date.now(), objects });
      setStatus(
        objects.length === 0
          ? t("redact.noMatches")
          : t("redact.marked", { count: objects.length }),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <form
        role="search"
        aria-label={t("redact.find")}
        className="space-y-3 rounded-card border bg-surface p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label={t("redact.term")}
            placeholder={t("redact.termPlaceholder")}
            className="max-w-sm"
            value={term}
            disabled={disabled}
            onChange={(e) => setTerm(e.target.value)}
          />
          <Button type="submit" variant="secondary" disabled={disabled || busy || !source}>
            <Search aria-hidden />
            {t("redact.markAll")}
          </Button>
          {status && (
            <span className="text-sm text-text-muted" role="status">
              {status}
            </span>
          )}
        </div>
        <fieldset className="flex flex-wrap gap-4 text-sm">
          <legend className="sr-only">{t("redact.presets")}</legend>
          {PRESETS.map((p) => (
            <label key={p.id} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={presets.includes(p.id)}
                disabled={disabled}
                onChange={(e) =>
                  setPresets((all) =>
                    e.target.checked ? [...all, p.id] : all.filter((x) => x !== p.id),
                  )
                }
              />
              {tx(p.label)}
            </label>
          ))}
        </fieldset>
        <p className="text-xs text-text-muted">{t("redact.help")}</p>
      </form>
      <EditorBoard
        file={file}
        disabled={disabled}
        onChange={onChange}
        tools={["select", "rect", "eraser"]}
        defaultStyle={REDACT_STYLE}
        incoming={incoming}
      />
    </div>
  );
}
