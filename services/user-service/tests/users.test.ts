/**
 * Integration tests for the whole HTTP surface, run in-process.
 *
 * supertest boots the Express app on an ephemeral port, fires real HTTP
 * requests at it and shuts it down — so this exercises routing, middleware,
 * validation and error handling together, but needs no database, no Docker
 * and no network. That is why it is safe to run in the CI pipeline's test
 * stage (guide section 20) on every pull request.
 */
import request from "supertest";
import { createApp } from "../src/app";
import { InMemoryUserRepository } from "../src/repository/userRepository";

/**
 * A FRESH repository per test file keeps tests independent — a leftover user
 * from one test must never make another test pass or fail.
 */
const app = createApp({ repository: new InMemoryUserRepository() });

const validUser = {
  email: "alice@example.com",
  password: "correct-horse-battery",
  displayName: "Alice"
};

describe("GET /health", () => {
  it("returns the payload the guide documents", async () => {
    const res = await request(app).get("/health").expect(200);

    expect(res.body.status).toBe("ok");
    expect(res.body.service).toBe("user-service");
    expect(typeof res.body.uptime).toBe("number");
  });
});

describe("GET /metrics", () => {
  it("exposes Prometheus text format", async () => {
    const res = await request(app).get("/metrics").expect(200);

    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.text).toContain("http_request_duration_seconds");
  });
});

describe("POST /register", () => {
  it("creates a user and never returns the password hash", async () => {
    const res = await request(app).post("/register").send(validUser).expect(201);

    expect(res.body).toMatchObject({ email: validUser.email, displayName: "Alice" });
    expect(res.body.id).toEqual(expect.any(String));
    expect(res.body).not.toHaveProperty("passwordHash");
  });

  it("rejects a duplicate email with 409", async () => {
    await request(app).post("/register").send(validUser).expect(409);
  });

  it("rejects a short password with 400", async () => {
    await request(app)
      .post("/register")
      .send({ ...validUser, email: "bob@example.com", password: "short" })
      .expect(400);
  });
});

describe("POST /login", () => {
  it("returns a bearer token for correct credentials", async () => {
    const res = await request(app)
      .post("/login")
      .send({ email: validUser.email, password: validUser.password })
      .expect(200);

    expect(res.body.tokenType).toBe("Bearer");
    expect(res.body.token).toEqual(expect.any(String));
  });

  it("gives the same 401 for a wrong password and an unknown email", async () => {
    const wrongPassword = await request(app)
      .post("/login")
      .send({ email: validUser.email, password: "nope" })
      .expect(401);

    const unknownEmail = await request(app)
      .post("/login")
      .send({ email: "nobody@example.com", password: "nope" })
      .expect(401);

    // Identical responses: the endpoint must not reveal which emails exist.
    expect(wrongPassword.body).toEqual(unknownEmail.body);
  });
});

describe("GET /profile", () => {
  it("returns the caller's own profile when given a valid token", async () => {
    const login = await request(app)
      .post("/login")
      .send({ email: validUser.email, password: validUser.password });

    const res = await request(app)
      .get("/profile")
      .set("Authorization", `Bearer ${login.body.token}`)
      .expect(200);

    expect(res.body.email).toBe(validUser.email);
  });

  it("rejects a request with no token", async () => {
    await request(app).get("/profile").expect(401);
  });

  it("rejects a tampered token", async () => {
    await request(app).get("/profile").set("Authorization", "Bearer not.a.real.token").expect(401);
  });
});

describe("unknown routes", () => {
  it("returns a JSON 404, not an HTML error page", async () => {
    const res = await request(app).get("/does-not-exist").expect(404);
    expect(res.body.error).toBe("not_found");
  });
});
