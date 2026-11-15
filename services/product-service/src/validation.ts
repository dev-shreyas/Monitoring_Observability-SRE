/**
 * Request validation with Zod — one schema per route, declared next to the route.
 *
 *   router.post("/cart", requireAuth, validate({ body: addToCartBody }), handler)
 *
 * WHY: hand-written `typeof x !== "string"` checks were spread through every
 * handler, each with its own wording, and several inputs (query arrays, huge
 * strings, extra types) slipped through. A schema states the whole contract in
 * one place, and every failure becomes the same 400 shape (see errors.ts):
 *
 *   { "error": "validation_error", "message": "...",
 *     "details": [{ "path": "quantity", "message": "..." }] }
 *
 * On success the PARSED value replaces the raw one, so handlers receive trimmed,
 * coerced, typed data — `?limit=20` arrives as the number 20, not the string.
 * Unknown body keys are stripped (Zod's default), not rejected, so an older or
 * newer client sending an extra field keeps working.
 */
import type { NextFunction, Request, Response } from "express";
import { z, type ZodTypeAny } from "zod";
import { validationError, type FieldIssue } from "./errors";

export { z };

interface Schemas {
  body?: ZodTypeAny;
  params?: ZodTypeAny;
  query?: ZodTypeAny;
}

function toIssues(error: z.ZodError, where: string): FieldIssue[] {
  return error.issues.map((issue) => ({
    // A body field is named plainly ("email"); params and query are prefixed
    // so "id" in the URL cannot be confused with an "id" in the body.
    path: [where === "body" ? null : where, ...issue.path].filter((p) => p !== null).join("."),
    message: issue.message
  }));
}

export function validate(schemas: Schemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const issues: FieldIssue[] = [];

    for (const where of ["params", "query", "body"] as const) {
      const schema = schemas[where];
      if (!schema) continue;
      // express.json leaves req.body undefined when there is no JSON body at all;
      // treat that as an empty object so "all fields optional" schemas pass.
      const input = where === "body" ? (req.body ?? {}) : req[where];
      const result = schema.safeParse(input);
      if (result.success) {
        // Express 4: params, query and body are plain writable properties.
        (req as unknown as Record<string, unknown>)[where] = result.data;
      } else {
        issues.push(...toIssues(result.error, where));
      }
    }

    if (issues.length > 0) return next(validationError(issues));
    next();
  };
}

/** Product ids look like "p-1001". Bounded so a 1MB path segment is refused early. */
export const productId = z
  .string({ required_error: "is required", invalid_type_error: "must be a string" })
  .regex(/^[A-Za-z0-9_-]{1,64}$/, "must be 1-64 letters, digits, '-' or '_'");
