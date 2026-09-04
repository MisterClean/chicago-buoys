import type { AppConfig, StationConfig } from "./config/schema.js";
import { Logger } from "./core/log.js";
import { LakePulseDatabase } from "./db/database.js";
import type { CanonicalPost, ObservationSource, Publisher } from "./domain/types.js";
import { buildBrief, buildThermalProfilePost, type BriefLane } from "./editorial/brief.js";
import { buildCameraPost, isCameraOpportunity } from "./editorial/camera.js";
import { detectEvents } from "./editorial/events.js";
import { freshnessState } from "./editorial/freshness.js";
import { HttpCameraSource } from "./media/camera-source.js";
import { PublishingService } from "./publishing/service.js";
import { dueBriefLane, isThermalOpportunity } from "./scheduling/opportunities.js";
import { GlosObservationSource } from "./sources/glos.js";
import { NdbcObservationSource } from "./sources/ndbc.js";

export type RuntimeOptions = {
  dryRun: boolean;
  environment: NodeJS.ProcessEnv;
  now?: Date;
  stationKey?: string;
};

function sourcesForStation(station: StationConfig): ObservationSource[] {
  const sources: ObservationSource[] = [];
  if (station.sources.glos !== undefined) {
    sources.push(
      new GlosObservationSource({
        baseUrl: station.sources.glos.baseUrl,
        dataset: station.sources.glos.dataset,
        ...(station.sources.glos.latestDataset === undefined
          ? {}
          : { latestDataset: station.sources.glos.latestDataset }),
      }),
    );
  }
  if (station.sources.ndbc !== undefined) {
    sources.push(
      new NdbcObservationSource({
        realtimeUrl: station.sources.ndbc.realtimeUrl,
        stationId: station.sources.ndbc.stationId,
      }),
    );
  }
  return sources;
}

function selectedStations(config: AppConfig, stationKey?: string): StationConfig[] {
  if (stationKey === undefined) {
    return config.stations;
  }
  const station = config.stations.find((candidate) => candidate.key === stationKey);
  if (station === undefined) {
    throw new Error(`Unknown station: ${stationKey}`);
  }
  return [station];
}

function beginningOfLookback(database: LakePulseDatabase, stationKey: string, now: Date): Date {
  const latest = database.getLatestAcceptableObservation(stationKey);
  if (latest === undefined) {
    return new Date(now.getTime() - 48 * 60 * 60_000);
  }
  const observedAt = new Date(latest.observedAt);
  const maximumLookback = new Date(now.getTime() - 48 * 60 * 60_000);
  const overlapped = new Date(observedAt.getTime() - 2 * 60 * 60_000);
  return overlapped < maximumLookback ? maximumLookback : overlapped;
}

export async function pollStations(
  config: AppConfig,
  database: LakePulseDatabase,
  logger: Logger,
  options: RuntimeOptions,
): Promise<void> {
  const now = options.now ?? new Date();
  for (const station of selectedStations(config, options.stationKey)) {
    const since = beginningOfLookback(database, station.key, now);
    let successfulSources = 0;
    for (const source of sourcesForStation(station)) {
      try {
        const result = await source.fetchRecent(station.key, since);
        for (const observation of result.observations) {
          database.upsertObservation(observation);
        }
        successfulSources += 1;
        logger.info("source_poll_complete", {
          observationCount: result.observations.length,
          source: result.source,
          stationKey: station.key,
          warnings: result.warnings,
        });
      } catch (error) {
        logger.warn("source_poll_failed", {
          error: error instanceof Error ? error.message : String(error),
          source: source.id,
          stationKey: station.key,
        });
      }
    }
    if (successfulSources === 0) {
      throw new Error(`All observation sources failed for ${station.key}`);
    }
  }
}

function publisherCapAllows(
  config: AppConfig,
  database: LakePulseDatabase,
  post: CanonicalPost,
  now: Date,
): boolean {
  const since = new Date(now.getTime() - 24 * 60 * 60_000);
  if (post.kind.startsWith("event:")) {
    return (
      database.countPublicationKindPrefixSince(post.stationKey, since, "event:") <
      config.posting.eventDailyMaximum
    );
  }
  return (
    database.countPublicationsSince(post.stationKey, since) -
      database.countPublicationKindPrefixSince(post.stationKey, since, "event:") <
    config.posting.ordinaryDailyMaximum
  );
}

async function dispatchIfAllowed(
  config: AppConfig,
  database: LakePulseDatabase,
  publishing: PublishingService,
  logger: Logger,
  post: CanonicalPost,
  now: Date,
): Promise<boolean> {
  if (!publisherCapAllows(config, database, post, now)) {
    logger.info("publication_daily_cap_suppressed", {
      kind: post.kind,
      stationKey: post.stationKey,
    });
    return false;
  }
  await publishing.dispatch(post);
  return database.hasCompletedPublication(post.idempotencyKey);
}

