/**
 * One structured log line per completed request.
 *
 * Deliberately logs on 'finish' rather than on arrival, so a single line
 * carries the status code and duration too — one event per request is far
 * cheaper to store and easier to query than a start/end pair.
 */
import type { NextFunction, Request, Response } from "express";
import { logger } from "../logger";

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

    // Probe and scrape traffic is constant and would drown out real requests.
    if (req.path === "/health" || req.path === "/metrics") return;

    logger.info("request", {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Number(durationMs.toFixed(2))
    });
  });

  next();
}
