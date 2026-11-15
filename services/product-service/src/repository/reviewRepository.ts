/**
 * Product reviews & ratings — a separate aggregate from the catalog itself,
 * so the read-heavy product list never has to join against it. Same seam
 * pattern as productRepository.ts: an in-memory store today, a Cosmos
 * container (partitioned by productId) later.
 */
import { randomUUID } from "node:crypto";
import { config } from "../config";
import { logger } from "../logger";

export interface Review {
  id: string;
  productId: string;
  userId: string;
  rating: number; // 1-5, integer
  comment: string;
  createdAt: string;
}

export interface RatingStats {
  average: number;
  count: number;
}

export interface ReviewRepository {
  listForProduct(productId: string): Promise<Review[]>;
  hasReviewed(productId: string, userId: string): Promise<boolean>;
  create(input: { productId: string; userId: string; rating: number; comment: string }): Promise<Review>;
  statsForProduct(productId: string): Promise<RatingStats>;
  /** Bulk stats for a page of products, so listing the catalog stays O(1) roundtrips. */
  statsForProducts(productIds: string[]): Promise<Map<string, RatingStats>>;
}

const ZERO_STATS: RatingStats = { average: 0, count: 0 };

export class InMemoryReviewRepository implements ReviewRepository {
  private readonly reviews: Review[] = [];

  async listForProduct(productId: string): Promise<Review[]> {
    return this.reviews
      .filter((r) => r.productId === productId)
      // Newest first, same convention as order history.
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async hasReviewed(productId: string, userId: string): Promise<boolean> {
    return this.reviews.some((r) => r.productId === productId && r.userId === userId);
  }

  async create(input: { productId: string; userId: string; rating: number; comment: string }): Promise<Review> {
    const review: Review = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    this.reviews.push(review);
    return review;
  }

  async statsForProduct(productId: string): Promise<RatingStats> {
    const forProduct = this.reviews.filter((r) => r.productId === productId);
    if (forProduct.length === 0) return ZERO_STATS;

    const total = forProduct.reduce((sum, r) => sum + r.rating, 0);
    // Round to one decimal — "4.3" reads better than "4.333333333333333".
    return { average: Math.round((total / forProduct.length) * 10) / 10, count: forProduct.length };
  }

  async statsForProducts(productIds: string[]): Promise<Map<string, RatingStats>> {
    const map = new Map<string, RatingStats>();
    for (const id of productIds) {
      map.set(id, await this.statsForProduct(id));
    }
    return map;
  }
}

export function createReviewRepository(): ReviewRepository {
  if (config.cosmos.endpoint) {
    // <<< REPLACE ME >>> A Cosmos implementation goes here, same seam as
    // productRepository.ts — likely its own container partitioned by productId.
    logger.warn("COSMOS_ENDPOINT is set but no Cosmos review repository is implemented yet; using in-memory reviews");
  }
  return new InMemoryReviewRepository();
}
