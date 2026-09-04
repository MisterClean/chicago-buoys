import { createHash } from "node:crypto";

import {
  Agent,
  AtpAgent,
  CredentialSession,
  RichText,
  type AppBskyFeedPost,
  type AppBskyRichtextFacet,
  type AppBskyVideoDefs,
  type BlobRef,
} from "@atproto/api";

import type { PublisherConfig } from "../config/schema.js";
import type {
  CanonicalPost,
  MediaAttachment,
  Publisher,
  PublishReceipt,
} from "../domain/types.js";
import { AtomicSessionStore } from "./session-store.js";

const POST_MAX_BYTES = 3_000;
const POST_MAX_GRAPHEMES = 300;
const IMAGE_MAX_BYTES = 2_000_000;
const VIDEO_MAX_BYTES = 300_000_000;
const VIDEO_UPLOAD_LIMIT_LEXICON = "app.bsky.video.getUploadLimits";
const PDS_UPLOAD_BLOB_LEXICON = "com.atproto.repo.uploadBlob";
const TID_ALPHABET = "234567abcdefghijklmnopqrstuvwxyz";
const TID_MAX_MICROSECONDS = (1n << 53n) - 1n;

export type BlueskyPublisherOptions = {
  id: string;
  serviceUrl: string;
  handle: string;
  expectedDid?: string;
  appPassword: string;
  sessionPath: string;
  videoServiceUrl?: string;
  videoServiceDid?: string;
  videoPollIntervalMs?: number;
  videoPollAttempts?: number;
  videoStatusRetryAttempts?: number;
  partRetryAttempts?: number;
  uploadRecoveryAttempts?: number;
};

export type PreparedText = {
  text: string;
  byteLength: number;
  graphemeLength: number;
  facets?: AppBskyRichtextFacet.Main[];
};

export type ServiceAuthRequest = {
  aud: string;
  lxm: string;
  exp?: number;
};

export interface BlueskyClientPort {
  readonly did: string;
  readonly handle: string;
  readonly dispatchUrl: URL;
  prepareText(text: string): Promise<PreparedText>;
  uploadBlob(bytes: Uint8Array, mimeType: string): Promise<BlobRef>;
  getServiceAuth(request: ServiceAuthRequest): Promise<string>;
  getPost(rkey: string): Promise<{ uri: string; cid: string } | undefined>;
  createPost(record: AppBskyFeedPost.Record, rkey: string): Promise<{ uri: string; cid: string }>;
}

export type VideoUploadLimits = {
  canUpload: boolean;
  remainingDailyVideos?: number;
  remainingDailyBytes?: number;
  message?: string;
  error?: string;
};

export type VideoStartResult = {
  jobId: string;
  partSizeBytes: number;
  partCount: number;
  expiresAt: string;
};

export type VideoPartResult = {
  partNumber: number;
  sizeBytes: number;
};

export type VideoUploadState =
  | "created"
  | "finishing"
  | "completed"
  | "failed"
  | "aborted"
  | "expired";

export type VideoUploadStatus = {
  jobId: string;
  partSizeBytes: number;
  partCount: number;
  receivedParts: number[];
  expiresAt: string;
  state: VideoUploadState | (string & {});
  completedJobId?: string;
  jobStatus?: AppBskyVideoDefs.JobStatus;
  failureReason?: string;
};

export type VideoFinishResult = {
  completedJobId: string;
  jobStatus: AppBskyVideoDefs.JobStatus;
};

export type VideoAbortResult = {
  state: "aborted" | "completed" | "failed" | "expired" | (string & {});
  completedJobId?: string;
  failureReason?: string;
};

