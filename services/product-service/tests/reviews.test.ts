import jwt from "jsonwebtoken";
import request from "supertest";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { InMemoryProductRepository } from "../src/repository/productRepository";
import { InMemoryReviewRepository } from "../src/repository/reviewRepository";

/** Mint a token exactly as user-service would, using the same shared secret. */
function tokenFor(userId: string): string {
  return jwt.sign({ sub: userId, email: `${userId}@example.com` }, config.jwtSecret, { expiresIn: "5m" });
}

let app: ReturnType<typeof createApp>;
let auth: string;

beforeEach(() => {
  app = createApp(new InMemoryProductRepository(), new InMemoryReviewRepository());
  auth = `Bearer ${tokenFor("user-1")}`;
});

describe("GET /categories", () => {
  it("returns distinct categories with item counts", async () => {
    const res = await request(app).get("/categories").expect(200);

    expect(res.body.items).toEqual(
      expect.arrayContaining([
        { category: "electronics", count: 5 },
        { category: "apparel", count: 2 },
        { category: "home", count: 3 },
        { category: "books", count: 2 }
      ])
    );
  });
});

describe("product rating enrichment", () => {
  it("reports zero rating for a product with no reviews", async () => {
    const res = await request(app).get("/products/p-1001").expect(200);
    expect(res.body.rating).toEqual({ average: 0, count: 0 });
  });

  it("includes rating on every item in the catalog list", async () => {
    const res = await request(app).get("/products").expect(200);
    expect(res.body.items[0].rating).toEqual({ average: 0, count: 0 });
  });
});

describe("GET /products/:id/reviews", () => {
  it("404s for an unknown product", async () => {
    await request(app).get("/products/does-not-exist/reviews").expect(404);
  });

  it("starts empty", async () => {
    const res = await request(app).get("/products/p-1001/reviews").expect(200);
    expect(res.body.items).toEqual([]);
  });
});

describe("POST /products/:id/reviews", () => {
  it("requires auth", async () => {
    await request(app).post("/products/p-1001/reviews").send({ rating: 5, comment: "Great!" }).expect(401);
  });

  it("404s for an unknown product", async () => {
    await request(app)
      .post("/products/does-not-exist/reviews")
      .set("Authorization", auth)
      .send({ rating: 5, comment: "Great!" })
      .expect(404);
  });

  it("rejects an out-of-range or non-integer rating", async () => {
    await request(app).post("/products/p-1001/reviews").set("Authorization", auth).send({ rating: 0, comment: "x" }).expect(400);
    await request(app).post("/products/p-1001/reviews").set("Authorization", auth).send({ rating: 6, comment: "x" }).expect(400);
    await request(app).post("/products/p-1001/reviews").set("Authorization", auth).send({ rating: 4.5, comment: "x" }).expect(400);
  });

  it("requires a non-empty comment", async () => {
    await request(app).post("/products/p-1001/reviews").set("Authorization", auth).send({ rating: 5, comment: "" }).expect(400);
    await request(app).post("/products/p-1001/reviews").set("Authorization", auth).send({ rating: 5 }).expect(400);
  });

  it("creates a review and folds it into the product's rating", async () => {
    const res = await request(app)
      .post("/products/p-1001/reviews")
      .set("Authorization", auth)
      .send({ rating: 4, comment: "Solid laptop, would buy again." })
      .expect(201);

    expect(res.body).toMatchObject({ productId: "p-1001", userId: "user-1", rating: 4 });

    const product = await request(app).get("/products/p-1001").expect(200);
    expect(product.body.rating).toEqual({ average: 4, count: 1 });
  });

  it("averages multiple reviewers' ratings", async () => {
    await request(app).post("/products/p-1001/reviews").set("Authorization", auth).send({ rating: 4, comment: "Good" });

    const otherAuth = `Bearer ${tokenFor("user-2")}`;
    await request(app).post("/products/p-1001/reviews").set("Authorization", otherAuth).send({ rating: 2, comment: "Meh" });

    const product = await request(app).get("/products/p-1001").expect(200);
    expect(product.body.rating).toEqual({ average: 3, count: 2 });
  });

  it("refuses a second review from the same shopper on the same product", async () => {
    await request(app).post("/products/p-1001/reviews").set("Authorization", auth).send({ rating: 4, comment: "Good" }).expect(201);

    await request(app)
      .post("/products/p-1001/reviews")
      .set("Authorization", auth)
      .send({ rating: 1, comment: "Changed my mind" })
      .expect(409);
  });

  it("lets the same shopper review two different products", async () => {
    await request(app).post("/products/p-1001/reviews").set("Authorization", auth).send({ rating: 4, comment: "Good" }).expect(201);
    await request(app).post("/products/p-1002/reviews").set("Authorization", auth).send({ rating: 5, comment: "Great" }).expect(201);
  });
});
