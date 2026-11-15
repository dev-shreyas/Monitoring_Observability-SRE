/**
 * JWT verification — needed only by the reviews routes (posting a review
 * requires a signed-in shopper; browsing the catalog stays anonymous).
 *
 * IMPORTANT ASYMMETRY with user-service: that service both SIGNS and VERIFIES
 * tokens; this one only VERIFIES. There is deliberately no signToken() here —
 * user-service is the single source of identity truth, and no other service
 * is allowed to mint credentials.
 */
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { unauthorized } from "../errors";

export interface TokenClaims {
  sub: string; // user id
  email: string;
}

export type AuthUser = {
  sub: string;
  email: string;
};

export type AuthenticatedRequest = Request & {
  user?: AuthUser;
};

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return next(unauthorized("Missing or malformed Authorization header"));
  }

  const token = header.slice("Bearer ".length);

  try {
    const claims = jwt.verify(token, config.jwtSecret) as TokenClaims;
    (req as AuthenticatedRequest).user = { sub: claims.sub, email: claims.email };
    next();
  } catch {
    next(unauthorized("Invalid or expired token"));
  }
}
