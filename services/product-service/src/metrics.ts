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
 * Reservation lifecycle (P1.1). held -> committed is a sale; held -> released or
 * expired is stock coming back. A rising out_of_stock rate is lost revenue;
 * a rising expired rate means orders are not being confirmed in time.
 */
export const reservationOutcomes = new client.Counter({
  name: "inventory_reservations_total",
  help: "Stock reservations by outcome (held, committed, released, expired, out_of_stock)",
  labelNames: ["outcome"],
  registers: [registry]
});

/** Live stock per product, read from the stock store on every scrape. */
let stockReader: (() => Promise<Map<string, number>>) | null = null;
export function setStockReader(reader: () => Promise<Map<string, number>>): void {
  stockReader = reader;
}
new client.Gauge({
  name: "inventory_stock_units",
  help: "Units available to reserve, per product",
  labelNames: ["product_id"],
  registers: [registry],
  async collect() {
    if (!stockReader) return;
    try {
      for (const [id, units] of await stockReader()) this.set({ product_id: id }, units);
    } catch {
      // A Redis blip must not break the whole /metrics scrape.
    }
  }
});
