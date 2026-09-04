import type { BriefLane } from "../editorial/brief.js";

type LocalParts = {
  day: number;
  hour: number;
  minute: number;
};

function localParts(now: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hourCycle: "h23",
    minute: "numeric",
    timeZone,
    weekday: "short",
  }).formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday ?? "");
  return {
    day,
    hour: Number(parts.find((part) => part.type === "hour")?.value),
    minute: Number(parts.find((part) => part.type === "minute")?.value),
  };
}

export function dueBriefLane(now: Date, timeZone: string): BriefLane | undefined {
  const { hour, minute } = localParts(now, timeZone);
  if (hour === 7 && minute >= 30 && minute < 40) {
    return "morning";
  }
  if (hour === 16 && minute >= 30 && minute < 40) {
    return "afternoon";
  }
  return undefined;
}

export function isThermalOpportunity(now: Date, timeZone: string): boolean {
  const { hour, minute } = localParts(now, timeZone);
  return hour === 12 && minute < 10;
}

export function isWeeklyOpportunity(now: Date, timeZone: string): boolean {
  const { day, hour, minute } = localParts(now, timeZone);
  return day === 0 && hour === 11 && minute < 10;
}
