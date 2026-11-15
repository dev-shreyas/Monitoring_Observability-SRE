/**
 * A shopper's saved-for-later list. Deliberately its own tiny store rather
 * than a field on UserRecord — wishlist entries churn far more than account
 * data, and keeping them apart means a wishlist write never risks touching
 * (or corrupting) the account record itself.
 */
import { config } from "../config";
import { logger } from "../logger";
import { getRedis } from "../redisClient";

export interface WishlistItem {
  productId: string;
  addedAt: string;
}

export interface WishlistRepository {
  list(userId: string): Promise<WishlistItem[]>;
  contains(userId: string, productId: string): Promise<boolean>;
  add(userId: string, productId: string): Promise<WishlistItem[]>;
  remove(userId: string, productId: string): Promise<WishlistItem[]>;
}

export class InMemoryWishlistRepository implements WishlistRepository {
  /** Keyed by userId; a Map (not a Set) so insertion order drives display order. */
  private readonly wishlists = new Map<string, Map<string, WishlistItem>>();

  async list(userId: string): Promise<WishlistItem[]> {
    return [...(this.wishlists.get(userId)?.values() ?? [])];
  }

  async contains(userId: string, productId: string): Promise<boolean> {
    return this.wishlists.get(userId)?.has(productId) ?? false;
  }

  async add(userId: string, productId: string): Promise<WishlistItem[]> {
    const wishlist = this.wishlists.get(userId) ?? new Map<string, WishlistItem>();

    // Adding something already saved is a no-op, not an error — the caller
    // just wants "this is on my wishlist" to be true, idempotently.
    if (!wishlist.has(productId)) {
      wishlist.set(productId, { productId, addedAt: new Date().toISOString() });
    }

    this.wishlists.set(userId, wishlist);
    return [...wishlist.values()];
  }

  async remove(userId: string, productId: string): Promise<WishlistItem[]> {
    this.wishlists.get(userId)?.delete(productId);
    return [...(this.wishlists.get(userId)?.values() ?? [])];
  }
}

/**
 * Redis-backed storage. This is what runs in Kubernetes.
 *
 * KEY LAYOUT
 *   wishlist:<userId>   ZSET   member = productId, score = addedAt (epoch ms)
 *
 * A ZSET rather than a HASH because this list has an order. The in-memory version
 * relied on JavaScript Map insertion order to decide display order; a Redis HASH
 * has no order at all, so that would have been silently lost. Scoring on the
 * timestamp keeps "oldest saved first" explicit, and `addedAt` is recovered from
 * the score instead of being stored twice.
 *
 * A ZSET also makes `add` naturally idempotent: ZADD with NX adds a member only
 * if absent, so saving something twice does not move it to the end of the list.
 */
export class RedisWishlistRepository implements WishlistRepository {
  private readonly key = (userId: string) => `wishlist:${userId}`;

  async list(userId: string): Promise<WishlistItem[]> {
    // WITHSCORES so addedAt comes back with the member, in one round trip.
    const entries = await getRedis().zRangeWithScores(this.key(userId), 0, -1);
    return entries.map((e) => ({
      productId: e.value,
      addedAt: new Date(e.score).toISOString()
    }));
  }

  async contains(userId: string, productId: string): Promise<boolean> {
    // zScore returns null when the member is absent — O(1), no need to fetch the list.
    const score = await getRedis().zScore(this.key(userId), productId);
    return score !== null;
  }

  async add(userId: string, productId: string): Promise<WishlistItem[]> {
    // NX: only add if not already present, so re-saving keeps the ORIGINAL addedAt.
    // Without it the item would jump to the end of the list on every repeat add.
    await getRedis().zAdd(this.key(userId), { score: Date.now(), value: productId }, { NX: true });
    return this.list(userId);
  }

  async remove(userId: string, productId: string): Promise<WishlistItem[]> {
    // Removing something absent is a no-op in Redis, matching the previous behaviour.
    await getRedis().zRem(this.key(userId), productId);
    return this.list(userId);
  }
}

export function createWishlistRepository(): WishlistRepository {
  if (config.sqlConnectionString && config.sqlConnectionString !== "dummy-local-connection") {
    // <<< REPLACE ME >>> An Azure SQL implementation goes here, same seam as
    // userRepository.ts — likely one row per (userId, productId) pair.
    logger.warn("SQL_CONNECTION_STRING is set but no SQL wishlist repository is implemented yet; using Redis/in-memory store");
  }

  if (config.redisUrl) {
    return new RedisWishlistRepository();
  }

  logger.warn("REDIS_URL is not set; using in-memory store (safe ONLY with a single replica)");
  return new InMemoryWishlistRepository();
}
