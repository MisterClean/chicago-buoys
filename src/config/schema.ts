import { z } from "zod";

const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/u);
const url = z.url();

const sourceSchema = z.object({
  glos: z
    .object({
      baseUrl: url.default("https://seagull-erddap.glos.org/erddap"),
      dataset: z.string().min(1),
      latestDataset: z.string().min(1).optional(),
    })
    .optional(),
  ndbc: z
    .object({
      realtimeUrl: url,
      stationId: z.string().min(1),
    })
    .optional(),
});

const cameraSchema = z
  .object({
    enabled: z.boolean().default(false),
    currentClipUrl: url,
    archiveFeedUrl: url.optional(),
    freshnessMinutes: z.int().positive().default(120),
    maximumBytes: z.int().positive().default(50_000_000),
    dailyMaximum: z.int().min(0).max(4).default(1),
    minimumIntervalHours: z.number().positive().default(4),
    opportunityHoursLocal: z.array(z.int().min(0).max(23)).default([10, 14, 18]),
    rights: z.object({
      status: z.enum(["not_granted", "pending", "granted"]).default("not_granted"),
      permissionReference: z.string().min(1).optional(),
      attribution: z.string().min(1).optional(),
    }),
  })
  .optional();

const stationSchema = z.object({
  key: z.string().min(1),
  displayName: z.string().min(1),
  timeZone: z.string().min(1),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  links: z.object({
    station: url,
    officialForecast: url.optional(),
  }),
  sources: sourceSchema.refine((sources) => sources.glos !== undefined || sources.ndbc !== undefined, {
    message: "At least one observation source is required",
  }),
  camera: cameraSchema,
});

const publisherSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("bluesky"),
  enabled: z.boolean().default(false),
  serviceUrl: url.default("https://bsky.social"),
  handleEnv: envName,
  appPasswordEnv: envName,
  sessionPath: z.string().min(1),
});

export const configSchema = z.object({
  app: z.object({
    mode: z.enum(["shadow", "live"]).default("shadow"),
    databasePath: z.string().min(1),
    logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  }),
  posting: z.object({
    ordinaryDailyMaximum: z.int().min(1).max(20).default(4),
    eventDailyMaximum: z.int().min(1).max(30).default(6),
    freshnessMinutes: z.int().positive().default(60),
    delayedMinutes: z.int().positive().default(20),
  }),
  publishers: z.array(publisherSchema).default([]),
  stations: z.array(stationSchema).min(1),
});

export type AppConfig = z.infer<typeof configSchema>;
export type StationConfig = AppConfig["stations"][number];
export type PublisherConfig = AppConfig["publishers"][number];
