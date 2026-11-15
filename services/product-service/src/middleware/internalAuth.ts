/**
 * Guard for /internal routes: service-to-service calls only.
 *
 * Three layers keep these away from shoppers:
 *   1. the frontend nginx proxies an allow-list of public paths; /internal is
 *      not on it, so the Ingress can never reach these routes;
 *   2. NetworkPolicies let only the frontend and the two other services connect;
 *   3. this shared token, so a compromised frontend pod still cannot restock.
 */
import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config";
import { AppError } from "../errors";

export function requireInternalToken(token: string = config.internalApiToken) {
  const expected = Buffer.from(token);
  return (req: Request, _res: Response, next: NextFunction): void => {
    const given = Buffer.from(req.get("X-Internal-Token") ?? "");
    // Constant-time comparison; lengths must match first for timingSafeEqual.
    const ok = given.length === expected.length && timingSafeEqual(given, expected);
    next(ok ? undefined : new AppError(403, "Internal endpoint", "forbidden"));
  };
}
