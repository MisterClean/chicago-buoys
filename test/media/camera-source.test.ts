import { describe, expect, it } from "vitest";

import { type StationConfig, configSchema } from "../../src/config/schema.js";
import { assertCameraAuthorized, HttpCameraSource } from "../../src/media/camera-source.js";

function stationWithCamera(
  status: "not_granted" | "pending" | "granted",
  enabled = true,
): StationConfig {
  const station = configSchema.parse({
    app: { databasePath: "test.sqlite" },
    posting: {},
    stations: [
      {
        key: "test",
        displayName: "Test Buoy",
        timeZone: "America/Chicago",
        links: { station: "https://example.com/station" },
        sources: { ndbc: { stationId: "1", realtimeUrl: "https://example.com/data.txt" } },
        camera: {
          enabled,
          currentClipUrl: "https://example.com/clip.mp4",
          rights: {
            status,
            ...(status === "granted"
              ? { attribution: "Example operator", permissionReference: "permission-2026-01" }
              : {}),
          },
        },
      },
    ],
  }).stations[0];
  if (station === undefined) {
    throw new Error("Test station was not parsed");
  }
  return station;
}

describe("camera permission gate", () => {
  it("refuses ungranted redistribution", () => {
    expect(() => assertCameraAuthorized(stationWithCamera("pending"))).toThrow(/not been granted/u);
  });

  it("accepts a recorded grant with attribution", () => {
    expect(() => assertCameraAuthorized(stationWithCamera("granted"))).not.toThrow();
  });
});

describe("HttpCameraSource", () => {
  it("does not call the network while disabled", async () => {
    let called = false;
    const fetcher: typeof fetch = () => {
      called = true;
      throw new Error("unexpected fetch");
    };
    const source = new HttpCameraSource(stationWithCamera("not_granted", false), fetcher);
    await expect(source.fetchLatest(undefined)).resolves.toMatchObject({ state: "disabled" });
    expect(called).toBe(false);
  });

  it("uses an ETag to suppress unchanged clips", async () => {
    const fetcher: typeof fetch = async () => new Response(null, { status: 304 });
    const source = new HttpCameraSource(stationWithCamera("granted"), fetcher);
    await expect(source.fetchLatest('"old"')).resolves.toMatchObject({ state: "not_modified" });
  });
});
