/**
 * Same structure as user-service's app.ts (read that one for the full
 * explanation of middleware ordering) — only the routes differ.
 */
import express from "express";
import helmet from "helmet";
import { config } from "./config";
import { errorHandler, notFoundHandler } from "./errors";
import { metricsMiddleware, registry } from "./metrics";
import { requestLogger } from "./middleware/requestLogger";
import { createProductRepository, SEED_STOCK, type ProductRepository } from "./repository/productRepository";
import { createStockStore, type StockStore } from "./repository/stockStore";
import { createReviewRepository, type ReviewRepository } from "./repository/reviewRepository";
import { healthRouter } from "./routes/health";
import { createInternalRouter } from "./routes/internal";
import { createProductsRouter } from "./routes/products";

export function createApp(
  repository: ProductRepository = createProductRepository(),
  reviewRepository: ReviewRepository = createReviewRepository(),
  stockStore: StockStore = createStockStore(SEED_STOCK)
) {
  const app = express();

  app.set("trust proxy", true);
  // JSON-only API: the strictest CSP (load nothing, never framed). See user-service app.ts.
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }
    })
  );
  app.use(express.json({ limit: "100kb" }));
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Origin, X-Requested-With, Accept");

    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }

    next();
  });
  app.use(metricsMiddleware);
  app.use(requestLogger);

  app.use(healthRouter);

  app.get("/metrics", async (_req, res, next) => {
    try {
      res.set("Content-Type", registry.contentType);
      res.send(await registry.metrics());
    } catch (err) {
      next(err);
    }
  });

  // Internal first: its token guard must run before anything public could match.
  app.use("/internal", createInternalRouter(repository, stockStore));
  app.use(createProductsRouter(repository, reviewRepository, stockStore));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/** The process-wide stock store, shared with the expiry sweeper in index.ts. */
export const stockStore = createStockStore(SEED_STOCK);
const app = createApp(undefined, undefined, stockStore);
export default app;
export { config };
