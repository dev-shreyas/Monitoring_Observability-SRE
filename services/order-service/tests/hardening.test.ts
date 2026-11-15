/**
 * Phase 0: checkout idempotency (P0.3), stub catalogue fails closed (P0.2),
 * JWT secret fails closed (P0.1) and validation (P0.6).
 */
import jwt from "jsonwebtoken";
import request from "supertest";
import { createApp } from "../src/app";
import { config, DEV_JWT_SECRET, jwtSecretFromEnv } from "../src/config";
import { createProductClient, StubProductClient } from "../src/clients/productClient";
import { LoggingOrderEventPublisher } from "../src/messaging/orderEventPublisher";
import { InMemoryIdempotencyStore } from "../src/repository/idempotencyStore";
import { InMemoryOrderRepository } from "../src/repository/orderRepository";

const auth = `Bearer ${jwt.sign({ sub: "user-1", email: "user-1@example.com" }, config.jwtSecret, { expiresIn: "5m" })}`;

let app: ReturnType<typeof createApp>;
let repository: InMemoryOrderRepository;
let publisher: LoggingOrderEventPublisher;

beforeEach(() => {
  repository = new InMemoryOrderRepository();
  publisher = new LoggingOrderEventPublisher();
  app = createApp({
    repository,
    productClient: new StubProductClient(),
    publisher,
    idempotency: new InMemoryIdempotencyStore()
  });
});

const addToCart = () =>
  request(app).post("/cart").set("Authorization", auth).send({ productId: "p-1003", quantity: 1 }).expect(201);

const checkout = (key?: string, body: object = {}) => {
  const req = request(app).post("/checkout").set("Authorization", auth);
  if (key) req.set("Idempotency-Key", key);
  return req.send(body);
};

describe("P0.3 checkout idempotency", () => {
  it("a retry with the same key returns the SAME order and creates no second one", async () => {
    await addToCart();
    const first = await checkout("key-aaaa-1111");
    expect(first.status).toBe(201);

    // The cart is now empty, so without idempotency this would be a 400.
    const retry = await checkout("key-aaaa-1111");
    expect(retry.status).toBe(201);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(retry.body.id).toBe(first.body.id);

    expect(await repository.listOrders("user-1")).toHaveLength(1);
    expect(publisher.published).toHaveLength(1);
  });

  it("two CONCURRENT checkouts with one key create exactly one order", async () => {
    await addToCart();
    await addToCart();
    const results = await Promise.all([checkout("key-concurrent-1"), checkout("key-concurrent-1")]);
    const statuses = results.map((r) => r.status).sort();

    expect(await repository.listOrders("user-1")).toHaveLength(1);
    expect(publisher.published).toHaveLength(1);
    // The loser either saw it in progress (409) or, if it lost by a whole
    // request, got the replay (201) — never a second order.
    expect([[201, 409], [201, 201]]).toContainEqual(statuses);
    const conflict = results.find((r) => r.status === 409);
    if (conflict) expect(conflict.headers["retry-after"]).toBe("1");
  });

  it("a failed checkout releases the key so the shopper can fix it and retry", async () => {
    await checkout("key-empty-cart").expect(400); // cart empty
    await addToCart();
    await checkout("key-empty-cart").expect(201);
  });

  it("refuses the same key with a different body (422)", async () => {
    await addToCart();
    await checkout("key-mismatch-1").expect(201);
    const res = await checkout("key-mismatch-1", { couponCode: "WELCOME10" });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("unprocessable");
  });

  it("scopes keys per user", async () => {
    await addToCart();
    await checkout("shared-key-123").expect(201);
    const other = `Bearer ${jwt.sign({ sub: "user-2", email: "u2@example.com" }, config.jwtSecret)}`;
    await request(app).post("/cart").set("Authorization", other).send({ productId: "p-1003", quantity: 1 }).expect(201);
    const res = await request(app).post("/checkout").set("Authorization", other).set("Idempotency-Key", "shared-key-123").send({});
    expect(res.status).toBe(201);
    expect(res.headers["idempotent-replayed"]).toBeUndefined();
  });

  it("rejects a malformed key", async () => {
    await checkout("bad key!").expect(400);
  });

  it("still works without a key (older clients)", async () => {
    await addToCart();
    await checkout().expect(201);
  });
});

describe("P0.2 stub catalogue fails closed in production", () => {
  it("throws when PRODUCT_SERVICE_URL is empty in production", () => {
    expect(() => createProductClient({ url: "", nodeEnv: "production" })).toThrow(/PRODUCT_SERVICE_URL/);
  });
  it("allows the stub outside production", () => {
    expect(createProductClient({ url: "", nodeEnv: "test" })).toBeInstanceOf(StubProductClient);
  });
});

describe("P0.1 JWT secret fails closed in production", () => {
  it("refuses the code default", () => {
    expect(() => jwtSecretFromEnv({ NODE_ENV: "production", JWT_SECRET: DEV_JWT_SECRET } as NodeJS.ProcessEnv)).toThrow(/publicly known/);
  });
  it("refuses a missing secret", () => {
    expect(() => jwtSecretFromEnv({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(/Missing/);
  });
});

describe("P0.6 validation", () => {
  it("rejects a string quantity with a field-level message", async () => {
    const res = await request(app).post("/cart").set("Authorization", auth).send({ productId: "p-1003", quantity: "2" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
    expect(res.body.details[0].path).toBe("quantity");
  });

  it("rejects a non-string coupon", async () => {
    const res = await checkout(undefined, { couponCode: 42 });
    expect(res.status).toBe(400);
    expect(res.body.details[0].path).toBe("couponCode");
  });

  it("rejects a malformed order id", async () => {
    const res = await request(app).get("/orders/bad%20id").set("Authorization", auth);
    expect(res.status).toBe(400);
    expect(res.body.details[0].path).toBe("params.id");
  });

  it("returns 400 (not 500) for malformed JSON", async () => {
    const res = await request(app).post("/cart").set("Authorization", auth).set("Content-Type", "application/json").send("{bad");
    expect(res.status).toBe(400);
  });

  it("allows the Idempotency-Key header cross-origin", async () => {
    const res = await request(app).options("/checkout");
    expect(res.headers["access-control-allow-headers"]).toContain("Idempotency-Key");
  });
});
