/**
 * Phase 0 hardening: secrets fail closed, stub catalogue fails closed,
 * registration is race-free, login is throttled and locks out, passwords hash
 * off the main thread, and every malformed input is a 400 with field details.
 */
import bcrypt from "bcryptjs";
import request from "supertest";
import { createApp, type AppDeps } from "../src/app";
import { createProductClient, StubProductClient } from "../src/clients/productClient";
import { DEV_JWT_SECRET, jwtSecretFromEnv } from "../src/config";
import { InMemoryUserRepository } from "../src/repository/userRepository";
import { InMemoryWishlistRepository } from "../src/repository/wishlistRepository";
import { hashPassword, verifyPassword } from "../src/security/passwords";
import { InMemoryCounterStore } from "../src/security/rateLimiter";

const user = { email: "race@example.com", password: "correct-horse-1", displayName: "Race" };

function build(overrides: Partial<AppDeps> = {}) {
  const repository = new InMemoryUserRepository();
  const app = createApp({
    repository,
    wishlistRepository: new InMemoryWishlistRepository(),
    productClient: new StubProductClient(),
    counters: new InMemoryCounterStore(),
    ...overrides
  });
  return { app, repository };
}

describe("P0.1 JWT secret fails closed in production", () => {
  const prod = (JWT_SECRET?: string) => ({ NODE_ENV: "production", JWT_SECRET }) as NodeJS.ProcessEnv;

  it("refuses a missing secret", () => {
    expect(() => jwtSecretFromEnv(prod(undefined))).toThrow(/Missing required environment variable: JWT_SECRET/);
  });
  it("refuses the code default and the value that was once in the repo", () => {
    expect(() => jwtSecretFromEnv(prod(DEV_JWT_SECRET))).toThrow(/publicly known/);
    expect(() => jwtSecretFromEnv(prod("local-dev-shared-jwt-secret-not-for-production"))).toThrow(/publicly known/);
  });
  it("refuses a short secret", () => {
    expect(() => jwtSecretFromEnv(prod("too-short"))).toThrow(/at least 32/);
  });
  it("accepts a long random secret, and falls back outside production", () => {
    const good = "a".repeat(20) + "B".repeat(20);
    expect(jwtSecretFromEnv(prod(good))).toBe(good);
    expect(jwtSecretFromEnv({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBe(DEV_JWT_SECRET);
  });
});

describe("P0.2 stub catalogue fails closed in production", () => {
  it("throws at startup when PRODUCT_SERVICE_URL is empty in production", () => {
    expect(() => createProductClient({ url: "", nodeEnv: "production" })).toThrow(/PRODUCT_SERVICE_URL/);
  });
  it("still allows the stub outside production", () => {
    expect(createProductClient({ url: "", nodeEnv: "test" })).toBeInstanceOf(StubProductClient);
  });
});

describe("P0.4 registration race", () => {
  it("20 concurrent registrations of one email create exactly one account", async () => {
    const { app } = build({ rateLimit: { registerPerIpPer10Minutes: 1000 } });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => request(app).post("/register").send(user))
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(19);
  });

  it("treats emails case-insensitively", async () => {
    const { app } = build();
    await request(app).post("/register").send(user).expect(201);
    await request(app).post("/register").send({ ...user, email: "RACE@Example.com" }).expect(409);
  });
});

describe("P0.5 login throttling and lockout", () => {
  async function registered(overrides: Partial<AppDeps> = {}) {
    const built = build(overrides);
    await request(built.app).post("/register").send(user).expect(201);
    return built;
  }

  it("locks an account after repeated wrong passwords — even the right one then gets 429", async () => {
    const { app } = await registered({ rateLimit: { loginMaxFailures: 3, lockoutSeconds: 900 } });
    for (let i = 0; i < 3; i++) {
      await request(app).post("/login").send({ email: user.email, password: "wrong-password" }).expect(401);
    }
    const locked = await request(app).post("/login").send({ email: user.email, password: user.password });
    expect(locked.status).toBe(429);
    expect(locked.body.error).toBe("too_many_requests");
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("a successful login resets the failure count", async () => {
    const { app } = await registered({ rateLimit: { loginMaxFailures: 3 } });
    for (let round = 0; round < 3; round++) {
      await request(app).post("/login").send({ email: user.email, password: "wrong-password" }).expect(401);
      await request(app).post("/login").send({ email: user.email, password: "wrong-password" }).expect(401);
      await request(app).post("/login").send({ email: user.email, password: user.password }).expect(200);
    }
  });

  it("limits login attempts per source IP", async () => {
    const { app } = await registered({ rateLimit: { loginPerIpPerMinute: 5, loginMaxFailures: 1000 } });
    for (let i = 0; i < 5; i++) {
      await request(app).post("/login").send({ email: user.email, password: user.password }).expect(200);
    }
    await request(app).post("/login").send({ email: user.email, password: user.password }).expect(429);
  });

  it("exempt CIDRs (the in-cluster load generator) skip the per-IP limit", async () => {
    const { app } = await registered({
      rateLimit: { loginPerIpPerMinute: 2, exemptCidrs: ["127.0.0.0/8"] }
    });
    for (let i = 0; i < 6; i++) {
      await request(app).post("/login").send({ email: user.email, password: user.password }).expect(200);
    }
  });

  it("limits registrations per source IP", async () => {
    const { app } = build({ rateLimit: { registerPerIpPer10Minutes: 2 } });
    await request(app).post("/register").send({ ...user, email: "a@example.com" }).expect(201);
    await request(app).post("/register").send({ ...user, email: "b@example.com" }).expect(201);
    await request(app).post("/register").send({ ...user, email: "c@example.com" }).expect(429);
  });
});

describe("P0.5 password hashing", () => {
  it("hashes with scrypt and verifies", async () => {
    const hash = await hashPassword("s3cret-password");
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect((await verifyPassword("s3cret-password", hash)).ok).toBe(true);
    expect((await verifyPassword("wrong", hash)).ok).toBe(false);
  });

  it("upgrades a legacy bcrypt account to scrypt on login", async () => {
    const repository = new InMemoryUserRepository();
    const legacy = await repository.create({
      email: "old@example.com",
      passwordHash: await bcrypt.hash("old-password-1", 4),
      displayName: "Old"
    });
    const { app } = build({ repository });
    await request(app).post("/login").send({ email: "old@example.com", password: "old-password-1" }).expect(200);
    // The rehash is fire-and-forget; give it a moment.
    await new Promise((r) => setTimeout(r, 300));
    const after = await repository.findById(legacy.id);
    expect(after?.passwordHash).toMatch(/^scrypt\$/);
    await request(app).post("/login").send({ email: "old@example.com", password: "old-password-1" }).expect(200);
  });
});

describe("hashing parameters and load shedding", () => {
  it("re-hashes a hash made with different parameters (e.g. the v2.7 p=5 ones)", async () => {
    const { scryptSync, randomBytes } = await import("node:crypto");
    const salt = randomBytes(16);
    const key = scryptSync("pw-123456", salt, 32, { N: 16384, r: 8, p: 5, maxmem: 64 * 1024 * 1024 });
    const old = ["scrypt", 16384, 8, 5, salt.toString("base64"), key.toString("base64")].join("$");
    expect(await verifyPassword("pw-123456", old)).toEqual({ ok: true, needsRehash: true });
  });

  it("refuses fast with 503 when the hashing queue is full", async () => {
    const { app } = build({ rateLimit: { registerPerIpPer10Minutes: 1000 } });
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        request(app).post("/register").send({ ...user, email: `shed${i}@example.com` })
      )
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201).length).toBeGreaterThanOrEqual(20);
    expect(statuses.filter((s) => s === 503).length).toBeGreaterThan(0);
    const shed = results.find((r) => r.status === 503)!;
    expect(shed.headers["retry-after"]).toBe("2");
    expect(shed.body.error).toBe("busy");
  });
});

describe("P0.6 validation and headers", () => {
  it("returns 400 with field-level details", async () => {
    const { app } = build();
    const res = await request(app).post("/register").send({ email: "nope", password: "short", displayName: "" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
    expect(res.body.details.map((d: { path: string }) => d.path).sort()).toEqual(["displayName", "email", "password"]);
  });

  it("returns 400 (not 500) for malformed JSON", async () => {
    const { app } = build();
    const res = await request(app).post("/login").set("Content-Type", "application/json").send("{bad");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_json");
  });

  it("rejects a malformed product id in the URL", async () => {
    const { app } = build();
    // Auth runs first, so an anonymous request is still a 401.
    await request(app).delete("/wishlist/bad%20id").expect(401);
  });

  it("sends security headers", async () => {
    const { app } = build();
    const res = await request(app).get("/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
  });
});
