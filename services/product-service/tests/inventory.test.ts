/** P1.1 inventory: atomic all-or-nothing reservations, commit, release, expiry. */
import request from "supertest";
import { createApp } from "../src/app";
import { DEV_INTERNAL_TOKEN, internalTokenFromEnv } from "../src/config";
import { InMemoryProductRepository, SEED_STOCK } from "../src/repository/productRepository";
import { InMemoryReviewRepository } from "../src/repository/reviewRepository";
import { InMemoryStockStore } from "../src/repository/stockStore";

let stock: InMemoryStockStore;
let app: ReturnType<typeof createApp>;
const T = { "X-Internal-Token": DEV_INTERNAL_TOKEN };

beforeEach(() => {
  stock = new InMemoryStockStore(SEED_STOCK);
  app = createApp(new InMemoryProductRepository(), new InMemoryReviewRepository(), stock);
});

const reserve = (reservationId: string, items: object[]) =>
  request(app).post("/internal/reservations").set(T).send({ reservationId, items });
const level = async (id: string) => (await request(app).get(`/products/${id}`)).body.stock;

describe("internal API protection", () => {
  it("refuses calls without the internal token", async () => {
    await request(app).post("/internal/reservations").send({}).expect(403);
    await request(app).put("/internal/stock/p-1001").set("X-Internal-Token", "wrong").send({ quantity: 1 }).expect(403);
  });
  it("fails closed in production without a real token", () => {
    expect(() => internalTokenFromEnv({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(/INTERNAL_API_TOKEN/);
  });
});

describe("reservations", () => {
  it("decrements stock and the catalogue shows the live level", async () => {
    expect(await level("p-1001")).toBe(12);
    await reserve("order-aaaa-1", [{ productId: "p-1001", quantity: 2 }]).expect(201);
    expect(await level("p-1001")).toBe(10);
    const list = await request(app).get("/products?limit=50");
    expect(list.body.items.find((p: { id: string }) => p.id === "p-1001").stock).toBe(10);
  });

  it("50 concurrent reservations for the last 5 units: exactly 5 succeed", async () => {
    await request(app).put("/internal/stock/p-1012").set(T).send({ quantity: 5 }).expect(200);
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => reserve(`race-order-${i}`, [{ productId: "p-1012", quantity: 1 }]))
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(5);
    expect(statuses.filter((s) => s === 409)).toHaveLength(45);
    expect(results.find((r) => r.status === 409)!.body.error).toBe("out_of_stock");
    expect(await level("p-1012")).toBe(0);
  });

  it("is all-or-nothing across lines", async () => {
    // p-1004 has 0 in stock, so the whole reservation fails and p-1003 is untouched.
    const res = await reserve("order-mixed-1", [
      { productId: "p-1003", quantity: 3 },
      { productId: "p-1004", quantity: 1 }
    ]);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/Only 0 of 'Ceramic Mug 350ml'/);
    expect(await level("p-1003")).toBe(240);
  });

  it("merges duplicate lines before checking", async () => {
    await request(app).put("/internal/stock/p-1012").set(T).send({ quantity: 3 }).expect(200);
    await reserve("order-dupe-1", [
      { productId: "p-1012", quantity: 2 },
      { productId: "p-1012", quantity: 2 }
    ]).expect(409);
  });

  it("is idempotent: the same reservation id takes stock once", async () => {
    await reserve("order-idem-1", [{ productId: "p-1005", quantity: 4 }]).expect(201);
    await reserve("order-idem-1", [{ productId: "p-1005", quantity: 4 }]).expect(200);
    expect(await level("p-1005")).toBe(30);
  });

  it("release returns the stock exactly once", async () => {
    await reserve("order-rel-1", [{ productId: "p-1006", quantity: 6 }]).expect(201);
    await request(app).post("/internal/reservations/order-rel-1/release").set(T).send({ reason: "cancelled" }).expect(200);
    await request(app).post("/internal/reservations/order-rel-1/release").set(T).send({}).expect(200);
    expect(await level("p-1006")).toBe(56);
  });

  it("a committed reservation can still be released (cancel after confirm)", async () => {
    await reserve("order-cc-1", [{ productId: "p-1007", quantity: 1 }]).expect(201);
    await request(app).post("/internal/reservations/order-cc-1/commit").set(T).expect(200);
    expect(await level("p-1007")).toBe(80);
    await request(app).post("/internal/reservations/order-cc-1/release").set(T).send({}).expect(200);
    expect(await level("p-1007")).toBe(81);
  });

  it("cannot commit a reservation that was already released", async () => {
    await reserve("order-late-1", [{ productId: "p-1008", quantity: 1 }]).expect(201);
    await request(app).post("/internal/reservations/order-late-1/release").set(T).send({}).expect(200);
    const res = await request(app).post("/internal/reservations/order-late-1/commit").set(T);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("reservation_released");
  });

  it("expiry releases HELD reservations only, never committed ones", async () => {
    await reserve("order-exp-held", [{ productId: "p-1009", quantity: 4 }]).expect(201);
    await reserve("order-exp-comm", [{ productId: "p-1009", quantity: 5 }]).expect(201);
    await request(app).post("/internal/reservations/order-exp-comm/commit").set(T).expect(200);
    stock.expireNow("order-exp-held");
    stock.expireNow("order-exp-comm");

    const due = await stock.expired(Date.now(), 10);
    expect(due).toEqual(["order-exp-held"]);
    for (const id of due) await stock.release(id, "expired", true);
    expect(await stock.release("order-exp-comm", "expired", true)).toBe("committed");
    expect(await level("p-1009")).toBe(64 - 5);
  });

  it("404s an unknown product instead of treating it as out of stock", async () => {
    await reserve("order-unk-1", [{ productId: "p-9999", quantity: 1 }]).expect(404);
  });
});
