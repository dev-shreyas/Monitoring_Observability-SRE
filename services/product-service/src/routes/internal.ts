/**
 * Internal inventory API (P1.1) — called by order-service, never by browsers.
 *
 *   POST /internal/reservations               reserve stock for an order (all lines or none)
 *   POST /internal/reservations/:id/commit    order confirmed: the stock is sold
 *   POST /internal/reservations/:id/release   order cancelled/expired: stock goes back
 *   PUT  /internal/stock/:productId           set a level (restock; admin tooling in P3.2)
 *
 * Every call is idempotent, because a network timeout leaves the caller unsure
 * whether it worked, and the only safe recovery is to send the same call again:
 *   - reserve with an existing id returns the existing reservation, takes nothing;
 *   - commit/release of an already committed/released reservation is a no-op.
 */
import { Router } from "express";
import { config } from "../config";
import { AppError, notFound } from "../errors";
import { reservationOutcomes } from "../metrics";
import { requireInternalToken } from "../middleware/internalAuth";
import type { ProductRepository } from "../repository/productRepository";
import type { StockStore } from "../repository/stockStore";
import { productId, validate, z } from "../validation";

const reservationId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "must be 8-64 letters, digits, '-' or '_'");

const reserveBody = z.object({
  reservationId,
  items: z
    .array(z.object({ productId, quantity: z.number().int().min(1).max(100) }))
    .min(1, "must contain at least one item")
    .max(50, "must contain at most 50 items")
});

const reservationParams = z.object({ id: reservationId });
const releaseBody = z.object({ reason: z.string().trim().max(200).default("released") });
const stockParams = z.object({ productId });
const stockBody = z.object({ quantity: z.number().int().min(0).max(1_000_000) });

export function createInternalRouter(products: ProductRepository, stock: StockStore, token?: string): Router {
  const router = Router();
  router.use(requireInternalToken(token));

  router.post("/reservations", validate({ body: reserveBody }), async (req, res, next) => {
    try {
      const { reservationId: id, items } = req.body as z.infer<typeof reserveBody>;

      // Unknown product ids are a 404, not "0 in stock".
      for (const item of items) {
        if (!(await products.findById(item.productId))) throw notFound(`No product with id '${item.productId}'`);
      }

      const result = await stock.reserve(id, items, config.reservationTtlSeconds);
      if (!result.ok) {
        reservationOutcomes.inc({ outcome: "out_of_stock" });
        const product = await products.findById(result.productId);
        throw new AppError(
          409,
          `Only ${result.available} of '${product?.name ?? result.productId}' left in stock`,
          "out_of_stock",
          [{ path: result.productId, message: `available: ${result.available}` }]
        );
      }
      if (result.created) reservationOutcomes.inc({ outcome: "held" });
      res.status(result.created ? 201 : 200).json({ reservationId: id, state: result.state });
    } catch (err) {
      next(err);
    }
  });

  router.post("/reservations/:id/commit", validate({ params: reservationParams }), async (req, res, next) => {
    try {
      const outcome = await stock.commit(req.params.id);
      if (outcome === "missing") throw notFound(`No reservation '${req.params.id}'`);
      if (outcome === "released") {
        // Too late: it expired (or was cancelled) and the stock went back.
        throw new AppError(409, "Reservation was already released", "reservation_released");
      }
      reservationOutcomes.inc({ outcome: "committed" });
      res.json({ reservationId: req.params.id, state: "committed" });
    } catch (err) {
      next(err);
    }
  });

  router.post(
    "/reservations/:id/release",
    validate({ params: reservationParams, body: releaseBody }),
    async (req, res, next) => {
      try {
        const { reason } = req.body as z.infer<typeof releaseBody>;
        const outcome = await stock.release(req.params.id, reason);
        if (outcome === "missing") throw notFound(`No reservation '${req.params.id}'`);
        if (outcome === "released_now") reservationOutcomes.inc({ outcome: "released" });
        res.json({ reservationId: req.params.id, state: "released" });
      } catch (err) {
        next(err);
      }
    }
  );

  router.put("/stock/:productId", validate({ params: stockParams, body: stockBody }), async (req, res, next) => {
    try {
      if (!(await products.findById(req.params.productId))) {
        throw notFound(`No product with id '${req.params.productId}'`);
      }
      const { quantity } = req.body as z.infer<typeof stockBody>;
      await stock.setLevel(req.params.productId, quantity);
      res.json({ productId: req.params.productId, stock: quantity });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
