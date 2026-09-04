import { describe, expect, it } from "vitest";

import type { StationConfig } from "../../src/config/schema.js";
import type { NormalizedObservation } from "../../src/domain/types.js";
import { buildBrief, buildThermalProfilePost } from "../../src/editorial/brief.js";
import { graphemeLength } from "../../src/editorial/graphemes.js";

const station: StationConfig = {
  key: "chicago-pier",
  displayName: "Chicago Pier Buoy",
  timeZone: "America/Chicago",
  links: { station: "https://example.com/station" },
  sources: { ndbc: { stationId: "45198", realtimeUrl: "https://example.com/data.txt" } },
};

function observation(observedAt: string, waveM: number, waterC: number): NormalizedObservation {
  return {
    stationKey: station.key,
    observedAt,
    ingestedAt: observedAt,
    source: "glos",
    sourceDataset: "obs_98",
    sourceHash: observedAt,
    overallQuality: "good",
    values: {
      airPressureHpa: 1012.1,
      airTemperatureC: 20,
      relativeHumidityPercent: 81.8,
      seaSurfaceTemperatureC: waterC,
      significantWaveHeightM: waveM,
      waveMeanPeriodS: 3.2,
      windFromDirectionDeg: 250,
      windSpeedMps: 4,
    },
    fieldQuality: {},
    missingFields: [],
    profile: [
      { depthM: 1, quality: "good", temperatureC: waterC },
      { depthM: 9, quality: "good", temperatureC: waterC - 6 },
    ],
    raw: {},
  };
}

describe("brief rendering", () => {
  it("builds a factual, bounded post with comparisons", () => {
    const current = observation("2026-09-04T12:30:00Z", 0.6, 22);
    const previous = observation("2026-09-03T12:30:00Z", 0.3, 21);
    const post = buildBrief(station, "morning", current, previous);

    expect(post.text).toContain("Since yesterday");
    expect(post.text).toContain("🌊 Waves");
    expect(post.text).toContain("⏱️ Period");
    expect(post.text).toContain("🌡️ Water");
    expect(post.text).toContain("💨 Wind");
    expect(post.text).toContain("🎚️ Pressure");
    expect(post.text).toContain("💧 Humidity");
    expect(post.text).toMatch(/🕒 Observed .+  ·  View data/);
    expect(post.text).not.toContain("Observations, not a forecast");
    expect(graphemeLength(post.text)).toBeLessThanOrEqual(300);
  });

  it("uses the local date for scheduled-post idempotency", () => {
    const first = buildBrief(station, "morning", observation("2026-09-04T12:30:00Z", 0.6, 22));
    const later = buildBrief(station, "morning", observation("2026-09-04T12:39:00Z", 0.7, 22));
    expect(first.idempotencyKey).toBe(later.idempotencyKey);
  });

  it("renders thermal structure without causal claims", () => {
    const post = buildThermalProfilePost(station, observation("2026-09-04T17:00:00Z", 0.3, 24));
    expect(post.text).toContain("strongly layered");
    expect(post.text).toMatch(/🕒 Observed .+  ·  View profile data/);
    expect(graphemeLength(post.text)).toBeLessThanOrEqual(300);
  });
});
