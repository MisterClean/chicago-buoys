import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { CanonicalPost, NormalizedObservation, PublishReceipt } from "../domain/types.js";

type ObservationRow = {
  normalized_json: string;
};

type CountRow = {
  count: number;
};

const MAX_PUBLICATION_ATTEMPTS = 3;
const PUBLICATION_RECLAIM_AFTER_MS = 30 * 60_000;

type CameraClipRow = {
  discovered_at: string;
  etag: string | null;
  last_modified: string | null;
  sha256: string | null;
  posted_at: string | null;
};

export type CameraClipRecord = {
  stationKey: string;
  sourceUrl: string;
  etag?: string;
  lastModified?: string;
  sha256?: string;
  discoveredAt: string;
  postedAt?: string;
};

export type RunRecord = {
  id: number;
  command: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "succeeded" | "failed";
  error?: string;
};

export class ChicagoBuoysDatabase {
  private readonly database: DatabaseSync;

  public constructor(
    databasePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    const absolutePath = path.resolve(databasePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    this.database = new DatabaseSync(absolutePath, {
      timeout: 5_000,
    });
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = NORMAL");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  public close(): void {
    this.database.close();
  }

  public healthCheck(): boolean {
    const row = this.database.prepare("SELECT 1 AS healthy").get() as { healthy?: number } | undefined;
    return row?.healthy === 1;
  }

  public startRun(command: string): number {
    const result = this.database
      .prepare("INSERT INTO runs(command, started_at, status) VALUES (?, ?, 'running')")
      .run(command, this.now().toISOString());
    return Number(result.lastInsertRowid);
  }

  public finishRun(runId: number, status: "succeeded" | "failed", error?: string): void {
    this.database
      .prepare("UPDATE runs SET finished_at = ?, status = ?, error = ? WHERE id = ?")
      .run(this.now().toISOString(), status, error?.slice(0, 2_000) ?? null, runId);
  }

  public getLatestRun(): RunRecord | undefined {
    const row = this.database
      .prepare(`
        SELECT id, command, started_at, finished_at, status, error
        FROM runs
        ORDER BY id DESC
        LIMIT 1
      `)
      .get() as
      | {
          id: number;
          command: string;
          started_at: string;
          finished_at: string | null;
          status: "running" | "succeeded" | "failed";
          error: string | null;
        }
      | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id,
      command: row.command,
      startedAt: row.started_at,
      status: row.status,
      ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
      ...(row.error === null ? {} : { error: row.error }),
    };
  }

  public upsertObservation(observation: NormalizedObservation): void {
    this.database
      .prepare(`
        INSERT INTO observations (
          station_key,
          observed_at,
          ingested_at,
          source,
          source_dataset,
          source_hash,
          overall_quality,
          normalized_json,
          raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(station_key, source, observed_at) DO UPDATE SET
          ingested_at = excluded.ingested_at,
          source_dataset = excluded.source_dataset,
          source_hash = excluded.source_hash,
          overall_quality = excluded.overall_quality,
          normalized_json = excluded.normalized_json,
          raw_json = excluded.raw_json
      `)
      .run(
        observation.stationKey,
        observation.observedAt,
        observation.ingestedAt,
        observation.source,
        observation.sourceDataset,
        observation.sourceHash,
        observation.overallQuality,
        JSON.stringify(observation),
        JSON.stringify(observation.raw),
      );
  }

  public getLatestAcceptableObservation(stationKey: string): NormalizedObservation | undefined {
    const row = this.database
      .prepare(`
        WITH latest AS (
          SELECT MAX(observed_at) AS observed_at
          FROM observations
          WHERE station_key = ?
        )
        SELECT normalized_json
        FROM observations, latest
        WHERE station_key = ? AND observations.observed_at = latest.observed_at
        ORDER BY source = 'glos' DESC
        LIMIT 1
      `)
      .get(stationKey, stationKey) as ObservationRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    const observation = JSON.parse(row.normalized_json) as NormalizedObservation;
    return observation.overallQuality === "good" || observation.overallQuality === "not_evaluated"
      ? observation
      : undefined;
  }