export interface VideoServicePort {
  getUploadLimits(token: string): Promise<VideoUploadLimits>;
  startUpload(
    input: { sizeBytes: number; mimeType: string; name: string },
    token: string,
  ): Promise<VideoStartResult>;
  uploadPart(
    bytes: Uint8Array,
    input: { jobId: string; partNumber: number },
    token: string,
  ): Promise<VideoPartResult>;
  getUploadStatus(jobId: string, token: string): Promise<VideoUploadStatus>;
  finishUpload(jobId: string, token: string): Promise<VideoFinishResult>;
  abortUpload(jobId: string, token: string): Promise<VideoAbortResult>;
  getJobStatus(jobId: string): Promise<AppBskyVideoDefs.JobStatus>;
}

export type BlueskyPublisherDependencies = {
  clientFactory?: (options: BlueskyPublisherOptions) => Promise<BlueskyClientPort>;
  videoService?: VideoServicePort;
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
  clockMs?: () => number;
};

type TransferTokenProvider = {
  get(forceRefresh?: boolean): Promise<string>;
};

type MultipartPlan = {
  bytes: Uint8Array;
  jobId: string;
  partCount: number;
  partSizeBytes: number;
};

type VideoCompletion = {
  completedJobId: string;
  jobStatus: AppBskyVideoDefs.JobStatus;
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function validateAspectRatio(
  aspectRatio: { width: number; height: number } | undefined,
): { width: number; height: number } | undefined {
  if (aspectRatio === undefined) {
    return undefined;
  }
  return {
    width: positiveInteger(aspectRatio.width, "Media aspect-ratio width"),
    height: positiveInteger(aspectRatio.height, "Media aspect-ratio height"),
  };
}

function recordKey(post: Pick<CanonicalPost, "idempotencyKey" | "observedAt">): string {
  const observedAtMs = Date.parse(post.observedAt);
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
    throw new Error("Bluesky posts require a valid non-negative observedAt timestamp");
  }

  const digest = createHash("sha256").update(post.idempotencyKey).digest();
  const paddedMicroseconds = (((digest[0] ?? 0) << 8) | (digest[1] ?? 0)) % 1_000;
  const clockIdentifier = (((digest[2] ?? 0) << 8) | (digest[3] ?? 0)) & 0x3ff;
  const timestampMicroseconds = BigInt(observedAtMs) * 1_000n + BigInt(paddedMicroseconds);
  if (timestampMicroseconds > TID_MAX_MICROSECONDS) {
    throw new Error("Bluesky post observedAt timestamp exceeds the TID range");
  }

  let value = (timestampMicroseconds << 10n) | BigInt(clockIdentifier);
  let encoded = "";
  for (let index = 0; index < 13; index += 1) {
    encoded = (TID_ALPHABET[Number(value & 31n)] ?? "") + encoded;
    value >>= 5n;
  }
  return encoded;
}

function labeledLinkFacets(
  text: string,
  links: CanonicalPost["links"],
): AppBskyRichtextFacet.Main[] {
  if (links === undefined) {
    return [];
  }
  const encoder = new TextEncoder();
  return links.map((link) => {
    if (link.label.length === 0) {
      throw new Error("Bluesky labeled links require non-empty labels");
    }
    const labelStart = text.indexOf(link.label);
    if (labelStart === -1) {
      throw new Error(`Bluesky labeled link text is missing its label: ${link.label}`);
    }
    if (text.indexOf(link.label, labelStart + link.label.length) !== -1) {
      throw new Error(`Bluesky labeled link text repeats its label: ${link.label}`);
    }
    const uri = new URL(link.uri);
    if (uri.protocol !== "https:" && uri.protocol !== "http:") {
      throw new Error(`Bluesky labeled link uses an unsupported protocol: ${uri.protocol}`);
    }
    return {
      features: [{ $type: "app.bsky.richtext.facet#link", uri: uri.href }],
      index: {
        byteStart: encoder.encode(text.slice(0, labelStart)).byteLength,
        byteEnd: encoder.encode(text.slice(0, labelStart + link.label.length)).byteLength,
      },
    };
  });
}

function isMp4(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  );
}

