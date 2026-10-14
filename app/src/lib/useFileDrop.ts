import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useRef, useState } from "react";
import { isTauri } from "@/engine/client";

/**
 * Window-wide file drop via Tauri (WebView2 does not expose real paths through HTML5 drag-drop).
 * Returns whether files are currently dragged over the window.
 */
export function useFileDrop(onDrop: (paths: string[]) => void, enabled = true): boolean {
  const [over, setOver] = useState(false);
  const callback = useRef(onDrop);
  useEffect(() => {
    callback.current = onDrop;
  }, [onDrop]);

  useEffect(() => {
    if (!enabled || !isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent(({ payload }) => {
        if (payload.type === "enter" || payload.type === "over") setOver(true);
        else if (payload.type === "leave") setOver(false);
        else {
          setOver(false);
          if (payload.paths.length > 0) callback.current(payload.paths);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
      setOver(false);
    };
  }, [enabled]);

  return over;
}
