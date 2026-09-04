import type { StationConfig } from "../config/schema.js";
import { sha256 } from "../core/hash.js";
import type { CameraClipCandidate } from "../media/camera-source.js";
import type { CanonicalPost } from "../domain/types.js";
import { assertPostLength } from "./graphemes.js";

export function isCameraOpportunity(station: StationConfig, now: Date): boolean {
  const camera = station.camera;
  if (camera === undefined) {
    return false;
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hourCycle: "h23",
    minute: "numeric",
    timeZone: station.timeZone,
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return camera.opportunityHoursLocal.includes(hour) && minute < 10;
}

export function buildCameraPost(station: StationConfig, clip: CameraClipCandidate): CanonicalPost {
  const camera = station.camera;
  if (camera === undefined || camera.rights.attribution === undefined) {
    throw new Error(`Camera attribution is not configured for ${station.key}`);
  }
  const updated = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric",
    timeZone: station.timeZone,
    timeZoneName: "short",
  }).format(new Date(clip.lastModified));
  const text = `Offshore office hours: a recent view from ${station.displayName}. Camera updated ${updated}.\nVideo: ${camera.rights.attribution}`;
  assertPostLength(text);
  return {
    idempotencyKey: sha256(`${station.key}:camera:${clip.sha256}`),
    kind: "camera",
    stationKey: station.key,
    text,
    langs: ["en-US"],
    observedAt: clip.lastModified,
    sourceUrls: [station.links.station, clip.sourceUrl],
    media: {
      kind: "video",
      alt: `Approximately 30-second video from the camera on ${station.displayName}, offshore from Chicago. Camera file updated ${updated}.`,
      aspectRatio: { width: 16, height: 9 },
      bytes: clip.bytes,
      mimeType: "video/mp4",
    },
  };
}
