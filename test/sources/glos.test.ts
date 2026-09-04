import { describe, expect, it, vi } from "vitest";

import {
  GlosObservationSource,
  GlosSchemaError,
  parseErddapResponse,
} from "../../src/sources/glos.js";

const units: Record<string, string | null> = {
  time: "UTC",
  longitude: "degrees_east",
  latitude: "degrees_north",
  air_pressure_at_mean_sea_level: "Pa",
  air_temperature: "K",
  air_temperature_aggregate: null,
  battery_voltage: "V",
  dew_point_temperature: "K",
  dew_point_temperature_aggregate: null,
  relative_humidity: "1",
  relative_humidity_aggregate: null,
  sea_surface_temperature: "K",
  sea_surface_temperature_aggregate: null,
  sea_surface_wave_from_direction: "degree",
  sea_surface_wave_maximum_height: "m",
  sea_surface_wave_mean_period: "s",
  sea_surface_wave_period_at_variance_spectral_density_maximum: "s",
  sea_surface_wave_significant_height: "m",
  sea_surface_wave_significant_period: "s",
  sea_water_temperature_1: "K",
  sea_water_temperature_1_aggregate: null,
  sea_water_temperature_1_depth: "m",
  sea_water_temperature_2: "K",
  sea_water_temperature_2_aggregate: null,
  sea_water_temperature_2_depth: "m",
  sea_water_temperature_3: "K",
  sea_water_temperature_3_aggregate: null,
  sea_water_temperature_3_depth: "m",
  sea_water_temperature_4: "K",
  sea_water_temperature_4_aggregate: null,
  sea_water_temperature_4_depth: "m",
  sea_water_temperature_5: "K",
  sea_water_temperature_5_aggregate: null,
  sea_water_temperature_5_depth: "m",
  wind_from_direction: "degree",
  wind_from_direction_aggregate: null,
  wind_speed: "m s-1",
  wind_speed_aggregate: null,
  wind_speed_of_gust: "m s-1",
  wind_speed_of_gust_aggregate: null,
};

const rawRow: Record<string, string | number | null> = {
  time: "2026-09-03T23:10:00Z",
  longitude: -87.563_056,
  latitude: 41.8925,
  air_pressure_at_mean_sea_level: 101_209,
  air_temperature: 298.06,
  air_temperature_aggregate: 3,
  battery_voltage: 12.7,
  dew_point_temperature: 294.75,
  dew_point_temperature_aggregate: 1,
  relative_humidity: 81.8,
  relative_humidity_aggregate: 2,
  sea_surface_temperature: 297.42,
  sea_surface_temperature_aggregate: 2,
  sea_surface_wave_from_direction: 359.6,
  sea_surface_wave_maximum_height: 0.581,
  sea_surface_wave_mean_period: 3.933,
  sea_surface_wave_period_at_variance_spectral_density_maximum: null,
  sea_surface_wave_significant_height: 0.367,
  sea_surface_wave_significant_period: null,
  sea_water_temperature_1: 297.42,
  sea_water_temperature_1_aggregate: 2,
  sea_water_temperature_1_depth: 9,
  sea_water_temperature_2: 297.48,
  sea_water_temperature_2_aggregate: 1,
  sea_water_temperature_2_depth: 3,
  sea_water_temperature_3: null,
  sea_water_temperature_3_aggregate: 9,
  sea_water_temperature_3_depth: 5,
  sea_water_temperature_4: 297.49,
  sea_water_temperature_4_aggregate: 4,
  sea_water_temperature_4_depth: 7,
  sea_water_temperature_5: 297.5,
  sea_water_temperature_5_aggregate: 1,
  sea_water_temperature_5_depth: 1,
  wind_from_direction: null,
  wind_from_direction_aggregate: 9,
  wind_speed: 4.012,
  wind_speed_aggregate: 1,
  wind_speed_of_gust: null,
  wind_speed_of_gust_aggregate: 9,
};

function jsonResponse(columns: string[], row: Array<string | number | null>): Response {
  return Response.json({
    table: {
      columnNames: columns,
      columnTypes: columns.map((column) =>
        column === "time" ? "String" : column.endsWith("_aggregate") ? "byte" : "double",
      ),
      columnUnits: columns.map((column) => units[column] ?? null),
      rows: [row],
    },
  });
}

function projection(input: string | URL | Request): string[] {
  const rawQuery = new URL(String(input)).search.slice(1).split("&")[0] ?? "";
  return decodeURIComponent(rawQuery).split(",");
}

