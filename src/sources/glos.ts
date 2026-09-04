import { z } from "zod";

import { sha256, stableJson } from "../core/hash.js";
import { isPublishableQuality, qualityFromIoosFlag } from "../domain/quality.js";
import { kelvinToCelsius, normalizeDegrees, pascalsToHectopascals } from "../domain/units.js";
import type {
  NormalizedObservation,
  ObservationSource,
  ObservationValues,
  QualityState,
  SourceFetchResult,
  TemperaturePoint,
} from "../domain/types.js";
import { fetchWithPolicy, type FetchLike } from "./http.js";

const erddapCellSchema = z.union([z.string(), z.number(), z.null()]);
const erddapEnvelopeSchema = z.object({
  table: z.object({
    columnNames: z.array(z.string()).min(1),
    columnTypes: z.array(z.string()).min(1),
    columnUnits: z.array(z.string().nullable()).min(1),
    rows: z.array(z.array(erddapCellSchema)),
  }),
});

export type ErddapTable = z.infer<typeof erddapEnvelopeSchema>["table"];

export class GlosSchemaError extends Error {
  public override readonly name = "GlosSchemaError";
}

export type GlosObservationSourceOptions = {
  baseUrl: string;
  dataset: string;
  fetch?: FetchLike;
  latestDataset?: string;
  now?: () => Date;
  retries?: number;
  timeoutMs?: number;
};

const FIELD_UNITS = {
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
} as const;

type GlosField = keyof typeof FIELD_UNITS;
type RawGlosRow = Record<GlosField, string | number | null>;

const FULL_FIELDS = Object.keys(FIELD_UNITS) as GlosField[];

type ScalarSpec = {
  canonical: keyof ObservationValues;
  maximum: number;
  minimum: number;
  qualityField?: GlosField;
  sourceMaximum?: number;
  sourceMinimum?: number;
  sourceField: GlosField;
  transform?: (value: number) => number;
};

const SCALAR_SPECS: readonly ScalarSpec[] = [
  {
    canonical: "airPressureHpa",
    sourceField: "air_pressure_at_mean_sea_level",
    transform: pascalsToHectopascals,
    minimum: 800,
    maximum: 1_200,
  },
  {
    canonical: "airTemperatureC",
    sourceField: "air_temperature",
    qualityField: "air_temperature_aggregate",
    transform: kelvinToCelsius,
    minimum: -80,
    maximum: 60,
  },
  {
    canonical: "batteryVoltage",
    sourceField: "battery_voltage",
    minimum: 0,
    maximum: 100,
  },
  {
    canonical: "dewPointTemperatureC",
    sourceField: "dew_point_temperature",
    qualityField: "dew_point_temperature_aggregate",
    transform: kelvinToCelsius,
    minimum: -100,
    maximum: 60,
  },
  {
    canonical: "relativeHumidityPercent",
    sourceField: "relative_humidity",
    qualityField: "relative_humidity_aggregate",
    minimum: 0,
    maximum: 100,
  },
  {
    canonical: "seaSurfaceTemperatureC",
    sourceField: "sea_surface_temperature",
    qualityField: "sea_surface_temperature_aggregate",
    transform: kelvinToCelsius,
    minimum: -5,
    maximum: 40,
  },
  {
    canonical: "significantWaveHeightM",
    sourceField: "sea_surface_wave_significant_height",
    minimum: 0,
    maximum: 30,
  },
  {
    canonical: "maximumWaveHeightM",
    sourceField: "sea_surface_wave_maximum_height",
    minimum: 0,
    maximum: 60,
  },
  {
    canonical: "waveFromDirectionDeg",
    sourceField: "sea_surface_wave_from_direction",
    transform: normalizeDegrees,
    sourceMinimum: 0,
    sourceMaximum: 360,
    minimum: 0,
    maximum: 360,
  },
  {
    canonical: "waveMeanPeriodS",
    sourceField: "sea_surface_wave_mean_period",
    minimum: 0,
    maximum: 60,
  },
  {
    canonical: "windFromDirectionDeg",
    sourceField: "wind_from_direction",
    qualityField: "wind_from_direction_aggregate",
    transform: normalizeDegrees,
    sourceMinimum: 0,
    sourceMaximum: 360,
    minimum: 0,
    maximum: 360,
  },
  {
    canonical: "windSpeedMps",
    sourceField: "wind_speed",
    qualityField: "wind_speed_aggregate",
    minimum: 0,
    maximum: 100,
  },
  {
    canonical: "windGustMps",
    sourceField: "wind_speed_of_gust",
    qualityField: "wind_speed_of_gust_aggregate",
    minimum: 0,
    maximum: 150,
  },
];

const PROFILE_CHANNELS = [1, 2, 3, 4, 5] as const;

