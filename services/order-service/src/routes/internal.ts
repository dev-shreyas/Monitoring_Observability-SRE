/**
 * Internal order API — operators and other services, never browsers.
 *
 *   GET  /internal/orders/:id                 any order (not scoped to a user)
 *   POST /internal/orders/:id/transitions     { to, reason } as actor "admin"
 *
 * This is how an order moves through fulfilment (packed -> shipped -> delivered)
 * until the admin APIs and roles of Phase 3 exist. The state machine still
 * applies: an admin cannot move "delivered" back to "paid" either.
 */
import { Router } from "express";
import { notFound } from "../errors";
import { ORDER_STATUSES } from "../domain/orderStateMachine";
import type { OrderLifecycle } from "../domain/orderLifecycle";
import { requireInternalToken } from "../middleware/internalAuth";
import type { OrderRepository } from "../repository/orderRepository";
import { validate, z } from "../validation";

const params = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "is not a valid order id") });
const body = z.object({
  to: z.enum(ORDER_STATUSES),
  reason: z.string().trim().min(1, "is required").max(200)
});

export function createInternalRouter(repository: OrderRepository, lifecycle: OrderLifecycle, token?: string): Router {
  const router = Router();
  router.use(requireInternalToken(token));

  router.get("/orders/:id", validate({ params }), async (req, res, next) => {
    try {
      const order = await repository.findOrderById(req.params.id);
      if (!order) throw notFound(`No order with id '${req.params.id}'`);
      res.json(order);
    } catch (err) {
      next(err);
    }
  });

  router.post("/orders/:id/transitions", validate({ params, body }), async (req, res, next) => {
    try {
      const { to, reason } = req.body as z.infer<typeof body>;
      const order = await repository.findOrderById(req.params.id);
      if (!order) throw notFound(`No order with id '${req.params.id}'`);
      res.json(await lifecycle.change(order, to, "admin", reason));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
