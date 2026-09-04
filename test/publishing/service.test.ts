import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../../src/config/schema.js";
import { Logger } from "../../src/core/log.js";
import { ChicagoBuoysDatabase } from "../../src/db/database.js";
import type { CanonicalPost, Publisher, PublishReceipt } from "../../src/domain/types.js";
import { PublishingService } from "../../src/publishing/service.js";

const temporaryDirectories: string[] = [];

function openDatabase(): ChicagoBuoysDatabase {
  const directory = mkdtempSync(path.join(tmpdir(), "chicago-buoys-publishing-test-"));
  temporaryDirectories.push(directory);
  return new ChicagoBuoysDatabase(path.join(directory, "test.sqlite"));
}

const config = {
  app: { databasePath: "unused.sqlite", logLevel: "error", mode: "live" },
  posting: {
    delayedMinutes: 20,
    eventDailyMaximum: 6,
    eventsEnabled: false,
    freshnessMinutes: 60,
    ordinaryDailyMaximum: 4,
  },
  publishers: [],
  stations: [],
} satisfies AppConfig;

const post: CanonicalPost = {
  idempotencyKey: "retryable-post",
  kind: "brief:morning",
  langs: ["en-US"],
  observedAt: "2026-09-04T15:00:00.000Z",
  sourceUrls: ["https://example.com/station"],
  stationKey: "test",
  text: "Lake check",
};

class FlakyPublisher implements Publisher {
  public readonly id = "bluesky";
  public calls = 0;

  public publish(): Promise<PublishReceipt> {
    this.calls += 1;
    if (this.calls === 1) {
      return Promise.reject(new TypeError("temporary network failure"));
    }
    return Promise.resolve({
      cid: "cid",
      publishedAt: new Date().toISOString(),
      publisherId: this.id,
      uri: "at://did:plc:test/app.bsky.feed.post/retryable-post",
    });
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("PublishingService", () => {
  it("retries a failed intent and records one completed logical publication", async () => {
    const database = openDatabase();
    const publisher = new FlakyPublisher();
    const service = new PublishingService(config, database, [publisher], new Logger("error"));

    await expect(service.dispatch(post)).rejects.toThrow("temporary network failure");
    await expect(service.dispatch(post)).resolves.toHaveLength(1);

    expect(publisher.calls).toBe(2);
    expect(database.hasCompletedPublication(post.idempotencyKey)).toBe(true);
    expect(database.countPublicationsSince("test", new Date(Date.now() - 60_000))).toBe(1);
    database.close();
  });
});
