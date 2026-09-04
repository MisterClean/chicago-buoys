import { describe, expect, it } from "vitest";

import { configSchema } from "../../src/config/schema.js";
import type { NormalizedObservation, ObservationValues, TemperaturePoint } from "../../src/domain/types.js";
import { detectEvents } from "../../src/editorial/events.js";

const station = configSchema.parse({
  app: { databasePath: "unused.sqlite" },
  posting: {},
  publishers: [],
  stations: [
    {
      displayName: "Test Buoy",
      key: "test",
      links: { station: "https://example.com/station" },
      sources: {
        ndbc: { realtimeUrl: "https://example.com/ndbc.txt", stationId: "test" },
      },
      timeZone: "America/Chicago",
    },
  ],
}).stations[0];

if (station === undefined) {
  throw new Error("Test station was not parsed");
}

function observation(
  observedAt: string,
  values: ObservationValues = {},
  fieldQuality: Record<string, "good" | "not_evaluated"> = {},
  profile: TemperaturePoint[] = [],
): NormalizedObservation {
  return {
    fieldQuality,
    ingestedAt: observedAt,
    missingFields: [],
    observedAt,
    overallQuality: "good",
    profile,
    raw: {},
    source: "glos",
    sourceDataset: "test",
    sourceHash: observedAt,
    stationKey: "test",
    values,
  };
}

describe("event detection", () => {
  it("fires a wave-build event only from good measurements crossing the threshold", () => {
    const previous = observation(
      "2026-09-04T12:30:00.000Z",
      { significantWaveHeightM: 0.35 },
      { significantWaveHeightM: "good" },
    );
    const current = observation(
      "2026-09-04T14:00:00.000Z",
      { significantWaveHeightM: 0.7 },
      { significantWaveHeightM: "good" },
    );

    expect(detectEvents(station, { current, ninetyMinutesAgo: previous })).toMatchObject([
      { kind: "event:wave-build" },
    ]);
    expect(
      detectEvents(station, {
        current: { ...current, fieldQuality: { significantWaveHeightM: "not_evaluated" } },
        ninetyMinutesAgo: previous,
      }),
    ).toEqual([]);
  });

  it("detects mixing only when the same sensor depths are comparable", () => {
    const yesterday = observation("2026-09-03T14:00:00.000Z", {}, {}, [
      { depthM: 1, quality: "good", temperatureC: 22 },
      { depthM: 9, quality: "good", temperatureC: 18 },
    ]);
    const current = observation("2026-09-04T14:00:00.000Z", {}, {}, [
      { depthM: 1, quality: "good", temperatureC: 20 },
      { depthM: 9, quality: "good", temperatureC: 19.5 },
    ]);

    expect(detectEvents(station, { current, yesterday })).toMatchObject([
      { kind: "event:mixing" },
    ]);
    expect(
      detectEvents(station, {
        current: {
          ...current,
          profile: [
            { depthM: 1, quality: "good", temperatureC: 20 },
            { depthM: 6, quality: "good", temperatureC: 19.5 },
          ],
        },
        yesterday,
      }),
    ).toEqual([]);
  });
});