function statusCode(error: unknown): number | undefined {
  if (error === null || typeof error !== "object" || !("status" in error)) {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("error" in error)) {
    return undefined;
  }
  const code = (error as { error?: unknown }).error;
  return typeof code === "string" ? code : undefined;
}

function isAuthenticationError(error: unknown): boolean {
  return statusCode(error) === 401 || errorCode(error) === "AuthRequired";
}

function isTransientServiceError(error: unknown): boolean {
  const status = statusCode(error);
  return (
    error instanceof TypeError ||
    status === 1 ||
    status === 408 ||
    status === 429 ||
    (status !== undefined && status >= 500) ||
    errorCode(error) === "ServiceOverloaded"
  );
}

function jobFailure(status: AppBskyVideoDefs.JobStatus): Error {
  const detail = status.message ?? status.error ?? status.failureCode ?? "unknown failure";
  return new Error(`Bluesky video processing failed: ${detail}`);
}

function uploadFailure(status: VideoUploadStatus): Error {
  return new Error(
    `Bluesky multipart upload ${status.state}: ${status.failureReason ?? "no reason supplied"}`,
  );
}

class AtprotoBlueskyClient implements BlueskyClientPort {
  public constructor(
    private readonly agent: AtpAgent,
    private readonly session: CredentialSession,
  ) {}

  public get did(): string {
    const did = this.agent.did;
    if (did === undefined) {
      throw new Error("Bluesky client is not authenticated");
    }
    return did;
  }

  public get handle(): string {
    const handle = this.session.session?.handle;
    if (handle === undefined) {
      throw new Error("Bluesky client session has no handle");
    }
    return handle;
  }

  public get dispatchUrl(): URL {
    return this.session.dispatchUrl;
  }

  public async prepareText(text: string): Promise<PreparedText> {
    const richText = new RichText({ text });
    await richText.detectFacets(this.agent);
    return {
      byteLength: new TextEncoder().encode(richText.text).byteLength,
      graphemeLength: richText.graphemeLength,
      text: richText.text,
      ...(richText.facets === undefined ? {} : { facets: richText.facets }),
    };
  }

  public async uploadBlob(bytes: Uint8Array, mimeType: string): Promise<BlobRef> {
    const response = await this.agent.uploadBlob(bytes, { encoding: mimeType });
    return response.data.blob;
  }

  public async getServiceAuth(request: ServiceAuthRequest): Promise<string> {
    const response = await this.agent.com.atproto.server.getServiceAuth(request);
    return response.data.token;
  }

  public async getPost(rkey: string): Promise<{ uri: string; cid: string } | undefined> {
    try {
      const response = await this.agent.com.atproto.repo.getRecord({
        collection: "app.bsky.feed.post",
        repo: this.did,
        rkey,
      });
      if (response.data.cid === undefined) {
        throw new Error("Existing Bluesky post record did not return a CID");
      }
      return { cid: response.data.cid, uri: response.data.uri };
    } catch (error) {
      if (errorCode(error) === "RecordNotFound") {
        return undefined;
      }
      throw error;
    }
  }

  public createPost(
    record: AppBskyFeedPost.Record,
    rkey: string,
  ): Promise<{ uri: string; cid: string }> {
    return this.agent.com.atproto.repo
      .putRecord({
        collection: "app.bsky.feed.post",
        record,
        repo: this.did,
        rkey,
        swapRecord: null,
        validate: true,
      })
      .then((response) => response.data);
  }
}

class AtprotoVideoService implements VideoServicePort {
  private readonly agent: Agent;

  public constructor(serviceUrl: string, fetcher: typeof fetch) {
    this.agent = new Agent({ fetch: fetcher, service: serviceUrl });
  }

  public async getUploadLimits(token: string): Promise<VideoUploadLimits> {
    const response = await this.agent.app.bsky.video.getUploadLimits(undefined, {
      headers: { authorization: `Bearer ${token}` },
    });
    return response.data;
  }