function eventCooldownHours(kind: string): number {
  switch (kind) {
    case "event:pressure-fall":
      return 6;
    case "event:rapid-cooling":
    case "event:mixing":
      return 8;
    default:
      return 4;
  }
}

async function evaluateObservationPosts(
  config: AppConfig,
  station: StationConfig,
  database: LakePulseDatabase,
  publishing: PublishingService,
  logger: Logger,
  now: Date,
  forcedLane?: BriefLane,
): Promise<void> {
  const current = database.getLatestAcceptableObservation(station.key);
  if (current === undefined) {
    logger.warn("station_has_no_acceptable_observation", { stationKey: station.key });
    return;
  }
  const state = freshnessState(
    new Date(current.observedAt),
    now,
    config.posting.delayedMinutes,
    config.posting.freshnessMinutes,
  );
  if (state === "stale" || state === "outage") {
    logger.warn("station_observation_stale", {
      observedAt: current.observedAt,
      state,
      stationKey: station.key,
    });
    return;
  }

  const lane = forcedLane ?? dueBriefLane(now, station.timeZone);
  if (lane !== undefined) {
    const yesterdayTarget = new Date(new Date(current.observedAt).getTime() - 24 * 60 * 60_000);
    const yesterday = database.getAcceptableObservationAtOrBefore(station.key, yesterdayTarget, 90);
    await dispatchIfAllowed(
      config,
      database,
      publishing,
      logger,
      buildBrief(station, lane, current, yesterday),
      now,
    );
  }

  if (forcedLane === undefined && state === "fresh") {
    const observedAt = new Date(current.observedAt);
    const ninetyMinutesAgo = database.getAcceptableObservationAtOrBefore(
      station.key,
      new Date(observedAt.getTime() - 90 * 60_000),
      40,
    );
    const threeHoursAgo = database.getAcceptableObservationAtOrBefore(
      station.key,
      new Date(observedAt.getTime() - 3 * 60 * 60_000),
      40,
    );
    const yesterday = database.getAcceptableObservationAtOrBefore(
      station.key,
      new Date(observedAt.getTime() - 24 * 60 * 60_000),
      90,
    );
    const events = detectEvents(station, {
      current,
      ...(ninetyMinutesAgo === undefined ? {} : { ninetyMinutesAgo }),
      ...(threeHoursAgo === undefined ? {} : { threeHoursAgo }),
      ...(yesterday === undefined ? {} : { yesterday }),
    });
    for (const event of events) {
      const last = database.getLastPublicationTime(station.key, event.kind);
      const cooldownMs = eventCooldownHours(event.kind) * 60 * 60_000;
      if (last !== undefined && now.getTime() - last.getTime() < cooldownMs) {
        logger.info("event_cooldown_suppressed", { kind: event.kind, stationKey: station.key });
        continue;
      }
      await dispatchIfAllowed(config, database, publishing, logger, event, now);
    }
  }

  if (
    forcedLane === undefined &&
    isThermalOpportunity(now, station.timeZone) &&
    current.profile.length >= 2
  ) {
    await dispatchIfAllowed(
      config,
      database,
      publishing,
      logger,
      buildThermalProfilePost(station, current),
      now,
    );
  }
}

