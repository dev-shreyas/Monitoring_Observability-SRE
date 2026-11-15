/**
 * Builds the Express application and exports it — but does NOT listen on a
 * port. That separation is the whole point of this file:
 *
 *   app.ts   = the application (routes + middleware)   -> importable by tests
 *   index.ts = the process (port, signals, shutdown)   -> the container's CMD
 *
 * Because of it, supertest can drive the API in-process with no real socket,
 * which is exactly what the guide's test snippet assumes when it writes
 * `const app = require("../src/app")`.
 *
 * MIDDLEWARE ORDER MATTERS. Express runs these top to bottom:
 *   1. body parser      — so handlers see req.body
 *   2. metrics          — starts its timer before any work happens
 *   3. request logger   — same reason
 *   4. /health, /metrics — open, no auth, no logging noise
 *   5. business routes  — the real API
 *   6. 404 handler      — reached only when nothing above matched
 *   7. error handler    — four-arg, must be dead last
 */
import express from "express";
import helmet from "helmet";
import { config } from "./config";
import { errorHandler, notFoundHandler } from "./errors";
import { metricsMiddleware, registry } from "./metrics";
import { requestLogger } from "./middleware/requestLogger";
import { createProductClient, type ProductClient } from "./clients/productClient";
import { createUserRepository, type UserRepository } from "./repository/userRepository";
import { createWishlistRepository, type WishlistRepository } from "./repository/wishlistRepository";
import { createCounterStore, type CounterStore } from "./security/rateLimiter";
import { healthRouter } from "./routes/health";
import { createUsersRouter, type RateLimitSettings } from "./routes/users";
import { createWishlistRouter } from "./routes/wishlist";

export interface AppDeps {
  repository?: UserRepository;
  wishlistRepository?: WishlistRepository;
  productClient?: ProductClient;
  counters?: CounterStore;
  rateLimit?: Partial<RateLimitSettings>;
}

export function createApp(deps: AppDeps = {}) {
  const repository = deps.repository ?? createUserRepository();
  const wishlistRepository = deps.wishlistRepository ?? createWishlistRepository();
  const productClient = deps.productClient ?? createProductClient();
  const counters = deps.counters ?? createCounterStore();
  const app = express();

  // Behind Azure Front Door -> APIM -> NGINX ingress there are several proxies
  // in front of us. This makes req.ip and req.protocol reflect the ORIGINAL
  // client from the X-Forwarded-* headers instead of the last proxy hop.
  app.set("trust proxy", true);

  // Security headers. This service only ever returns JSON, so the CSP is the
  // strictest possible: a response from here may load nothing and be framed by
  // nothing. nosniff stops a browser treating a JSON error as HTML.
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }
    })
  );

  // Refuse absurd bodies early — a cheap denial-of-service guard.
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

  // Prometheus scrape target. Content-Type must be exactly what the client
  // library says, or the scraper will not parse the payload.
  app.get("/metrics", async (_req, res, next) => {
    try {
      res.set("Content-Type", registry.contentType);
      res.send(await registry.metrics());
    } catch (err) {
      next(err);
    }
  });

  // Business routes mounted at the root, matching the paths in section 6.
  // The NGINX ingress strips the /users prefix before traffic reaches us.
  app.use(createUsersRouter({ repository, counters, rateLimit: deps.rateLimit }));
  app.use(createWishlistRouter({ repository: wishlistRepository, productClient }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/** Default export: a ready-to-use app with the real repository wired in. */
const app = createApp();
export default app;
export { config };
