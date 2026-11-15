/**
 * Cart and order storage — the Azure SQL seam.
 *
 * Orders are relational and need ACID guarantees (an order and its line items
 * must be written together or not at all), which is why section 6 puts this
 * service on Azure SQL rather than Cosmos.
 */
import { randomUUID } from "node:crypto";
import { config } from "../config";
import { logger } from "../logger";
import { getRedis } from "../redisClient";
import type { OrderStatus, StatusChange } from "../domain/orderStateMachine";

export type { OrderStatus, StatusChange };

export interface CartItem {
  productId: string;
  quantity: number;
}

export interface OrderLine {
  productId: string;
  name: string;
  quantity: number;
  /** Price CAPTURED at checkout time. The catalog price may change later;
   *  an order must always show what the customer actually agreed to pay. */
  unitPriceMinor: number;
}

export interface Order {
  id: string;
  userId: string;
  status: OrderStatus;
  lines: OrderLine[];
  /** Line total before any coupon is applied. */
  subtotalMinor: number;
  /** 0 when no coupon was applied. */
  discountMinor: number;
  couponCode: string | null;
  /** subtotalMinor - discountMinor. What the customer actually owes. */
  totalMinor: number;
  currency: string;
  createdAt: string;
  /** Last status change. */
  updatedAt: string;
  /** product-service reservation holding this order's stock (P1.1). */
  reservationId: string | null;
  /** While pending_payment: when the order is cancelled if still unpaid. */
  paymentDueAt: string | null;
  /** Every status change, oldest first — who, when and why (P1.2). */
  history: StatusChange[];
}

export type NewOrder = Omit<Order, "createdAt" | "updatedAt">;

/**
 * Orders written before P1.2 have status "placed" and no history. "placed" meant
 * "accepted, stock assumed available" — the closest new status is "paid" (the
 * shop had no payment step). Normalised on every read so the rest of the code
 * only ever sees the new statuses; the stored JSON is rewritten on the next change.
 */
type StoredOrder = Omit<Order, "status"> & { status: OrderStatus | "placed" };

export function normalizeOrder(stored: Order | StoredOrder): Order {
  const raw = stored as StoredOrder;
  if (raw.status !== "placed" && raw.history) return raw as Order;
  const status: OrderStatus = raw.status === "placed" ? "paid" : raw.status;
  return {
    ...raw,
    status,
    updatedAt: raw.updatedAt ?? raw.createdAt,
    reservationId: raw.reservationId ?? null,
    paymentDueAt: raw.paymentDueAt ?? null,
    history: raw.history ?? [
      { from: null, to: status, at: raw.createdAt, actor: "system", reason: "migrated: order placed before the order lifecycle existed" }
    ]
  };
}

export interface OrderRepository {
  getCart(userId: string): Promise<CartItem[]>;
  addToCart(userId: string, item: CartItem): Promise<CartItem[]>;
  clearCart(userId: string): Promise<void>;
  createOrder(order: NewOrder): Promise<Order>;
  listOrders(userId: string): Promise<Order[]>;
  /** Scoped to the owner: another user's order is "not found". */
  findOrder(userId: string, orderId: string): Promise<Order | null>;
  /** Unscoped — for the system (sweeper) and admin paths only. */
  findOrderById(orderId: string): Promise<Order | null>;
  /**
   * COMPARE-AND-SET: store `next` only if the stored status is still `expected`.
   * Returns null when it was not (someone else changed the order first), so two
   * racing changes — a shopper cancelling while the payment sweeper confirms —
   * cannot both win.
   */
  transition(orderId: string, expected: OrderStatus, next: Order): Promise<Order | null>;
  /** Atomically claim pending_payment orders whose payment deadline has passed. */
  claimOverduePending(nowMs: number, limit: number): Promise<string[]>;
}

export class InMemoryOrderRepository implements OrderRepository {
  private readonly carts = new Map<string, CartItem[]>();
  private readonly orders = new Map<string, Order>();

  async getCart(userId: string): Promise<CartItem[]> {
    return this.carts.get(userId) ?? [];
  }

  async addToCart(userId: string, item: CartItem): Promise<CartItem[]> {
    const cart = this.carts.get(userId) ?? [];
    const existing = cart.find((c) => c.productId === item.productId);

    // Adding the same product twice increments quantity rather than creating
    // a duplicate line — what a shopper expects.
    if (existing) {
      existing.quantity += item.quantity;
    } else {
      cart.push({ ...item });
    }

    this.carts.set(userId, cart);
    return cart;
  }

