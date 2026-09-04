import { describe, expect, it } from "vitest";

import { freshnessState } from "../../src/editorial/freshness.js";

describe("freshnessState", () => {
  const now = new Date("2026-09-04T12:00:00Z");

  it.each([
    ["2026-09-04T11:40:00Z", "fresh"],
    ["2026-09-04T11:39:00Z", "delayed"],
    ["2026-09-04T10:59:00Z", "stale"],
    ["2026-09-04T09:59:00Z", "outage"],
  ] as const)("classifies %s as %s", (observedAt, expected) => {
    expect(freshnessState(new Date(observedAt), now)).toBe(expected);
  });
});
