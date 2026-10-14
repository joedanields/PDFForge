export type FileStatus = "loading" | "ready" | "locked" | "error";

/** A file added to a tool page. Passwords live only in memory for the current job (S4). */
export interface InputFile {
  key: string;
  path: string;
  name: string;
  size: number | null;
  modified: number | null;
  status: FileStatus;
  pages: number | null;
  thumbnail: string | null;
  password?: string;
  /** Inline, plain-language problem shown on the card. */
  error?: string;
}

let counter = 0;
export function fileKey(): string {
  counter += 1;
  return `f${counter}`;
}

export function sortByName(files: InputFile[]): InputFile[] {
  return [...files].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
  );
}

export function sortByDate(files: InputFile[]): InputFile[] {
  return [...files].sort((a, b) => (a.modified ?? 0) - (b.modified ?? 0));
}

export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return items;
  }
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}
