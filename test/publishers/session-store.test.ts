import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AtpSessionData } from "@atproto/api";
import { describe, expect, it } from "vitest";

import { AtomicSessionStore } from "../../src/publishers/session-store.js";

const session: AtpSessionData = {
  accessJwt: "access-secret",
  active: true,
  did: "did:plc:test",
  handle: "chicago-buoys.test",
  refreshJwt: "refresh-secret",
};

function temporarySessionPath(): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "chicago-buoys-session-"));
  return { directory, path: join(directory, "session.json") };
}

describe("AtomicSessionStore", () => {
  it("atomically persists and loads a mode-0600 session", () => {
    const target = temporarySessionPath();
    const store = new AtomicSessionStore(target.path);

    store.handle("create", session);

    expect(store.load()).toEqual(session);
    expect(statSync(target.path).mode & 0o777).toBe(0o600);
    expect(readdirSync(target.directory)).toEqual(["session.json"]);
  });

  it("updates refreshed tokens synchronously", () => {
    const target = temporarySessionPath();
    const store = new AtomicSessionStore(target.path);
    store.handle("create", session);

    store.persist("update", { ...session, accessJwt: "new-access" });

    expect(store.load()?.accessJwt).toBe("new-access");
  });

  it("removes an expired session and ignores a missing file", () => {
    const target = temporarySessionPath();
    const store = new AtomicSessionStore(target.path);
    store.save(session);

    store.handle("expired", undefined);
    store.handle("expired", undefined);

    expect(store.load()).toBeUndefined();
  });

  it("rejects malformed session data without exposing its contents", () => {
    const target = temporarySessionPath();
    writeFileSync(target.path, "not-json refresh-secret", { mode: 0o600 });
    const store = new AtomicSessionStore(target.path);

    expect(() => store.load()).toThrow("invalid JSON");
    try {
      store.load();
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).not.toContain("refresh-secret");
    }
  });
});
