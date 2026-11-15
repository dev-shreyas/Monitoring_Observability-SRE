/**
 * Same pattern as user-service: the only file that reads process.env.
 * The values differ because this service talks to Cosmos DB, not Azure SQL.
 */
/** The fallback used outside production, so `npm run dev` and the tests need no setup. */
export const DEV_JWT_SECRET = "dev-only-insecure-secret-change-me";

/**
 * Values that must never sign a production token: the code default above, and
 * the value that used to sit in plaintext in kind-k8s/base/secrets.yaml. Anyone
 * who has read this repository knows them, so a token signed with either can be
 * forged by anyone — accepting them is the same as having no authentication.
 */
const KNOWN_BAD_JWT_SECRETS = new Set([DEV_JWT_SECRET, "local-dev-shared-jwt-secret-not-for-production"]);
const MIN_JWT_SECRET_LENGTH = 32;

/**
 * FAIL CLOSED. In production a missing, short or publicly known secret stops the
 * process at startup: the pod crash-loops with this message in its log, which
 * is loud and immediate. The alternative — starting with a guessable key — is
 * silent and only discovered after someone forges a token.
 */
export function jwtSecretFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.JWT_SECRET ?? "";
  if (env.NODE_ENV !== "production") return value || DEV_JWT_SECRET;

  if (!value) {
    throw new Error("Missing required environment variable: JWT_SECRET (refusing to start in production)");
  }
  if (KNOWN_BAD_JWT_SECRETS.has(value)) {
    throw new Error("JWT_SECRET is a publicly known development value; refusing to start in production");
  }
  if (value.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(`JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters in production`);
  }
  return value;
}

export const DEV_INTERNAL_TOKEN = "dev-only-internal-token";

/**
 * Service-to-service token for /internal routes. Same fail-closed rule as the
 * JWT secret: production refuses to start without a real one, because an
 * internal API with a guessable token lets anyone restock or release stock.
 */
export function internalTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.INTERNAL_API_TOKEN ?? "";
  if (env.NODE_ENV !== "production") return value || DEV_INTERNAL_TOKEN;
  if (value.length < 32 || value === DEV_INTERNAL_TOKEN) {
    throw new Error("INTERNAL_API_TOKEN is missing or shorter than 32 characters; refusing to start in production");
  }
  return value;
}

export const config = {
  serviceName: "product-service",

  /** 3002 — matches EXPOSE 3002 in the PDF's Dockerfile. */
  port: Number(process.env.PORT ?? 3002),

  nodeEnv: process.env.NODE_ENV ?? "development",

  /**
   * Cosmos DB connection details. All empty locally, which makes the
   * repository factory fall back to the in-memory catalog.
   *
   * In production you would not use COSMOS_KEY at all — you would use
   * Workload Identity (guide section 16) so the pod authenticates as a
   * managed identity and no key exists to leak.
   */
  cosmos: {
    endpoint: process.env.COSMOS_ENDPOINT ?? "",
    key: process.env.COSMOS_KEY ?? "",
    database: process.env.COSMOS_DATABASE ?? "ecommerce",
    container: process.env.COSMOS_CONTAINER ?? "products"
  },

  /** Cap on ?limit= so one caller cannot ask for the entire catalog at once. */
  maxPageSize: Number(process.env.MAX_PAGE_SIZE ?? 100),

  /**
   * Reviews require a signed-in shopper. This service only VERIFIES tokens
   * (same pattern as order-service) — user-service is the sole issuer. Must
   * be the same Key Vault secret in every deployment or every review post
   * returns 401.
   */
  jwtSecret: jwtSecretFromEnv(),

  /**
   * Shared stock and reservations (P1.1). Stock has to live outside the process:
   * with several replicas, a decrement on one pod would be invisible to the
   * others and the same last unit could be sold twice. Empty => in-memory store
   * (tests and single-process runs).
   */
  redisUrl: process.env.REDIS_URL ?? "",

  /** Shared secret for the /internal API (reservations, restock). See internalAuth.ts. */
  internalApiToken: internalTokenFromEnv(),

  /** A held reservation is released automatically after this long (backstop). */
  reservationTtlSeconds: Number(process.env.RESERVATION_TTL_SECONDS ?? 1200),

  shutdownTimeoutMs: Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 10000)
} as const;
