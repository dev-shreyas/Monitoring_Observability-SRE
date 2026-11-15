/**
 * The Redis connection — one per process, shared by every repository.
 *
 * WHY THIS EXISTS
 * ---------------
 * The repositories used to hold state in a `new Map()` inside the process. That
 * is correct for exactly one replica. With two, Kubernetes round-robins requests
 * between pods, so a shopper could POST /cart to pod A and then POST /checkout to
 * pod B — which had never seen the cart and correctly reported it empty. Roughly
 * half of all checkouts failed. Moving the state out of the process and into Redis
 * means every replica reads and writes the same data.
 *
 * Redis is a reasonable choice here because carts and sessions are ephemeral,
 * key-addressed, and benefit from TTLs. Orders are relational and really belong in
 * Azure SQL (see the `<<< REPLACE ME >>>` seam the repositories still carry) —
 * they live here for now so the local stack is coherent with one dependency.
 */
import { createClient, type RedisClientType } from "redis";
import { config } from "./config";
import { logger } from "./logger";

let client: RedisClientType | null = null;

/**
 * Returns the shared client, connecting on first use.
 *
 * `connect()` is deliberately NOT awaited here. node-redis queues commands issued
 * before the socket is ready (its offline queue) and replays them on connect, so
 * callers need no special handling for the startup window. Awaiting instead would
 * mean making the repository factories async, which would ripple into app.ts.
 */
export function getRedis(): RedisClientType {
  if (client) return client;

  client = createClient({
    url: config.redisUrl,
    socket: {
      /**
       * Reconnect with exponential backoff instead of node-redis's default of
       * giving up. A pod must survive Redis restarting or being rescheduled —
       * without this, one blip leaves the process permanently unable to serve.
       * Capped at 3s so recovery stays quick.
       */
      reconnectStrategy: (retries) => Math.min(retries * 100, 3000)
    }
  }) as RedisClientType;

  /**
   * An 'error' listener is MANDATORY. node-redis emits 'error' on the client, and
   * an EventEmitter with no 'error' listener throws — which our uncaughtException
   * handler turns into process.exit(1). A single network hiccup would crash-loop
   * the pod. Logging it and letting reconnectStrategy work is the correct response.
   */
  client.on("error", (err: Error) => {
    logger.error("redis client error", { reason: err.message });
  });

  client.on("ready", () => {
    logger.info("redis connected", { url: redactRedisUrl(config.redisUrl) });
  });

  client.connect().catch((err: Error) => {
    logger.error("redis initial connect failed", { reason: err.message });
  });

  return client;
}

/** Closes the connection during graceful shutdown. Safe to call when never opened. */
export async function closeRedis(): Promise<void> {
  if (!client) return;
  try {
    // Lets in-flight commands finish, unlike .disconnect() which drops them.
    await client.quit();
  } catch (err) {
    logger.warn("redis quit failed", { reason: (err as Error).message });
  } finally {
    client = null;
  }
}

/** Strips any password before a URL reaches the logs. */
export function redactRedisUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return "<unparseable>";
  }
}
