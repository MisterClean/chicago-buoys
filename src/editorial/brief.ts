import { sha256 } from "../core/hash.js";
import {
  celsiusToFahrenheit,
  degreesToCompass,
  metersPerSecondToKnots,
  metersToFeet,
} from "../domain/units.js";
import type { CanonicalPost, NormalizedObservation, ObservationValues } from "../domain/types.js";
import type { StationConfig } from "../config/schema.js";
import { assertPostLength, graphemeLength } from "./graphemes.js";

export type BriefLane = "morning" | "afternoon";

function formatOne(value: number): string {
  return value.toFixed(1);
}

function currentFacts(values: ObservationValues): string[] {
  const facts: string[] = [];
  if (values.significantWaveHeightM !== undefined) {
    const period = values.waveMeanPeriodS === undefined ? "" : ` @ ${formatOne(values.waveMeanPeriodS)} s`;
    facts.push(`Waves ${formatOne(metersToFeet(values.significantWaveHeightM))} ft${period}`);
  }
  if (values.seaSurfaceTemperatureC !== undefined) {
    facts.push(`Water ${formatOne(celsiusToFahrenheit(values.seaSurfaceTemperatureC))}°F`);
  }
  if (values.airTemperatureC !== undefined) {
    facts.push(`Air ${formatOne(celsiusToFahrenheit(values.airTemperatureC))}°F`);
  }
  if (values.windSpeedMps !== undefined) {
    const direction =
      values.windFromDirectionDeg === undefined ? "" : `${degreesToCompass(values.windFromDirectionDeg)} `;
    const gust =
      values.windGustMps === undefined
        ? ""
        : `, gust ${formatOne(metersPerSecondToKnots(values.windGustMps))}`;
    facts.push(`Wind ${direction}${formatOne(metersPerSecondToKnots(values.windSpeedMps))} kt${gust}`);
  }
  return facts;
}

function comparisonFacts(current: ObservationValues, previous?: ObservationValues): string[] {
  if (previous === undefined) {
    return [];
  }
  const facts: string[] = [];
  if (current.significantWaveHeightM !== undefined && previous.significantWaveHeightM !== undefined) {
    const difference = metersToFeet(current.significantWaveHeightM - previous.significantWaveHeightM);
    if (Math.abs(difference) >= 0.2) {
      facts.push(`waves ${difference > 0 ? "up" : "down"} ${formatOne(Math.abs(difference))} ft in 24h`);
    }
  }
  if (current.seaSurfaceTemperatureC !== undefined && previous.seaSurfaceTemperatureC !== undefined) {
    const difference = (current.seaSurfaceTemperatureC - previous.seaSurfaceTemperatureC) * 1.8;
    if (Math.abs(difference) >= 0.3) {
      facts.push(`water ${difference > 0 ? "up" : "down"} ${formatOne(Math.abs(difference))}° in 24h`);
    }
  }
  return facts;
}

function formatObservedAt(observedAt: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    timeZone,
    timeZoneName: "short",
  }).format(new Date(observedAt));
}

function localDateKey(observedAt: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).format(new Date(observedAt));
}

export function buildBrief(
  station: StationConfig,
  lane: BriefLane,
  current: NormalizedObservation,
  previous?: NormalizedObservation,
): CanonicalPost {
  const facts = currentFacts(current.values);
  if (facts.length === 0) {
    throw new Error(`No publishable fields are available for ${station.key}`);
  }
  const comparisons = comparisonFacts(current.values, previous?.values);
  const comparisonSentence = comparisons.length === 0 ? "" : ` Since yesterday: ${comparisons.join("; ")}.`;
  const label = lane === "morning" ? "Morning lake check" : "Afternoon lake check";
  const factualText = `${label}: ${facts.join(" · ")}.${comparisonSentence}\nObserved ${formatObservedAt(current.observedAt, station.timeZone)}. Observations, not a forecast.`;
  const linkedText = `${factualText}\n${station.links.station}`;
  const text = graphemeLength(linkedText) <= 300 ? linkedText : factualText;
  assertPostLength(text);
  return {
    idempotencyKey: sha256(`${station.key}:${lane}:${localDateKey(current.observedAt, station.timeZone)}`),
    kind: `brief:${lane}`,
    stationKey: station.key,
    text,
    langs: ["en-US"],
    observedAt: current.observedAt,
    sourceUrls: [station.links.station],
  };
}

export function buildThermalProfilePost(
  station: StationConfig,
  observation: NormalizedObservation,
): CanonicalPost {
  const profile = observation.profile
    .filter((point) => point.quality === "good" || point.quality === "not_evaluated")
    .sort((left, right) => left.depthM - right.depthM);
  if (profile.length < 2) {
    throw new Error(`At least two valid temperature depths are required for ${station.key}`);
  }
  const shallowest = profile[0];
  const deepest = profile.at(-1);
  if (shallowest === undefined || deepest === undefined) {
    throw new Error("Temperature profile is unexpectedly empty");
  }
  const spreadF = Math.abs(shallowest.temperatureC - deepest.temperatureC) * 1.8;
  const state = spreadF < 1.5 ? "nearly mixed" : spreadF >= 5 ? "strongly layered" : "partly layered";
  const factualText = `The lake has floors: the water column is ${state}. The shallowest and deepest sensors are ${formatOne(spreadF)}°F apart across ${formatOne(metersToFeet(deepest.depthM - shallowest.depthM))} ft.\nObserved ${formatObservedAt(observation.observedAt, station.timeZone)}.`;
  const linkedText = `${factualText}\n${station.links.station}`;
  const text = graphemeLength(linkedText) <= 300 ? linkedText : factualText;
  assertPostLength(text);
  return {
    idempotencyKey: sha256(
      `${station.key}:thermal:${localDateKey(observation.observedAt, station.timeZone)}`,
    ),
    kind: "thermal-profile",
    stationKey: station.key,
    text,
    langs: ["en-US"],
    observedAt: observation.observedAt,
    sourceUrls: [station.links.station],
  };
}
