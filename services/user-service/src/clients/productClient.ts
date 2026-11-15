/**
 * HTTP client for product-service — same shape as order-service's client.
 *
 * The wishlist must know a product is real before saving it, and should be
 * able to show enough of the catalog entry (name, price, image) to render a
 * wishlist card without the frontend making a second round trip per item.
 */
import { config } from "../config";
import { logger } from "../logger";

export interface CatalogProduct {
  id: string;
  name: string;
  priceMinor: number;
  currency: string;
  imageUrl: string;
  stock: number;
}

export interface ProductClient {
  fetchProduct(id: string): Promise<CatalogProduct | null>;
}

/** Talks to the real product-service over the cluster network. */
export class HttpProductClient implements ProductClient {
  constructor(private readonly baseUrl: string) {}

  async fetchProduct(id: string): Promise<CatalogProduct | null> {
    // A TIMEOUT IS MANDATORY — see order-service's productClient.ts for why:
    // without one, a hung product-service would hang every wishlist request
    // here too.
    const response = await fetch(`${this.baseUrl}/products/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(config.httpTimeoutMs)
    });

    if (response.status === 404) return null;

    if (!response.ok) {
      throw new Error(`product-service returned ${response.status} for product ${id}`);
    }

    return (await response.json()) as CatalogProduct;
  }
}

/**
 * Offline stub used when PRODUCT_SERVICE_URL is empty — i.e. in unit tests
 * and when you run this service on its own. Mirrors the seed catalog.
 */
export class StubProductClient implements ProductClient {
  private readonly catalog: Record<string, CatalogProduct> = {
    "p-1001": {
      id: "p-1001",
      name: "Aether 14 Laptop",
      priceMinor: 8999900,
      currency: "INR",
      imageUrl: "https://images.unsplash.com/photo-1496181133206-80ce9b88a853",
      stock: 12
    },
    "p-1002": {
      id: "p-1002",
      name: "Nimbus Over-Ear Headphones",
      priceMinor: 1249900,
      currency: "INR",
      imageUrl: "https://images.unsplash.com/photo-1546435770-a3e426bf472b",
      stock: 87
    },
    "p-1003": {
      id: "p-1003",
      name: "Everyday T-Shirt",
      priceMinor: 79900,
      currency: "INR",
      imageUrl: "https://images.unsplash.com/photo-1521572163474-6864f9cf17ab",
      stock: 240
    }
  };

  async fetchProduct(id: string): Promise<CatalogProduct | null> {
    return this.catalog[id] ?? null;
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
