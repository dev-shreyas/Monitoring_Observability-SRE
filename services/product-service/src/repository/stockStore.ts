/**
 * Stock levels and reservations (P1.1) — product-service owns stock.
 *
 * THE BUG THIS FIXES: checkout used to READ stock and never decrement it, so the
 * catalogue said "12 left" forever and the 13th, 100th and 1000th laptop all
 * sold. A plain decrement is not enough either: "read stock, check, write
 * stock-1" from two checkouts at once lets both see the last unit.
 *
 * THE MODEL
 *   reserve(id, lines)  all-or-nothing: every line has enough stock, or nothing
 *                       is taken. Stock is decremented now; the reservation is
 *                       "held" with a deadline.
 *   commit(id)          the order is confirmed (paid) — the stock is gone for good.
 *   release(id)         the order was cancelled, or never confirmed in time —
 *                       the stock goes back on the shelf.
 *
 * Each step is ONE Lua script. Redis runs a script atomically — no other command
 * runs between its first and last line — so "check every line, then decrement
 * every line" cannot interleave with another checkout. That is what makes 50
 * simultaneous checkouts for the last 5 units produce exactly 5 orders.
 *
 * KEY LAYOUT
 *   stock:<productId>          STRING  units available to reserve
 *   reservation:<id>           HASH    state, items (JSON), expiresAt, createdAt
 *   reservations:held          ZSET    member = reservation id, score = expiresAt
 *                                      (what the expiry sweeper scans)
 */
import { config } from "../config";
import { getRedis } from "../redisClient";

export interface ReservationItem {
  productId: string;
  quantity: number;
}

export type ReservationState = "held" | "committed" | "released";

export type ReserveResult =
  | { ok: true; state: ReservationState; created: boolean }
  | { ok: false; productId: string; available: number };

export type CommitResult = "committed" | "released" | "missing";
/** "released_now" = this call returned the stock; anything else changed nothing. */
export type ReleaseResult = "released_now" | ReservationState | "missing";

export interface StockStore {
  levels(productIds: string[]): Promise<Map<string, number>>;
  reserve(id: string, items: ReservationItem[], ttlSeconds: number): Promise<ReserveResult>;
  commit(id: string): Promise<CommitResult>;
  /** onlyIfHeld: the expiry sweeper must never release stock of a COMMITTED order. */
  release(id: string, reason: string, onlyIfHeld?: boolean): Promise<ReleaseResult>;
  /** Held reservations whose deadline has passed (for the sweeper). */
  expired(nowMs: number, limit: number): Promise<string[]>;
  /** Restock / correct a level (internal API; admin tooling arrives in P3.2). */
  setLevel(productId: string, quantity: number): Promise<void>;
}

/** Two lines for the same product are one line: otherwise each passes the check alone. */
export function mergeItems(items: ReservationItem[]): ReservationItem[] {
  const merged = new Map<string, number>();
  for (const item of items) merged.set(item.productId, (merged.get(item.productId) ?? 0) + item.quantity);
  return [...merged.entries()].map(([productId, quantity]) => ({ productId, quantity }));
}

const DAY = 24 * 60 * 60;

// ---------------------------------------------------------------------------
// In-memory — tests and single-process runs. Same semantics; JS is
// single-threaded and nothing below awaits mid-operation, so each method is atomic.
// ---------------------------------------------------------------------------
export class InMemoryStockStore implements StockStore {
  private readonly stock = new Map<string, number>();
  private readonly reservations = new Map<
    string,
    { state: ReservationState; items: ReservationItem[]; expiresAt: number }
  >();

  constructor(private readonly initial: Readonly<Record<string, number>>) {}

  private level(productId: string): number {
    if (!this.stock.has(productId)) this.stock.set(productId, this.initial[productId] ?? 0);
    return this.stock.get(productId)!;
  }

  async levels(productIds: string[]): Promise<Map<string, number>> {
    return new Map(productIds.map((id) => [id, this.level(id)]));
  }

  async reserve(id: string, items: ReservationItem[], ttlSeconds: number): Promise<ReserveResult> {
    const existing = this.reservations.get(id);
    if (existing) return { ok: true, state: existing.state, created: false };

    const lines = mergeItems(items);
    for (const line of lines) {
      const available = this.level(line.productId);
      if (available < line.quantity) return { ok: false, productId: line.productId, available };
    }
    for (const line of lines) this.stock.set(line.productId, this.level(line.productId) - line.quantity);
    this.reservations.set(id, { state: "held", items: lines, expiresAt: Date.now() + ttlSeconds * 1000 });
    return { ok: true, state: "held", created: true };
  }

  async commit(id: string): Promise<CommitResult> {
    const r = this.reservations.get(id);
    if (!r) return "missing";
    if (r.state === "held") r.state = "committed";
    return r.state === "committed" ? "committed" : "released";
  }

  async release(id: string, _reason: string, onlyIfHeld = false): Promise<ReleaseResult> {
    const r = this.reservations.get(id);
    if (!r) return "missing";
    if (r.state === "released") return "released";
    if (onlyIfHeld && r.state !== "held") return r.state;
    for (const line of r.items) this.stock.set(line.productId, this.level(line.productId) + line.quantity);
    r.state = "released";
    return "released_now";
  }

  async expired(nowMs: number, limit: number): Promise<string[]> {
    return [...this.reservations.entries()]
      .filter(([, r]) => r.state === "held" && r.expiresAt <= nowMs)
      .slice(0, limit)
      .map(([id]) => id);
  }

  async setLevel(productId: string, quantity: number): Promise<void> {
    this.stock.set(productId, quantity);
  }

  /** Test helper: move a reservation's deadline. */
  expireNow(id: string): void {
    const r = this.reservations.get(id);
    if (r) r.expiresAt = 0;
  }
}

