#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { pollStations, runBrief, runCamera, runDoctor, runThermal, runTick } from "./app.js";
import { loadConfig } from "./config/load.js";
import type { AppConfig } from "./config/schema.js";
import { Logger } from "./core/log.js";
import { ChicagoBuoysDatabase } from "./db/database.js";
import type { Publisher } from "./domain/types.js";
import { createBlueskyPublisher } from "./publishers/bluesky.js";

type Command = "tick" | "poll" | "brief" | "camera" | "weekly" | "doctor" | "migrate" | "shadow";

type CliOptions = {
  command: Command;
  configPath: string;
  databasePath?: string;
  dryRun: boolean;
  offline: boolean;
  stationKey?: string;
  lane: "morning" | "afternoon";
};

function valueAfter(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseCli(args: string[], environment: NodeJS.ProcessEnv = process.env): CliOptions {
  const first = args[0];
  const command: Command =
    first === undefined || first.startsWith("--") ? "tick" : (first as Command);
  const commands: Command[] = ["tick", "poll", "brief", "camera", "weekly", "doctor", "migrate", "shadow"];
  if (!commands.includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }
  const options: CliOptions = {
    command,
    configPath: environment.CHICAGO_BUOYS_CONFIG ?? "config.yaml",
    dryRun: false,
    offline: false,
    lane: "morning",
  };
  const start = first === undefined || first.startsWith("--") ? 0 : 1;
  for (let index = start; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case "--config":
        options.configPath = valueAfter(args, index, argument);
        index += 1;
        break;
      case "--database":
        options.databasePath = valueAfter(args, index, argument);
        index += 1;
        break;
      case "--station":
        options.stationKey = valueAfter(args, index, argument);
        index += 1;
        break;
      case "--lane": {
        const lane = valueAfter(args, index, argument);
        if (lane !== "morning" && lane !== "afternoon") {
          throw new Error("--lane must be morning or afternoon");
        }
        options.lane = lane;
        index += 1;
        break;
      }
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--offline":
        options.offline = true;
        break;
      default:
        throw new Error(`Unknown option: ${String(argument)}`);
    }
  }
  return options;
}

function runtimeConfig(config: AppConfig, options: CliOptions): AppConfig {
  return {
    ...config,
    app: {
      ...config.app,
      ...(options.databasePath === undefined ? {} : { databasePath: options.databasePath }),
      ...(options.dryRun || options.command === "shadow" ? { mode: "shadow" as const } : {}),
    },
  };
}

function createPublishers(config: AppConfig, environment: NodeJS.ProcessEnv): Publisher[] {
  const enabled = config.publishers.filter((publisher) => publisher.enabled);
  if (config.app.mode === "live" && environment.PUBLISH_ENABLED !== "true") {
    throw new Error("Live mode requires PUBLISH_ENABLED=true");
  }
  if (config.app.mode === "shadow") {
    return [];
  }
  if (enabled.length === 0) {
    throw new Error("Live mode requires at least one enabled publisher");
  }
  return enabled.map((publisher) =>
    createBlueskyPublisher(
      {
        ...publisher,
        sessionPath: environment.BLUESKY_SESSION_PATH ?? publisher.sessionPath,
      },
      environment,
    ),
  );
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  const config = runtimeConfig(await loadConfig(options.configPath), options);
  const logger = new Logger(config.app.logLevel);
  const database = new ChicagoBuoysDatabase(config.app.databasePath);
  const runId = database.startRun(options.command);
  const runtimeOptions = {
    dryRun: config.app.mode === "shadow",
    environment: process.env,
    ...(options.stationKey === undefined ? {} : { stationKey: options.stationKey }),
  };
  try {
    const publishers =
      options.command === "tick" ||
      options.command === "brief" ||
      options.command === "camera" ||
      options.command === "weekly"
        ? createPublishers(config, process.env)
        : [];
    switch (options.command) {
      case "migrate":
        logger.info("database_migration_complete");
        break;
      case "doctor":
        await runDoctor(config, database, logger, runtimeOptions, options.offline);
        break;
      case "poll":
        await pollStations(config, database, logger, runtimeOptions);
        break;
      case "brief":
        await runBrief(config, database, publishers, logger, runtimeOptions, options.lane);
        break;
      case "camera":
        await runCamera(config, database, publishers, logger, runtimeOptions);
        break;
      case "weekly":
        await runThermal(config, database, publishers, logger, runtimeOptions);
        break;
      case "shadow":
      case "tick":
        await runTick(config, database, publishers, logger, runtimeOptions);
        break;
    }
    database.finishRun(runId, "succeeded");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    database.finishRun(runId, "failed", message);
    logger.error("command_failed", { command: options.command, error: message });
    process.exitCode = 1;
  } finally {
    database.close();
  }
}

const executablePath = process.argv[1];
if (executablePath !== undefined && import.meta.url === pathToFileURL(executablePath).href) {
  await main();
}