  public getAcceptableObservationAtOrBefore(
    stationKey: string,
    target: Date,
    toleranceMinutes: number,
  ): NormalizedObservation | undefined {
    const earliest = new Date(target.getTime() - toleranceMinutes * 60_000).toISOString();
    const row = this.database
      .prepare(`
        WITH latest AS (
          SELECT MAX(observed_at) AS observed_at
          FROM observations
          WHERE station_key = ? AND observed_at <= ? AND observed_at >= ?
        )
        SELECT normalized_json
        FROM observations, latest
        WHERE station_key = ? AND observations.observed_at = latest.observed_at
        ORDER BY source = 'glos' DESC
        LIMIT 1
      `)
      .get(stationKey, target.toISOString(), earliest, stationKey) as ObservationRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    const observation = JSON.parse(row.normalized_json) as NormalizedObservation;
    return observation.overallQuality === "good" || observation.overallQuality === "not_evaluated"
      ? observation
      : undefined;
  }

  public reservePublication(post: CanonicalPost, publisherId: string, status: "pending" | "shadow"): boolean {
    const timestampDate = this.now();
    const timestamp = timestampDate.toISOString();
    const reclaimBefore = new Date(
      timestampDate.getTime() - PUBLICATION_RECLAIM_AFTER_MS,
    ).toISOString();
    const result = this.database
      .prepare(`
        INSERT INTO publication_intents (
          idempotency_key,
          publisher_id,
          station_key,
          kind,
          status,
          payload_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(idempotency_key, publisher_id) DO UPDATE SET
          status = excluded.status,
          payload_json = excluded.payload_json,
          error = NULL,
          updated_at = excluded.updated_at
        WHERE (
          publication_intents.status = 'failed'
          OR (
            publication_intents.status IN ('pending', 'publishing')
            AND publication_intents.updated_at <= ?
          )
        )
          AND publication_intents.attempt_count < ${MAX_PUBLICATION_ATTEMPTS}
      `)
      .run(
        post.idempotencyKey,
        publisherId,
        post.stationKey,
        post.kind,
        status,
        JSON.stringify(post, (_key, value: unknown) => (value instanceof Uint8Array ? "[binary]" : value)),
        timestamp,
        timestamp,
        reclaimBefore,
      );
    return result.changes === 1;
  }

  public markPublicationStarted(idempotencyKey: string, publisherId: string): void {
    this.database
      .prepare(`
        UPDATE publication_intents
        SET status = 'publishing', attempt_count = attempt_count + 1, updated_at = ?
        WHERE idempotency_key = ? AND publisher_id = ? AND status = 'pending'
      `)
      .run(this.now().toISOString(), idempotencyKey, publisherId);
  }

  public markPublicationComplete(
    idempotencyKey: string,
    receipt: PublishReceipt,
  ): void {
    this.database
      .prepare(`
        UPDATE publication_intents
        SET status = 'published', uri = ?, cid = ?, published_at = ?, updated_at = ?
        WHERE idempotency_key = ? AND publisher_id = ?
      `)
      .run(
        receipt.uri,
        receipt.cid,
        receipt.publishedAt,
        this.now().toISOString(),
        idempotencyKey,
        receipt.publisherId,
      );
  }

  public markPublicationFailed(idempotencyKey: string, publisherId: string, message: string): void {
    this.database
      .prepare(`
        UPDATE publication_intents
        SET status = 'failed', error = ?, updated_at = ?
        WHERE idempotency_key = ? AND publisher_id = ?
      `)
      .run(message.slice(0, 2_000), this.now().toISOString(), idempotencyKey, publisherId);
  }

  public countPublicationsSince(stationKey: string, since: Date, kind?: string): number {
    const row =
      kind === undefined
        ? (this.database
            .prepare(`
              SELECT COUNT(DISTINCT idempotency_key) AS count
              FROM publication_intents
              WHERE station_key = ? AND created_at >= ? AND status IN ('shadow', 'published')
            `)
            .get(stationKey, since.toISOString()) as CountRow)
        : (this.database
            .prepare(`
              SELECT COUNT(DISTINCT idempotency_key) AS count
              FROM publication_intents
              WHERE station_key = ? AND kind = ? AND created_at >= ? AND status IN ('shadow', 'published')
            `)
            .get(stationKey, kind, since.toISOString()) as CountRow);
    return row.count;
  }

  public countPublicationKindPrefixSince(
    stationKey: string,
    since: Date,
    kindPrefix: string,
  ): number {
    const row = this.database
      .prepare(`
        SELECT COUNT(DISTINCT idempotency_key) AS count
        FROM publication_intents
        WHERE station_key = ?
          AND kind LIKE ? ESCAPE '\\'
          AND created_at >= ?
          AND status IN ('shadow', 'published')
      `)
      .get(stationKey, `${kindPrefix.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`, since.toISOString()) as CountRow;
    return row.count;
  }