  public async startUpload(
    input: { sizeBytes: number; mimeType: string; name: string },
    token: string,
  ): Promise<VideoStartResult> {
    const response = await this.agent.app.bsky.video.startUpload(input, {
      headers: { authorization: `Bearer ${token}` },
    });
    return response.data;
  }

  public async uploadPart(
    bytes: Uint8Array,
    input: { jobId: string; partNumber: number },
    token: string,
  ): Promise<VideoPartResult> {
    const response = await this.agent.app.bsky.video.uploadPart(bytes, {
      encoding: "application/octet-stream",
      headers: { authorization: `Bearer ${token}` },
      qp: input,
    });
    return response.data;
  }

  public async getUploadStatus(jobId: string, token: string): Promise<VideoUploadStatus> {
    const response = await this.agent.app.bsky.video.getUploadStatus(
      { jobId },
      { headers: { authorization: `Bearer ${token}` } },
    );
    return response.data;
  }

  public async finishUpload(jobId: string, token: string): Promise<VideoFinishResult> {
    const response = await this.agent.app.bsky.video.finishUpload(
      { jobId },
      { headers: { authorization: `Bearer ${token}` } },
    );
    return response.data;
  }

  public async abortUpload(jobId: string, token: string): Promise<VideoAbortResult> {
    const response = await this.agent.app.bsky.video.abortUpload(
      { jobId },
      { headers: { authorization: `Bearer ${token}` } },
    );
    return response.data;
  }

  public async getJobStatus(jobId: string): Promise<AppBskyVideoDefs.JobStatus> {
    const response = await this.agent.app.bsky.video.getJobStatus({ jobId });
    return response.data.jobStatus;
  }
}

async function createCredentialClient(
  options: BlueskyPublisherOptions,
  fetcher: typeof fetch,
): Promise<BlueskyClientPort> {
  const store = new AtomicSessionStore(options.sessionPath);
  const session = new CredentialSession(new URL(options.serviceUrl), fetcher, store.persist);
  const saved = store.load();

  if (saved !== undefined) {
    try {
      await session.resumeSession(saved);
    } catch (error) {
      // A transient refresh failure leaves the saved session attached. Logging
      // in here would rotate more credentials and conceal an outage.
      if (session.hasSession) {
        throw new Error("Unable to refresh the saved Bluesky session", { cause: error });
      }
    }
  }

  if (!session.hasSession) {
    await session.login({ identifier: options.handle, password: options.appPassword });
  }

  // @atproto/api's SessionManager declaration is not exactOptionalPropertyTypes
  // compatible even though CredentialSession is its runtime implementation.
  // AtpAgent's direct CredentialSession overload preserves the same Agent API.
  return new AtprotoBlueskyClient(new AtpAgent(session), session);
}

export class BlueskyPublisher implements Publisher {
  public readonly id: string;
  private readonly clientFactory: (options: BlueskyPublisherOptions) => Promise<BlueskyClientPort>;
  private readonly videoService: VideoServicePort;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly clockMs: () => number;
  private clientPromise: Promise<BlueskyClientPort> | undefined;

  public constructor(
    private readonly options: BlueskyPublisherOptions,
    dependencies: BlueskyPublisherDependencies = {},
  ) {
    this.id = options.id;
    const fetcher = dependencies.fetcher ?? fetch;
    this.clientFactory =
      dependencies.clientFactory ??
      ((publisherOptions) => createCredentialClient(publisherOptions, fetcher));
    this.videoService =
      dependencies.videoService ??
      new AtprotoVideoService(options.videoServiceUrl ?? "https://video.bsky.app", fetcher);
    this.sleep = dependencies.sleep ?? delay;
    this.now = dependencies.now ?? (() => new Date());
    this.clockMs = dependencies.clockMs ?? Date.now;

    positiveInteger(options.videoPollIntervalMs ?? 2_000, "videoPollIntervalMs");
    positiveInteger(options.videoPollAttempts ?? 150, "videoPollAttempts");
    positiveInteger(options.videoStatusRetryAttempts ?? 3, "videoStatusRetryAttempts");
    positiveInteger(options.partRetryAttempts ?? 3, "partRetryAttempts");
    positiveInteger(options.uploadRecoveryAttempts ?? 5, "uploadRecoveryAttempts");
  }

