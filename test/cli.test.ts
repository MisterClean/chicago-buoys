import { describe, expect, it } from "vitest";

import { parseCli } from "../src/cli.js";

describe("CLI parsing", () => {
  it("defaults to tick and the configured environment path", () => {
    expect(parseCli([], { CHICAGO_BUOYS_CONFIG: "/tmp/example.yaml" })).toMatchObject({
      command: "tick",
      configPath: "/tmp/example.yaml",
    });
  });

  it("parses deployment flags", () => {
    expect(
      parseCli(["doctor", "--config", "config.example.yaml", "--database", "/state/test.sqlite", "--offline"]),
    ).toMatchObject({
      command: "doctor",
      configPath: "config.example.yaml",
      databasePath: "/state/test.sqlite",
      offline: true,
    });
  });

  it("rejects unknown commands", () => {
    expect(() => parseCli(["launch"])).toThrow(/Unknown command/u);
  });
});
