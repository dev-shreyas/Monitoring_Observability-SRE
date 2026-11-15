/**
 * Because every collaborator is injected, this test file runs the full
 * checkout flow with NO database, NO product-service and NO Service Bus —
 * and still asserts that the right event would have been published.
 */
import jwt from "jsonwebtoken";
import request from "supertest";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { StubProductClient } from "../src/clients/productClient";
import { LoggingOrderEventPublisher } from "../src/messaging/orderEventPublisher";
import { InMemoryOrderRepository } from "../src/repository/orderRepository";

/** Mint a token exactly as user-service would, using the same shared secret. */
function tokenFor(userId: string): string {
  return jwt.sign({ sub: userId, email: `${userId}@example.com` }, config.jwtSecret, {
    expiresIn: "5m"
  });
}

let publisher: LoggingOrderEventPublisher;
let app: ReturnType<typeof createApp>;
let auth: string;

beforeEach(() => {
  // Fresh state per test — no cross-test contamination.
  publisher = new LoggingOrderEventPublisher();
  app = createApp({
    repository: new InMemoryOrderRepository(),
    productClient: new StubProductClient(),
    publisher
  });
  auth = `Bearer ${tokenFor("user-1")}`;
});

describe("authentication", () => {
  it("rejects every business route without a token", async () => {
    await request(app).get("/cart").expect(401);
    await request(app).post("/checkout").expect(401);
    await request(app).get("/orders").expect(401);
  });

  it("leaves /health and /metrics open for probes and scrapes", async () => {
    await request(app).get("/health").expect(200);
    await request(app).get("/metrics").expect(200);
  });
});

describe("POST /cart", () => {
  it("adds an item", async () => {
    const res = await request(app)
      .post("/cart")
      .set("Authorization", auth)
      .send({ productId: "p-1003", quantity: 2 })
      .expect(201);

    expect(res.body.items).toEqual([{ productId: "p-1003", quantity: 2 }]);
  });

  it("merges quantities for the same product", async () => {
    await request(app).post("/cart").set("Authorization", auth).send({ productId: "p-1003", quantity: 2 });
    const res = await request(app)
      .post("/cart")
      .set("Authorization", auth)
      .send({ productId: "p-1003", quantity: 3 })
      .expect(201);

    expect(res.body.items).toEqual([{ productId: "p-1003", quantity: 5 }]);
  });

  it("rejects an unknown product and a bad quantity", async () => {
    await request(app).post("/cart").set("Authorization", auth).send({ productId: "nope", quantity: 1 }).expect(404);
    await request(app).post("/cart").set("Authorization", auth).send({ productId: "p-1003", quantity: 0 }).expect(400);
    await request(app).post("/cart").set("Authorization", auth).send({ productId: "p-1003", quantity: 1.5 }).expect(400);
  });
});

describe("POST /checkout", () => {
  it("prices the cart from the catalog and publishes one event", async () => {
    await request(app).post("/cart").set("Authorization", auth).send({ productId: "p-1003", quantity: 2 });
    await request(app).post("/cart").set("Authorization", auth).send({ productId: "p-1006", quantity: 1 });

    const res = await request(app).post("/checkout").set("Authorization", auth).expect(201);

    // 2 x 79900 + 1 x 129900 — integer arithmetic, exact.
    expect(res.body.totalMinor).toBe(2 * 79900 + 129900);
    expect(res.body.status).toBe("paid");
    expect(res.body.history.map((h: { to: string }) => h.to)).toEqual(["pending_payment", "paid"]);
    expect(res.body.lines).toHaveLength(2);

    expect(publisher.published).toHaveLength(1);
    expect(publisher.published[0]).toMatchObject({
      eventType: "order.placed",
      orderId: res.body.id,
      userId: "user-1"
    });
  });

  it("ignores a price sent by the client", async () => {
    await request(app)
      .post("/cart")
      .set("Authorization", auth)
      .send({ productId: "p-1003", quantity: 1, priceMinor: 1 });

    const res = await request(app).post("/checkout").set("Authorization", auth).expect(201);
    expect(res.body.totalMinor).toBe(79900);
  });

  it("empties the cart afterwards", async () => {
    await request(app).post("/cart").set("Authorization", auth).send({ productId: "p-1003", quantity: 1 });
    await request(app).post("/checkout").set("Authorization", auth).expect(201);

    const cart = await request(app).get("/cart").set("Authorization", auth).expect(200);
    expect(cart.body.items).toEqual([]);
  });

  it("refuses an empty cart", async () => {
    await request(app).post("/checkout").set("Authorization", auth).expect(400);
  });

  it("refuses an out-of-stock item and publishes nothing", async () => {
    // p-1004 has stock 0 in the stub catalog.
    await request(app).post("/cart").set("Authorization", auth).send({ productId: "p-1004", quantity: 1 });

    await request(app).post("/checkout").set("Authorization", auth).expect(409);
    expect(publisher.published).toHaveLength(0);
  });
});

