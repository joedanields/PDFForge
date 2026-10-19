import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { isTauri } from "@/engine/client";

/** The viewer route for a file. */
export function viewerPath(path: string): string {
  return `/view?path=${encodeURIComponent(path)}`;
}

/** Pick a PDF with the system dialog and open it in the built-in viewer. */
export async function chooseAndView(navigate: (to: string) => void): Promise<void> {
  if (!isTauri()) return;
  const picked = await openDialog({
    multiple: false,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (typeof picked === "string") navigate(viewerPath(picked));
}