describe("GlosObservationSource", () => {
  it("normalizes exact units, keeps partial rows, and suppresses rejected QC fields", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const columns = projection(input);
      if (String(input).includes("obs_98_latest")) {
        return jsonResponse(columns, [rawRow.time ?? null]);
      }
      return jsonResponse(columns, columns.map((column) => rawRow[column] ?? null));
    });
    const source = new GlosObservationSource({
      baseUrl: "https://example.test/erddap",
      dataset: "obs_98",
      latestDataset: "obs_98_latest",
      fetch: fetcher,
      retries: 0,
      now: () => new Date("2026-09-04T00:00:00Z"),
    });

    const result = await source.fetchRecent("chicago-pier", new Date("2026-09-03T23:00:00Z"));

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1]?.[0])).toContain("time%3E2026-09-03T23%3A00%3A00.000Z");
    expect(result.observations).toHaveLength(1);
    const observation = result.observations[0];
    expect(observation?.values.airPressureHpa).toBeCloseTo(1012.09);
    expect(observation?.values.seaSurfaceTemperatureC).toBeCloseTo(24.27);
    expect(observation?.values.relativeHumidityPercent).toBe(81.8);
    expect(observation?.values.waveFromDirectionDeg).toBeCloseTo(359.6);
    expect(observation?.values.airTemperatureC).toBeUndefined();
    expect(observation?.fieldQuality.airTemperatureC).toBe("suspect");
    expect(observation?.fieldQuality.significantWaveHeightM).toBe("not_evaluated");
    expect(observation?.missingFields).toContain("windGustMps");
    expect(observation?.profile.map((point) => point.depthM)).toEqual([1, 3, 9]);
    expect(observation?.overallQuality).toBe("not_evaluated");
    expect(observation?.sourceHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("treats ERDDAP's no-matching-results 404 as an empty source", async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        'Error { code=404; message="Not Found: Your query produced no matching results. (nRows = 0)"; }',
        { status: 404 },
      ),
    );
    const source = new GlosObservationSource({
      baseUrl: "https://example.test/erddap",
      dataset: "obs_98",
      latestDataset: "obs_98_latest",
      fetch: fetcher,
      retries: 0,
    });

    await expect(source.fetchRecent("chicago-pier", new Date("2026-09-03T00:00:00Z"))).resolves.toEqual({
      observations: [],
      source: "glos",
      warnings: [],
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not hide a dataset-not-found 404", async () => {
    const source = new GlosObservationSource({
      baseUrl: "https://example.test/erddap",
      dataset: "typo",
      latestDataset: "typo_latest",
      fetch: async () => new Response("Error { message=Unknown dataset; }", { status: 404 }),
      retries: 0,
    });

    await expect(source.fetchRecent("chicago-pier", new Date("2026-09-03T00:00:00Z"))).rejects.toThrow(
      "GLOS ERDDAP returned 404",
    );
  });

  it("rejects malformed envelopes and inconsistent row widths", () => {
    expect(() => parseErddapResponse({ nope: true })).toThrow(GlosSchemaError);
    expect(() =>
      parseErddapResponse({
        table: {
          columnNames: ["time"],
          columnTypes: ["String"],
          columnUnits: ["UTC"],
          rows: [["2026-09-03T23:10:00Z", 1]],
        },
      }),
    ).toThrow("row length");
  });

  it("fails closed when ERDDAP changes a requested field's unit", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const columns = projection(input);
      if (String(input).includes("obs_98_latest")) {
        return jsonResponse(columns, [rawRow.time ?? null]);
      }
      return Response.json({
        table: {
          columnNames: columns,
          columnTypes: columns.map((column) =>
            column === "time" ? "String" : column.endsWith("_aggregate") ? "byte" : "double",
          ),
          columnUnits: columns.map((column) =>
            column === "air_temperature" ? "degree_C" : (units[column] ?? null),
          ),
          rows: [columns.map((column) => rawRow[column] ?? null)],
        },
      });
    });
    const source = new GlosObservationSource({
      baseUrl: "https://example.test/erddap",
      dataset: "obs_98",
      latestDataset: "obs_98_latest",
      fetch: fetcher,
      retries: 0,
    });

    await expect(source.fetchRecent("chicago-pier", new Date("2026-09-03T23:00:00Z"))).rejects.toThrow(
      "changed units",
    );
  });

  it("skips the full dataset request when the latest marker has not advanced", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const columns = projection(input);
      return jsonResponse(columns, [rawRow.time ?? null]);
    });
    const source = new GlosObservationSource({
      baseUrl: "https://example.test/erddap",
      dataset: "obs_98",
      latestDataset: "obs_98_latest",
      fetch: fetcher,
      retries: 0,
    });

    const result = await source.fetchRecent("chicago-pier", new Date("2026-09-03T23:10:00Z"));

    expect(result.observations).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