  public async publish(post: CanonicalPost): Promise<PublishReceipt> {
    const client = await this.client();
    const rkey = recordKey(post);
    const existing = await client.getPost(rkey);
    if (existing !== undefined) {
      return this.receipt(existing);
    }
    const preparedText = await client.prepareText(post.text);
    this.assertPostText(preparedText);
    if (post.langs.length > 3) {
      throw new Error("Bluesky posts may specify at most three languages");
    }

    const facets = [...(preparedText.facets ?? []), ...labeledLinkFacets(preparedText.text, post.links)]
      .sort((left, right) => left.index.byteStart - right.index.byteStart);
    for (let index = 1; index < facets.length; index += 1) {
      if ((facets[index - 1]?.index.byteEnd ?? 0) > (facets[index]?.index.byteStart ?? 0)) {
        throw new Error("Bluesky rich-text facets may not overlap");
      }
    }

    const createdAt = this.now().toISOString();
    const baseRecord: AppBskyFeedPost.Record = {
      $type: "app.bsky.feed.post",
      createdAt,
      langs: post.langs,
      text: preparedText.text,
      ...(facets.length === 0 ? {} : { facets }),
    };
    const record =
      post.media === undefined
        ? baseRecord
        : await this.attachMedia(baseRecord, post.media, rkey, client);
    let response: { uri: string; cid: string };
    try {
      response = await client.createPost(record, rkey);
    } catch (error) {
      // A request may have committed even if its response was lost. The null
      // swap guard also turns a concurrent writer into a safe reconciliation.
      const committed = await this.reconcilePost(client, rkey, error);
      if (committed === undefined) {
        throw error;
      }
      response = committed;
    }

    return this.receipt(response);
  }

  private client(): Promise<BlueskyClientPort> {
    this.clientPromise ??= this.clientFactory(this.options).then((client) => {
      const expectedHandle = this.normalizeHandle(this.options.handle);
      if (this.normalizeHandle(client.handle) !== expectedHandle) {
        throw new Error("Authenticated Bluesky account does not match the configured handle");
      }
      if (this.options.expectedDid !== undefined && client.did !== this.options.expectedDid) {
        throw new Error("Authenticated Bluesky account does not match the configured DID");
      }
      return client;
    });
    return this.clientPromise;
  }

  private normalizeHandle(handle: string): string {
    return handle.trim().replace(/^@/u, "").toLowerCase();
  }

  private receipt(record: { uri: string; cid: string }): PublishReceipt {
    return {
      cid: record.cid,
      publishedAt: this.now().toISOString(),
      publisherId: this.id,
      uri: record.uri,
    };
  }

  private async reconcilePost(
    client: BlueskyClientPort,
    rkey: string,
    writeError: unknown,
  ): Promise<{ uri: string; cid: string } | undefined> {
    try {
      return await client.getPost(rkey);
    } catch (reconciliationError) {
      throw new AggregateError(
        [writeError, reconciliationError],
        "Bluesky post outcome is uncertain and record reconciliation failed",
      );
    }
  }

  private assertPostText(text: PreparedText): void {
    if (text.graphemeLength > POST_MAX_GRAPHEMES) {
      throw new Error(
        `Bluesky post is ${text.graphemeLength} graphemes; maximum is ${POST_MAX_GRAPHEMES}`,
      );
    }
    if (text.byteLength > POST_MAX_BYTES) {
      throw new Error(`Bluesky post is ${text.byteLength} bytes; maximum is ${POST_MAX_BYTES}`);
    }
  }

