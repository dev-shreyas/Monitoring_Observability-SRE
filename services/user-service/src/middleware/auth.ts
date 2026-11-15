/**
 * JWT bearer-token authentication.
 *
 * user-service ISSUES tokens (in routes/users.ts) and VERIFIES them here.
 * order-service verifies the same tokens with the same shared secret, which
 * is why JWT_SECRET must be the same Key Vault secret in both deployments.
 */
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { unauthorized } from "../errors";

/** The claims we put into every token we sign. */
export interface TokenClaims {
  sub: string;    // user id
  email: string;
}

export type AuthUser = {
  sub: string;
  email: string;
};

export type AuthenticatedRequest = Request & {
  user?: AuthUser;
};

export function signToken(claims: TokenClaims): string {
  return jwt.sign(claims, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
    issuer: config.serviceName
  } as jwt.SignOptions);
}

/**
 * Guard for protected routes. Mount it per-route, not globally — /health and
 * /metrics must stay open or Kubernetes probes and Prometheus scrapes fail.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return next(unauthorized("Missing or malformed Authorization header"));
  }

  const token = header.slice("Bearer ".length);

  try {
    const claims = jwt.verify(token, config.jwtSecret) as TokenClaims;
    // Hand the identity to the route handlers via the request object.
    (req as AuthenticatedRequest).user = { sub: claims.sub, email: claims.email };
    next();
  } catch {
    // Covers expired, tampered and wrong-secret tokens alike. We deliberately
    // do not tell the caller which, to avoid helping an attacker.
    next(unauthorized("Invalid or expired token"));
  }
}
