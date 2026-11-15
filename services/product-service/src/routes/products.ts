/**
 * Catalog API — section 6 of the guide:
 *   GET  /products             list, with category filter and pagination
 *   GET  /products/:id         a single product
 *   GET  /search?q=            free-text search
 *   GET  /categories           distinct categories with item counts
 *   GET  /products/:id/reviews list a product's reviews
 *   POST /products/:id/reviews add a review (requires auth)
 *
 * Catalog reads and review reads are public: anonymous shoppers browse the
 * catalog and read what others thought of it. Posting a review is the one
 * write this service accepts, and it needs a real identity — otherwise
 * ratings are trivially fakeable.
 */
import { Router } from "express";
import { config } from "../config";
import { conflict, notFound } from "../errors";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import type { Product, ProductRepository } from "../repository/productRepository";
import type { StockStore } from "../repository/stockStore";
import type { RatingStats, ReviewRepository } from "../repository/reviewRepository";
import { productId, validate, z } from "../validation";

const ZERO_STATS: RatingStats = { average: 0, count: 0 };
const MAX_COMMENT_LENGTH = 1000;

/**
 * Query strings are attacker-controlled, so every value is coerced, bounded,
 * and defaulted — `?limit=99999999` must not become a request for the entire
 * container, and `?limit=1&limit=2` (an ARRAY) must not reach the repository.
 */
const paging = {
  limit: z.coerce
    .number({ invalid_type_error: "must be a number" })
    .int("must be a whole number")
    .min(1, `must be between 1 and ${config.maxPageSize}`)
    .max(config.maxPageSize, `must be between 1 and ${config.maxPageSize}`)
    .default(20),
  offset: z.coerce.number({ invalid_type_error: "must be a number" }).int("must be a whole number").min(0, "must be 0 or more").default(0)
};

const listQuery = z.object({
  ...paging,
  category: z.string({ invalid_type_error: "must be a single value" }).trim().max(64).optional()
});

const searchQuery = z.object({
  ...paging,
  q: z
    .string({ required_error: "is required", invalid_type_error: "must be a single value" })
    .trim()
    .min(1, "is required")
    .max(100, "must be at most 100 characters")
});

const productParams = z.object({ id: productId });

const reviewBody = z.object({
  rating: z
    .number({ required_error: "is required", invalid_type_error: "must be a number" })
    .int("must be a whole number")
    .min(1, "must be between 1 and 5")
    .max(5, "must be between 1 and 5"),
  comment: z
    .string({ required_error: "is required", invalid_type_error: "must be a string" })
    .trim()
    .min(1, "is required")
    .max(MAX_COMMENT_LENGTH, `must be at most ${MAX_COMMENT_LENGTH} characters`)
});

export function createProductsRouter(
  repository: ProductRepository,
  reviewRepository: ReviewRepository,
  stockStore: StockStore
): Router {
  const router = Router();

  /**
   * Stock on every product response comes from the stock store (P1.1), not the
   * catalogue record — otherwise the shop would keep showing "12 left" while
   * reservations sold them. One MGET per response, however many products.
   */
  async function withLiveStock<T extends Product>(items: T[]): Promise<T[]> {
    const levels = await stockStore.levels(items.map((p) => p.id));
    return items.map((p) => ({ ...p, stock: levels.get(p.id) ?? p.stock }));
  }

  router.get("/products", validate({ query: listQuery }), async (req, res, next) => {
    try {
      const { limit, offset, category } = req.query as unknown as z.infer<typeof listQuery>;

      const page = await repository.list({ category, limit, offset });
      const stats = await reviewRepository.statsForProducts(page.items.map((p) => p.id));

      res.json({
        ...page,
        items: (await withLiveStock(page.items)).map((p) => ({ ...p, rating: stats.get(p.id) ?? ZERO_STATS }))
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * NOTE the route order: /products/:id is declared AFTER /products, and
   * /search and /categories are separate paths entirely. If you ever add
   * /products/search, it must be registered BEFORE /products/:id or ":id"
   * will swallow it.
   */
  router.get("/products/:id", validate({ params: productParams }), async (req, res, next) => {
    try {
      const product = await repository.findById(req.params.id);
      if (!product) throw notFound(`No product with id '${req.params.id}'`);

      const [live] = await withLiveStock([product]);
      res.json({ ...live, rating: await reviewRepository.statsForProduct(product.id) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/search", validate({ query: searchQuery }), async (req, res, next) => {
    try {
      const { q, limit, offset } = req.query as unknown as z.infer<typeof searchQuery>;
      const page = await repository.list({ q, limit, offset });
      res.json({ ...page, items: await withLiveStock(page.items) });
    } catch (err) {
      next(err);
    }
  });

  /** Distinct categories with a count — drives the frontend's filter tabs
   *  from real data instead of it guessing categories from a product page. */
  router.get("/categories", async (_req, res, next) => {
    try {
      // maxPageSize is the largest single page this service will ever hand
      // back, which is exactly the bound we want here too — one query, no
      // separate "count everything" code path.
      const { items } = await repository.list({ limit: config.maxPageSize, offset: 0 });
      const counts = new Map<string, number>();
      for (const product of items) {
        counts.set(product.category, (counts.get(product.category) ?? 0) + 1);
      }

      res.json({
        items: [...counts.entries()]
          .map(([category, count]) => ({ category, count }))
          .sort((a, b) => a.category.localeCompare(b.category))
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/products/:id/reviews", validate({ params: productParams }), async (req, res, next) => {
    try {
      const product = await repository.findById(req.params.id);
      if (!product) throw notFound(`No product with id '${req.params.id}'`);

      res.json({ items: await reviewRepository.listForProduct(req.params.id) });
    } catch (err) {
      next(err);
    }
  });

  router.post(
    "/products/:id/reviews",
    requireAuth,
    validate({ params: productParams, body: reviewBody }),
    async (req, res, next) => {
      try {
        const product = await repository.findById(req.params.id);
        if (!product) throw notFound(`No product with id '${req.params.id}'`);

        const { rating, comment } = req.body as z.infer<typeof reviewBody>;

        const authReq = req as AuthenticatedRequest;
        const userId = authReq.user?.sub;
        if (!userId) throw new Error("Unauthorized request: missing user identity");

        // One review per shopper per product — otherwise a single caller can
        // stuff the average by posting the same 5-star review a thousand times.
        if (await reviewRepository.hasReviewed(req.params.id, userId)) {
          throw conflict("You have already reviewed this product");
        }

        const review = await reviewRepository.create({
          productId: req.params.id,
          userId,
          rating,
          comment
        });

        res.status(201).json(review);
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