async function evaluateCamera(
  config: AppConfig,
  station: StationConfig,
  database: LakePulseDatabase,
  publishing: PublishingService,
  logger: Logger,
  options: RuntimeOptions,
  force: boolean,
): Promise<void> {
  const now = options.now ?? new Date();
  const camera = station.camera;
  if (camera === undefined || (!force && !isCameraOpportunity(station, now))) {
    return;
  }
  if (
    options.environment.CAMERA_PUBLISH_ENABLED !== "true" ||
    options.environment.CAMERA_RIGHTS_CONFIRMED !== "true"
  ) {
    logger.info("camera_environment_gate_closed", { stationKey: station.key });
    return;
  }
  if (
    camera.rights.permissionReference === undefined ||
    options.environment.CAMERA_RIGHTS_REFERENCE !== camera.rights.permissionReference
  ) {
    logger.warn("camera_permission_reference_mismatch", { stationKey: station.key });
    return;
  }
  const since = new Date(now.getTime() - 24 * 60 * 60_000);
  if (database.countPublicationsSince(station.key, since, "camera") >= camera.dailyMaximum) {
    logger.info("camera_daily_cap_suppressed", { stationKey: station.key });
    return;
  }
  const lastPublication = database.getLastPublicationTime(station.key, "camera");
  if (
    lastPublication !== undefined &&
    now.getTime() - lastPublication.getTime() < camera.minimumIntervalHours * 60 * 60_000
  ) {
    logger.info("camera_cooldown_suppressed", { stationKey: station.key });
    return;
  }
  const previous = database.getCameraClip(station.key, camera.currentClipUrl);
  const inspection = await new HttpCameraSource(station).fetchLatest(previous?.etag, now);
  if (inspection.state !== "available") {
    logger.info("camera_clip_suppressed", {
      reason: inspection.reason,
      state: inspection.state,
      stationKey: station.key,
    });
    return;
  }
  const post = buildCameraPost(station, inspection.candidate);
  const completed = await dispatchIfAllowed(config, database, publishing, logger, post, now);
  if (!completed) {
    return;
  }
  database.upsertCameraClip({
    stationKey: station.key,
    sourceUrl: inspection.candidate.sourceUrl,
    ...(inspection.candidate.etag === undefined ? {} : { etag: inspection.candidate.etag }),
    lastModified: inspection.candidate.lastModified,
    sha256: inspection.candidate.sha256,
    discoveredAt: inspection.candidate.discoveredAt,
    postedAt: now.toISOString(),
  });
}

export async function runTick(
  config: AppConfig,
  database: LakePulseDatabase,
  publishers: Publisher[],
  logger: Logger,
  options: RuntimeOptions,
): Promise<void> {
  const now = options.now ?? new Date();
  await pollStations(config, database, logger, options);
  const publishing = new PublishingService(config, database, publishers, logger);
  for (const station of selectedStations(config, options.stationKey)) {
    await evaluateObservationPosts(config, station, database, publishing, logger, now);
    await evaluateCamera(config, station, database, publishing, logger, options, false);
  }
}

export async function runBrief(
  config: AppConfig,
  database: LakePulseDatabase,
  publishers: Publisher[],
  logger: Logger,
  options: RuntimeOptions,
  lane: BriefLane,
): Promise<void> {
  const publishing = new PublishingService(config, database, publishers, logger);
  for (const station of selectedStations(config, options.stationKey)) {
    await evaluateObservationPosts(
      config,
      station,
      database,
      publishing,
      logger,
      options.now ?? new Date(),
      lane,
    );
  }
}

export async function runCamera(
  config: AppConfig,
  database: LakePulseDatabase,
  publishers: Publisher[],
  logger: Logger,
  options: RuntimeOptions,
): Promise<void> {
  const publishing = new PublishingService(config, database, publishers, logger);
  for (const station of selectedStations(config, options.stationKey)) {
    await evaluateCamera(config, station, database, publishing, logger, options, true);
  }
}

export async function runThermal(
  config: AppConfig,
  database: LakePulseDatabase,
  publishers: Publisher[],
  logger: Logger,
  options: RuntimeOptions,
): Promise<void> {
  const now = options.now ?? new Date();
  const publishing = new PublishingService(config, database, publishers, logger);
  for (const station of selectedStations(config, options.stationKey)) {
    const current = database.getLatestAcceptableObservation(station.key);
    if (current === undefined || current.profile.length < 2) {
      logger.info("thermal_profile_unavailable", { stationKey: station.key });
      continue;
    }
    const state = freshnessState(
      new Date(current.observedAt),
      now,
      config.posting.delayedMinutes,
      config.posting.freshnessMinutes,
    );
    if (state === "stale" || state === "outage") {
      logger.warn("thermal_profile_stale", {
        observedAt: current.observedAt,
        state,
        stationKey: station.key,
      });
      continue;
    }
    await dispatchIfAllowed(
      config,
      database,
      publishing,
      logger,
      buildThermalProfilePost(station, current),
      now,
    );
  }
}

export async function runDoctor(
  config: AppConfig,
  database: LakePulseDatabase,
  logger: Logger,
  options: RuntimeOptions,
  offline: boolean,
): Promise<void> {
  if (!database.healthCheck()) {
    throw new Error("SQLite health check failed");
  }
  logger.info("database_health_ok");
  if (offline) {
    return;
  }
  const since = new Date((options.now ?? new Date()).getTime() - 48 * 60 * 60_000);
  for (const station of selectedStations(config, options.stationKey)) {
    for (const source of sourcesForStation(station)) {
      const result = await source.fetchRecent(station.key, since);
      logger.info("source_health_ok", {
        observationCount: result.observations.length,
        source: source.id,
        stationKey: station.key,
        warnings: result.warnings,
      });
    }
  }
}
