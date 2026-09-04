import type {
  AppBskyFeedPost,
  AppBskyVideoDefs,
  BlobRef,
} from "@atproto/api";
import { describe, expect, it } from "vitest";

import type { CanonicalPost } from "../../src/domain/types.js";
import {
  BlueskyPublisher,
  createBlueskyPublisher,
  type BlueskyClientPort,
  type PreparedText,
  type ServiceAuthRequest,
  type VideoAbortResult,
  type VideoFinishResult,
  type VideoPartResult,
  type VideoServicePort,
  type VideoStartResult,
  type VideoUploadLimits,
  type VideoUploadStatus,
} from "../../src/publishers/bluesky.js";

const imageBlob = { mimeType: "image/png", size: 4 } as BlobRef;
const videoBlob = { mimeType: "video/mp4", size: 20 } as BlobRef;
const fixedDate = new Date("2026-09-04T15:00:00.000Z");

class FakeClient implements BlueskyClientPort {
  public readonly did = "did:plc:lake-pulse";
  public readonly dispatchUrl = new URL("https://pds.example.com");
  public readonly authRequests: ServiceAuthRequest[] = [];
  public readonly blobUploads: Array<{ bytes: Uint8Array; mimeType: string }> = [];
  public readonly posts: Array<{ record: AppBskyFeedPost.Record; rkey: string }> = [];
  public preparedText: PreparedText | undefined;

  public prepareText(text: string): Promise<PreparedText> {
    return Promise.resolve(
      this.preparedText ?? {
        byteLength: new TextEncoder().encode(text).byteLength,
        graphemeLength: [...text].length,
        text,
      },
    );
  }

  public uploadBlob(bytes: Uint8Array, mimeType: string): Promise<BlobRef> {
    this.blobUploads.push({ bytes, mimeType });
    return Promise.resolve(imageBlob);
  }

  public getServiceAuth(request: ServiceAuthRequest): Promise<string> {
    this.authRequests.push(request);
    return Promise.resolve(`token-${this.authRequests.length}`);
  }

  public createPost(
    record: AppBskyFeedPost.Record,
    rkey: string,
  ): Promise<{ uri: string; cid: string }> {
    this.posts.push({ record, rkey });
    return Promise.resolve({ cid: "post-cid", uri: `at://${this.did}/app.bsky.feed.post/${rkey}` });
  }
}

class FakeVideoService implements VideoServicePort {
  public readonly parts: Array<{
    bytes: Uint8Array;
    jobId: string;
    partNumber: number;
    token: string;
  }> = [];
  public finishTokens: string[] = [];
  public jobStatuses: AppBskyVideoDefs.JobStatus[] = [];
  public limits: VideoUploadLimits = {
    canUpload: true,
    remainingDailyBytes: 1_000,
    remainingDailyVideos: 1,
  };

  public getUploadLimits(_token: string): Promise<VideoUploadLimits> {
    return Promise.resolve(this.limits);
  }

  public startUpload(
    _input: { sizeBytes: number; mimeType: string; name: string },
    _token: string,
  ): Promise<VideoStartResult> {
    return Promise.resolve({
      expiresAt: "2026-09-04T16:00:00.000Z",
      jobId: "upload-job",
      partCount: 3,
      partSizeBytes: 8,
    });
  }

  public uploadPart(
    bytes: Uint8Array,
    input: { jobId: string; partNumber: number },
    token: string,
  ): Promise<VideoPartResult> {
    this.parts.push({
      bytes: Uint8Array.from(bytes),
      jobId: input.jobId,
      partNumber: input.partNumber,
      token,
    });
    return Promise.resolve({ partNumber: input.partNumber, sizeBytes: bytes.byteLength });
  }

  public getUploadStatus(_jobId: string, _token: string): Promise<VideoUploadStatus> {
    throw new Error("unexpected getUploadStatus");
  }

