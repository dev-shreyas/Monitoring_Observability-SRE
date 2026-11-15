import request from "supertest";
import { createApp } from "../src/app";
import { InMemoryProductRepository } from "../src/repository/productRepository";

const app = createApp(new InMemoryProductRepository());

describe("GET /health", () => {
  it("identifies itself as product-service", async () => {
    const res = await request(app).get("/health").expect(200);
    expect(res.body).toMatchObject({ status: "ok", service: "product-service" });
  });
});

describe("GET /products", () => {
  it("returns a page with total, limit and offset", async () => {
    const res = await request(app).get("/products").expect(200);

    expect(res.body.total).toBe(12);
    expect(res.body.items).toHaveLength(12);
    expect(res.body).toMatchObject({ limit: 20, offset: 0 });
  });

  it("filters by category", async () => {
    const res = await request(app).get("/products?category=electronics").expect(200);

    expect(res.body.total).toBe(5);
    expect(res.body.items.every((p: { category: string }) => p.category === "electronics")).toBe(true);
  });

  it("pages results while reporting the full total", async () => {
    const res = await request(app).get("/products?limit=2&offset=2").expect(200);

    expect(res.body.items).toHaveLength(2);
    expect(res.body.total).toBe(12); // total is the match count, not the page size
  });

  it("rejects an out-of-range limit instead of returning everything", async () => {
    await request(app).get("/products?limit=100000").expect(400);
    await request(app).get("/products?limit=0").expect(400);
    await request(app).get("/products?offset=-5").expect(400);
  });
});

describe("GET /products/:id", () => {
  it("returns one product", async () => {
    const res = await request(app).get("/products/p-1001").expect(200);
    expect(res.body.name).toBe("Aether 14 Laptop");
    // Money is an integer in minor units — never a float.
    expect(Number.isInteger(res.body.priceMinor)).toBe(true);
  });

  it("404s on an unknown id", async () => {
    await request(app).get("/products/does-not-exist").expect(404);
  });
});

describe("GET /search", () => {
  it("matches on name, description or sku", async () => {
    const byName = await request(app).get("/search?q=laptop").expect(200);
    expect(byName.body.total).toBe(1);

    const bySku = await request(app).get("/search?q=BKS-DEVOPS").expect(200);
    expect(bySku.body.items[0].name).toBe("The DevOps Handbook");
  });

  it("is case-insensitive", async () => {
    const res = await request(app).get("/search?q=HEADPHONES").expect(200);
    expect(res.body.total).toBe(1);
  });

  it("requires q", async () => {
    await request(app).get("/search").expect(400);
  });

  it("returns an empty page rather than 404 when nothing matches", async () => {
    const res = await request(app).get("/search?q=zzzznothing").expect(200);
    expect(res.body).toMatchObject({ total: 0, items: [] });
  });
});
