import request from "supertest";
import { createApp } from "../src/app";
import { StubProductClient } from "../src/clients/productClient";
import { InMemoryUserRepository } from "../src/repository/userRepository";
import { InMemoryWishlistRepository } from "../src/repository/wishlistRepository";

const validUser = {
  email: "wishlist-user@example.com",
  password: "correct-horse-battery",
  displayName: "Wish Lister"
};

let app: ReturnType<typeof createApp>;
let auth: string;

beforeEach(async () => {
  app = createApp({
    repository: new InMemoryUserRepository(),
    wishlistRepository: new InMemoryWishlistRepository(),
    productClient: new StubProductClient()
  });

  await request(app).post("/register").send(validUser);
  const login = await request(app).post("/login").send({ email: validUser.email, password: validUser.password });
  auth = `Bearer ${login.body.token}`;
});

describe("authentication", () => {
  it("rejects every wishlist route without a token", async () => {
    await request(app).get("/wishlist").expect(401);
    await request(app).post("/wishlist").send({ productId: "p-1001" }).expect(401);
    await request(app).delete("/wishlist/p-1001").expect(401);
  });
});

describe("GET /wishlist", () => {
  it("starts empty", async () => {
    const res = await request(app).get("/wishlist").set("Authorization", auth).expect(200);
    expect(res.body.items).toEqual([]);
  });
});

describe("POST /wishlist", () => {
  it("saves a product", async () => {
    const res = await request(app).post("/wishlist").set("Authorization", auth).send({ productId: "p-1001" }).expect(201);

    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ productId: "p-1001" });
    expect(res.body.items[0].addedAt).toEqual(expect.any(String));
  });

  it("requires a productId", async () => {
    await request(app).post("/wishlist").set("Authorization", auth).send({}).expect(400);
  });

  it("404s for an unknown product", async () => {
    await request(app).post("/wishlist").set("Authorization", auth).send({ productId: "does-not-exist" }).expect(404);
  });

  it("adding the same product twice is idempotent, not an error", async () => {
    await request(app).post("/wishlist").set("Authorization", auth).send({ productId: "p-1001" }).expect(201);
    const res = await request(app).post("/wishlist").set("Authorization", auth).send({ productId: "p-1001" }).expect(201);

    expect(res.body.items).toHaveLength(1);
  });

  it("is scoped per user", async () => {
    await request(app).post("/wishlist").set("Authorization", auth).send({ productId: "p-1001" });

    await request(app).post("/register").send({ email: "other@example.com", password: "correct-horse-battery", displayName: "Other" });
    const otherLogin = await request(app).post("/login").send({ email: "other@example.com", password: "correct-horse-battery" });
    const otherAuth = `Bearer ${otherLogin.body.token}`;

    const res = await request(app).get("/wishlist").set("Authorization", otherAuth).expect(200);
    expect(res.body.items).toEqual([]);
  });
});

describe("DELETE /wishlist/:productId", () => {
  it("removes a saved product", async () => {
    await request(app).post("/wishlist").set("Authorization", auth).send({ productId: "p-1001" });

    const res = await request(app).delete("/wishlist/p-1001").set("Authorization", auth).expect(200);
    expect(res.body.items).toEqual([]);
  });

  it("removing something not on the list is a no-op success", async () => {
    const res = await request(app).delete("/wishlist/never-added").set("Authorization", auth).expect(200);
    expect(res.body.items).toEqual([]);
  });
});
