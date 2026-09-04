import type { QualityState } from "./types.js";

export function qualityFromIoosFlag(value: unknown): QualityState {
  const numeric = typeof value === "string" ? Number(value) : value;
  switch (numeric) {
    case 1:
      return "good";
    case 2:
      return "not_evaluated";
    case 3:
      return "suspect";
    case 4:
      return "bad";
    case 9:
    case null:
    case undefined:
      return "missing";
    default:
      return "not_evaluated";
  }
}

export function isPublishableQuality(quality: QualityState): boolean {
  return quality === "good" || quality === "not_evaluated";
}

export function isEventQuality(quality: QualityState): boolean {
  return quality === "good";
}