  private async attachMedia(
    record: AppBskyFeedPost.Record,
    media: MediaAttachment,
    rkey: string,
    client: BlueskyClientPort,
  ): Promise<AppBskyFeedPost.Record> {
    if (media.alt.trim().length === 0) {
      throw new Error("Bluesky media requires useful alt text");
    }
    const aspectRatio = validateAspectRatio(media.aspectRatio);

    if (media.kind === "image") {
      if (!media.mimeType.startsWith("image/")) {
        throw new Error(`Unsupported Bluesky image MIME type: ${media.mimeType}`);
      }
      if (media.bytes.byteLength > IMAGE_MAX_BYTES) {
        throw new Error(
          `Bluesky image is ${media.bytes.byteLength} bytes; maximum is ${IMAGE_MAX_BYTES}`,
        );
      }
      const blob = await client.uploadBlob(media.bytes, media.mimeType);
      return {
        ...record,
        embed: {
          $type: "app.bsky.embed.images",
          images: [
            {
              alt: media.alt,
              image: blob,
              ...(aspectRatio === undefined ? {} : { aspectRatio }),
            },
          ],
        },
      };
    }

    const blob = await this.uploadVideo(media, rkey, client);
    return {
      ...record,
      embed: {
        $type: "app.bsky.embed.video",
        alt: media.alt,
        video: blob,
        presentation: "default",
        ...(aspectRatio === undefined ? {} : { aspectRatio }),
      },
    };
  }

  private async uploadVideo(
    media: Extract<MediaAttachment, { kind: "video" }>,
    rkey: string,
    client: BlueskyClientPort,
  ): Promise<BlobRef> {
    if (media.bytes.byteLength > VIDEO_MAX_BYTES) {
      throw new Error(
        `Bluesky video is ${media.bytes.byteLength} bytes; maximum is ${VIDEO_MAX_BYTES}`,
      );
    }
    if (!isMp4(media.bytes)) {
      throw new Error("Bluesky video attachment is not an MP4 file");
    }

    await this.assertVideoQuota(media.bytes.byteLength, client);
    const tokenProvider = this.createTransferTokenProvider(client);
    const initialToken = await tokenProvider.get();
    const start = await this.videoService.startUpload(
      {
        mimeType: "video/mp4",
        name: `chicago-buoys-${rkey}.mp4`,
        sizeBytes: media.bytes.byteLength,
      },
      initialToken,
    );
    const plan = this.multipartPlan(media.bytes, start);

    let completion: VideoCompletion;
    try {
      await this.uploadMissingParts(plan, [], tokenProvider);
      // The finish credential is retained while the video service transfers
      // the processed blob to the PDS, so mint it after the potentially slow
      // part transfer.
      await tokenProvider.get(true);
      completion = await this.finishAndRecover(plan, tokenProvider);
    } catch (error) {
      const racedCompletion = await this.abortOrRecover(plan.jobId, tokenProvider);
      if (racedCompletion === undefined) {
        throw error;
      }
      completion = racedCompletion;
    }

    const status = await this.waitForVideo(completion.completedJobId, completion.jobStatus);
    if (status.did !== client.did) {
      throw new Error("Bluesky video job belongs to a different account");
    }
    if (status.blob === undefined) {
      throw new Error("Completed Bluesky video job did not return a blob");
    }
    return status.blob;
  }

  private async assertVideoQuota(sizeBytes: number, client: BlueskyClientPort): Promise<void> {
    const token = await client.getServiceAuth({
      aud: this.options.videoServiceDid ?? "did:web:video.bsky.app",
      lxm: VIDEO_UPLOAD_LIMIT_LEXICON,
    });
    const limits = await this.videoService.getUploadLimits(token);
    if (!limits.canUpload || limits.remainingDailyVideos === 0) {
      throw new Error(limits.message ?? "Bluesky video upload quota is unavailable");
    }
    if (limits.remainingDailyBytes !== undefined && limits.remainingDailyBytes < sizeBytes) {
      throw new Error("Bluesky daily video byte quota is too low for this clip");
    }
  }