  async clearCart(userId: string): Promise<void> {
    this.carts.delete(userId);
  }

  async createOrder(order: NewOrder): Promise<Order> {
    const now = new Date().toISOString();
    const record: Order = { ...order, id: order.id || randomUUID(), createdAt: now, updatedAt: now };
    this.orders.set(record.id, record);
    return record;
  }

  async listOrders(userId: string): Promise<Order[]> {
    return [...this.orders.values()]
      .filter((o) => o.userId === userId)
      .map((o) => normalizeOrder(o))
      // Newest first — the order a customer is asking about is usually the last one.
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async findOrder(userId: string, orderId: string): Promise<Order | null> {
    const order = this.orders.get(orderId);
    // Scoping by userId here is an authorization check, not just a filter:
    // it stops user A fetching user B's order by guessing its id.
    return order && order.userId === userId ? normalizeOrder(order) : null;
  }

  async findOrderById(orderId: string): Promise<Order | null> {
    const order = this.orders.get(orderId);
    return order ? normalizeOrder(order) : null;
  }

  async transition(orderId: string, expected: OrderStatus, next: Order): Promise<Order | null> {
    const stored = this.orders.get(orderId);
    const current = stored ? normalizeOrder(stored) : null;
    if (!current || current.status !== expected) return null;
    this.orders.set(orderId, next);
    return next;
  }

  private readonly claimed = new Set<string>();
  async claimOverduePending(nowMs: number, limit: number): Promise<string[]> {
    const due = [...this.orders.values()]
      .filter((o) => o.status === "pending_payment" && o.paymentDueAt && Date.parse(o.paymentDueAt) <= nowMs)
      .filter((o) => !this.claimed.has(o.id))
      .slice(0, limit)
      .map((o) => o.id);
    due.forEach((id) => this.claimed.add(id));
    return due;
  }

  /** Test helper: an existing record exactly as stored (e.g. a legacy "placed" order). */
  insertRaw(order: Order): void {
    this.orders.set(order.id, order);
  }
}

/**
 * Redis-backed storage. This is what runs in Kubernetes.
 *
 * KEY LAYOUT
 * ----------
 *   cart:<userId>            HASH   field = productId, value = quantity
 *   order:<orderId>          STRING the order as JSON
 *   user:<userId>:orders     ZSET   member = orderId, score = createdAt (epoch ms)
 *   orders:pending_payment   ZSET   member = orderId, score = paymentDueAt (epoch ms)
 *
 * Two choices worth understanding:
 *
 * 1. The cart is a HASH, not a JSON blob. Adding an item is a single HINCRBY,
 *    which Redis applies atomically. The old in-memory code did read-modify-write
 *    (`get`, mutate, `set`), so two concurrent "add to cart" calls could each read
 *    quantity 1 and both write 2, losing an item. A JSON blob in Redis would have
 *    exactly the same race. HINCRBY cannot lose an increment.
 *
 * 2. Orders are indexed by a ZSET scored on creation time, rather than scanning
 *    every order and filtering by userId as the in-memory version did. That scan
 *    was O(all orders in the system) for every "my orders" request. ZRANGE with
 *    REV gives newest-first directly from the index.
 */
export class RedisOrderRepository implements OrderRepository {
  private readonly cartKey = (userId: string) => `cart:${userId}`;
  private readonly orderKey = (orderId: string) => `order:${orderId}`;
  private readonly userOrdersKey = (userId: string) => `user:${userId}:orders`;

  /**
   * How long an abandoned cart survives. A cart is not a permanent record, and
   * without a TTL every cart ever created would sit in Redis forever. Refreshed
   * on each write, so an active shopper never loses theirs mid-session.
   */
  private readonly cartTtlSeconds = 60 * 60 * 24 * 7;

  async getCart(userId: string): Promise<CartItem[]> {
    const raw = await getRedis().hGetAll(this.cartKey(userId));
    return Object.entries(raw).map(([productId, quantity]) => ({
      productId,
      quantity: Number(quantity)
    }));
  }

  async addToCart(userId: string, item: CartItem): Promise<CartItem[]> {
    const key = this.cartKey(userId);

    // Pipelined so both commands make one round trip. HINCRBY creates the field
    // at `quantity` if absent, or adds to it if present — the same "increment,
    // do not duplicate" behaviour the in-memory version implemented by hand.
    const tx = getRedis().multi();
    tx.hIncrBy(key, item.productId, item.quantity);
    tx.expire(key, this.cartTtlSeconds);
    await tx.exec();

    return this.getCart(userId);
  }

  async clearCart(userId: string): Promise<void> {
    await getRedis().del(this.cartKey(userId));
  }

