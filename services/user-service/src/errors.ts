/**
 * One error type and two terminal middlewares, so that every failure leaves
 * the service as JSON with a sensible status code — never as an HTML stack
 * trace, and never as a 200 with an error body.
 *
 * Every error body has the same shape, so a client needs one parser:
 *
 *   { "error": "<machine code>", "message": "<human text>", "details"?: [...] }
 *
 * `details` appears only on validation errors: one entry per bad field,
 * `{ "path": "quantity", "message": "..." }`, so a form can highlight the field.
 */
import type { NextFunction, Request, Response } from "express";
import { logger } from "./logger";

export interface FieldIssue {
  path: string;
  message: string;
}

/** An error we raised deliberately and whose status code we chose. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** Machine-readable code — stable, unlike the message. */
    public readonly code: string = "request_error",
    public readonly details?: FieldIssue[],
    /** Sets a Retry-After header (seconds) — used with 429 and 409-in-progress. */
    public readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** Convenience constructors for the codes this service actually returns. */
export const badRequest = (m: string) => new AppError(400, m);
export const unauthorized = (m: string) => new AppError(401, m);
export const notFound = (m: string) => new AppError(404, m);
export const conflict = (m: string, retryAfterSeconds?: number) =>
  new AppError(409, m, "conflict", undefined, retryAfterSeconds);
export const unprocessable = (m: string) => new AppError(422, m, "unprocessable");
export const tooManyRequests = (m: string, retryAfterSeconds: number) =>
  new AppError(429, m, "too_many_requests", undefined, retryAfterSeconds);
export const validationError = (details: FieldIssue[]) =>
  new AppError(
    400,
    details.map((d) => (d.path ? `'${d.path}': ${d.message}` : d.message)).join("; "),
    "validation_error",
    details
  );

/** Runs when no route matched. Must sit AFTER all routes are mounted. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: "not_found", message: `No route for ${req.method} ${req.path}` });
}

/**
 * Errors thrown by express.json() BEFORE any route runs: malformed JSON, a body
 * over the size limit, an unsupported charset. They carry a 4xx `status` and a
 * `type` like "entity.parse.failed". Without this mapping they fell through to
 * the generic branch and a typo in a request body came back as a 500 — counted
 * as a server error on the dashboard and in the error-rate SLO.
 */
function bodyParserError(err: unknown): AppError | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { type?: unknown; status?: unknown };
  if (typeof e.type !== "string" || typeof e.status !== "number") return null;
  if (e.status < 400 || e.status >= 500) return null;
  if (e.type === "entity.parse.failed") return new AppError(400, "Request body is not valid JSON", "invalid_json");
  if (e.type === "entity.too.large") return new AppError(413, "Request body is too large", "payload_too_large");
  return new AppError(e.status, "Request body could not be read", "invalid_body");
}

/**
 * A call to another service that timed out (AbortSignal.timeout -> TimeoutError)
 * or could not connect. That is not a bug in this service: answer 503 with
 * Retry-After so clients know it is temporary and safe to retry, instead of an
 * opaque 500.
 */
function dependencyError(err: unknown): AppError | null {
  // Duck-typed, not `instanceof Error`: fetch's errors (DOMException, undici's
  // TypeError) can come from a different realm, where instanceof is false.
  if (!err || typeof err !== "object") return null;
  const e = err as { name?: unknown; message?: unknown; cause?: { code?: string } };
  const cause = e.cause;
  if (e.name === "TimeoutError" || e.name === "AbortError") {
    return new AppError(503, "A service we depend on is slow right now; please try again", "dependency_timeout", undefined, 1);
  }
  if (e.message === "fetch failed" && cause?.code) {
    return new AppError(503, "A service we depend on is unavailable; please try again", "dependency_unavailable", undefined, 2);
  }
  return null;
}

/**
 * Express recognises a middleware as an error handler purely by its arity:
 * it must take exactly four arguments. `_next` is unused but required.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const known = err instanceof AppError ? err : (bodyParserError(err) ?? dependencyError(err));
  const status = known ? known.status : 500;
  const message = known ? known.message : "Internal server error";

  // 4xx are the caller's problem and are expected; logging them at error level
  // would bury the 5xx that actually page someone.
  const log = status >= 500 ? logger.error : logger.warn;
  log("request failed", {
    method: req.method,
    path: req.path,
    status,
    // Log the real reason internally...
    reason: err instanceof Error ? err.message : String(err),
    stack: !known && err instanceof Error ? err.stack : undefined
  });

  if (known?.retryAfterSeconds !== undefined) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil(known.retryAfterSeconds))));
  }

  // ...but never leak internals to the caller on a 500.
  res.status(status).json({
    error: known ? known.code : "internal_error",
    message,
    ...(known?.details ? { details: known.details } : {})
  });
}
