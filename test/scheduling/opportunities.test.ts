import { describe, expect, it } from "vitest";

import { dueBriefLane, isThermalOpportunity, isWeeklyOpportunity } from "../../src/scheduling/opportunities.js";

describe("local scheduling opportunities", () => {
  it("uses Chicago daylight time for briefs", () => {
    expect(dueBriefLane(new Date("2026-09-04T12:34:00Z"), "America/Chicago")).toBe("morning");
    expect(dueBriefLane(new Date("2026-09-04T21:34:00Z"), "America/Chicago")).toBe("afternoon");
  });

  it("handles standard time without hard-coded UTC offsets", () => {
    expect(dueBriefLane(new Date("2026-12-04T13:34:00Z"), "America/Chicago")).toBe("morning");
  });

  it("identifies thermal and Sunday weekly windows", () => {
    expect(isThermalOpportunity(new Date("2026-09-04T17:04:00Z"), "America/Chicago")).toBe(true);
    expect(isWeeklyOpportunity(new Date("2026-09-06T16:04:00Z"), "America/Chicago")).toBe(true);
  });
});