  public finishUpload(_jobId: string, token: string): Promise<VideoFinishResult> {
    this.finishTokens.push(token);
    return Promise.resolve({
      completedJobId: "processing-job",
      jobStatus: {
        did: "did:plc:lake-pulse",
        jobId: "processing-job",
        state: "JOB_STATE_ENCODING",
      },
    });
  }

  public abortUpload(_jobId: string, _token: string): Promise<VideoAbortResult> {
    throw new Error("unexpected abortUpload");
  }

  public getJobStatus(_jobId: string): Promise<AppBskyVideoDefs.JobStatus> {
    const next = this.jobStatuses.shift();
    if (next === undefined) {
      throw new Error("missing fake job status");
    }
    return Promise.resolve(next);
  }
}

function publisher(client: FakeClient, videoService: VideoServicePort = new FakeVideoService()) {
  return new BlueskyPublisher(
    {
      appPassword: "never-used",
      handle: "lake-pulse.test",
      id: "bluesky",
      partRetryAttempts: 2,
      serviceUrl: "https://bsky.social",
      sessionPath: "/never/used/session.json",
      uploadRecoveryAttempts: 2,
      videoPollAttempts: 2,
      videoPollIntervalMs: 1,
    },
    {
      clientFactory: () => Promise.resolve(client),
      clockMs: () => fixedDate.getTime(),
      now: () => fixedDate,
      sleep: () => Promise.resolve(),
      videoService,
    },
  );
}

function post(media?: CanonicalPost["media"]): CanonicalPost {
  return {
    idempotencyKey: "station:camera:2026-09-04T15:00:00Z",
    kind: "camera",
    langs: ["en"],
    ...(media === undefined ? {} : { media }),
    sourceUrls: ["https://example.com/station"],
    stationKey: "chicago",
    text: "Lake Michigan right now.",
  };
}

function mp4Bytes(length = 20): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70]);
  return bytes;
}

