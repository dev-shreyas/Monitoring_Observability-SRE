/**
 * The service's actual business API — section 6 of the guide:
 *   POST /register   create an account
 *   POST /login      exchange credentials for a JWT
 *   GET  /profile    read the caller's own profile (requires the JWT)
 *
 * Abuse protection (P0.5):
 *   - per source IP:   at most N login attempts a minute, M registrations per 10 min
 *   - per account:     after K wrong passwords the account is locked for a window
 *   Both answer 429 with a Retry-After header.
 */
import { Router, type Request } from "express";
import { config } from "../config";
import { AppError, conflict, tooManyRequests, unauthorized, notFound } from "../errors";
import { authThrottled, hashShed, loginAttempts, passwordRehashes } from "../metrics";
import { logger } from "../logger";
import { requireAuth, signToken, type AuthenticatedRequest } from "../middleware/auth";
import {
  EmailTakenError,
  type UserRecord,
  type UserRepository
} from "../repository/userRepository";
import { burnVerifyTime, HashingBusyError, hashPassword, verifyPassword } from "../security/passwords";
import { buildExemptList, isExempt, type CounterStore } from "../security/rateLimiter";
import { validate, z } from "../validation";

const registerBody = z.object({
  email: z.string().trim().toLowerCase().max(254).email("must be a valid email address"),
  // 128 caps the hashing cost an attacker can force with one request.
  password: z.string().min(8, "must be at least 8 characters").max(128, "must be at most 128 characters"),
  displayName: z.string().trim().min(1, "is required").max(80, "must be at most 80 characters")
});

const loginBody = z.object({
  email: z.string().trim().toLowerCase().min(1, "is required").max(254),
  password: z.string().min(1, "is required").max(128)
});

type RegisterBody = z.infer<typeof registerBody>;
type LoginBody = z.infer<typeof loginBody>;

/** Never return the password hash to a client, not even to its owner. */
function toPublicUser(user: UserRecord) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    createdAt: user.createdAt
  };
}

/** 503 + Retry-After when the hashing queue is full (see security/passwords.ts). */
function busy(): AppError {
  hashShed.inc();
  return new AppError(503, "We are busy right now. Please try again in a moment.", "busy", undefined, 2);
}

function minutes(seconds: number): string {
  const m = Math.max(1, Math.ceil(seconds / 60));
  return `${m} minute${m === 1 ? "" : "s"}`;
}

export type RateLimitSettings = typeof config.rateLimit;

export interface UsersRouterDeps {
  repository: UserRepository;
  counters: CounterStore;
  /** Overrides for tests; production reads config.rateLimit from the environment. */
  rateLimit?: Partial<RateLimitSettings>;
}

/**
 * A FACTORY, not a bare router: the repository is passed in (dependency
 * injection). That is what lets app.ts wire the real store and a test wire a
 * fake one, without any global mutable state.
 */
export function createUsersRouter({ repository, counters, rateLimit }: UsersRouterDeps): Router {
  const router = Router();
  const limits: RateLimitSettings = { ...config.rateLimit, ...rateLimit };
  const exempt = buildExemptList(limits.exemptCidrs);

  /** Per-IP fixed window. Throws 429 once the budget for this window is spent. */
  async function limitByIp(req: Request, action: string, max: number, windowSeconds: number) {
    if (isExempt(exempt, req.ip)) return;
    const key = `ratelimit:${action}:ip:${req.ip}`;
    const count = await counters.hit(key, windowSeconds);
    if (count > max) {
      authThrottled.inc({ reason: `${action}_ip` });
      if (action === "login") loginAttempts.inc({ outcome: "throttled" });
      const wait = await counters.ttl(key);
      throw tooManyRequests(`Too many ${action} attempts from your network. Try again in ${minutes(wait)}.`, wait);
    }
  }

  router.post("/register", validate({ body: registerBody }), async (req, res, next) => {
    try {
      const { email, password, displayName } = req.body as RegisterBody;
      await limitByIp(req, "register", limits.registerPerIpPer10Minutes, 600);

      // Fast path only — saves hashing for an obvious duplicate. The real
      // guarantee is the atomic claim inside repository.create().
      if (await repository.findByEmail(email)) {
        throw conflict("An account with that email already exists");
      }

      const passwordHash = await hashPassword(password);
      const user = await repository.create({ email, passwordHash, displayName });

      res.status(201).json(toPublicUser(user));
    } catch (err) {
      // Lost the race to a concurrent registration of the same email.
      if (err instanceof EmailTakenError) return next(conflict(err.message));
      if (err instanceof HashingBusyError) return next(busy());
      // Async errors are NOT caught by Express 4 automatically — forwarding
      // them to next() is what routes them to errorHandler.
      next(err);
    }
  });

  router.post("/login", validate({ body: loginBody }), async (req, res, next) => {
    try {
      const { email, password } = req.body as LoginBody;
      await limitByIp(req, "login", limits.loginPerIpPerMinute, 60);

      // Account lockout: checked BEFORE the password, so a locked account costs
      // the attacker a 429 and costs us no hashing at all.
      const failuresKey = `ratelimit:login:fail:${email}`;
      if ((await counters.count(failuresKey)) >= limits.loginMaxFailures) {
        authThrottled.inc({ reason: "account_locked" });
        loginAttempts.inc({ outcome: "throttled" });
        const wait = await counters.ttl(failuresKey);
        throw tooManyRequests(
          `Too many failed sign-in attempts for this account. Try again in ${minutes(wait)}.`,
          wait
        );
      }

      const user = await repository.findByEmail(email);

      // Same generic message, AND the same time spent, whether the email is
      // unknown or the password is wrong — otherwise the endpoint becomes an
      // account-enumeration oracle.
      let ok = false;
      if (user) {
        const result = await verifyPassword(password, user.passwordHash);
        ok = result.ok;
        if (ok && result.needsRehash) {
          // Upgrade legacy bcrypt to scrypt now that we hold the plaintext.
          // Best effort: a failure here must not fail the login.
          hashPassword(password)
            .then((hash) => repository.updatePasswordHash(user.id, hash))
            .then(() => passwordRehashes.inc())
            .catch((e: Error) => logger.warn("password rehash failed", { reason: e.message }));
        }
      } else {
        await burnVerifyTime(password);
      }

      if (!user || !ok) {
        await counters.hit(failuresKey, limits.lockoutSeconds);
        loginAttempts.inc({ outcome: "failure" });
        throw unauthorized("Invalid email or password");
      }

      await counters.reset(failuresKey);
      loginAttempts.inc({ outcome: "success" });
      res.json({
        token: signToken({ sub: user.id, email: user.email }),
        tokenType: "Bearer",
        user: toPublicUser(user)
      });
    } catch (err) {
      if (err instanceof HashingBusyError) return next(busy());
      next(err);
    }
  });

  // requireAuth runs first; the handler only ever sees authenticated callers.
  router.get("/profile", requireAuth, async (req, res, next) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user?.sub;
      if (!userId) throw new Error("Unauthorized request: missing user identity");
      // The id comes from the signed token, never from a query parameter —
      // that is what stops one user reading another user's profile.
      const user = await repository.findById(userId);
      if (!user) throw notFound("User no longer exists");

      res.json(toPublicUser(user));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