  private readonly pendingKey = "orders:pending_payment";

  async createOrder(order: NewOrder): Promise<Order> {
    const now = new Date().toISOString();
    const record: Order = { ...order, id: order.id || randomUUID(), createdAt: now, updatedAt: now };

    // All writes in one transaction: an order that exists but is missing from the
    // user's index would be invisible to listOrders — a silently lost order; one
    // missing from the pending index would never be expired if left unpaid.
    const tx = getRedis().multi();
    tx.set(this.orderKey(record.id), JSON.stringify(record));
    tx.zAdd(this.userOrdersKey(record.userId), {
      score: Date.parse(record.createdAt),
      value: record.id
    });
    if (record.status === "pending_payment" && record.paymentDueAt) {
      tx.zAdd(this.pendingKey, { score: Date.parse(record.paymentDueAt), value: record.id });
    }
    await tx.exec();

    return record;
  }

  async listOrders(userId: string): Promise<Order[]> {
    // REV = highest score first = newest first.
    const ids = await getRedis().zRange(this.userOrdersKey(userId), 0, -1, { REV: true });
    if (ids.length === 0) return [];

    // One MGET rather than N round trips.
    const raw = await getRedis().mGet(ids.map((id) => this.orderKey(id)));
    return raw
      .filter((value): value is string => value !== null)
      .map((value) => normalizeOrder(JSON.parse(value) as Order));
  }

  async findOrder(userId: string, orderId: string): Promise<Order | null> {
    const raw = await getRedis().get(this.orderKey(orderId));
    if (!raw) return null;

    const order = normalizeOrder(JSON.parse(raw) as Order);
    // Scoping by userId is an AUTHORIZATION check, not a filter: without it, user A
    // could fetch user B's order by guessing its id.
    return order.userId === userId ? order : null;
  }

  async findOrderById(orderId: string): Promise<Order | null> {
    const raw = await getRedis().get(this.orderKey(orderId));
    return raw ? normalizeOrder(JSON.parse(raw) as Order) : null;
  }

  /**
   * Compare-and-set in one Lua script: read the stored status, compare, write —
   * atomically, so no other change can land in between. ("placed" is the legacy
   * spelling of "paid"; see normalizeOrder.)
   */
  private static readonly TRANSITION_LUA = `
    local raw = redis.call('GET', KEYS[1])
    if not raw then return 'missing' end
    local current = cjson.decode(raw).status
    if current == 'placed' then current = 'paid' end
    if current ~= ARGV[1] then return current end
    redis.call('SET', KEYS[1], ARGV[2])
    if ARGV[4] ~= 'pending_payment' then redis.call('ZREM', KEYS[2], ARGV[3]) end
    return 'ok'
  `;

  async transition(orderId: string, expected: OrderStatus, next: Order): Promise<Order | null> {
    const result = await getRedis().eval(RedisOrderRepository.TRANSITION_LUA, {
      keys: [this.orderKey(orderId), this.pendingKey],
      arguments: [expected, JSON.stringify(next), orderId, next.status]
    });
    return result === "ok" ? next : null;
  }

  async claimOverduePending(nowMs: number, limit: number): Promise<string[]> {
    const redis = getRedis();
    const due = await redis.zRangeByScore(this.pendingKey, "-inf", nowMs, { LIMIT: { offset: 0, count: limit } });
    const claimed: string[] = [];
    for (const id of due) {
      // ZREM returns 1 to exactly ONE caller, so when every replica runs the
      // sweeper each overdue order is handled once.
      if ((await redis.zRem(this.pendingKey, id)) === 1) claimed.push(id);
    }
    return claimed;
  }
}

export function createOrderRepository(): OrderRepository {
  if (config.sqlConnectionString && config.sqlConnectionString !== "dummy-local-connection") {
    // <<< REPLACE ME >>> An Azure SQL implementation goes here. Orders are the
    // relational, must-be-durable half of this file; Redis is the pragmatic
    // local choice, not the final destination for them.
    logger.warn("SQL_CONNECTION_STRING is set but no SQL repository is implemented yet; using Redis/in-memory store");
  }

  // Redis when configured (every deployed replica), in-memory otherwise (tests).
  if (config.redisUrl) {
    return new RedisOrderRepository();
  }

  // Reaching here with more than one replica is the bug this file was changed to
  // fix: each pod would keep its own carts and half of all checkouts would fail.
  logger.warn("REDIS_URL is not set; using in-memory store (safe ONLY with a single replica)");
  return new InMemoryOrderRepository();
}
