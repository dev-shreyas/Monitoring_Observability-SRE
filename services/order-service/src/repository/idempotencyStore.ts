/**
 * Idempotency keys for POST /checkout (P0.3).
 *
 * THE PROBLEM: a shopper double-clicks "Place order", or the network drops the
 * response and the browser retries. Each request is a valid checkout, so the
 * shopper was charged for — and received — two orders.
 *
 * THE CONTRACT (same idea as Stripe's Idempotency-Key):
 *   - the client sends one random key per checkout ATTEMPT and reuses it on retry;
 *   - the first request with a key claims it and does the work;
 *   - a repeat AFTER it finished gets the stored response back (and no new order);
 *   - a repeat WHILE it is still running gets 409 + Retry-After;
 *   - the same key with a different body gets 422 — that is a client bug.
 *
 * Keys are scoped per user, so one shopper can never replay another's response.
 */
import { getRedis } from "../redisClient";
import { config } from "../config";

export type IdempotencyRecord =
  | { state: "processing"; fingerprint: string }
  | { state: "done"; fingerprint: string; status: number; body: unknown };

export interface IdempotencyStore {
  /** Claim the key. Returns null if WE claimed it; otherwise what is already stored. */
  begin(key: string, fingerprint: string): Promise<IdempotencyRecord | null>;
  /** Store the final response for replay. */
  complete(key: string, record: { fingerprint: string; status: number; body: unknown }): Promise<void>;
  /** Release the claim after a failure, so the client may retry with the same key. */
  abandon(key: string): Promise<void>;
}

/**
 * A claim that is still "processing" expires after a minute. Without this, a pod
 * dying mid-checkout would leave the key stuck and every retry would get 409 for
 * 24 hours. A checkout takes well under a second, so a minute is generous.
 */
export const PROCESSING_TTL_SECONDS = 60;
/** Completed responses are replayable for a day — longer than any sane retry. */
export const RESULT_TTL_SECONDS = 24 * 60 * 60;

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, { record: IdempotencyRecord; expiresAt: number }>();

  async begin(key: string, fingerprint: string): Promise<IdempotencyRecord | null> {
    const existing = this.records.get(key);
    if (existing && existing.expiresAt > Date.now()) return existing.record;
    // No await between the check and the set: atomic in single-threaded JS.
    this.records.set(key, {
      record: { state: "processing", fingerprint },
      expiresAt: Date.now() + PROCESSING_TTL_SECONDS * 1000
    });
    return null;
  }

  async complete(key: string, record: { fingerprint: string; status: number; body: unknown }): Promise<void> {
    this.records.set(key, {
      record: { state: "done", ...record },
      expiresAt: Date.now() + RESULT_TTL_SECONDS * 1000
    });
  }

  async abandon(key: string): Promise<void> {
    this.records.delete(key);
  }
}

export class RedisIdempotencyStore implements IdempotencyStore {
  async begin(key: string, fingerprint: string): Promise<IdempotencyRecord | null> {
    const redis = getRedis();
    const claim: IdempotencyRecord = { state: "processing", fingerprint };
    // Two attempts: if the key expires between our failed SET NX and the GET,
    // the second SET NX simply claims it.
    for (let attempt = 0; attempt < 2; attempt++) {
      // SET NX is the whole trick: Redis executes it atomically, so of N
      // concurrent requests with one key, exactly one gets "OK".
      const ok = await redis.set(key, JSON.stringify(claim), { NX: true, EX: PROCESSING_TTL_SECONDS });
      if (ok === "OK") return null;
      const raw = await redis.get(key);
      if (raw) return JSON.parse(raw) as IdempotencyRecord;
    }
    throw new Error(`idempotency key ${key} could be neither claimed nor read`);
  }

  async complete(key: string, record: { fingerprint: string; status: number; body: unknown }): Promise<void> {
    const done: IdempotencyRecord = { state: "done", ...record };
    await getRedis().set(key, JSON.stringify(done), { EX: RESULT_TTL_SECONDS });
  }

  async abandon(key: string): Promise<void> {
    await getRedis().del(key);
  }
}

export function createIdempotencyStore(): IdempotencyStore {
  return config.redisUrl ? new RedisIdempotencyStore() : new InMemoryIdempotencyStore();
}
