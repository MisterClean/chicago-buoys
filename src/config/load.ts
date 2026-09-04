import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

import { type AppConfig, configSchema } from "./schema.js";

export async function loadConfig(configPath: string): Promise<AppConfig> {
  const absolutePath = path.resolve(configPath);
  const source = await readFile(absolutePath, "utf8");
  const parsed: unknown = parse(source);
  return configSchema.parse(parsed);
}
