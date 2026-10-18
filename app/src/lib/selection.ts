/** Multi-select rules for thumbnail grids (docs/04 §2.5): click, Shift-click, Ctrl-click. */

export interface Selection {
  selected: ReadonlySet<string>;
  /** Item that Shift-click ranges start from. */
  anchor: string | null;
}

export interface Modifiers {
  ctrl: boolean;
  shift: boolean;
}

export const EMPTY_SELECTION: Selection = { selected: new Set(), anchor: null };

function rangeBetween(order: readonly string[], a: string, b: string): string[] {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i < 0 || j < 0) return [b];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}

/** New selection after clicking ``key`` with the given modifier keys. */
export function clickSelect(
  order: readonly string[],
  current: Selection,
  key: string,
  { ctrl, shift }: Modifiers,
): Selection {
  if (shift && current.anchor !== null) {
    const range = rangeBetween(order, current.anchor, key);
    const selected = new Set(ctrl ? current.selected : []);
    for (const k of range) selected.add(k);
    return { selected, anchor: current.anchor };
  }
  if (ctrl) {
    const selected = new Set(current.selected);
    if (selected.has(key)) selected.delete(key);
    else selected.add(key);
    return { selected, anchor: key };
  }
  return { selected: new Set([key]), anchor: key };
}

/** Selection from a rubber-band drag; with Ctrl the band adds to the existing selection. */
export function bandSelect(
  current: Selection,
  inBand: readonly string[],
  ctrl: boolean,
): Selection {
  const selected = new Set(ctrl ? current.selected : []);
  for (const k of inBand) selected.add(k);
  return { selected, anchor: inBand[inBand.length - 1] ?? current.anchor };
}

export function selectAll(order: readonly string[]): Selection {
  return { selected: new Set(order), anchor: order[0] ?? null };
}

/** Keep the selection consistent after items were removed or reordered. */
export function pruneSelection(order: readonly string[], current: Selection): Selection {
  const keys = new Set(order);
  const selected = new Set([...current.selected].filter((k) => keys.has(k)));
  const anchor = current.anchor !== null && keys.has(current.anchor) ? current.anchor : null;
  return { selected, anchor };
}
