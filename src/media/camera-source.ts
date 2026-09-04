import type { StationConfig } from "../config/schema.js";
import { sha256 } from "../core/hash.js";

export type CameraClipCandidate = {
  bytes: Uint8Array;
  contentLength: number;
  discoveredAt: string;
  etag?: string;
  lastModified: string;
  sha256: string;
  sourceUrl: string;
};

export type CameraInspection =
  | { state: "disabled" | "not_authorized" | "not_modified" | "stale"; reason: string }
  | { state: "available"; candidate: CameraClipCandidate };

function cameraConfig(station: StationConfig): NonNullable<StationConfig["camera"]> {
  if (station.camera === undefined) {
    throw new Error(`No camera is configured for ${station.key}`);
  }
  return station.camera;
}

export function assertCameraAuthorized(station: StationConfig): void {
  const camera = cameraConfig(station);
  if (!camera.enabled) {
    throw new Error(`Camera publication is disabled for ${station.key}`);
  }
  if (camera.rights.status !== "granted") {
    throw new Error(`Camera redistribution rights have not been granted for ${station.key}`);
  }
  if (camera.rights.permissionReference === undefined || camera.rights.attribution === undefined) {
    throw new Error(`Camera permission reference and attribution are required for ${station.key}`);
  }
}

function headerNumber(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function isMp4(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === "ftyp";
}

export class HttpCameraSource {
  public constructor(
    private readonly station: StationConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  public async fetchLatest(previousEtag: string | undefined, now = new Date()): Promise<CameraInspection> {
    const camera = cameraConfig(this.station);
    if (!camera.enabled) {
      return { state: "disabled", reason: "camera.enabled is false" };
    }
    if (
      camera.rights.status !== "granted" ||
      camera.rights.permissionReference === undefined ||
      camera.rights.attribution === undefined
    ) {
      return { state: "not_authorized", reason: "redistribution permission is not recorded" };
    }

    const requestHeaders = previousEtag === undefined ? undefined : { "if-none-match": previousEtag };
    const head = await this.fetcher(camera.currentClipUrl, {
      ...(requestHeaders === undefined ? {} : { headers: requestHeaders }),
      method: "HEAD",
      signal: AbortSignal.timeout(20_000),
    });
    if (head.status === 304) {
      return { state: "not_modified", reason: "source ETag has not changed" };
    }
    if (!head.ok) {
      throw new Error(`Camera HEAD returned HTTP ${head.status}`);
    }

    const etag = head.headers.get("etag") ?? undefined;
    if (etag !== undefined && etag === previousEtag) {
      return { state: "not_modified", reason: "source ETag has not changed" };
    }
    const lastModifiedRaw = head.headers.get("last-modified");
    if (lastModifiedRaw === null) {
      throw new Error("Camera source did not provide Last-Modified");
    }
    const lastModified = new Date(lastModifiedRaw);
    if (Number.isNaN(lastModified.getTime())) {
      throw new Error(`Camera source returned invalid Last-Modified: ${lastModifiedRaw}`);
    }
    const ageMinutes = Math.max(0, (now.getTime() - lastModified.getTime()) / 60_000);
    if (ageMinutes > camera.freshnessMinutes) {
      return { state: "stale", reason: `clip is ${Math.round(ageMinutes)} minutes old` };
    }

    const headLength = headerNumber(head.headers, "content-length");
    if (headLength !== undefined && headLength > camera.maximumBytes) {
      throw new Error(`Camera clip is ${headLength} bytes; configured maximum is ${camera.maximumBytes}`);
    }

    const response = await this.fetcher(camera.currentClipUrl, {
      ...(etag === undefined ? {} : { headers: { "if-match": etag } }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(`Camera download returned HTTP ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > camera.maximumBytes) {
      throw new Error(`Camera clip is ${bytes.byteLength} bytes; configured maximum is ${camera.maximumBytes}`);
    }
    if (!isMp4(bytes)) {
      throw new Error("Camera source did not return an MP4 file");
    }

    return {
      state: "available",
      candidate: {
        bytes,
        contentLength: bytes.byteLength,
        discoveredAt: now.toISOString(),
        ...(etag === undefined ? {} : { etag }),
        lastModified: lastModified.toISOString(),
        sha256: sha256(bytes),
        sourceUrl: camera.currentClipUrl,
      },
    };
  }
}
