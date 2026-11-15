/**
 * Structured JSON logging to stdout.
 *
 * Rule for containers: never write log files. Write one JSON object per line
 * to stdout. The kubelet captures stdout, Azure Monitor's container insights
 * agent ships it to the Log Analytics Workspace, and because it is JSON you
 * can query fields directly with KQL:
 *
 *   ContainerLogV2 | where LogMessage.service == "user-service"
 *                  | where LogMessage.level == "error"
 *
 * A human-formatted multi-line log would be one unqueryable blob.
 */
import { config } from "./config";

type Level = "info" | "warn" | "error";

function write(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    service: config.serviceName,
    message,
    ...fields
  });
  // stdout for everything: stderr would split one stream into two in the
  // log pipeline for no benefit.
  process.stdout.write(line + "\n");
}

export const logger = {
  info: (message: string, fields?: Record<string, unknown>) => write("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => write("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => write("error", message, fields)
};
