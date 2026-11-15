/**
 * Cart, checkout and orders — section 6 of the guide:
 *   GET  /cart              the caller's cart
 *   POST /cart              add an item
 *   POST /checkout          turn the cart into an order + publish an event
 *                           (honours an Idempotency-Key header — see below)
 *   GET  /orders            the caller's order history
 *   GET  /orders/:id        one order
 *   POST /orders/:id/cancel cancel an order that has not been packed yet
 *
 * Orders follow the lifecycle in domain/orderStateMachine.ts; GET /orders/:id
 * includes the full status history (who changed it, when, and why).
 *   GET  /coupons           active promotional codes
 *
 * EVERY route here requires a valid JWT. There is no such thing as an
 * anonymous cart in this design: the user id always comes from the token,
 * never from the request body.
 *
 * requireAuth is applied PER ROUTE, not via a blanket router.use(). A
 * blanket router.use(requireAuth) has no path filter, so — because this
 * router is mounted at app root — it would also run for any unmatched path
 * that falls through to it, turning an unauthenticated request to a
 * nonexistent route into a 401 instead of the 404 notFoundHandler is
 * supposed to give.
 */
import { createHash, randomUUID } from "node:crypto";
import { Router } from "express";
import { badRequest, conflict, notFound, unprocessable } from "../errors";
import { idempotencyOutcomes, orderTransitions } from "../metrics";
import { config } from "../config";
import { OrderLifecycle } from "../domain/orderLifecycle";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import type { ProductClient } from "../clients/productClient";
import {
  newOrderPlacedEvent,
  type OrderEventPublisher
} from "../messaging/orderEventPublisher";
import { calculateDiscountMinor, type CouponRepository } from "../repository/couponRepository";
import type { IdempotencyStore } from "../repository/idempotencyStore";
import type { Order, OrderLine, OrderRepository } from "../repository/orderRepository";
import { productId, validate, z } from "../validation";

export interface OrdersRouterDeps {
  repository: OrderRepository;
  productClient: ProductClient;
  publisher: OrderEventPublisher;
  couponRepository: CouponRepository;
  idempotency: IdempotencyStore;
  lifecycle?: OrderLifecycle;
}

/** Guard against a typo'd quantity becoming a million-unit order. */
const MAX_QUANTITY_PER_LINE = 100;

const addToCartBody = z.object({
  productId,
  quantity: z
    .number({ required_error: "is required", invalid_type_error: "must be a number" })
    .int("must be a whole number")
    .min(1, `must be between 1 and ${MAX_QUANTITY_PER_LINE}`)
    .max(MAX_QUANTITY_PER_LINE, `must be between 1 and ${MAX_QUANTITY_PER_LINE}`)
});

const checkoutBody = z.object({
  // Empty string means "no coupon" (the frontend sends what is in the box).
  couponCode: z.string({ invalid_type_error: "must be a string" }).trim().max(32, "is too long").optional()
});

const orderParams = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "is not a valid order id")
});

/** Long enough to be unguessable, short enough to be a sane Redis key. UUIDs fit. */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;

