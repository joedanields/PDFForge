import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { EMPTY_SELECTION, type Selection } from "@/lib/selection";
import { ThumbnailGrid, type GridItem } from "./ThumbnailGrid";

const items: GridItem[] = Array.from({ length: 6 }, (_, i) => ({
  key: String(i),
  source: null, // blank tiles: no PDF rendering needed
  pageIndex: i,
  label: String(i + 1),
}));

function Harness({ tone }: { tone?: "select" | "remove" }) {
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  return (
    <>
      <ThumbnailGrid
        items={items}
        selection={selection}
        onSelectionChange={setSelection}
        ariaLabel="Pages"
        tone={tone}
      />
      <output data-testid="selected">{[...selection.selected].sort().join(",")}</output>
    </>
  );
}

const selected = () => screen.getByTestId("selected").textContent;
const tile = (n: number) => screen.getByRole("option", { name: `Page ${n}` });

describe("ThumbnailGrid", () => {
  it("click, shift-click and ctrl-click select like a file manager", () => {
    render(<Harness />);
    fireEvent.click(tile(2));
    expect(selected()).toBe("1");
    fireEvent.click(tile(4), { shiftKey: true });
    expect(selected()).toBe("1,2,3");
    fireEvent.click(tile(6), { ctrlKey: true });
    expect(selected()).toBe("1,2,3,5");
    fireEvent.click(tile(3), { ctrlKey: true });
    expect(selected()).toBe("1,3,5");
    expect(tile(2)).toHaveAttribute("aria-selected", "true");
    expect(tile(3)).toHaveAttribute("aria-selected", "false");
  });

  it("supports Ctrl+A and Escape on the grid", () => {
    render(<Harness />);
    const grid = screen.getByRole("listbox", { name: "Pages" });
    fireEvent.keyDown(grid, { key: "a", ctrlKey: true });
    expect(selected()).toBe("0,1,2,3,4,5");
    fireEvent.keyDown(grid, { key: "Escape" });
    expect(selected()).toBe("");
  });

  it("toggles with Space and extends with Shift+Arrow", () => {
    render(<Harness />);
    const grid = screen.getByRole("listbox", { name: "Pages" });
    fireEvent.keyDown(grid, { key: " " });
    expect(selected()).toBe("0");
    fireEvent.keyDown(grid, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(grid, { key: "ArrowRight", shiftKey: true });
    expect(selected()).toBe("0,1,2");
  });

  it("marks pages for removal in remove mode", () => {
    render(<Harness tone="remove" />);
    fireEvent.click(tile(1));
    expect(tile(1).className).toContain("ring-danger");
  });

  it("exposes a zoom slider", () => {
    render(<Harness />);
    const slider = screen.getByLabelText("Thumbnail size");
    fireEvent.change(slider, { target: { value: "240" } });
    expect((slider as HTMLInputElement).value).toBe("240");
  });
});
