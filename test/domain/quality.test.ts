import { describe, expect, it } from "vitest";

import { isEventQuality, isPublishableQuality, qualityFromIoosFlag } from "../../src/domain/quality.js";

describe("IOOS quality flags", () => {
  it.each([
    [1, "good"],
    [2, "not_evaluated"],
    [3, "suspect"],
    [4, "bad"],
    [9, "missing"],
  ] as const)("maps %s", (flag, expected) => {
    expect(qualityFromIoosFlag(flag)).toBe(expected);
  });

  it("allows not-evaluated data in briefs but not event triggers", () => {
    expect(isPublishableQuality("not_evaluated")).toBe(true);
    expect(isEventQuality("not_evaluated")).toBe(false);
  });
});
