export type FreshnessState = "fresh" | "delayed" | "stale" | "outage";

export function freshnessState(
  observedAt: Date,
  now: Date,
  delayedMinutes = 20,
  staleMinutes = 60,
  outageMinutes = 120,
): FreshnessState {
  const ageMinutes = Math.max(0, (now.getTime() - observedAt.getTime()) / 60_000);
  if (ageMinutes <= delayedMinutes) {
    return "fresh";
  }
  if (ageMinutes <= staleMinutes) {
    return "delayed";
  }
  if (ageMinutes <= outageMinutes) {
    return "stale";
  }
  return "outage";
}
