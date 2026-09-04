import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LakePulseDatabase } from "../../src/db/database.js";
import type { CanonicalPost, NormalizedObservation } from "../../src/domain/types.js";

const temporaryDirectories: string[] = [];

function openDatabase(): LakePulseDatabase {
  const directory = mkdtempSync(path.join(tmpdir(), "lake-pulse-test-"));
  temporaryDirectories.push(directory);
  return new LakePulseDatabase(path.join(directory, "test.sqlite"));
}

function observation(observedAt = "2026-09-04T12:00:00.000Z"): NormalizedObservation {
  return {
    stationKey: "test",
    observedAt,
    ingestedAt: "2026-09-04T12:01:00.000Z",
    source: "glos",
    sourceDataset: "obs_test",
    sourceHash: "abc123",
    overallQuality: "good",
    values: { seaSurfaceTemperatureC: 20 },
    fieldQuality: { seaSurfaceTemperatureC: "good" },
    profile: [],
    missingFields: [],
    raw: { value: 293.15 },
  };
}

function post(): CanonicalPost {
  return {
    idempotencyKey: "post-key",
    kind: "brief:morning",
    stationKey: "test",
    text: "Lake check",
    langs: ["en-US"],
    sourceUrls: ["https://example.com"],
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("LakePulseDatabase", () => {
  it("stores observations idempotently and reads the latest", () => {
    const database = openDatabase();
    database.upsertObservation(observation());
    database.upsertObservation({ ...observation(), sourceHash: "corrected" });

    expect(database.getLatestAcceptableObservation("test")?.sourceHash).toBe("corrected");
    database.close();
  });

  it("reserves a post only once per publisher", () => {
    const database = openDatabase();
    expect(database.reservePublication(post(), "bluesky", "pending")).toBe(true);
    expect(database.reservePublication(post(), "bluesky", "pending")).toBe(false);
    expect(database.reservePublication(post(), "other", "pending")).toBe(true);
    database.close();
  });

  it("retries failed publication intents a bounded number of times", () => {
    const database = openDatabase();
    expect(database.reservePublication(post(), "bluesky", "pending")).toBe(true);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      database.markPublicationStarted(post().idempotencyKey, "bluesky");
      database.markPublicationFailed(post().idempotencyKey, "bluesky", `failure ${attempt}`);
      expect(database.reservePublication(post(), "bluesky", "pending")).toBe(attempt < 3);
    }
    database.close();
  });

  it("counts logical posts once across publisher adapters", () => {
    const database = openDatabase();
    const now = new Date();
    expect(database.reservePublication(post(), "bluesky", "shadow")).toBe(true);
    expect(database.reservePublication(post(), "future-publisher", "shadow")).toBe(true);

    expect(database.countPublicationsSince("test", new Date(now.getTime() - 60_000))).toBe(1);
    expect(
      database.countPublicationKindPrefixSince("test", new Date(now.getTime() - 60_000), "brief:"),
    ).toBe(1);
    database.close();
  });

  it("records run health", () => {
    const database = openDatabase();
    const runId = database.startRun("tick");
    database.finishRun(runId, "succeeded");

    expect(database.getLatestRun()).toMatchObject({ command: "tick", status: "succeeded" });
    database.close();
  });
});
