import type { AppConfig } from "../config/schema.js";
import { Logger } from "../core/log.js";
import { ChicagoBuoysDatabase } from "../db/database.js";
import type { CanonicalPost, Publisher, PublishReceipt } from "../domain/types.js";

export class PublishingService {
  public constructor(
    private readonly config: AppConfig,
    private readonly database: ChicagoBuoysDatabase,
    private readonly publishers: Publisher[],
    private readonly logger: Logger,
  ) {}

  public async dispatch(post: CanonicalPost): Promise<PublishReceipt[]> {
    if (this.config.app.mode === "shadow") {
      const created = this.database.reservePublication(post, "shadow", "shadow");
      this.logger.info(created ? "shadow_post_created" : "shadow_post_duplicate", {
        idempotencyKey: post.idempotencyKey,
        kind: post.kind,
        stationKey: post.stationKey,
        text: post.text,
      });
      return [];
    }

    if (this.publishers.length === 0) {
      throw new Error("Live mode requires at least one enabled publisher");
    }

    const receipts: PublishReceipt[] = [];
    for (const publisher of this.publishers) {
      const reserved = this.database.reservePublication(post, publisher.id, "pending");
      if (!reserved) {
        this.logger.info("publication_duplicate_suppressed", {
          idempotencyKey: post.idempotencyKey,
          publisherId: publisher.id,
        });
        continue;
      }
      this.database.markPublicationStarted(post.idempotencyKey, publisher.id);
      try {
        const receipt = await publisher.publish(post);
        this.database.markPublicationComplete(post.idempotencyKey, receipt);
        receipts.push(receipt);
        this.logger.info("publication_complete", {
          cid: receipt.cid,
          publisherId: publisher.id,
          uri: receipt.uri,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.database.markPublicationFailed(post.idempotencyKey, publisher.id, message);
        this.logger.error("publication_failed", {
          error: message,
          idempotencyKey: post.idempotencyKey,
          publisherId: publisher.id,
        });
        throw error;
      }
    }
    return receipts;
  }
}
