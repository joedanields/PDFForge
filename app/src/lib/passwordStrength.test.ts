import { describe, expect, it } from "vitest";
import { passwordStrength } from "./passwordStrength";

describe("passwordStrength", () => {
  it.each([
    ["", 0],
    ["password", 0],
    ["Password1!", 0],
    ["123456789", 0],
    ["abc", 0],
    ["sunny22", 1],
    ["tiger-lake", 2],
    ["Correct-Horse-7", 4],
    ["Lakeside2024", 3],
    ["purple monkey dishwasher 42", 4],
    ["G7#kq!Lm2@Zp9x", 4],
  ] as const)("%j → %i", (pw, score) => {
    expect(passwordStrength(pw).score).toBe(score);
  });

  it("penalises repeats and sequences", () => {
    expect(passwordStrength("aaaaaaaaaaaa").score).toBeLessThan(
      passwordStrength("q8vn2kx7wr4m").score,
    );
    expect(passwordStrength("abcd1234wxyz").score).toBeLessThan(
      passwordStrength("ab7d1x34w9yz").score,
    );
  });

  it("has a label for every score", () => {
    expect(passwordStrength("G7#kq!Lm2@Zp9x").label).toBe("Strong");
    expect(passwordStrength("").label).toBe("Very weak");
  });
});
