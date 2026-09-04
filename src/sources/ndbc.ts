import { z } from "zod";

import { sha256, stableJson } from "../core/hash.js";
import { normalizeDegrees } from "../domain/units.js";
import type {
  NormalizedObservation,
  ObservationSource,
  ObservationValues,
  QualityState,
  SourceFetchResult,
} from "../domain/types.js";
import { fetchWithPolicy, type FetchLike } from "./http.js";

export class NdbcSchemaError extends Error {
  public override readonly name = "NdbcSchemaError";
}

export type NdbcObservationSourceOptions = {
  fetch?: FetchLike;
  now?: () => Date;
  realtimeUrl: string;
  retries?: number;
  stationId: string;
  timeoutMs?: number;
};

export type ParsedNdbcText = {
  records: Array<Record<string, string>>;
  warnings: string[];
};

const REQUIRED_UNITS = {
  YY: "yr",
  MM: "mo",
  DD: "dy",
  hh: "hr",
  mm: "mn",
  WDIR: "degT",
  WSPD: "m/s",
  GST: "m/s",
  WVHT: "m",
  DPD: "sec",
  APD: "sec",
  MWD: "degT",
  PRES: "hPa",
  ATMP: "degC",
  WTMP: "degC",
  DEWP: "degC",
  VIS: "nmi",
  PTDY: "hPa",
  TIDE: "ft",
} as const;

const ndbcHeaderSchema = z
  .object({
    columns: z.array(z.string().min(1)).min(Object.keys(REQUIRED_UNITS).length),
    units: z.array(z.string().min(1)).min(Object.keys(REQUIRED_UNITS).length),
  })
  .superRefine((header, context) => {
    if (header.columns.length !== header.units.length) {
      context.addIssue({ code: "custom", message: "NDBC column and unit header lengths differ" });
      return;
    }
    if (new Set(header.columns).size !== header.columns.length) {
      context.addIssue({ code: "custom", message: "NDBC header contains duplicate columns" });
    }
    for (const [column, expectedUnit] of Object.entries(REQUIRED_UNITS)) {
      const index = header.columns.indexOf(column);
      if (index === -1) {
        context.addIssue({ code: "custom", message: `NDBC header omitted ${column}` });
      } else if (header.units[index] !== expectedUnit) {
        context.addIssue({
          code: "custom",
          message: `NDBC column ${column} changed units from ${expectedUnit} to ${String(header.units[index])}`,
        });
      }
    }
  });

function headerTokens(line: string): string[] {
  const tokens = line.trim().split(/\s+/u);
  const first = tokens[0];
  if (first !== undefined) {
    tokens[0] = first.replace(/^#/u, "");
  }
  return tokens;
}

export function parseNdbcText(text: string): ParsedNdbcText {
  const lines = text.split(/\r?\n/u);
  const columnLine = lines.find((line) => /^#YY\s/u.test(line));
  const columnLineIndex = columnLine === undefined ? -1 : lines.indexOf(columnLine);
  const unitLine = columnLineIndex === -1 ? undefined : lines.slice(columnLineIndex + 1).find((line) => /^#yr\s/u.test(line));
  if (columnLine === undefined || unitLine === undefined) {
    throw new NdbcSchemaError("NDBC response omitted its column or unit header");
  }

  const parsedHeader = ndbcHeaderSchema.safeParse({
    columns: headerTokens(columnLine),
    units: headerTokens(unitLine),
  });
  if (!parsedHeader.success) {
    throw new NdbcSchemaError(`Invalid NDBC header: ${z.prettifyError(parsedHeader.error)}`);
  }

  const { columns } = parsedHeader.data;
  const records: Array<Record<string, string>> = [];
  const warnings: string[] = [];
  const dataStart = lines.indexOf(unitLine) + 1;
  for (let index = dataStart; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const tokens = line.split(/\s+/u);
    if (tokens.length !== columns.length) {
      if (warnings.length < 20) {
        warnings.push(`Skipped NDBC line ${index + 1}: expected ${columns.length} fields, got ${tokens.length}`);
      }
      continue;
    }
    records.push(Object.fromEntries(columns.map((column, tokenIndex) => [column, tokens[tokenIndex] ?? "MM"])));
  }
  return { records, warnings };
}

function parseInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/u.test(value)) {
    return undefined;
  }
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric : undefined;
}

function observationTime(record: Record<string, string>): Date | undefined {
  const year = parseInteger(record.YY);
  const month = parseInteger(record.MM);
  const day = parseInteger(record.DD);
  const hour = parseInteger(record.hh);
  const minute = parseInteger(record.mm);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined
  ) {
    return undefined;
  }
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute
  ) {
    return undefined;
  }
  return date;
}

function numericField(record: Record<string, string>, field: string): number | undefined {
  const raw = record[field];
  if (raw === undefined || raw === "MM") {
    return undefined;
  }
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : undefined;
}

type NdbcScalarSpec = {
  canonical: keyof ObservationValues;
  maximum: number;
  minimum: number;
  sourceMaximum?: number;
  sourceMinimum?: number;
  sourceField: keyof typeof REQUIRED_UNITS;
  transform?: (value: number) => number;
};