  private createTransferTokenProvider(client: BlueskyClientPort): TransferTokenProvider {
    let token: string | undefined;
    let expiresAtMs = 0;
    return {
      get: async (forceRefresh = false) => {
        const now = this.clockMs();
        if (!forceRefresh && token !== undefined && now < expiresAtMs - 60_000) {
          return token;
        }
        const exp = Math.floor(now / 1_000) + 30 * 60;
        const audience = `did:web:${client.dispatchUrl.hostname}`;
        token = await client.getServiceAuth({ aud: audience, exp, lxm: PDS_UPLOAD_BLOB_LEXICON });
        expiresAtMs = exp * 1_000;
        return token;
      },
    };
  }

  private multipartPlan(bytes: Uint8Array, start: VideoStartResult): MultipartPlan {
    const partSizeBytes = positiveInteger(start.partSizeBytes, "Video part size");
    const partCount = positiveInteger(start.partCount, "Video part count");
    const expectedPartCount = Math.ceil(bytes.byteLength / partSizeBytes);
    if (partCount !== expectedPartCount) {
      throw new Error(
        `Bluesky returned ${partCount} video parts; expected ${expectedPartCount}`,
      );
    }
    if (start.jobId.length === 0) {
      throw new Error("Bluesky returned an empty video job ID");
    }
    return { bytes, jobId: start.jobId, partCount, partSizeBytes };
  }

  private async uploadMissingParts(
    plan: MultipartPlan,
    receivedParts: number[],
    tokenProvider: TransferTokenProvider,
  ): Promise<void> {
    const received = new Set(receivedParts);
    for (let partNumber = 1; partNumber <= plan.partCount; partNumber += 1) {
      if (received.has(partNumber)) {
        continue;
      }
      const start = (partNumber - 1) * plan.partSizeBytes;
      const end = Math.min(plan.bytes.byteLength, start + plan.partSizeBytes);
      const bytes = plan.bytes.subarray(start, end);
      await this.uploadPartWithRetry(plan.jobId, partNumber, bytes, tokenProvider);
    }
  }

