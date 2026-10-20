import { describe, expect, it } from "vitest";
import { TOOLS } from "@/tools/registry";
import {
  chainProblems,
  newStep,
  runsOnAllFiles,
  STEP_KINDS,
  stepForEngine,
  stepTools,
  workflowAccepts,
} from "./workflows";

describe("workflows", () => {
  it("offers every step kind the engine knows, and only available tools", () => {
    const ids = stepTools(TOOLS).map((t) => t.id);
    expect(new Set(ids)).toEqual(new Set(Object.keys(STEP_KINDS)));
    expect(ids).not.toContain("redact");
    expect(ids).not.toContain("sign");
  });

  it("new steps start from the tool defaults without passwords", () => {
    const protect = newStep("protect");
    expect(protect.options).not.toHaveProperty("user_password");
    expect(protect.options).not.toHaveProperty("user_password_confirm");
    expect(protect.options).toHaveProperty("encryption", "aes256");
  });

  it("checks the chain: conversions first, non-PDF results last", () => {
    const ok = [newStep("word-to-pdf"), newStep("compress"), newStep("pdf-to-text")];
    expect(chainProblems(ok).size).toBe(0);
    const bad = [newStep("compress"), newStep("pdf-to-word"), newStep("word-to-pdf")];
    const problems = chainProblems(bad);
    expect(problems.get(1)).toMatch(/only be the last step/);
    expect(problems.get(2)).toMatch(/only be the first step/);
    expect(problems.has(0)).toBe(false);
  });

  it("runs once over all files when a step combines them", () => {
    expect(runsOnAllFiles([newStep("compress"), newStep("protect")])).toBe(false);
    expect(runsOnAllFiles([newStep("merge"), newStep("compress")])).toBe(true);
    expect(workflowAccepts([newStep("word-to-pdf")])?.extensions).toContain("docx");
    expect(workflowAccepts([])).toBeNull();
  });

  it("turns a step into engine options plus separate secrets", () => {
    const rotate = stepForEngine({ tool: "rotate", options: { angle: "180", pages: "" } }, {});
    expect(rotate.step).toEqual({
      tool: "rotate",
      options: expect.objectContaining({ angle: 180, pages: "all" }) as unknown,
    });
    const protect = stepForEngine(newStep("protect"), {
      user_password: "pw",
      user_password_confirm: "pw",
    });
    expect(protect.secrets).toEqual({ user_password: "pw", owner_password: "" });
    expect(protect.step.options).not.toHaveProperty("user_password");
  });
});