export function createOrdersRouter(deps: OrdersRouterDeps): Router {
  const { repository, productClient, publisher, couponRepository, idempotency } = deps;
  const lifecycle = deps.lifecycle ?? new OrderLifecycle(repository, productClient);
  const router = Router();

  router.get("/coupons", requireAuth, async (_req, res, next) => {
    try {
      res.json({ items: await couponRepository.listActive() });
    } catch (err) {
      next(err);
    }
  });

  router.get("/cart", requireAuth, async (req, res, next) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user?.sub;
      if (!userId) throw new Error("Unauthorized request: missing user identity");
      res.json({ items: await repository.getCart(userId) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/cart", requireAuth, validate({ body: addToCartBody }), async (req, res, next) => {
    try {
      const { productId, quantity } = req.body as z.infer<typeof addToCartBody>;

      // Validate the product EXISTS before it enters the cart, so the shopper
      // finds out now rather than at checkout.
      const product = await productClient.fetchProduct(productId);
      if (!product) throw notFound(`No product with id '${productId}'`);

      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user?.sub;
      if (!userId) throw new Error("Unauthorized request: missing user identity");

      res.status(201).json({ items: await repository.addToCart(userId, { productId, quantity }) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * The checkout itself. Kept as a plain function so the idempotency wrapper in
   * the route below reads clearly: claim the key -> placeOrder -> store result.
   */
  async function placeOrder(userId: string, couponCode: string | undefined): Promise<Order> {
    const cart = await repository.getCart(userId);

    if (cart.length === 0) throw badRequest("Cart is empty");

    const lines: OrderLine[] = [];
    let subtotalMinor = 0;
    let currency = "INR";

    /**
     * Price the cart from the CATALOG, never from anything the client sent.
     * Stock is NOT checked here any more: reading a level and acting on it later
     * is exactly the race that oversold. The reservation below is the check.
     */
    for (const item of cart) {
      const product = await productClient.fetchProduct(item.productId);
      if (!product) throw conflict(`Product '${item.productId}' is no longer available`);

      lines.push({
        productId: product.id,
        name: product.name,
        quantity: item.quantity,
        unitPriceMinor: product.priceMinor
      });

      // Integer arithmetic throughout — no floating point money.
      subtotalMinor += product.priceMinor * item.quantity;
      currency = product.currency;
    }

    let discountMinor = 0;
    let appliedCouponCode: string | null = null;

    // An empty string means "no coupon", not "an invalid coupon" — treat
    // it the same as omitting couponCode entirely.
    if (couponCode && couponCode.trim().length > 0) {
      const coupon = await couponRepository.findActiveByCode(couponCode);
      if (!coupon) throw badRequest(`Unknown or inactive coupon code '${couponCode}'`);

      discountMinor = calculateDiscountMinor(coupon, subtotalMinor);
      appliedCouponCode = coupon.code;
    }

    /**
     * RESERVE STOCK (P1.1) — atomically, all lines or none, in product-service.
     * The order id doubles as the reservation id, so a retried checkout (same
     * Idempotency-Key -> same flow) can never reserve twice for one order.
     */
    const orderId = randomUUID();
    let reservation: Awaited<ReturnType<ProductClient["reserve"]>>;
    try {
      reservation = await productClient.reserve(
        orderId,
        lines.map((l) => ({ productId: l.productId, quantity: l.quantity }))
      );
    } catch (err) {
      // A timeout does not mean it failed: product-service may have reserved
      // and only the answer was slow. Release under the same id (idempotent) so
      // the units are not held until the reservation's 20-minute expiry.
      void productClient.release(orderId, "reserve call failed or timed out").catch(() => undefined);
      throw err;
    }
    // 409 Conflict: the request was valid, the world changed under it.
    if (!reservation.ok) throw conflict(reservation.message);

    let order: Order;
    try {
      const now = Date.now();
      order = await repository.createOrder({
        id: orderId,
        userId,
        status: "pending_payment",
        lines,
        subtotalMinor,
        discountMinor,
        couponCode: appliedCouponCode,
        totalMinor: subtotalMinor - discountMinor,
        currency,
        reservationId: orderId,
        paymentDueAt: new Date(now + config.pendingPaymentTtlSeconds * 1000).toISOString(),
        history: [
          { from: null, to: "pending_payment", at: new Date(now).toISOString(), actor: "customer", reason: "checkout" }
        ]
      });
    } catch (err) {
      // No order means nobody will ever confirm this stock: give it back now
      // rather than waiting for the reservation to expire.
      await productClient.release(orderId, "order could not be saved").catch(() => undefined);
      throw err;
    }
    orderTransitions.inc({ from: "", to: "pending_payment", actor: "customer" });

    // The cart is consumed once the order exists.
    await repository.clearCart(userId);

    order = await lifecycle.confirmWithoutPayment(order);

    /**
     * Publish AFTER the order is safely persisted. If we published first
     * and then failed to save, downstream consumers would act on an order
     * that does not exist.
     *
     * Note this is not yet transactional — a crash between the write and
     * the publish loses the event. The production fix is the transactional
     * outbox pattern: write the event into the same SQL transaction as the
     * order, and have a separate relay publish it.
     */
    await publisher.publish(
      newOrderPlacedEvent({
        orderId: order.id,
        userId,
        totalMinor: order.totalMinor,
        currency: order.currency,
        items: lines.map((l) => ({
          productId: l.productId,
          quantity: l.quantity,
          unitPriceMinor: l.unitPriceMinor
        }))
      })
    );

    return order;
  }

  router.post("/checkout", requireAuth, validate({ body: checkoutBody }), async (req, res, next) => {
    let claimedKey: string | null = null;
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user?.sub;
      if (!userId) throw new Error("Unauthorized request: missing user identity");
      const { couponCode } = req.body as z.infer<typeof checkoutBody>;

      const rawKey = req.get("Idempotency-Key");
      if (rawKey === undefined) {
        // Optional for backwards compatibility (older clients, curl). The
        // frontend always sends one.
        const order = await placeOrder(userId, couponCode);
        res.status(201).json(order);
        return;
      }
      if (!IDEMPOTENCY_KEY.test(rawKey)) {
        throw badRequest("'Idempotency-Key' must be 8-128 letters, digits, '-' or '_'");
      }

      // Per-user scope: the same key from two shoppers is two different keys.
      const key = `idem:checkout:${userId}:${rawKey}`;
      // The fingerprint pins the key to one request body.
      const fingerprint = createHash("sha256")
        .update(JSON.stringify({ couponCode: couponCode ?? "" }))
        .digest("hex");

      const existing = await idempotency.begin(key, fingerprint);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          idempotencyOutcomes.inc({ outcome: "mismatch" });
          throw unprocessable("This Idempotency-Key was already used for a different checkout request");
        }
        if (existing.state === "processing") {
          idempotencyOutcomes.inc({ outcome: "in_progress" });
          throw conflict("This checkout is already being processed; retry shortly", 1);
        }
        idempotencyOutcomes.inc({ outcome: "replayed" });
        res.setHeader("Idempotent-Replayed", "true");
        res.status(existing.status).json(existing.body);
        return;
      }

      claimedKey = key;
      idempotencyOutcomes.inc({ outcome: "processed" });
      const order = await placeOrder(userId, couponCode);
      await idempotency.complete(key, { fingerprint, status: 201, body: order });
      claimedKey = null;
      res.status(201).json(order);
    } catch (err) {
      // Failed (empty cart, out of stock, product-service down...): release the
      // claim so the shopper can fix the problem and retry with the same key.
      // Only successes are remembered.
      if (claimedKey) {
        await idempotency.abandon(claimedKey).catch(() => undefined);
      }
      next(err);
    }
  });

  router.get("/orders", requireAuth, async (req, res, next) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user?.sub;
      if (!userId) throw new Error("Unauthorized request: missing user identity");
      res.json({ items: await repository.listOrders(userId) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/orders/:id", requireAuth, validate({ params: orderParams }), async (req, res, next) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user?.sub;
      if (!userId) throw new Error("Unauthorized request: missing user identity");
      const order = await repository.findOrder(userId, req.params.id);
      // A 404 (not a 403) for someone else's order: do not confirm it exists.
      if (!order) throw notFound(`No order with id '${req.params.id}'`);

      res.json(order);
    } catch (err) {
      next(err);
    }
  });

  router.post("/orders/:id/cancel", requireAuth, validate({ params: orderParams }), async (req, res, next) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user?.sub;
      if (!userId) throw new Error("Unauthorized request: missing user identity");

      const order = await repository.findOrder(userId, req.params.id);
      if (!order) throw notFound(`No order with id '${req.params.id}'`);

      // The state machine decides: a customer may cancel before the order is
      // packed. After that it is a return (P7.5), not a cancellation. Cancelling
      // puts the order's stock back on the shelf.
      res.json(await lifecycle.change(order, "cancelled", "customer", "cancelled by customer"));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