export function parseErddapResponse(payload: unknown): ErddapTable {
  const result = erddapEnvelopeSchema.safeParse(payload);
  if (!result.success) {
    throw new GlosSchemaError(`Invalid ERDDAP JSON envelope: ${z.prettifyError(result.error)}`);
  }
  const { table } = result.data;
  if (
    table.columnNames.length !== table.columnTypes.length ||
    table.columnNames.length !== table.columnUnits.length
  ) {
    throw new GlosSchemaError("ERDDAP column names, types, and units have different lengths");
  }
  if (new Set(table.columnNames).size !== table.columnNames.length) {
    throw new GlosSchemaError("ERDDAP returned duplicate column names");
  }
  for (const row of table.rows) {
    if (row.length !== table.columnNames.length) {
      throw new GlosSchemaError("ERDDAP row length does not match its column header");
    }
  }
  return table;
}

function assertRequestedSchema(table: ErddapTable, fields: readonly GlosField[]): void {
  const indexes = new Map(table.columnNames.map((name, index) => [name, index]));
  for (const field of fields) {
    const index = indexes.get(field);
    if (index === undefined) {
      throw new GlosSchemaError(`ERDDAP response omitted requested column ${field}`);
    }
    const expectedUnit = FIELD_UNITS[field];
    if (table.columnUnits[index] !== expectedUnit) {
      throw new GlosSchemaError(
        `ERDDAP column ${field} changed units from ${String(expectedUnit)} to ${String(table.columnUnits[index])}`,
      );
    }
  }
}

