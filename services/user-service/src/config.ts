/**
 * The ONE place in the service that reads process.env.
 *
 * Why centralise it: in Kubernetes every value below arrives as an env var
 * (from a ConfigMap for plain settings, from Key Vault via the CSI driver for
 * secrets). Keeping the reads in one file means you can see the service's
 * whole configuration surface at a glance, and nothing deep in the code
 * silently depends on an env var you forgot to set in the Helm values.
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

export const config = {
  /** Appears in logs, metrics labels and the /health payload. */
  serviceName: "user-service",

  /** 3001 for user-service — matches EXPOSE 3001 in the PDF's Dockerfile. */
  port: Number(process.env.PORT ?? 3001),

  nodeEnv: process.env.NODE_ENV ?? "development",

  /** Signing key for the JWTs this service issues. Key Vault secret in prod. */
  jwtSecret: jwtSecretFromEnv(),

  /** How long an issued token stays valid. */
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "1h",

  /**
   * Azure SQL connection string. Unused today (the repository is in-memory),
   * but read here so the wiring is already in place when you swap in `mssql`.
   */
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

  sqlConnectionString: process.env.SQL_CONNECTION_STRING ?? "",

  /**
   * Service-to-service URL, same pattern as order-service's productClient:
   * the wishlist validates a product exists before saving it. Empty string
   * => fall back to the built-in stub catalog (used by tests and standalone
   * runs).
   */
  productServiceUrl: process.env.PRODUCT_SERVICE_URL ?? "",

  /** Never let a slow dependency hold our request threads open forever. */
  httpTimeoutMs: Number(process.env.HTTP_TIMEOUT_MS ?? 3000),

  /**
   * Abuse protection for /login and /register (see security/rateLimiter.ts).
   * Defaults suit a shop: no human signs in 20 times a minute, and five wrong
   * passwords in a row is a guess, not a typo.
   */
  rateLimit: {
    loginPerIpPerMinute: Number(process.env.LOGIN_MAX_PER_IP_PER_MINUTE ?? 20),
    loginMaxFailures: Number(process.env.LOGIN_MAX_FAILURES ?? 5),
    lockoutSeconds: Number(process.env.LOGIN_LOCKOUT_SECONDS ?? 900),
    registerPerIpPer10Minutes: Number(process.env.REGISTER_MAX_PER_IP ?? 10),
    /** Comma-separated IPv4 CIDRs exempt from the per-IP limits (the pod CIDR). */
    exemptCidrs: (process.env.RATE_LIMIT_EXEMPT_CIDRS ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean)
  },

  /** Seconds to keep serving in-flight requests after SIGTERM. */
  shutdownTimeoutMs: Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 10000)
} as const;
