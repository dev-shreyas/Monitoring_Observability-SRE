/**
 * Same structure as the other two services. The difference: this app has
 * three collaborators wired in (storage, the product client and the event
 * publisher), all injectable so tests can substitute fakes.
 */
import express from "express";
import helmet from "helmet";
import { config } from "./config";
import { errorHandler, notFoundHandler } from "./errors";
import { metricsMiddleware, registry } from "./metrics";
import { requestLogger } from "./middleware/requestLogger";
import { createProductClient, type ProductClient } from "./clients/productClient";
import { createOrderEventPublisher, type OrderEventPublisher } from "./messaging/orderEventPublisher";
import { createCouponRepository, type CouponRepository } from "./repository/couponRepository";
import { createIdempotencyStore, type IdempotencyStore } from "./repository/idempotencyStore";
import { createOrderRepository, type OrderRepository } from "./repository/orderRepository";
import { healthRouter } from "./routes/health";
import { createOrdersRouter } from "./routes/orders";
import { createInternalRouter } from "./routes/internal";
import { OrderLifecycle } from "./domain/orderLifecycle";

export interface AppDeps {
  repository?: OrderRepository;
  productClient?: ProductClient;
  publisher?: OrderEventPublisher;
  couponRepository?: CouponRepository;
  idempotency?: IdempotencyStore;
  lifecycle?: OrderLifecycle;
}

export function createApp(deps: AppDeps = {}) {
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
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Origin, X-Requested-With, Accept, Idempotency-Key");

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

  const repository = deps.repository ?? createOrderRepository();
  const productClient = deps.productClient ?? createProductClient();
  const lifecycle = deps.lifecycle ?? new OrderLifecycle(repository, productClient);

  app.use("/internal", createInternalRouter(repository, lifecycle));
  app.use(
    createOrdersRouter({
      repository,
      productClient,
      publisher: deps.publisher ?? createOrderEventPublisher(),
      couponRepository: deps.couponRepository ?? createCouponRepository(),
      idempotency: deps.idempotency ?? createIdempotencyStore(),
      lifecycle
    })
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/** Shared with the overdue-payment sweeper in index.ts. */
export const lifecycle = new OrderLifecycle(createOrderRepository(), createProductClient());
const app = createApp({ lifecycle });
export default app;
export { config };