describe("BlueskyPublisher", () => {
  it("uploads an image and creates a deterministic post record", async () => {
    const client = new FakeClient();
    const instance = publisher(client);

    const receipt = await instance.publish(
      post({
        alt: "Small waves near the Chicago buoy.",
        aspectRatio: { height: 9, width: 16 },
        bytes: new Uint8Array([1, 2, 3, 4]),
        kind: "image",
        mimeType: "image/png",
      }),
    );

    expect(client.blobUploads).toHaveLength(1);
    expect(client.blobUploads[0]?.mimeType).toBe("image/png");
    expect(client.posts[0]?.record.embed).toMatchObject({
      $type: "app.bsky.embed.images",
      images: [
        {
          alt: "Small waves near the Chicago buoy.",
          aspectRatio: { height: 9, width: 16 },
          image: imageBlob,
        },
      ],
    });
    expect(client.posts[0]?.rkey).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt).toMatchObject({ cid: "post-cid", publisherId: "bluesky" });
  });

  it("rejects overlong text before uploading media", async () => {
    const client = new FakeClient();
    client.preparedText = {
      byteLength: 301,
      graphemeLength: 301,
      text: "x".repeat(301),
    };
    const instance = publisher(client);

    await expect(
      instance.publish(
        post({
          alt: "An image",
          bytes: new Uint8Array([1]),
          kind: "image",
          mimeType: "image/png",
        }),
      ),
    ).rejects.toThrow(/301 graphemes/u);
    expect(client.blobUploads).toHaveLength(0);
    expect(client.posts).toHaveLength(0);
  });

  it("uploads bounded video parts sequentially and waits for the processed blob", async () => {
    const client = new FakeClient();
    const videoService = new FakeVideoService();
    videoService.jobStatuses.push({
      blob: videoBlob,
      did: client.did,
      jobId: "processing-job",
      state: "JOB_STATE_COMPLETED",
    });
    const instance = publisher(client, videoService);

    await instance.publish(
      post({
        alt: "Thirty seconds of the lake surface near buoy 45198.",
        aspectRatio: { height: 720, width: 1280 },
        bytes: mp4Bytes(),
        kind: "video",
        mimeType: "video/mp4",
      }),
    );

    expect(videoService.parts.map((part) => part.partNumber)).toEqual([1, 2, 3]);
    expect(videoService.parts.map((part) => part.bytes.byteLength)).toEqual([8, 8, 4]);
    expect(videoService.parts.map((part) => part.token)).toEqual([
      "token-2",
      "token-2",
      "token-2",
    ]);
    expect(videoService.finishTokens).toEqual(["token-3"]);
    expect(client.authRequests).toEqual([
      { aud: "did:web:video.bsky.app", lxm: "app.bsky.video.getUploadLimits" },
      {
        aud: "did:web:pds.example.com",
        exp: Math.floor(fixedDate.getTime() / 1_000) + 1_800,
        lxm: "com.atproto.repo.uploadBlob",
      },
      {
        aud: "did:web:pds.example.com",
        exp: Math.floor(fixedDate.getTime() / 1_000) + 1_800,
        lxm: "com.atproto.repo.uploadBlob",
      },
    ]);
    expect(client.posts[0]?.record.embed).toMatchObject({
      $type: "app.bsky.embed.video",
      alt: "Thirty seconds of the lake surface near buoy 45198.",
      video: videoBlob,
    });
  });

  it("recovers a failed finish by resending only missing parts", async () => {
    const client = new FakeClient();
    class RecoveringVideoService extends FakeVideoService {
      private finishCalls = 0;

      public override finishUpload(jobId: string, token: string): Promise<VideoFinishResult> {
        this.finishCalls += 1;
        if (this.finishCalls === 1) {
          return Promise.reject(new TypeError("network interrupted"));
        }
        return super.finishUpload(jobId, token);
      }

      public override getUploadStatus(
        _jobId: string,
        _token: string,
      ): Promise<VideoUploadStatus> {
        return Promise.resolve({
          expiresAt: "2026-09-04T16:00:00.000Z",
          jobId: "upload-job",
          partCount: 3,
          partSizeBytes: 8,
          receivedParts: [1, 3],
          state: "created",
        });
      }
    }
    const videoService = new RecoveringVideoService();
    videoService.jobStatuses.push({
      blob: videoBlob,
      did: client.did,
      jobId: "processing-job",
      state: "JOB_STATE_COMPLETED",
    });

    await publisher(client, videoService).publish(
      post({
        alt: "Lake surface video.",
        bytes: mp4Bytes(),
        kind: "video",
        mimeType: "video/mp4",
      }),
    );

    expect(videoService.parts.map((part) => part.partNumber)).toEqual([1, 2, 3, 2]);
  });

  it("does not publish when video processing fails", async () => {
    const client = new FakeClient();
    const videoService = new FakeVideoService();
    videoService.jobStatuses.push({
      did: client.did,
      jobId: "processing-job",
      message: "codec rejected",
      state: "JOB_STATE_FAILED",
    });

    await expect(
      publisher(client, videoService).publish(
        post({
          alt: "Lake surface video.",
          bytes: mp4Bytes(),
          kind: "video",
          mimeType: "video/mp4",
        }),
      ),
    ).rejects.toThrow(/codec rejected/u);
    expect(client.posts).toHaveLength(0);
  });
});

describe("createBlueskyPublisher", () => {
  const config = {
    appPasswordEnv: "BOT_PASSWORD",
    enabled: true,
    handleEnv: "BOT_HANDLE",
    id: "bluesky",
    kind: "bluesky" as const,
    serviceUrl: "https://bsky.social",
    sessionPath: "/state/session.json",
  };

  it("resolves secrets from named environment variables", () => {
    const result = createBlueskyPublisher(config, {
      BOT_HANDLE: "lake-pulse.test",
      BOT_PASSWORD: "app-password",
    });
    expect(result.id).toBe("bluesky");
  });

  it("reports a missing variable by name without including another secret", () => {
    expect(() =>
      createBlueskyPublisher(config, { BOT_HANDLE: "lake-pulse.test" }),
    ).toThrow("BOT_PASSWORD");
  });
});
