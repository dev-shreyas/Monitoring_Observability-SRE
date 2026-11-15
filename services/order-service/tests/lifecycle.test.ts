/** P1.1 stock at checkout and P1.2 order lifecycle. */
import jwt from "jsonwebtoken";
import request from "supertest";
import { createApp } from "../src/app";
import { config, DEV_INTERNAL_TOKEN } from "../src/config";
import { StubProductClient } from "../src/clients/productClient";
import { OrderLifecycle } from "../src/domain/orderLifecycle";
import { allowedNext, assertTransition, releasesStock } from "../src/domain/orderStateMachine";
import { LoggingOrderEventPublisher } from "../src/messaging/orderEventPublisher";
import { InMemoryIdempotencyStore } from "../src/repository/idempotencyStore";
import { InMemoryOrderRepository, type Order } from "../src/repository/orderRepository";

const tokenFor = (sub: string) => `Bearer ${jwt.sign({ sub, email: `${sub}@example.com` }, config.jwtSecret)}`;
const auth = tokenFor("user-1");
const T = { "X-Internal-Token": DEV_INTERNAL_TOKEN };

let repository: InMemoryOrderRepository;
let products: StubProductClient;
let lifecycle: OrderLifecycle;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  repository = new InMemoryOrderRepository();
  products = new StubProductClient();
  lifecycle = new OrderLifecycle(repository, products);
  app = createApp({
    repository,
    productClient: products,
    publisher: new LoggingOrderEventPublisher(),
    idempotency: new InMemoryIdempotencyStore(),
    lifecycle
  });
});

async function buy(productId: string, quantity = 1, who = auth) {
  await request(app).post("/cart").set("Authorization", who).send({ productId, quantity }).expect(201);
  return request(app).post("/checkout").set("Authorization", who).send({});
}

describe("state machine", () => {
  it("rejects illegal transitions", () => {
    expect(() => assertTransition("delivered", "paid", "admin")).toThrow(/cannot move from 'delivered' to 'paid'/);
    expect(() => assertTransition("cancelled", "paid", "system")).toThrow(/cannot move/);
    expect(() => assertTransition("shipped", "cancelled", "admin")).toThrow(/cannot move/);
  });
  it("enforces who may make a legal change", () => {
    expect(() => assertTransition("paid", "shipped", "admin")).toThrow(/cannot move/); // must be packed first
    expect(() => assertTransition("packed", "shipped", "customer")).toThrow(/A customer cannot/);
    expect(() => assertTransition("pending_payment", "paid", "customer")).toThrow(/A customer cannot/);
    expect(() => assertTransition("paid", "packed", "admin")).not.toThrow();
  });
  it("lists what each actor may do", () => {
    expect(allowedNext("paid", "customer")).toEqual(["cancelled"]);
    expect(allowedNext("packed", "customer")).toEqual([]);
  });
  it("returns stock only when the goods never left", () => {
    expect(releasesStock("paid", "cancelled")).toBe(true);
    expect(releasesStock("paid", "refunded")).toBe(true);
    expect(releasesStock("delivered", "refunded")).toBe(false);
  });
});

describe("checkout reserves stock (P1.1)", () => {
  it("decrements stock and records the history", async () => {
    const res = await buy("p-1001", 2);
    expect(res.status).toBe(201);
    expect(products.stockOf("p-1001")).toBe(10);
    expect(res.body.status).toBe("paid");
    expect(res.body.reservationId).toBe(res.body.id);
    expect(res.body.history).toEqual([
      expect.objectContaining({ from: null, to: "pending_payment", actor: "customer" }),
      expect.objectContaining({ from: "pending_payment", to: "paid", actor: "system" })
    ]);
  });

  it("refuses to oversell and keeps the cart", async () => {
    products.setStock("p-1001", 1);
    const res = await buy("p-1001", 2);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/Only 1 of 'Aether 14 Laptop' left/);
    expect(products.stockOf("p-1001")).toBe(1);
    const cart = await request(app).get("/cart").set("Authorization", auth);
    expect(cart.body.items).toHaveLength(1);
  });

  it("last units: 10 shoppers race for 3, exactly 3 orders", async () => {
    products.setStock("p-1005", 3);
    const shoppers = Array.from({ length: 10 }, (_, i) => tokenFor(`racer-${i}`));
    for (const who of shoppers) {
      await request(app).post("/cart").set("Authorization", who).send({ productId: "p-1005", quantity: 1 }).expect(201);
    }
    const results = await Promise.all(shoppers.map((who) => request(app).post("/checkout").set("Authorization", who).send({})));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
    expect(products.stockOf("p-1005")).toBe(0);
  });
});

