/**
 * The order lifecycle (P1.2) — the ONE place that decides which status changes
 * are legal and who may make them.
 *
 *   pending_payment ──► paid ──► packed ──► shipped ──► delivered
 *         │              │         │                       │
 *         └──► cancelled ◄┘◄────────┘                       │
 *                         paid ──► refunded ◄───────────────┘
 *
 * Before this, `status` was a free-form field: any code path could write any
 * value, "paid"/"shipped" existed only as type names, and nothing stopped an
 * order going from "delivered" back to "paid". Now every change goes through
 * assertTransition(), and every change is recorded (who, when, why).
 *
 * WHO may do what:
 *   customer  cancel their own order before it is packed
 *   system    confirm payment; cancel an order whose payment never arrived
 *   admin     fulfilment (pack, ship, deliver), late cancellation, refunds
 */
import { AppError } from "../errors";

export const ORDER_STATUSES = [
  "pending_payment",
  "paid",
  "packed",
  "shipped",
  "delivered",
  "cancelled",
  "refunded"
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type Actor = "customer" | "system" | "admin";

export interface StatusChange {
  from: OrderStatus | null;
  to: OrderStatus;
  at: string;
  actor: Actor;
  reason: string;
}

const RULES: Record<OrderStatus, Partial<Record<OrderStatus, readonly Actor[]>>> = {
  pending_payment: { paid: ["system"], cancelled: ["customer", "system", "admin"] },
  paid: { packed: ["admin"], cancelled: ["customer", "admin"], refunded: ["admin"] },
  packed: { shipped: ["admin"], cancelled: ["admin"] },
  shipped: { delivered: ["admin"] },
  delivered: { refunded: ["admin"] },
  cancelled: {},
  refunded: {}
};

export function allowedNext(from: OrderStatus, actor: Actor): OrderStatus[] {
  return (Object.entries(RULES[from]) as [OrderStatus, readonly Actor[]][])
    .filter(([, actors]) => actors.includes(actor))
    .map(([to]) => to);
}

/** 409 for a move the lifecycle never allows; 403 for a legal move by the wrong actor. */
export function assertTransition(from: OrderStatus, to: OrderStatus, actor: Actor): void {
  const actors = RULES[from][to];
  if (!actors) {
    throw new AppError(409, `Order cannot move from '${from}' to '${to}'`, "illegal_transition");
  }
  if (!actors.includes(actor)) {
    throw new AppError(403, `A ${actor} cannot move an order from '${from}' to '${to}'`, "forbidden_transition");
  }
}

/**
 * Does this change put the order's stock back on the shelf? Yes when the goods
 * never left: cancelling, or refunding before shipping. A refund AFTER delivery
 * does not — the goods are with the customer; restocking returns is P7.5.
 */
export function releasesStock(from: OrderStatus, to: OrderStatus): boolean {
  if (to === "cancelled") return true;
  return to === "refunded" && from === "paid";
}