  private async uploadPartWithRetry(
    jobId: string,
    partNumber: number,
    bytes: Uint8Array,
    tokenProvider: TransferTokenProvider,
  ): Promise<void> {
    const attempts = this.options.partRetryAttempts ?? 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const token = await tokenProvider.get(attempt > 1 && isAuthenticationError(lastError));
        const result = await this.videoService.uploadPart(bytes, { jobId, partNumber }, token);
        if (result.partNumber !== partNumber || result.sizeBytes !== bytes.byteLength) {
          throw new Error(`Bluesky returned an invalid receipt for video part ${partNumber}`);
        }
        return;
      } catch (error) {
        lastError = error;
        if (
          attempt === attempts ||
          (!isAuthenticationError(error) && !isTransientServiceError(error))
        ) {
          throw error;
        }
        await this.sleep(Math.min(500 * 2 ** (attempt - 1), 4_000));
      }
    }
    throw lastError;
  }

  private async withTransferAuth<T>(
    tokenProvider: TransferTokenProvider,
    operation: (token: string) => Promise<T>,
  ): Promise<T> {
    try {
      return await operation(await tokenProvider.get());
    } catch (error) {
      if (!isAuthenticationError(error)) {
        throw error;
      }
      return operation(await tokenProvider.get(true));
    }
  }

  private async finishAndRecover(
    plan: MultipartPlan,
    tokenProvider: TransferTokenProvider,
  ): Promise<VideoCompletion> {
    const attempts = this.options.uploadRecoveryAttempts ?? 5;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.withTransferAuth(tokenProvider, (token) =>
          this.videoService.finishUpload(plan.jobId, token),
        );
      } catch (error) {
        lastError = error;
      }

      const status = await this.withTransferAuth(tokenProvider, (token) =>
        this.videoService.getUploadStatus(plan.jobId, token),
      );
      if (
        status.state === "completed" &&
        status.completedJobId !== undefined &&
        status.jobStatus !== undefined
      ) {
        return { completedJobId: status.completedJobId, jobStatus: status.jobStatus };
      }
      if (status.state === "created") {
        await this.uploadMissingParts(plan, status.receivedParts, tokenProvider);
      } else if (status.state !== "finishing") {
        throw uploadFailure(status);
      }
      if (attempt < attempts) {
        await this.sleep(Math.min(500 * 2 ** (attempt - 1), 4_000));
      }
    }
    throw lastError;
  }

  private async abortOrRecover(
    jobId: string,
    tokenProvider: TransferTokenProvider,
  ): Promise<VideoCompletion | undefined> {
    try {
      const result = await this.withTransferAuth(tokenProvider, (token) =>
        this.videoService.abortUpload(jobId, token),
      );
      if (result.state !== "completed" || result.completedJobId === undefined) {
        return undefined;
      }
      const uploadStatus = await this.withTransferAuth(tokenProvider, (token) =>
        this.videoService.getUploadStatus(jobId, token),
      );
      if (
        uploadStatus.state === "completed" &&
        uploadStatus.completedJobId !== undefined &&
        uploadStatus.jobStatus !== undefined
      ) {
        return {
          completedJobId: uploadStatus.completedJobId,
          jobStatus: uploadStatus.jobStatus,
        };
      }
    } catch {
      // Preserve the primary upload failure. Abort is best-effort cleanup.
    }
    return undefined;
  }

  private async waitForVideo(
    jobId: string,
    initialStatus: AppBskyVideoDefs.JobStatus,
  ): Promise<AppBskyVideoDefs.JobStatus> {
    const attempts = this.options.videoPollAttempts ?? 150;
    const interval = this.options.videoPollIntervalMs ?? 2_000;
    let status = initialStatus;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (status.state === "JOB_STATE_COMPLETED") {
        return status;
      }
      if (status.state === "JOB_STATE_FAILED") {
        throw jobFailure(status);
      }
      if (attempt < attempts) {
        await this.sleep(interval);
        status = await this.getVideoJobStatusWithRetry(jobId);
      }
    }
    throw new Error(`Bluesky video processing did not finish after ${attempts} checks`);
  }

  private async getVideoJobStatusWithRetry(jobId: string): Promise<AppBskyVideoDefs.JobStatus> {
    const attempts = this.options.videoStatusRetryAttempts ?? 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.videoService.getJobStatus(jobId);
      } catch (error) {
        lastError = error;
        if (attempt === attempts || !isTransientServiceError(error)) {
          throw error;
        }
        await this.sleep(Math.min(500 * 2 ** (attempt - 1), 4_000));
      }
    }
    throw lastError;
  }
}

export function createBlueskyPublisher(
  config: PublisherConfig,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: BlueskyPublisherDependencies = {},
): BlueskyPublisher {
  const handle = environment[config.handleEnv];
  if (handle === undefined || handle.length === 0) {
    throw new Error(`Missing Bluesky handle environment variable ${config.handleEnv}`);
  }
  const appPassword = environment[config.appPasswordEnv];
  if (appPassword === undefined || appPassword.length === 0) {
    throw new Error(
      `Missing Bluesky app-password environment variable ${config.appPasswordEnv}`,
    );
  }
  const expectedDid =
    config.expectedDidEnv === undefined ? undefined : environment[config.expectedDidEnv];
  if (config.expectedDidEnv !== undefined && (expectedDid === undefined || expectedDid.length === 0)) {
    throw new Error(`Missing Bluesky DID environment variable ${config.expectedDidEnv}`);
  }
  return new BlueskyPublisher(
    {
      appPassword,
      handle,
      id: config.id,
      serviceUrl: config.serviceUrl,
      sessionPath: config.sessionPath,
      ...(expectedDid === undefined ? {} : { expectedDid }),
    },
    dependencies,
  );
}
