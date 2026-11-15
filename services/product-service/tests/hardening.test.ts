/** Phase 0: validation (P0.6), headers (P0.6) and JWT secret fail-closed (P0.1). */
import jwt from "jsonwebtoken";
import request from "supertest";
import { createApp } from "../src/app";
import { config, DEV_JWT_SECRET, jwtSecretFromEnv } from "../src/config";

const app = createApp();
const auth = `Bearer ${jwt.sign({ sub: "user-9", email: "u9@example.com" }, config.jwtSecret)}`;

describe("P0.6 validation", () => {
  it("rejects a repeated query parameter (an array) instead of passing it through", async () => {
    const res = await request(app).get("/products?limit=1&limit=2");
    expect(res.status).toBe(400);
    expect(res.body.details[0].path).toBe("query.limit");
  });

  it("coerces and bounds paging", async () => {
    await request(app).get("/products?limit=5&offset=0").expect(200);
    await request(app).get(`/products?limit=${config.maxPageSize + 1}`).expect(400);
    await request(app).get("/products?offset=-1").expect(400);
  });

  it("requires q on /search and bounds its length", async () => {
    await request(app).get("/search").expect(400);
    await request(app).get(`/search?q=${"x".repeat(101)}`).expect(400);
    await request(app).get("/search?q=laptop").expect(200);
  });

  it("rejects a malformed product id", async () => {
    const res = await request(app).get("/products/bad%20id");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
  });

  it("reports every bad review field at once", async () => {
    const res = await request(app)
      .post("/products/p-1001/reviews")
      .set("Authorization", auth)
      .send({ rating: "5", comment: "" });
    expect(res.status).toBe(400);
    expect(res.body.details.map((d: { path: string }) => d.path).sort()).toEqual(["comment", "rating"]);
  });

  it("sends security headers", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });
});

describe("P0.1 JWT secret fails closed in production", () => {
  it("refuses the code default", () => {
    expect(() => jwtSecretFromEnv({ NODE_ENV: "production", JWT_SECRET: DEV_JWT_SECRET } as NodeJS.ProcessEnv)).toThrow(/publicly known/);
  });
});
