import { Globe } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n";

interface Props {
  open: boolean;
  url: string;
  onCancel: () => void;
  /** `remember`: don't ask again (saved in settings). */
  onConfirm: (remember: boolean) => void;
}

/** First-time confirmation before the only feature that goes online (D-043). */
export function OnlineConfirm({ open, url, onCancel, onConfirm }: Props) {
  const [remember, setRemember] = useState(true);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="p-6">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Globe className="size-5" aria-hidden />
          </span>
          <div className="space-y-2">
            <DialogTitle className="text-lg font-semibold">{t("online.title")}</DialogTitle>
            <DialogDescription className="text-sm text-text-muted">
              {t("online.body", { url: url.trim() })}
            </DialogDescription>
          </div>
        </div>
        <div className="mt-5 flex items-center gap-3">
          <Switch id="online-remember" checked={remember} onCheckedChange={setRemember} />
          <Label htmlFor="online-remember">{t("online.remember")}</Label>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            {t("online.cancel")}
          </Button>
          <Button onClick={() => onConfirm(remember)}>{t("online.confirm")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