describe("cancellation (P1.2)", () => {
  it("a customer cancel returns the stock and is recorded", async () => {
    const order = (await buy("p-1005", 3)).body as Order;
    expect(products.stockOf("p-1005")).toBe(31);
    const res = await request(app).post(`/orders/${order.id}/cancel`).set("Authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
    expect(res.body.history.at(-1)).toMatchObject({ from: "paid", to: "cancelled", actor: "customer" });
    expect(products.stockOf("p-1005")).toBe(34);
  });

  it("cannot cancel twice, and stock comes back only once", async () => {
    const order = (await buy("p-1005", 1)).body as Order;
    await request(app).post(`/orders/${order.id}/cancel`).set("Authorization", auth).expect(200);
    const again = await request(app).post(`/orders/${order.id}/cancel`).set("Authorization", auth);
    expect(again.status).toBe(409);
    expect(products.stockOf("p-1005")).toBe(34);
  });

  it("a customer cannot cancel once the order is packed", async () => {
    const order = (await buy("p-1003")).body as Order;
    await request(app).post(`/internal/orders/${order.id}/transitions`).set(T).send({ to: "packed", reason: "picked" }).expect(200);
    const res = await request(app).post(`/orders/${order.id}/cancel`).set("Authorization", auth);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden_transition");
  });
});

describe("fulfilment via the internal API", () => {
  it("walks the happy path and exposes the full history", async () => {
    const order = (await buy("p-1003")).body as Order;
    for (const to of ["packed", "shipped", "delivered"]) {
      await request(app).post(`/internal/orders/${order.id}/transitions`).set(T).send({ to, reason: `warehouse: ${to}` }).expect(200);
    }
    const res = await request(app).get(`/orders/${order.id}`).set("Authorization", auth);
    expect(res.body.status).toBe("delivered");
    expect(res.body.history.map((h: { to: string }) => h.to)).toEqual([
      "pending_payment", "paid", "packed", "shipped", "delivered"
    ]);
  });

  it("rejects delivered -> paid even for an admin", async () => {
    const order = (await buy("p-1003")).body as Order;
    for (const to of ["packed", "shipped", "delivered"]) {
      await request(app).post(`/internal/orders/${order.id}/transitions`).set(T).send({ to, reason: "x" }).expect(200);
    }
    const res = await request(app).post(`/internal/orders/${order.id}/transitions`).set(T).send({ to: "paid", reason: "x" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("illegal_transition");
  });

  it("requires the internal token", async () => {
    await request(app).post("/internal/orders/whatever/transitions").send({ to: "packed", reason: "x" }).expect(403);
  });
});

describe("unpaid orders expire", () => {
  it("the sweeper cancels an overdue pending order and returns its stock", async () => {
    await products.reserve("pending-order-1", [{ productId: "p-1006", quantity: 2 }]);
    await repository.createOrder({
      id: "pending-order-1", userId: "user-1", status: "pending_payment",
      lines: [{ productId: "p-1006", name: "The DevOps Handbook", quantity: 2, unitPriceMinor: 129900 }],
      subtotalMinor: 259800, discountMinor: 0, couponCode: null, totalMinor: 259800, currency: "INR",
      reservationId: "pending-order-1", paymentDueAt: new Date(Date.now() - 1000).toISOString(),
      history: [{ from: null, to: "pending_payment", at: new Date().toISOString(), actor: "customer", reason: "checkout" }]
    });
    expect(products.stockOf("p-1006")).toBe(54);
    expect(await lifecycle.cancelOverdue()).toBe(1);
    expect((await repository.findOrderById("pending-order-1"))?.status).toBe("cancelled");
    expect(products.stockOf("p-1006")).toBe(56);
    expect(await lifecycle.cancelOverdue()).toBe(0); // claimed once only
  });
});

describe("legacy orders", () => {
  it("reads a pre-lifecycle 'placed' order as paid with a migration note, and it can be cancelled", async () => {
    repository.insertRaw({
      id: "legacy-1", userId: "user-1", status: "placed",
      lines: [], subtotalMinor: 0, discountMinor: 0, couponCode: null, totalMinor: 0, currency: "INR",
      createdAt: "2026-09-01T00:00:00.000Z"
    } as unknown as Order);
    const res = await request(app).get("/orders/legacy-1").set("Authorization", auth);
    expect(res.body.status).toBe("paid");
    expect(res.body.history[0].reason).toMatch(/migrated/);
    await request(app).post("/orders/legacy-1/cancel").set("Authorization", auth).expect(200);
  });
});

describe("dependency timeouts", () => {
  it("a product-service timeout is a retryable 503, and a timed-out reserve is released", async () => {
    const slow = new StubProductClient();
    const released: string[] = [];
    slow.reserve = async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    slow.release = async (id: string) => {
      released.push(id);
    };
    const flaky = createApp({
      repository: new InMemoryOrderRepository(),
      productClient: slow,
      publisher: new LoggingOrderEventPublisher(),
      idempotency: new InMemoryIdempotencyStore()
    });
    await request(flaky).post("/cart").set("Authorization", auth).send({ productId: "p-1003", quantity: 1 }).expect(201);
    const res = await request(flaky).post("/checkout").set("Authorization", auth).set("Idempotency-Key", "timeout-key-1").send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("dependency_timeout");
    expect(res.headers["retry-after"]).toBe("1");
    expect(released).toHaveLength(1);
  });
});
