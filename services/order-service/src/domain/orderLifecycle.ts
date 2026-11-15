/**
 * Applies status changes to stored orders (P1.2) — the only code that writes a
 * new status. It combines:
 *   1. the rules      (orderStateMachine.assertTransition)
 *   2. the history    (who, when, why — appended to the order)
 *   3. the write      (compare-and-set, so concurrent changes cannot both win)
 *   4. side effects   (returning stock to product-service when goods never left)
 */
import { config } from "../config";
import { conflict } from "../errors";
import { logger } from "../logger";
import { orderTransitions, stockReleaseFailures } from "../metrics";
import type { ProductClient } from "../clients/productClient";
import type { Order, OrderRepository } from "../repository/orderRepository";
import { assertTransition, releasesStock, type Actor, type OrderStatus } from "./orderStateMachine";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class OrderLifecycle {
  constructor(
    private readonly repository: OrderRepository,
    private readonly products: ProductClient
  ) {}

  async change(order: Order, to: OrderStatus, actor: Actor, reason: string): Promise<Order> {
    assertTransition(order.status, to, actor);

    const at = new Date().toISOString();
    const next: Order = {
      ...order,
      status: to,
      updatedAt: at,
      paymentDueAt: to === "pending_payment" ? order.paymentDueAt : null,
      history: [...order.history, { from: order.status, to, at, actor, reason }]
    };

    const saved = await this.repository.transition(order.id, order.status, next);
    if (!saved) {
      // Someone else changed it between our read and our write.
      throw conflict("This order was updated by someone else just now; refresh and try again");
    }
    orderTransitions.inc({ from: order.status, to, actor });

    if (releasesStock(order.status, to) && order.reservationId) {
      await this.releaseStock(order.reservationId, `order ${to}: ${reason}`);
    }
    return saved;
  }

  /**
   * Until payments exist (P1.3, needs decision D1): confirm immediately and say
   * so in the history. If the stock reservation cannot be committed, the order
   * stays pending_payment and the overdue sweeper cancels it, returning the stock.
   */
  async confirmWithoutPayment(order: Order): Promise<Order> {
    if (config.paymentProvider !== "none" || !order.reservationId) return order;
    try {
      const outcome = await this.products.commit(order.reservationId);
      if (outcome !== "committed") {
        return await this.change(order, "cancelled", "system", `stock reservation ${outcome} before confirmation`);
      }
      return await this.change(order, "paid", "system", "auto-confirmed: no payment provider configured yet (P1.3)");
    } catch (err) {
      logger.error("order confirmation failed; left pending_payment for the sweeper", {
        orderId: order.id,
        reason: (err as Error).message
      });
      return order;
    }
  }

  /** Cancel orders whose payment never arrived, returning their stock. Safe on every replica. */
  async cancelOverdue(nowMs = Date.now()): Promise<number> {
    let cancelled = 0;
    for (const id of await this.repository.claimOverduePending(nowMs, 50)) {
      const order = await this.repository.findOrderById(id);
      if (!order || order.status !== "pending_payment") continue;
      try {
        await this.change(order, "cancelled", "system", "payment not completed in time");
        cancelled++;
      } catch (err) {
        logger.warn("could not cancel overdue order", { orderId: id, reason: (err as Error).message });
      }
    }
    return cancelled;
  }

  /**
   * Returning stock must not be lost to a single network blip: a cancelled order
   * whose stock never came back makes the product look sold out for good. Three
   * tries with backoff; a final failure is logged and counted for an alert.
   * (The transactional outbox, P1.4, makes this fully reliable.)
   */
  private async releaseStock(reservationId: string, reason: string): Promise<void> {
    for (const [attempt, delay] of [0, 200, 800].entries()) {
      if (delay) await sleep(delay);
      try {
        await this.products.release(reservationId, reason);
        return;
      } catch (err) {
        logger.warn("stock release failed", { reservationId, attempt: attempt + 1, reason: (err as Error).message });
      }
    }
    stockReleaseFailures.inc();
    logger.error("stock release gave up; units are missing from the shelf", { reservationId });
  }
}