describe("order history", () => {
  it("is scoped to the caller", async () => {
    await request(app).post("/cart").set("Authorization", auth).send({ productId: "p-1003", quantity: 1 });
    const placed = await request(app).post("/checkout").set("Authorization", auth).expect(201);

    const otherUser = `Bearer ${tokenFor("user-2")}`;

    // user-2 sees an empty history...
    const theirs = await request(app).get("/orders").set("Authorization", otherUser).expect(200);
    expect(theirs.body.items).toEqual([]);

    // ...and cannot fetch user-1's order even knowing its exact id.
    await request(app).get(`/orders/${placed.body.id}`).set("Authorization", otherUser).expect(404);

    // The owner can.
    await request(app).get(`/orders/${placed.body.id}`).set("Authorization", auth).expect(200);
  });
});

describe("unknown routes", () => {
  it("returns a JSON 404, not a 401, even without a token", async () => {
    const res = await request(app).get("/does-not-exist").expect(404);
    expect(res.body.error).toBe("not_found");
  });
});

describe("GET /coupons", () => {
  it("requires auth", async () => {
    await request(app).get("/coupons").expect(401);
  });

  it("lists the active seed coupons", async () => {
    const res = await request(app).get("/coupons").set("Authorization", auth).expect(200);
    expect(res.body.items.map((c: { code: string }) => c.code)).toEqual(
      expect.arrayContaining(["WELCOME10", "FLAT200", "SUMMER25"])
    );
  });
});

describe("POST /checkout with a coupon", () => {
  it("applies a percent coupon to the subtotal", async () => {
    await request(app).post("/cart").set("Authorization", auth).send({ productId: "p-1003", quantity: 2 }); // 2 x 79900

    const res = await request(app)
      .post("/checkout")
      .set("Authorization", auth)
      .send({ couponCode: "WELCOME10" })
      .expect(201);

    expect(res.body.subtotalMinor).toBe(159800);
    expect(res.body.discountMinor).toBe(15980); // 10%
    expect(res.body.totalMinor).toBe(159800 - 15980);
    expect(res.body.couponCode).toBe("WELCOME10");
  });

  it("applies a flat coupon, clamped to never go negative", async () => {
    // p-1004 is a low-value item; FLAT200 (₹200 = 20000 minor) would exceed
    // a tiny subtotal, so the discount must clamp instead of going negative.
    await request(app).post("/cart").set("Authorization", auth).send({ productId: "p-1003", quantity: 1 }); // 79900

    const res = await request(app)
      .post("/checkout")
      .set("Authorization", auth)
      .send({ couponCode: "flat200" }) // lowercase — codes are case-insensitive
      .expect(201);

    expect(res.body.discountMinor).toBe(20000);
    expect(res.body.totalMinor).toBe(79900 - 20000);
  });

  it("rejects an unknown coupon code", async () => {
    await request(app).post("/cart").set("Authorization", auth).send({ productId: "p-1003", quantity: 1 });

    await request(app).post("/checkout").set("Authorization", auth).send({ couponCode: "NOT-REAL" }).expect(400);
  });

  it("checks out fine with no coupon at all", async () => {
    await request(app).post("/cart").set("Authorization", auth).send({ productId: "p-1003", quantity: 1 });

    const res = await request(app).post("/checkout").set("Authorization", auth).expect(201);
    expect(res.body.discountMinor).toBe(0);
    expect(res.body.couponCode).toBeNull();
  });
});

describe("POST /orders/:id/cancel", () => {
  it("cancels a freshly placed order", async () => {
    await request(app).post("/cart").set("Authorization", auth).send({ productId: "p-1003", quantity: 1 });
    const placed = await request(app).post("/checkout").set("Authorization", auth).expect(201);

    const res = await request(app).post(`/orders/${placed.body.id}/cancel`).set("Authorization", auth).expect(200);
    expect(res.body.status).toBe("cancelled");
  });

  it("404s for someone else's order", async () => {
    await request(app).post("/cart").set("Authorization", auth).send({ productId: "p-1003", quantity: 1 });
    const placed = await request(app).post("/checkout").set("Authorization", auth).expect(201);

    const otherAuth = `Bearer ${tokenFor("user-2")}`;
    await request(app).post(`/orders/${placed.body.id}/cancel`).set("Authorization", otherAuth).expect(404);
  });

  it("refuses to cancel an order twice", async () => {
    await request(app).post("/cart").set("Authorization", auth).send({ productId: "p-1003", quantity: 1 });
    const placed = await request(app).post("/checkout").set("Authorization", auth).expect(201);

    await request(app).post(`/orders/${placed.body.id}/cancel`).set("Authorization", auth).expect(200);
    await request(app).post(`/orders/${placed.body.id}/cancel`).set("Authorization", auth).expect(409);
  });

  it("404s for an unknown order id", async () => {
    await request(app).post("/orders/does-not-exist/cancel").set("Authorization", auth).expect(404);
  });
});
