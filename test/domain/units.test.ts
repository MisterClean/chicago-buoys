import { describe, expect, it } from "vitest";

import {
  celsiusToFahrenheit,
  degreesToCompass,
  kelvinToCelsius,
  metersPerSecondToKnots,
  metersToFeet,
  normalizeDegrees,
  pascalsToHectopascals,
} from "../../src/domain/units.js";

describe("unit conversions", () => {
  it("converts temperatures", () => {
    expect(kelvinToCelsius(273.15)).toBeCloseTo(0);
    expect(celsiusToFahrenheit(0)).toBeCloseTo(32);
  });

  it("converts distance, speed, and pressure", () => {
    expect(metersToFeet(1)).toBeCloseTo(3.28084);
    expect(metersPerSecondToKnots(1)).toBeCloseTo(1.94384);
    expect(pascalsToHectopascals(101_210)).toBeCloseTo(1_012.1);
  });

  it("normalizes compass directions at boundaries", () => {
    expect(normalizeDegrees(-1)).toBe(359);
    expect(degreesToCompass(0)).toBe("N");
    expect(degreesToCompass(11.24)).toBe("N");
    expect(degreesToCompass(11.25)).toBe("NNE");
    expect(degreesToCompass(348.75)).toBe("N");
  });
});