  public hasCompletedPublication(idempotencyKey: string): boolean {
    const row = this.database
      .prepare(`
        SELECT 1 AS found
        FROM publication_intents
        WHERE idempotency_key = ? AND status IN ('shadow', 'published')
        LIMIT 1
      `)
      .get(idempotencyKey) as { found?: number } | undefined;
    return row?.found === 1;
  }

  public getCameraClip(stationKey: string, sourceUrl: string): CameraClipRecord | undefined {
    const row = this.database
      .prepare(`
        SELECT etag, last_modified, sha256, posted_at, discovered_at
        FROM camera_clips
        WHERE station_key = ? AND source_url = ?
        ORDER BY discovered_at DESC
        LIMIT 1
      `)
      .get(stationKey, sourceUrl) as CameraClipRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      stationKey,
      sourceUrl,
      discoveredAt: row.discovered_at,
      ...(row.etag === null ? {} : { etag: row.etag }),
      ...(row.last_modified === null ? {} : { lastModified: row.last_modified }),
      ...(row.sha256 === null ? {} : { sha256: row.sha256 }),
      ...(row.posted_at === null ? {} : { postedAt: row.posted_at }),
    };
  }

  public getLastPublicationTime(stationKey: string, kind: string): Date | undefined {
    const row = this.database
      .prepare(`
        SELECT COALESCE(published_at, created_at) AS occurred_at
        FROM publication_intents
        WHERE station_key = ? AND kind = ? AND status IN ('shadow', 'published')
        ORDER BY occurred_at DESC
        LIMIT 1
      `)
      .get(stationKey, kind) as { occurred_at?: string } | undefined;
    return row?.occurred_at === undefined ? undefined : new Date(row.occurred_at);
  }

  public upsertCameraClip(record: CameraClipRecord): void {
    this.database
      .prepare(`
        INSERT INTO camera_clips (
          station_key, source_url, etag, last_modified, sha256, discovered_at, posted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(station_key, source_url, etag) DO UPDATE SET
          last_modified = excluded.last_modified,
          sha256 = COALESCE(excluded.sha256, camera_clips.sha256),
          posted_at = COALESCE(excluded.posted_at, camera_clips.posted_at)
      `)
      .run(
        record.stationKey,
        record.sourceUrl,
        record.etag ?? "",
        record.lastModified ?? null,
        record.sha256 ?? null,
        record.discoveredAt,
        record.postedAt ?? null,
      );
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY,
        station_key TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        ingested_at TEXT NOT NULL,
        source TEXT NOT NULL,
        source_dataset TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        overall_quality TEXT NOT NULL,
        normalized_json TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        UNIQUE(station_key, source, observed_at)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS observations_station_time
        ON observations(station_key, observed_at DESC);

      CREATE TABLE IF NOT EXISTS publication_intents (
        id INTEGER PRIMARY KEY,
        idempotency_key TEXT NOT NULL,
        publisher_id TEXT NOT NULL,
        station_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        uri TEXT,
        cid TEXT,
        error TEXT,
        published_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        UNIQUE(idempotency_key, publisher_id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS publication_intents_station_created
        ON publication_intents(station_key, created_at DESC);

      CREATE TABLE IF NOT EXISTS camera_clips (
        id INTEGER PRIMARY KEY,
        station_key TEXT NOT NULL,
        source_url TEXT NOT NULL,
        etag TEXT NOT NULL DEFAULT '',
        last_modified TEXT,
        sha256 TEXT,
        discovered_at TEXT NOT NULL,
        posted_at TEXT,
        UNIQUE(station_key, source_url, etag)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY,
        command TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        error TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS runs_started_at
        ON runs(started_at DESC);

      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (1, datetime('now'));
    `);

    const publicationColumns = this.database
      .prepare("SELECT name FROM pragma_table_info('publication_intents')")
      .all() as Array<{ name: string }>;
    if (!publicationColumns.some((column) => column.name === "attempt_count")) {
      this.database.exec(
        "ALTER TABLE publication_intents ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0",
      );
    }
    this.database.exec(`
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (2, datetime('now'));
    `);
  }
}