// ---------------------------------------------------------------------------
// Redis — what runs in Kubernetes.
// ---------------------------------------------------------------------------

/**
 * KEYS: 1 reservation, 2 held-zset, 3.. stock keys
 * ARGV: 1 id, 2 expiresAt(ms), 3 items JSON, 4 createdAt,
 *       5..4+n wanted quantities, 5+n..4+2n initial stock (lazy seed)
 */
const RESERVE_LUA = `
local n = #KEYS - 2
if redis.call('EXISTS', KEYS[1]) == 1 then
  return {'exists', redis.call('HGET', KEYS[1], 'state')}
end
for i = 1, n do
  local key = KEYS[i + 2]
  if redis.call('EXISTS', key) == 0 then
    redis.call('SET', key, ARGV[4 + n + i])
  end
  local available = tonumber(redis.call('GET', key))
  if available < tonumber(ARGV[4 + i]) then
    return {'short', tostring(i), tostring(available)}
  end
end
for i = 1, n do
  redis.call('DECRBY', KEYS[i + 2], ARGV[4 + i])
end
redis.call('HSET', KEYS[1], 'state', 'held', 'items', ARGV[3], 'expiresAt', ARGV[2], 'createdAt', ARGV[4])
redis.call('EXPIRE', KEYS[1], ${30 * DAY})
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[1])
return {'held'}
`;

/** KEYS: 1 reservation, 2 held-zset. ARGV: 1 id */
const COMMIT_LUA = `
local state = redis.call('HGET', KEYS[1], 'state')
if not state then return 'missing' end
if state == 'held' then
  redis.call('HSET', KEYS[1], 'state', 'committed')
  redis.call('ZREM', KEYS[2], ARGV[1])
  return 'committed'
end
return state
`;

/** KEYS: 1 reservation, 2 held-zset, 3.. stock keys. ARGV: 1 id, 2 reason, 3 onlyIfHeld, 4.. quantities */
const RELEASE_LUA = `
local state = redis.call('HGET', KEYS[1], 'state')
if not state then return 'missing' end
if state == 'released' then return 'released' end
if ARGV[3] == '1' and state ~= 'held' then return state end
for i = 3, #KEYS do
  redis.call('INCRBY', KEYS[i], ARGV[i + 1])
end
redis.call('HSET', KEYS[1], 'state', 'released', 'releasedReason', ARGV[2])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('EXPIRE', KEYS[1], ${7 * DAY})
return 'released_now'
`;

export class RedisStockStore implements StockStore {
  private readonly stockKey = (productId: string) => `stock:${productId}`;
  private readonly reservationKey = (id: string) => `reservation:${id}`;
  private readonly heldKey = "reservations:held";

  constructor(private readonly initial: Readonly<Record<string, number>>) {}

  async levels(productIds: string[]): Promise<Map<string, number>> {
    if (productIds.length === 0) return new Map();
    const raw = await getRedis().mGet(productIds.map(this.stockKey));
    // A product never reserved has no counter yet: its seed value IS its level.
    return new Map(productIds.map((id, i) => [id, raw[i] === null ? (this.initial[id] ?? 0) : Number(raw[i])]));
  }

  async reserve(id: string, items: ReservationItem[], ttlSeconds: number): Promise<ReserveResult> {
    const lines = mergeItems(items);
    const now = Date.now();
    const result = (await getRedis().eval(RESERVE_LUA, {
      keys: [this.reservationKey(id), this.heldKey, ...lines.map((l) => this.stockKey(l.productId))],
      arguments: [
        id,
        String(now + ttlSeconds * 1000),
        JSON.stringify(lines),
        new Date(now).toISOString(),
        ...lines.map((l) => String(l.quantity)),
        ...lines.map((l) => String(this.initial[l.productId] ?? 0))
      ]
    })) as string[];

    if (result[0] === "short") {
      const line = lines[Number(result[1]) - 1]!;
      return { ok: false, productId: line.productId, available: Number(result[2]) };
    }
    if (result[0] === "exists") return { ok: true, state: result[1] as ReservationState, created: false };
    return { ok: true, state: "held", created: true };
  }

  async commit(id: string): Promise<CommitResult> {
    return (await getRedis().eval(COMMIT_LUA, {
      keys: [this.reservationKey(id), this.heldKey],
      arguments: [id]
    })) as CommitResult;
  }

  async release(id: string, reason: string, onlyIfHeld = false): Promise<ReleaseResult> {
    // The items are immutable once reserved, so reading them first and passing
    // the stock keys in KEYS (as Redis requires) is safe; the script re-checks
    // the STATE atomically, which is the part that can change.
    const itemsJson = await getRedis().hGet(this.reservationKey(id), "items");
    if (!itemsJson) return "missing";
    const lines = JSON.parse(itemsJson) as ReservationItem[];
    return (await getRedis().eval(RELEASE_LUA, {
      keys: [this.reservationKey(id), this.heldKey, ...lines.map((l) => this.stockKey(l.productId))],
      arguments: [id, reason, onlyIfHeld ? "1" : "0", ...lines.map((l) => String(l.quantity))]
    })) as ReleaseResult;
  }

  async expired(nowMs: number, limit: number): Promise<string[]> {
    return getRedis().zRangeByScore(this.heldKey, "-inf", nowMs, { LIMIT: { offset: 0, count: limit } });
  }

  async setLevel(productId: string, quantity: number): Promise<void> {
    await getRedis().set(this.stockKey(productId), String(quantity));
  }
}

export function createStockStore(initial: Readonly<Record<string, number>>): StockStore {
  return config.redisUrl ? new RedisStockStore(initial) : new InMemoryStockStore(initial);
}
