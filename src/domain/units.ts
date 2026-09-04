const METERS_TO_FEET = 3.280_839_895;
const MPS_TO_KNOTS = 1.943_844_492;

export function celsiusToFahrenheit(celsius: number): number {
  return (celsius * 9) / 5 + 32;
}

export function kelvinToCelsius(kelvin: number): number {
  return kelvin - 273.15;
}

export function metersToFeet(meters: number): number {
  return meters * METERS_TO_FEET;
}

export function metersPerSecondToKnots(metersPerSecond: number): number {
  return metersPerSecond * MPS_TO_KNOTS;
}

export function pascalsToHectopascals(pascals: number): number {
  return pascals / 100;
}

export function normalizeDegrees(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

const COMPASS_POINTS = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
] as const;

export function degreesToCompass(degrees: number): string {
  const index = Math.round(normalizeDegrees(degrees) / 22.5) % 16;
  return COMPASS_POINTS[index] ?? "N";
}
