import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { CalendarDays, PenTool, Plus, Type as TypeIcon, Upload, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, isTauri } from "@/engine/client";
import { t } from "@/i18n";
import { DEFAULT_STYLE, type EditObject } from "@/lib/editor";
import type { InputFile } from "@/lib/files";
import {
  dataUrl,
  fromCanvas,
  INK_COLORS,
  loadSignatures,
  type Signature,
  SIGNATURE_FONTS,
  type SignatureKind,
  typedSignature,
  uploadedSignature,
} from "@/lib/signatures";
import { cn } from "@/lib/utils";
import { EditorBoard } from "./EditorBoard";

type Stamp = Omit<EditObject, "id" | "page" | "x" | "y">;

interface Props {
  file: InputFile;
  disabled?: boolean;
  onChange: (objects: EditObject[]) => void;
  /** PNG (base64) of every signature that may be referenced as "secret:<id>". */
  onImages: (images: Record<string, string>) => void;
}

/** Sign PDF (02 F3): saved signatures + initials, date and text placed with the page editor. */
export function SignBoard({ file, disabled = false, onChange, onImages }: Props) {
  const [signatures, setSignatures] = useState<Signature[]>([]);
  const [stamp, setStamp] = useState<Stamp | null>(null);
  const [creating, setCreating] = useState<SignatureKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadSignatures()
      .then(setSignatures)
      .catch((err: unknown) => setError(String(err)));
  }, []);

  useEffect(() => {
    onImages(Object.fromEntries(signatures.map((s) => [s.id, s.png])));
  }, [signatures, onImages]);

  const place = (s: Signature) => {
    const width = s.kind === "initials" ? 0.1 : 0.28;
    setStamp({
      ...DEFAULT_STYLE,
      kind: "image",
      w: width,
      h: width * s.ratio, // as a fraction of the page width; the canvas converts it
      points: [],
      text: "",
      stroke: null,
      image: `secret:${s.id}`,
      imageUrl: dataUrl(s.png),
    });
  };

  const placeText = (text: string) => {
    setStamp({
      ...DEFAULT_STYLE,
      kind: "text",
      w: 0.3,
      h: 0.035,
      points: [],
      text,
      size: 12,
    });
  };

  const remove = async (s: Signature) => {
    setSignatures((all) => all.filter((x) => x.id !== s.id));
    if (!s.transient && isTauri()) await api.deleteSignature(s.id).catch(() => undefined);
  };

  const today = new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(new Date());

  return (
    <div className="space-y-3">
      <section
        aria-label={t("sign.yours")}
        className="flex flex-wrap items-center gap-2 rounded-card border bg-surface p-3"
      >
        {signatures.map((s) => (
          <div key={s.id} className="group relative">
            <button
              type="button"
              aria-label={t(s.kind === "initials" ? "sign.placeInitials" : "sign.placeSignature")}
              disabled={disabled}
              onClick={() => place(s)}
              className="flex h-14 w-36 items-center justify-center rounded-md border bg-white p-1 hover:border-primary"
            >
              <img src={dataUrl(s.png)} alt="" className="max-h-full max-w-full" />
            </button>
            <button
              type="button"
              aria-label={t("sign.delete")}
              onClick={() => void remove(s)}
              className="absolute -right-2 -top-2 hidden size-5 items-center justify-center rounded-full bg-danger text-white group-hover:flex"
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
        <Button variant="secondary" disabled={disabled} onClick={() => setCreating("signature")}>
          <Plus aria-hidden />
          {t("sign.addSignature")}
        </Button>
        <Button variant="secondary" disabled={disabled} onClick={() => setCreating("initials")}>
          <Plus aria-hidden />
          {t("sign.addInitials")}
        </Button>
        <Button variant="ghost" disabled={disabled} onClick={() => placeText(today)}>
          <CalendarDays aria-hidden />
          {t("sign.date")}
        </Button>
        <Button
          variant="ghost"
          disabled={disabled}
          onClick={() => placeText(t("sign.textDefault"))}
        >
          <TypeIcon aria-hidden />
          {t("sign.text")}
        </Button>
        {stamp && (
          <span className="ml-auto text-sm text-primary" role="status">
            {t("sign.clickToPlace")}
          </span>
        )}
      </section>
      {error && (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      )}
      <EditorBoard
        file={file}
        disabled={disabled}
        onChange={onChange}
        tools={["select", "text", "eraser"]}
        stamp={stamp}
        onStampPlaced={() => setStamp(null)}
      />
      {creating && (
        <CreateSignatureDialog
          kind={creating}
          onClose={() => setCreating(null)}
          onCreated={(s) => {
            setSignatures((all) => [...all, s]);
            setCreating(null);
            place(s);
          }}
        />
      )}
    </div>
  );
}

type Mode = "type" | "draw" | "upload";

function CreateSignatureDialog({
  kind,
  onClose,
  onCreated,
}: {
  kind: SignatureKind;
  onClose: () => void;
  onCreated: (s: Signature) => void;
}) {
  const [mode, setMode] = useState<Mode>("type");
  const [text, setText] = useState("");
  const [font, setFont] = useState<string>(SIGNATURE_FONTS[0].family);
  const [color, setColor] = useState<string>(INK_COLORS[0]);
  const [save, setSave] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const padRef = useRef<HTMLCanvasElement>(null);
  const [uploaded, setUploaded] = useState<{ png: string; ratio: number } | null>(null);

  const finish = async () => {
    setError(null);
    setBusy(true);
    try {
      let result: { png: string; ratio: number } | null = null;
      if (mode === "type") result = await typedSignature(text, font, color);
      if (mode === "draw" && padRef.current) result = fromCanvas(padRef.current);
      if (mode === "upload") result = uploaded;
      if (!result) {
        setError(t("sign.emptySignature"));
        return;
      }
      if (save && isTauri()) {
        const stored = await api.saveSignature(kind, result.png);
        onCreated({ id: stored.id, kind, png: result.png, ratio: result.ratio });
      } else {
        const id = `t${Date.now().toString(36)}`;
        onCreated({ id, kind, png: result.png, ratio: result.ratio, transient: true });
      }
    } catch (err) {
      setError(typeof err === "string" ? err : String(err));
    } finally {
      setBusy(false);
    }
  };

  const chooseUpload = async () => {
    if (!isTauri()) return;
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "Pictures", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"] }],
    });
    if (typeof picked === "string") setUploaded(await uploadedSignature(picked));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent aria-describedby={undefined} className="max-w-xl">
        <DialogTitle className="text-lg font-semibold">
          {t(kind === "initials" ? "sign.createInitials" : "sign.createSignature")}
        </DialogTitle>
        <div role="tablist" className="mt-3 flex gap-1">
          {(
            [
              ["type", t("sign.modeType"), <TypeIcon key="t" />],
              ["draw", t("sign.modeDraw"), <PenTool key="d" />],
              ["upload", t("sign.modeUpload"), <Upload key="u" />],
            ] as const
          ).map(([value, label, icon]) => (
            <Button
              key={value}
              role="tab"
              aria-selected={mode === value}
              variant={mode === value ? "primary" : "ghost"}
              size="sm"
              onClick={() => setMode(value)}
            >
              {icon}
              {label}
            </Button>
          ))}
        </div>
        <div className="mt-4 space-y-3">
          {mode === "type" && (
            <>
              <Input
                aria-label={t("sign.typeLabel")}
                placeholder={t(
                  kind === "initials" ? "sign.initialsPlaceholder" : "sign.namePlaceholder",
                )}
                value={text}
                autoFocus
                onChange={(e) => setText(e.target.value)}
              />
              <div className="grid grid-cols-2 gap-2">
                {SIGNATURE_FONTS.map((f) => (
                  <button
                    key={f.family}
                    type="button"
                    aria-label={f.label}
                    aria-pressed={font === f.family}
                    onClick={() => setFont(f.family)}
                    className={cn(
                      "h-16 truncate rounded-md border bg-white px-3 text-2xl",
                      font === f.family && "border-primary ring-2 ring-primary",
                    )}
                    style={{ fontFamily: f.family, color }}
                  >
                    {text || (kind === "initials" ? "AB" : "Your name")}
                  </button>
                ))}
              </div>
            </>
          )}
          {mode === "draw" && <DrawPad canvasRef={padRef} color={color} />}
          {mode === "upload" && (
            <div className="flex flex-col items-center gap-3">
              <div className="flex h-32 w-full items-center justify-center rounded-md border bg-white">
                {uploaded ? (
                  <img src={dataUrl(uploaded.png)} alt="" className="max-h-28" />
                ) : (
                  <span className="text-sm text-text-muted">{t("sign.uploadHint")}</span>
                )}
              </div>
              <Button variant="secondary" onClick={() => void chooseUpload()}>
                <Upload aria-hidden />
                {t("sign.choosePicture")}
              </Button>
            </div>
          )}
          {mode !== "upload" && (
            <div className="flex items-center gap-2 text-sm">
              <span>{t("sign.ink")}</span>
              {INK_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`${t("sign.ink")} ${c}`}
                  aria-pressed={color === c}
                  onClick={() => setColor(c)}
                  className={cn("size-6 rounded-full border", color === c && "ring-2 ring-primary")}
                  style={{ background: c }}
                />
              ))}
            </div>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
            {t("sign.saveForLater")}
          </label>
          {error && (
            <p className="text-sm text-danger" role="alert">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              {t("sign.cancel")}
            </Button>
            <Button disabled={busy} onClick={() => void finish()}>
              {t("sign.use")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DrawPad({
  canvasRef,
  color,
}: {
  canvasRef: React.RefObject<HTMLCanvasElement>;
  color: string;
}) {
  const drawing = useRef<[number, number] | null>(null);
  const clear = useCallback(() => {
    const canvas = canvasRef.current;
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  }, [canvasRef]);
  const point = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const rect = e.currentTarget.getBoundingClientRect();
    return [
      ((e.clientX - rect.left) / rect.width) * e.currentTarget.width,
      ((e.clientY - rect.top) / rect.height) * e.currentTarget.height,
    ];
  };
  return (
    <div className="space-y-2">
      <canvas
        ref={canvasRef}
        width={1200}
        height={360}
        aria-label={t("sign.drawHere")}
        data-testid="signature-pad"
        className="h-40 w-full touch-none rounded-md border bg-white"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drawing.current = point(e);
        }}
        onPointerMove={(e) => {
          const last = drawing.current;
          const ctx = e.currentTarget.getContext("2d");
          if (!last || !ctx) return;
          const next = point(e);
          ctx.strokeStyle = color;
          ctx.lineWidth = 7;
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          ctx.beginPath();
          ctx.moveTo(...last);
          ctx.lineTo(...next);
          ctx.stroke();
          drawing.current = next;
        }}
        onPointerUp={() => {
          drawing.current = null;
        }}
      />
      <Button variant="ghost" size="sm" onClick={clear}>
        {t("sign.clear")}
      </Button>
    </div>
  );
}
