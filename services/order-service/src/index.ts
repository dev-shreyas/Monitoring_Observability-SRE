/**
 * The process entry point — this is what `CMD ["node", "dist/index.js"]` runs.
 *
 * Its only jobs: open the port, and shut down cleanly. Everything about the
 * API itself lives in app.ts.
 */
// MUST stay first: auto-instrumentation patches express/http/redis as they load,
// so anything imported above this line is traced as nothing at all.
import { shutdownTracing } from "./tracing";
import app, { lifecycle } from "./app";
import { config } from "./config";
import { logger } from "./logger";
import { closeRedis } from "./redisClient";

const server = app.listen(config.port, () => {
  logger.info("service started", { port: config.port, nodeEnv: config.nodeEnv });
});

/**
 * OVERDUE-PAYMENT SWEEPER (P1.2). An order left pending_payment past its
 * deadline is cancelled by the system and its stock returned. Runs on every
 * replica; each overdue order is claimed by exactly one (see claimOverduePending).
 */
const sweeper = setInterval(() => {
  lifecycle
    .cancelOverdue()
    .then((n) => n > 0 && logger.info("cancelled overdue unpaid orders", { count: n }))
    .catch((err: Error) => logger.error("overdue sweep failed", { reason: err.message }));
}, 30_000);
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

  clearInterval(sweeper);
  server.close(() => {
    // Close Redis only AFTER the HTTP server has drained. Closing it first would
    // fail the very in-flight requests this graceful shutdown exists to protect.
    void closeRedis()
      // Then flush the trace exporter. It is last on purpose: the Redis close above
      // may itself produce the final spans, and nothing after this point is traced.
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
