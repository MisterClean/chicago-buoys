import { describe, expect, it, vi } from "vitest";

import {
  NdbcObservationSource,
  NdbcSchemaError,
  parseNdbcText,
} from "../../src/sources/ndbc.js";

const header = `#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE
#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft`;

const body = `${header}
2026 09 03 23 10  MM  4.0   MM   0.4    MM    MM 360 1012.1  24.9  24.3  21.6   MM   MM    MM
2026 09 03 23 00  15  5.0  7.0   0.5      5   4.2  20 1012.0  25.0  24.4  21.7   MM -0.3    MM
2026 09 03 22 50  20  4.0  6.0   0.3      4   3.9  25 1012.2  25.1  24.5  21.8   MM   MM    MM
bad short row`;

describe("parseNdbcText", () => {
  it("validates the header and retains each field token", () => {
    const parsed = parseNdbcText(body);

    expect(parsed.records).toHaveLength(3);
    expect(parsed.records[0]?.WDIR).toBe("MM");
    expect(parsed.records[1]?.PTDY).toBe("-0.3");
    expect(parsed.warnings).toEqual(["Skipped NDBC line 6: expected 19 fields, got 3"]);
  });

  it("rejects missing headers and unit drift", () => {
    expect(() => parseNdbcText("<html>maintenance</html>")).toThrow(NdbcSchemaError);
    expect(() => parseNdbcText(body.replace("degC  degC", "degF  degC"))).toThrow(
      "changed units",
    );
  });
});

describe("NdbcObservationSource", () => {
  it("normalizes partial rows, treats MM per field, filters time, and sorts oldest first", async () => {
    const fetcher = vi.fn(async () => new Response(body, { status: 200 }));
    const source = new NdbcObservationSource({
      realtimeUrl: "https://example.test/realtime2/45198.txt",
      stationId: "45198",
      fetch: fetcher,
      retries: 0,
      now: () => new Date("2026-09-04T00:00:00Z"),
    });

    const result = await source.fetchRecent("chicago-pier", new Date("2026-09-03T22:55:00Z"));

    expect(result.observations.map((observation) => observation.observedAt)).toEqual([
      "2026-09-03T23:00:00.000Z",
      "2026-09-03T23:10:00.000Z",
    ]);
    const complete = result.observations[0];
    expect(complete?.values.windFromDirectionDeg).toBe(15);
    expect(complete?.values.waveMeanPeriodS).toBe(4.2);
    expect(complete?.values.airPressureHpa).toBe(1012);
    expect(complete?.fieldQuality.windSpeedMps).toBe("not_evaluated");
    expect(complete?.overallQuality).toBe("not_evaluated");

    const partial = result.observations[1];
    expect(partial?.values.windSpeedMps).toBe(4);
    expect(partial?.values.windFromDirectionDeg).toBeUndefined();
    expect(partial?.fieldQuality.windFromDirectionDeg).toBe("missing");
    expect(partial?.values.waveFromDirectionDeg).toBe(0);
    expect(partial?.missingFields).toEqual(
      expect.arrayContaining(["windFromDirectionDeg", "windGustMps", "waveMeanPeriodS"]),
    );
    expect(partial?.profile).toEqual([]);
    expect(result.warnings).toContain("Skipped NDBC line 6: expected 19 fields, got 3");
  });

  it("returns an empty result for a seasonal/unavailable station file", async () => {
    const source = new NdbcObservationSource({
      realtimeUrl: "https://example.test/realtime2/45198.txt",
      stationId: "45198",
      fetch: async () => new Response("not found", { status: 404 }),
      retries: 0,
    });

    const result = await source.fetchRecent("chicago-pier", new Date("2026-09-03T00:00:00Z"));

    expect(result.observations).toEqual([]);
    expect(result.warnings[0]).toContain("404");
  });

  it("rejects invalid station IDs before requesting data", () => {
    expect(
      () =>
        new NdbcObservationSource({
          realtimeUrl: "https://example.test/realtime2/bad.txt",
          stationId: "bad/path",
        }),
    ).toThrow("exactly five");
  });
});
