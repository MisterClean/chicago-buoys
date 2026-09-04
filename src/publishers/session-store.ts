import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import type {
  AtpPersistSessionHandler,
  AtpSessionData,
  AtpSessionEvent,
} from "@atproto/api";

function optionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function parseSession(value: unknown): AtpSessionData {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Bluesky session file does not contain an object");
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.refreshJwt !== "string" ||
    typeof candidate.accessJwt !== "string" ||
    typeof candidate.handle !== "string" ||
    typeof candidate.did !== "string" ||
    typeof candidate.active !== "boolean" ||
    !optionalString(candidate.email) ||
    !optionalBoolean(candidate.emailConfirmed) ||
    !optionalBoolean(candidate.emailAuthFactor) ||
    !optionalString(candidate.status)
  ) {
    throw new Error("Bluesky session file has an invalid shape");
  }

  return {
    accessJwt: candidate.accessJwt,
    active: candidate.active,
    did: candidate.did,
    handle: candidate.handle,
    refreshJwt: candidate.refreshJwt,
    ...(candidate.email === undefined ? {} : { email: candidate.email }),
    ...(candidate.emailConfirmed === undefined
      ? {}
      : { emailConfirmed: candidate.emailConfirmed }),
    ...(candidate.emailAuthFactor === undefined
      ? {}
      : { emailAuthFactor: candidate.emailAuthFactor }),
    ...(candidate.status === undefined ? {} : { status: candidate.status }),
  };
}

function isMissingFile(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Synchronous persistence is intentional. CredentialSession does not await its
 * persistence callback, so asynchronous writes can be lost when a short-lived
 * command exits immediately after refreshing its session.
 */
export class AtomicSessionStore {
  public constructor(public readonly path: string) {}

  public load(): AtpSessionData | undefined {
    let serialized: string;
    try {
      serialized = readFileSync(this.path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        return undefined;
      }
      throw error;
    }

    try {
      return parseSession(JSON.parse(serialized) as unknown);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error("Bluesky session file contains invalid JSON", { cause: error });
      }
      throw error;
    }
  }

  public save(session: AtpSessionData): void {
    const directory = dirname(this.path);
    mkdirSync(directory, { mode: 0o700, recursive: true });

    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    let temporaryExists = false;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(session)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      temporaryExists = true;
      renameSync(temporaryPath, this.path);
      temporaryExists = false;
      chmodSync(this.path, 0o600);
    } finally {
      if (temporaryExists) {
        try {
          unlinkSync(temporaryPath);
        } catch {
          // Best-effort cleanup. The target session is never removed here.
        }
      }
    }
  }

  public remove(): void {
    try {
      unlinkSync(this.path);
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error;
      }
    }
  }

  public handle(event: AtpSessionEvent, session: AtpSessionData | undefined): void {
    if (event === "expired") {
      this.remove();
      return;
    }
    if (
      session !== undefined &&
      (event === "create" || event === "update" || event === "network-error")
    ) {
      this.save(session);
    }
  }

  public readonly persist: AtpPersistSessionHandler = (event, session) => {
    this.handle(event, session);
  };
}
