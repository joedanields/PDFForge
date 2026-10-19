import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { DoneEvent } from "@/engine/types";
import { ResultCard } from "./ResultCard";

function Where() {
  const location = useLocation();
  const state = location.state as { preload?: string[] } | null;
  return <output data-testid="where">{`${location.pathname} ${state?.preload?.join(",")}`}</output>;
}

function renderResult(stats: Record<string, unknown>) {
  const result = {
    job_id: "j1",
    outputs: ["C:\\out\\statement-redacted.pdf"],
    stats,
  } as unknown as DoneEvent;
  render(
    <MemoryRouter initialEntries={["/tool/redact"]}>
      <Routes>
        <Route
          path="/tool/redact"
          element={<ResultCard result={result} onStartOver={() => undefined} />}
        />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ResultCard after redaction (D-036)", () => {
  it("explains that redacted pages are images and offers OCR when they are not searchable", () => {
    renderResult({ rasterized_pages: 2, searchable: false });
    const note = screen.getByTestId("result-rasterized");
    expect(note).toHaveTextContent("2 redacted pages were rebuilt as images");
    expect(note).toHaveTextContent("can't be searched");
    fireEvent.click(screen.getByRole("button", { name: "Run OCR on non-redacted areas" }));
    expect(screen.getByTestId("where")).toHaveTextContent(
      "/tool/ocr C:\\out\\statement-redacted.pdf",
    );
  });

  it("says the text was restored when OCR already ran", () => {
    renderResult({ rasterized_pages: 1, searchable: true });
    expect(screen.getByTestId("result-rasterized")).toHaveTextContent(
      "OCR restored searchable text outside the redacted boxes.",
    );
    expect(screen.queryByRole("button", { name: "Run OCR on non-redacted areas" })).toBeNull();
  });

  it("shows nothing for other tools", () => {
    renderResult({ pages: 3 });
    expect(screen.queryByTestId("result-rasterized")).toBeNull();
  });
});
