/**
 * The process entry point — this is what `CMD ["node", "dist/index.js"]` runs.
 *
 * Its only jobs: open the port, and shut down cleanly. Everything about the
 * API itself lives in app.ts.
 */
// MUST stay first: auto-instrumentation patches express/http/redis as they load,
// so anything imported above this line is traced as nothing at all.
import { shutdownTracing } from "./tracing";
import app, { stockStore } from "./app";
import { config } from "./config";
import { logger } from "./logger";
import { reservationOutcomes, setStockReader } from "./metrics";
import { closeRedis } from "./redisClient";
import { SEED_STOCK } from "./repository/productRepository";

const server = app.listen(config.port, () => {
  logger.info("service started", { port: config.port, nodeEnv: config.nodeEnv });
});

setStockReader(() => stockStore.levels(Object.keys(SEED_STOCK)));

/**
 * RESERVATION EXPIRY SWEEPER (P1.1). A held reservation whose order was never
 * confirmed — order-service crashed between "reserve" and "commit", or (from
 * P1.3) the shopper never paid — must give its stock back, or every crash
 * silently shrinks the shelf. Every replica runs this; that is safe because the
 * release script only acts on a reservation that is still "held", atomically,
 * so two pods racing for the same one return the stock exactly once.
 */
const SWEEP_INTERVAL_MS = 30_000;
const sweeper = setInterval(() => {
  void (async () => {
    try {
      for (const id of await stockStore.expired(Date.now(), 50)) {
        if ((await stockStore.release(id, "expired", true)) === "released_now") {
          reservationOutcomes.inc({ outcome: "expired" });
          logger.warn("reservation expired; stock returned", { reservationId: id });
        }
      }
    } catch (err) {
      logger.error("reservation sweep failed", { reason: (err as Error).message });
    }
  })();
}, SWEEP_INTERVAL_MS);
sweeper.unref();

/**
 * GRACEFUL SHUTDOWN — the single most important piece of Kubernetes
 * plumbing in this file.
 *
 * On a rolling update Kubernetes sends SIGTERM and waits (30s by default)
 * before SIGKILL. Node's default SIGTERM behaviour is to die instantly,
 * which drops every in-flight request and shows up to users as 502s during
 * every deploy. Here we instead:
 *   - stop accepting new connections
 *   - let in-flight requests finish
 *   - exit 0 when they are done, or force-exit if they hang
 */
function shutdown(signal: string): void {
  logger.info("shutdown signal received", { signal });

  // Safety net: never let a stuck connection hold the pod open until SIGKILL.
  const forceExit = setTimeout(() => {
    logger.error("graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, config.shutdownTimeoutMs);

  // .unref() lets the process exit naturally if shutdown finishes first.
  forceExit.unref();

  server.close(() => {
    // Flush buffered spans AFTER the server has drained, so the last requests' spans
    // are included, and BEFORE exit, so they are not lost with the process.
    clearInterval(sweeper);
    void closeRedis()
      .then(() => shutdownTracing())
      .finally(() => {
        logger.info("all connections closed, exiting");
        process.exit(0);
      });
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM")); // from Kubernetes
process.on("SIGINT", () => shutdown("SIGINT"));   // from Ctrl-C locally

/**
 * A promise rejection nobody handled means our state is unknown. Log it and
 * die: Kubernetes will restart a fresh pod, which is safer than continuing
 * to serve traffic from a process in an undefined state.
 */
process.on("unhandledRejection", (reason) => {
  logger.error("unhandled promise rejection", { reason: String(reason) });
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  logger.error("uncaught exception", { reason: err.message, stack: err.stack });
  process.exit(1);
});
