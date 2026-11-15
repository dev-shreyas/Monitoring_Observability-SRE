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

/** Token for calling product-service's /internal API (and guarding our own). Fails closed in production. */
export function internalTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.INTERNAL_API_TOKEN ?? "";
  if (env.NODE_ENV !== "production") return value || DEV_INTERNAL_TOKEN;
  if (value.length < 32 || value === DEV_INTERNAL_TOKEN) {
    throw new Error("INTERNAL_API_TOKEN is missing or shorter than 32 characters; refusing to start in production");
  }
  return value;
}

export const config = {
  serviceName: "order-service",

  /** 3003 — matches EXPOSE 3003 in the PDF's Dockerfile. */
  port: Number(process.env.PORT ?? 3003),

  nodeEnv: process.env.NODE_ENV ?? "development",

  /**
   * The SAME secret user-service signs with. This service only VERIFIES
   * tokens, it never issues them — that is what makes user-service the single
   * source of identity truth.
   */
  jwtSecret: jwtSecretFromEnv(),

  /**
   * Shared state store. Carts, orders and sessions MUST NOT live in process
   * memory: with more than one replica, requests round-robin between pods and a
   * cart written on one pod is invisible on the next (see redisClient.ts).
   *
   * Empty string => the in-memory repositories are used. That is what keeps the
   * unit tests hermetic and fast: they need no Redis running. Kubernetes sets
   * this, so every deployed replica shares one store.
   */
  redisUrl: process.env.REDIS_URL ?? "",

  /** Orders and their line items are relational and need ACID -> Azure SQL. */
  sqlConnectionString: process.env.SQL_CONNECTION_STRING ?? "",

  /**
   * Service-to-service URLs. In docker-compose and in Kubernetes these are
   * DNS names, never localhost: each service is a separate container with its
   * own network namespace, so "localhost" inside this pod means THIS pod.
   * Empty string => fall back to the built-in stub catalog (used by tests).
   */
  productServiceUrl: process.env.PRODUCT_SERVICE_URL ?? "",
  userServiceUrl: process.env.USER_SERVICE_URL ?? "",

  /** Never let a slow dependency hold our request threads open forever. */
  httpTimeoutMs: Number(process.env.HTTP_TIMEOUT_MS ?? 3000),

  /** Azure Service Bus. Empty => the logging publisher is used instead. */
  serviceBus: {
    connectionString: process.env.SERVICE_BUS_CONNECTION_STRING ?? "",
    topic: process.env.SERVICE_BUS_TOPIC ?? "order-events"
  },

  internalApiToken: internalTokenFromEnv(),

  /**
   * Payments (P1.3) are not built yet — the gateway choice (decision D1) is open.
   * "none" = checkout confirms the order straight away (pending_payment -> paid,
   * recorded in the order history as an automatic confirmation). P1.3 replaces
   * this with confirmation from the provider's signed webhook.
   */
  paymentProvider: process.env.PAYMENT_PROVIDER ?? "none",

  /** An order still pending_payment after this long is cancelled and its stock released. */
  pendingPaymentTtlSeconds: Number(process.env.PENDING_PAYMENT_TTL_SECONDS ?? 900),

  shutdownTimeoutMs: Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 10000)
} as const;
