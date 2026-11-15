/**
 * Fixed-window counters for login and registration throttling.
 *
 * Shared in Redis for the same reason carts are: with two replicas, a limit
 * kept in process memory would let an attacker double their budget simply by
 * landing on both pods. The in-memory version is the test path, chosen the same
 * way the repositories are (REDIS_URL set => Redis).
 */
import { BlockList, isIPv4 } from "node:net";
import { config } from "../config";
import { getRedis } from "../redisClient";

export interface CounterStore {
  /** Increment and return the new count; the window starts at the FIRST hit. */
  hit(key: string, windowSeconds: number): Promise<number>;
  count(key: string): Promise<number>;
  /** Seconds until the key's window ends (0 if absent). */
  ttl(key: string): Promise<number>;
  reset(key: string): Promise<void>;
}

export class InMemoryCounterStore implements CounterStore {
  private readonly entries = new Map<string, { count: number; expiresAt: number }>();

  private live(key: string) {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  async hit(key: string, windowSeconds: number): Promise<number> {
    const entry = this.live(key) ?? { count: 0, expiresAt: Date.now() + windowSeconds * 1000 };
    entry.count += 1;
    this.entries.set(key, entry);
    return entry.count;
  }

  async count(key: string): Promise<number> {
    return this.live(key)?.count ?? 0;
  }

  async ttl(key: string): Promise<number> {
    const entry = this.live(key);
    return entry ? Math.ceil((entry.expiresAt - Date.now()) / 1000) : 0;
  }

  async reset(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

export class RedisCounterStore implements CounterStore {
  async hit(key: string, windowSeconds: number): Promise<number> {
    // INCR and EXPIRE NX in one round trip. NX sets the expiry only when the key
    // has none, so the window is anchored at the first hit and later hits do not
    // keep pushing it out (which would turn a 15-minute lock into a permanent one
    // for an attacker who keeps trying).
    const [count] = await getRedis()
      .multi()
      .incr(key)
      .expire(key, windowSeconds, "NX")
      .exec();
    return Number(count);
  }

  async count(key: string): Promise<number> {
    return Number((await getRedis().get(key)) ?? 0);
  }

  async ttl(key: string): Promise<number> {
    return Math.max(0, await getRedis().ttl(key));
  }

  async reset(key: string): Promise<void> {
    await getRedis().del(key);
  }
}

export function createCounterStore(): CounterStore {
  return config.redisUrl ? new RedisCounterStore() : new InMemoryCounterStore();
}

/**
 * Source addresses that skip the PER-IP limits — set to the pod CIDR so the
 * in-cluster k6 load generator (one pod IP, thousands of logins) is not throttled.
 * Safe for OUTSIDE callers: they can only arrive through ingress-nginx, which
 * overwrites X-Forwarded-For with the real TCP peer address, so they cannot
 * claim to be 10.244.x.x. A pod INSIDE the cluster could forge the header when
 * calling the service directly — but it is already exempt by its own address;
 * kind-k8s/security/network-policies.yaml closes that path once applied.
 * Per-ACCOUNT lockout still applies to exempt sources.
 */
export function buildExemptList(cidrs: readonly string[]): BlockList {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [ip, bits] = cidr.split("/");
    if (ip && isIPv4(ip)) list.addSubnet(ip, Number(bits ?? 32), "ipv4");
  }
  return list;
}

export function isExempt(list: BlockList, ip: string | undefined): boolean {
  if (!ip) return false;
  const v4 = ip.startsWith("::ffff:") ? ip.slice("::ffff:".length) : ip;
  return isIPv4(v4) && list.check(v4, "ipv4");
}
