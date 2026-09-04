import type { StationConfig } from "../config/schema.js";
import { sha256 } from "../core/hash.js";
import { isEventQuality } from "../domain/quality.js";
import { metersToFeet } from "../domain/units.js";
import type { CanonicalPost, NormalizedObservation } from "../domain/types.js";
import { assertPostLength } from "./graphemes.js";

type EventInputs = {
  current: NormalizedObservation;
  ninetyMinutesAgo?: NormalizedObservation;
  threeHoursAgo?: NormalizedObservation;
  yesterday?: NormalizedObservation;
};

function fieldIsGood(observation: NormalizedObservation, field: string): boolean {
  return isEventQuality(observation.fieldQuality[field] ?? observation.overallQuality);
}

function buildEvent(
  station: StationConfig,
  current: NormalizedObservation,
  family: string,
  text: string,
): CanonicalPost {
  const linkLabel = "View data";
  const postText = `${text}\n\nObserved at ${station.displayName}.  ·  ${linkLabel}`;
  assertPostLength(postText);
  return {
    idempotencyKey: sha256(`${station.key}:event:${family}:${current.observedAt}`),
    kind: `event:${family}`,
    stationKey: station.key,
    text: postText,
    langs: ["en-US"],
    observedAt: current.observedAt,
    sourceUrls: [station.links.station],
    links: [{ label: linkLabel, uri: station.links.station }],
  };
}

function comparableTemperatureSpreads(
  current: NormalizedObservation,
  previous: NormalizedObservation,
): { current: number; previous: number } | undefined {
  const currentProfile = current.profile
    .filter((point) => isEventQuality(point.quality))
    .sort((left, right) => left.depthM - right.depthM);
  const previousProfile = previous.profile
    .filter((point) => isEventQuality(point.quality))
    .sort((left, right) => left.depthM - right.depthM);
  if (
    currentProfile.length < 2 ||
    currentProfile.length !== previousProfile.length ||
    currentProfile.some(
      (point, index) => Math.abs(point.depthM - (previousProfile[index]?.depthM ?? Infinity)) > 0.05,
    )
  ) {
    return undefined;
  }
  const currentTemperatures = currentProfile.map((point) => point.temperatureC);
  const previousTemperatures = previousProfile.map((point) => point.temperatureC);
  return {
    current: Math.max(...currentTemperatures) - Math.min(...currentTemperatures),
    previous: Math.max(...previousTemperatures) - Math.min(...previousTemperatures),
  };
}

export function detectEvents(station: StationConfig, inputs: EventInputs): CanonicalPost[] {
  const events: CanonicalPost[] = [];
  const { current, ninetyMinutesAgo, threeHoursAgo, yesterday } = inputs;

  const currentWave = current.values.significantWaveHeightM;
  const previousWave = ninetyMinutesAgo?.values.significantWaveHeightM;
  if (
    currentWave !== undefined &&
    previousWave !== undefined &&
    ninetyMinutesAgo !== undefined &&
    fieldIsGood(current, "significantWaveHeightM") &&
    fieldIsGood(ninetyMinutesAgo, "significantWaveHeightM") &&
    currentWave >= 0.6096 &&
    previousWave < 0.6096 &&
    currentWave - previousWave >= 0.2286
  ) {
    events.push(
      buildEvent(
        station,
        current,
        "wave-build",
        `The lake changed gears: significant waves rose from ${metersToFeet(previousWave).toFixed(1)} to ${metersToFeet(currentWave).toFixed(1)} ft in about 90 minutes.`,
      ),
    );
  }

  const currentPressure = current.values.airPressureHpa;
  const previousPressure = threeHoursAgo?.values.airPressureHpa;
  if (
    currentPressure !== undefined &&
    previousPressure !== undefined &&
    threeHoursAgo !== undefined &&
    fieldIsGood(current, "airPressureHpa") &&
    fieldIsGood(threeHoursAgo, "airPressureHpa") &&
    previousPressure - currentPressure >= 3
  ) {
    events.push(
      buildEvent(
        station,
        current,
        "pressure-fall",
        `Pressure fell ${(previousPressure - currentPressure).toFixed(1)} hPa in about three hours, from ${previousPressure.toFixed(1)} to ${currentPressure.toFixed(1)} hPa.`,
      ),
    );
  }

  const currentWater = current.values.seaSurfaceTemperatureC;
  const previousWater = threeHoursAgo?.values.seaSurfaceTemperatureC;
  if (
    currentWater !== undefined &&
    previousWater !== undefined &&
    threeHoursAgo !== undefined &&
    fieldIsGood(current, "seaSurfaceTemperatureC") &&
    fieldIsGood(threeHoursAgo, "seaSurfaceTemperatureC") &&
    previousWater - currentWater >= 4 / 1.8
  ) {
    events.push(
      buildEvent(
        station,
        current,
        "rapid-cooling",
        `The lake surface cooled ${((previousWater - currentWater) * 1.8).toFixed(1)}°F in about three hours—an upwelling-shaped signal, not proof of the cause.`,
      ),
    );
  }

  if (yesterday !== undefined) {
    const spreads = comparableTemperatureSpreads(current, yesterday);
    if (
      spreads !== undefined &&
      spreads.previous >= 5 / 1.8 &&
      spreads.current <= 1.5 / 1.8 &&
      spreads.current <= spreads.previous / 2
    ) {
      events.push(
        buildEvent(
          station,
          current,
          "mixing",
          `The lake removed a layer: its measured temperature spread narrowed from ${(spreads.previous * 1.8).toFixed(1)}°F yesterday to ${(spreads.current * 1.8).toFixed(1)}°F now.`,
        ),
      );
    }
  }

  return events;
}