const NDBC_SCALAR_SPECS: readonly NdbcScalarSpec[] = [
  { canonical: "windFromDirectionDeg", sourceField: "WDIR", transform: normalizeDegrees, sourceMinimum: 0, sourceMaximum: 360, minimum: 0, maximum: 360 },
  { canonical: "windSpeedMps", sourceField: "WSPD", minimum: 0, maximum: 100 },
  { canonical: "windGustMps", sourceField: "GST", minimum: 0, maximum: 150 },
  { canonical: "significantWaveHeightM", sourceField: "WVHT", minimum: 0, maximum: 30 },
  { canonical: "waveMeanPeriodS", sourceField: "APD", minimum: 0, maximum: 60 },
  { canonical: "waveFromDirectionDeg", sourceField: "MWD", transform: normalizeDegrees, sourceMinimum: 0, sourceMaximum: 360, minimum: 0, maximum: 360 },
  { canonical: "airPressureHpa", sourceField: "PRES", minimum: 800, maximum: 1_200 },
  { canonical: "airTemperatureC", sourceField: "ATMP", minimum: -80, maximum: 60 },
  { canonical: "seaSurfaceTemperatureC", sourceField: "WTMP", minimum: -5, maximum: 40 },
  { canonical: "dewPointTemperatureC", sourceField: "DEWP", minimum: -100, maximum: 60 },
];

function normalizeNdbcRecord(
  stationKey: string,
  stationId: string,
  record: Record<string, string>,
  observedAt: Date,
  ingestedAt: string,
): NormalizedObservation {
  const values: Record<string, number> = {};
  const fieldQuality: Record<string, QualityState> = {};
  const missingFields: string[] = [];
  for (const spec of NDBC_SCALAR_SPECS) {
    const rawValue = numericField(record, spec.sourceField);
    const value = rawValue === undefined ? undefined : (spec.transform?.(rawValue) ?? rawValue);
    const sourceInRange =
      rawValue !== undefined &&
      (spec.sourceMinimum === undefined || rawValue >= spec.sourceMinimum) &&
      (spec.sourceMaximum === undefined || rawValue <= spec.sourceMaximum);
    if (!sourceInRange || value === undefined || value < spec.minimum || value > spec.maximum) {
      fieldQuality[spec.canonical] = "missing";
      missingFields.push(spec.canonical);
      continue;
    }
    fieldQuality[spec.canonical] = "not_evaluated";
    values[spec.canonical] = value;
  }

  return {
    stationKey,
    observedAt: observedAt.toISOString(),
    ingestedAt,
    source: "ndbc",
    sourceDataset: `realtime2/${stationId}.txt`,
    sourceHash: sha256(stableJson(record)),
    overallQuality: Object.keys(values).length === 0 ? "missing" : "not_evaluated",
    values: values as ObservationValues,
    fieldQuality,
    profile: [],
    missingFields,
    raw: record,
  };
}

export class NdbcObservationSource implements ObservationSource {
  public readonly id = "ndbc";

  private readonly fetcher: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly realtimeUrl: string;
  private readonly retries: number;
  private readonly stationId: string;
  private readonly timeoutMs: number;

  public constructor(options: NdbcObservationSourceOptions) {
    if (!/^[A-Za-z0-9]{5}$/u.test(options.stationId)) {
      throw new TypeError("NDBC stationId must contain exactly five letters or digits");
    }
    this.fetcher = options.fetch;
    this.now = options.now ?? (() => new Date());
    this.realtimeUrl = options.realtimeUrl;
    this.retries = options.retries ?? 1;
    this.stationId = options.stationId.toUpperCase();
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  public async fetchRecent(stationKey: string, since: Date): Promise<SourceFetchResult> {
    if (!Number.isFinite(since.getTime())) {
      throw new TypeError("NDBC since date is invalid");
    }
    const response = await fetchWithPolicy(
      this.realtimeUrl,
      { headers: { accept: "text/plain" } },
      { fetch: this.fetcher, retries: this.retries, timeoutMs: this.timeoutMs },
    );
    if (response.status === 304) {
      return { observations: [], source: this.id, warnings: ["NDBC source was not modified"] };
    }
    if (response.status === 404) {
      return { observations: [], source: this.id, warnings: ["NDBC source is unavailable (HTTP 404)"] };
    }
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`NDBC returned ${response.status}: ${body.slice(0, 500)}`);
    }

    const parsed = parseNdbcText(await response.text());
    const ingestedAt = this.now().toISOString();
    const observations: NormalizedObservation[] = [];
    const warnings = [...parsed.warnings];
    const seenTimes = new Set<string>();
    for (const record of parsed.records) {
      const observedAt = observationTime(record);
      if (observedAt === undefined) {
        if (warnings.length < 20) {
          warnings.push("Skipped NDBC row with an invalid UTC timestamp");
        }
        continue;
      }
      const isoTime = observedAt.toISOString();
      if (observedAt.getTime() <= since.getTime() || seenTimes.has(isoTime)) {
        continue;
      }
      seenTimes.add(isoTime);
      observations.push(normalizeNdbcRecord(stationKey, this.stationId, record, observedAt, ingestedAt));
    }
    observations.sort((left, right) => left.observedAt.localeCompare(right.observedAt));
    return { observations, source: this.id, warnings };
  }
}