function rowAsObject(table: ErddapTable, row: ErddapTable["rows"][number]): RawGlosRow {
  return Object.fromEntries(table.columnNames.map((name, index) => [name, row[index] ?? null])) as RawGlosRow;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function strictIoosQuality(value: unknown): QualityState {
  const numeric = typeof value === "string" ? Number(value) : value;
  if (numeric !== 1 && numeric !== 2 && numeric !== 3 && numeric !== 4 && numeric !== 9) {
    return "missing";
  }
  return qualityFromIoosFlag(numeric);
}

function qualityFor(raw: RawGlosRow, qualityField: GlosField | undefined): QualityState {
  if (qualityField === undefined) {
    return "not_evaluated";
  }
  return strictIoosQuality(raw[qualityField]);
}

function overallQuality(qualities: readonly QualityState[]): QualityState {
  if (qualities.length === 0) {
    return "missing";
  }
  return qualities.includes("not_evaluated") ? "not_evaluated" : "good";
}

function normalizeGlosRow(
  stationKey: string,
  dataset: string,
  table: ErddapTable,
  row: ErddapTable["rows"][number],
  ingestedAt: string,
): NormalizedObservation {
  const raw = rowAsObject(table, row);
  const time = raw.time;
  if (typeof time !== "string" || !Number.isFinite(Date.parse(time))) {
    throw new GlosSchemaError("ERDDAP returned an invalid observation time");
  }

  const values: Record<string, number> = {};
  const fieldQuality: Record<string, QualityState> = {};
  const missingFields: string[] = [];
  const acceptedQualities: QualityState[] = [];

  for (const spec of SCALAR_SPECS) {
    const quality = qualityFor(raw, spec.qualityField);
    const rawValue = finiteNumber(raw[spec.sourceField]);
    const transformed = rawValue === undefined ? undefined : (spec.transform?.(rawValue) ?? rawValue);
    const sourceInRange =
      rawValue !== undefined &&
      (spec.sourceMinimum === undefined || rawValue >= spec.sourceMinimum) &&
      (spec.sourceMaximum === undefined || rawValue <= spec.sourceMaximum);
    const inRange =
      sourceInRange && transformed !== undefined && transformed >= spec.minimum && transformed <= spec.maximum;
    const finalQuality = rawValue === undefined || !inRange ? "missing" : quality;
    fieldQuality[spec.canonical] = finalQuality;
    if (transformed !== undefined && inRange && isPublishableQuality(finalQuality)) {
      values[spec.canonical] = transformed;
      acceptedQualities.push(finalQuality);
    } else {
      missingFields.push(spec.canonical);
    }
  }

  const profile: TemperaturePoint[] = [];
  for (const channel of PROFILE_CHANNELS) {
    const temperatureField = `sea_water_temperature_${channel}` as GlosField;
    const qualityField = `sea_water_temperature_${channel}_aggregate` as GlosField;
    const depthField = `sea_water_temperature_${channel}_depth` as GlosField;
    const temperatureK = finiteNumber(raw[temperatureField]);
    const depthM = finiteNumber(raw[depthField]);
    const quality = strictIoosQuality(raw[qualityField]);
    if (
      temperatureK === undefined ||
      depthM === undefined ||
      depthM < 0 ||
      depthM > 500 ||
      !isPublishableQuality(quality)
    ) {
      missingFields.push(`profile.${channel}`);
      continue;
    }
    const temperatureC = kelvinToCelsius(temperatureK);
    if (temperatureC < -5 || temperatureC > 40) {
      missingFields.push(`profile.${channel}`);
      continue;
    }
    profile.push({ depthM, quality, temperatureC });
    acceptedQualities.push(quality);
  }
  profile.sort((left, right) => left.depthM - right.depthM);

  return {
    stationKey,
    observedAt: new Date(time).toISOString(),
    ingestedAt,
    source: "glos",
    sourceDataset: dataset,
    sourceHash: sha256(stableJson(raw)),
    overallQuality: overallQuality(acceptedQualities),
    values: values as ObservationValues,
    fieldQuality,
    profile,
    missingFields,
    raw,
  };
}

function isNoRowsBody(body: string): boolean {
  return /query produced no matching results|No data matches/iu.test(body);
}

async function readErddapResponse(response: Response): Promise<ErddapTable | undefined> {
  if (response.status === 404) {
    const body = await response.text();
    if (isNoRowsBody(body)) {
      return undefined;
    }
    throw new Error(`GLOS ERDDAP returned 404: ${body.slice(0, 500)}`);
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GLOS ERDDAP returned ${response.status}: ${body.slice(0, 500)}`);
  }
  return parseErddapResponse((await response.json()) as unknown);
}

function buildQueryUrl(
  baseUrl: string,
  dataset: string,
  fields: readonly string[],
  constraints: readonly string[],
): string {
  const projection = encodeURIComponent(fields.join(","));
  const query = [projection, ...constraints].join("&");
  return `${baseUrl.replace(/\/$/u, "")}/tabledap/${encodeURIComponent(dataset)}.json?${query}`;
}

export class GlosObservationSource implements ObservationSource {
  public readonly id = "glos";

  private readonly baseUrl: string;
  private readonly dataset: string;
  private readonly fetcher: FetchLike | undefined;
  private readonly latestDataset: string | undefined;
  private readonly now: () => Date;
  private readonly retries: number;
  private readonly timeoutMs: number;

  public constructor(options: GlosObservationSourceOptions) {
    this.baseUrl = options.baseUrl;
    this.dataset = options.dataset;
    this.latestDataset = options.latestDataset;
    this.fetcher = options.fetch;
    this.timeoutMs = options.timeoutMs ?? 45_000;
    this.retries = options.retries ?? 1;
    this.now = options.now ?? (() => new Date());
  }

  public async fetchRecent(stationKey: string, since: Date): Promise<SourceFetchResult> {
    if (!Number.isFinite(since.getTime())) {
      throw new TypeError("GLOS since date is invalid");
    }

    const latestTime = await this.fetchLatestTime();
    if (latestTime !== undefined && latestTime.getTime() <= since.getTime()) {
      return { observations: [], source: this.id, warnings: [] };
    }

    const constraints = [`time%3E${encodeURIComponent(since.toISOString())}`];
    if (latestTime !== undefined) {
      constraints.push(`time%3C%3D${encodeURIComponent(latestTime.toISOString())}`);
    }
    constraints.push("orderBy(%22time%22)");
    const url = buildQueryUrl(this.baseUrl, this.dataset, FULL_FIELDS, constraints);
    const response = await fetchWithPolicy(
      url,
      { headers: { accept: "application/json" } },
      { fetch: this.fetcher, retries: this.retries, timeoutMs: this.timeoutMs },
    );
    const table = await readErddapResponse(response);
    if (table === undefined) {
      return { observations: [], source: this.id, warnings: [] };
    }
    assertRequestedSchema(table, FULL_FIELDS);
    const ingestedAt = this.now().toISOString();
    const observations = table.rows
      .map((row) => normalizeGlosRow(stationKey, this.dataset, table, row, ingestedAt))
      .sort((left, right) => left.observedAt.localeCompare(right.observedAt));
    return { observations, source: this.id, warnings: [] };
  }

  public async fetchLatestTime(): Promise<Date | undefined> {
    if (this.latestDataset === undefined) {
      return undefined;
    }
    const url = buildQueryUrl(this.baseUrl, this.latestDataset, ["time"], ["orderByMax(%22time%22)"]);
    const response = await fetchWithPolicy(
      url,
      { headers: { accept: "application/json" } },
      { fetch: this.fetcher, retries: this.retries, timeoutMs: this.timeoutMs },
    );
    const table = await readErddapResponse(response);
    if (table === undefined) {
      return undefined;
    }
    assertRequestedSchema(table, ["time"]);
    const timeIndex = table.columnNames.indexOf("time");
    const rawTime = table.rows.at(-1)?.[timeIndex];
    if (rawTime === undefined) {
      return undefined;
    }
    if (typeof rawTime !== "string" || !Number.isFinite(Date.parse(rawTime))) {
      throw new GlosSchemaError("ERDDAP latest dataset returned an invalid time");
    }
    return new Date(rawTime);
  }
}
