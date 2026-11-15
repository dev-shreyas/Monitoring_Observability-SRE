/**
 * HTTP client for product-service — the sync half of the architecture.
 *
 * Checkout must know the CURRENT price and stock. Trusting a price sent by
 * the browser would let anyone buy a laptop for ₹1, so the price is always
 * re-fetched from the owning service at checkout time.
 */
import { config } from "../config";
import { logger } from "../logger";

export interface CatalogProduct {
  id: string;
  name: string;
  priceMinor: number;
  currency: string;
  stock: number;
}

export interface ReservationLine {
  productId: string;
  quantity: number;
}

export type ReserveOutcome = { ok: true } | { ok: false; message: string };
export type CommitOutcome = "committed" | "released" | "missing";

export interface ProductClient {
  fetchProduct(id: string): Promise<CatalogProduct | null>;
  /** P1.1: take stock for an order — all lines or none. Idempotent per reservationId. */
  reserve(reservationId: string, lines: ReservationLine[]): Promise<ReserveOutcome>;
  /** The order is confirmed: the reserved stock is sold. */
  commit(reservationId: string): Promise<CommitOutcome>;
  /** The order is cancelled/expired: put the stock back. Idempotent. */
  release(reservationId: string, reason: string): Promise<void>;
}

/** Talks to the real product-service over the cluster network. */
export class HttpProductClient implements ProductClient {
  constructor(private readonly baseUrl: string) {}

  async fetchProduct(id: string): Promise<CatalogProduct | null> {
    /**
     * A TIMEOUT IS MANDATORY. Without it, product-service hanging would make
     * every checkout request here hang too, exhaust our connections, fail our
     * readiness probe, and take order-service down with it — a cascading
     * failure. AbortSignal.timeout is built into Node 20's fetch.
     */
    const response = await fetch(`${this.baseUrl}/products/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(config.httpTimeoutMs)
    });

    if (response.status === 404) return null;

    if (!response.ok) {
      // Surface it as a real error so checkout fails loudly rather than
      // silently pricing an item at zero.
      throw new Error(`product-service returned ${response.status} for product ${id}`);
    }

    return (await response.json()) as CatalogProduct;
  }

  private internal(path: string, body: unknown): Promise<Response> {
    return fetch(`${this.baseUrl}/internal${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Token": config.internalApiToken },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.httpTimeoutMs)
    });
  }

  async reserve(reservationId: string, lines: ReservationLine[]): Promise<ReserveOutcome> {
    const response = await this.internal("/reservations", { reservationId, items: lines });
    if (response.ok) return { ok: true };
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    if (response.status === 409) return { ok: false, message: body.message ?? "Not enough stock" };
    throw new Error(`product-service reserve returned ${response.status}: ${body.message ?? ""}`);
  }

  async commit(reservationId: string): Promise<CommitOutcome> {
    const response = await this.internal(`/reservations/${encodeURIComponent(reservationId)}/commit`, {});
    if (response.ok) return "committed";
    if (response.status === 409) return "released";
    if (response.status === 404) return "missing";
    throw new Error(`product-service commit returned ${response.status}`);
  }

  async release(reservationId: string, reason: string): Promise<void> {
    const response = await this.internal(`/reservations/${encodeURIComponent(reservationId)}/release`, { reason });
    // 404 = nothing was reserved under this id — nothing to give back.
    if (!response.ok && response.status !== 404) {
      throw new Error(`product-service release returned ${response.status}`);
    }
  }
}

/**
 * Offline stub used when PRODUCT_SERVICE_URL is empty — i.e. in unit tests and
 * when you run this service on its own. Mirrors the seed catalog.
 */
export class StubProductClient implements ProductClient {
  private readonly catalog: Record<string, CatalogProduct> = {
    "p-1001": { id: "p-1001", name: "Aether 14 Laptop",               priceMinor: 8999900, currency: "INR", stock: 12 },
    "p-1002": { id: "p-1002", name: "Nimbus Over-Ear Headphones",     priceMinor: 1249900, currency: "INR", stock: 87 },
    "p-1003": { id: "p-1003", name: "Everyday T-Shirt",               priceMinor:   79900, currency: "INR", stock: 240 },
    "p-1004": { id: "p-1004", name: "Ceramic Mug 350ml",              priceMinor:   49900, currency: "INR", stock: 0 },
    "p-1005": { id: "p-1005", name: "Tenkeyless Mechanical Keyboard", priceMinor:  649900, currency: "INR", stock: 34 },
    "p-1006": { id: "p-1006", name: "The DevOps Handbook",            priceMinor:  129900, currency: "INR", stock: 56 }
  };

  private readonly reservations = new Map<string, { state: "held" | "committed" | "released"; lines: ReservationLine[] }>();

  async fetchProduct(id: string): Promise<CatalogProduct | null> {
    const product = this.catalog[id];
    return product ? { ...product } : null;
  }

  /** Same semantics as product-service's stock store, in memory, for tests. */
  async reserve(reservationId: string, lines: ReservationLine[]): Promise<ReserveOutcome> {
    if (this.reservations.has(reservationId)) return { ok: true };
    for (const line of lines) {
      const product = this.catalog[line.productId];
      if (!product || product.stock < line.quantity) {
        return { ok: false, message: `Only ${product?.stock ?? 0} of '${product?.name ?? line.productId}' left in stock` };
      }
    }
    for (const line of lines) this.catalog[line.productId]!.stock -= line.quantity;
    this.reservations.set(reservationId, { state: "held", lines });
    return { ok: true };
  }

  async commit(reservationId: string): Promise<CommitOutcome> {
    const r = this.reservations.get(reservationId);
    if (!r) return "missing";
    if (r.state === "held") r.state = "committed";
    return r.state === "committed" ? "committed" : "released";
  }

  async release(reservationId: string, _reason: string): Promise<void> {
    const r = this.reservations.get(reservationId);
    if (!r || r.state === "released") return;
    for (const line of r.lines) this.catalog[line.productId]!.stock += line.quantity;
    r.state = "released";
  }

  /** Test helpers. */
  stockOf(id: string): number {
    return this.catalog[id]?.stock ?? 0;
  }
  setStock(id: string, units: number): void {
    if (this.catalog[id]) this.catalog[id]!.stock = units;
  }
}

/**
 * FAIL CLOSED on a missing URL in production.
 *
 * The stub is a convenience for tests and standalone runs. Deployed, it is a
 * silent disaster: one forgotten env var and the service keeps answering 200,
 * but from a hard-coded six-product catalogue — prices and stock that no longer
 * match the real catalogue, accepted as truth. Crashing at startup turns that
 * into a failed rollout (the old pods keep serving) instead of wrong orders.
 */
export function createProductClient(
  opts: { url?: string; nodeEnv?: string } = {}
): ProductClient {
  const url = opts.url ?? config.productServiceUrl;
  const nodeEnv = opts.nodeEnv ?? config.nodeEnv;

  if (!url) {
    if (nodeEnv === "production") {
      throw new Error(
        "PRODUCT_SERVICE_URL is not set; refusing to start in production with the offline stub catalog"
      );
    }
    logger.warn("PRODUCT_SERVICE_URL is not set; using the offline stub catalog (non-production only)");
    return new StubProductClient();
  }
  return new HttpProductClient(url);
}
