/**
 * Prometheus metrics.
 *
 * Section 9 of the guide says each service exposes /metrics in Prometheus
 * format, scraped by Azure Monitor Managed Prometheus. Two things live here:
 *
 *  1. a registry holding every metric this process publishes
 *  2. an Express middleware that times each request and records the result
 */
import client from "prom-client";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config";

/** A private registry (rather than the global default) keeps tests isolated. */
export const registry = new client.Registry();

/** Every metric from this process is tagged with the service name. */
registry.setDefaultLabels({ service: config.serviceName });

/** CPU, memory, event-loop lag, GC — free, and genuinely useful in incidents. */
client.collectDefaultMetrics({ register: registry });

/**
 * The single most valuable app metric: request latency, split by outcome.
 * From this one histogram you get request rate, error rate and p50/p95/p99
 * latency — three of the four "golden signals".
 */
export const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code"],
  // Buckets chosen around the latencies an API like this actually sees.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry]
});

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const stopTimer = httpRequestDuration.startTimer();

  // 'finish' fires once the response has been fully handed to the socket.
  res.on("finish", () => {
    stopTimer({
      method: req.method,
      // IMPORTANT: req.route.path is the TEMPLATE ("/users/:id"), not the
      // actual URL ("/users/42"). Using the raw URL would create a new time
      // series per user id and blow up cardinality in Prometheus.
      route: req.route?.path ?? "unmatched",
      status_code: res.statusCode
    });
  });

  next();
}

/**
 * How often checkout retries were absorbed by the Idempotency-Key instead of
 * becoming duplicate orders. `replayed` = a retry after success (would have been
 * a second order); `in_progress` = a double-click while the first was running;
 * `mismatch` = a client reusing a key for a different body (a client bug).
 */
export const idempotencyOutcomes = new client.Counter({
  name: "checkout_idempotency_total",
  help: "Checkout requests carrying an Idempotency-Key, by outcome",
  labelNames: ["outcome"],
  registers: [registry]
});

/** Every order status change (P1.2). from="" is creation. Drives the "Orders by status" panels. */
export const orderTransitions = new client.Counter({
  name: "order_transitions_total",
  help: "Order status changes by from, to and actor",
  labelNames: ["from", "to", "actor"],
  registers: [registry]
});

/** Stock that could not be returned after retries — each one is units missing from the shelf. */
export const stockReleaseFailures = new client.Counter({
  name: "order_stock_release_failures_total",
  help: "Reservations that could not be released after retries",
  registers: [registry]
});
