/**
 * OpenTelemetry bootstrap. MUST be the first import in index.ts.
 *
 * WHY THE ORDER MATTERS (roadmap 7, "understand first" question 5)
 * ----------------------------------------------------------------
 * Auto-instrumentation works by MONKEY-PATCHING the modules it traces: it replaces
 * methods on express, http and redis as they are loaded. Node caches a module the
 * first time it is required, so anything required BEFORE this file runs keeps the
 * original, unpatched version and produces no spans. There is no error message. The
 * app works perfectly and Tempo simply stays empty. Hence `import "./tracing";` sits
 * above every other import in index.ts, and this file imports none of our own code
 * (./config or ./logger would load -- and cache -- modules before patching).
 *
 * CONFIGURATION IS ENVIRONMENT-ONLY
 * ---------------------------------
 * Nothing here is hard-coded. The standard OTEL_* variables decide where spans go
 * (OTEL_EXPORTER_OTLP_ENDPOINT), who sent them (OTEL_SERVICE_NAME), and extra
 * identity (OTEL_RESOURCE_ATTRIBUTES). The same image therefore runs locally with
 * tracing off, on kind sending to a node-local agent, and on AKS sending somewhere
 * else, with no rebuild. That portability is the point of OpenTelemetry: the
 * instrumentation is ours and the backend is a routing decision.
 */
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { ExpressLayerType } from "@opentelemetry/instrumentation-express";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
// NOTE: resources 1.x exports the Resource CLASS. The resourceFromAttributes()
// helper is a 2.x API -- using it here fails with "has no exported member".
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

/**
 * Traces are OFF unless an endpoint is configured. This keeps `npm test` and local
 * runs free of a collector, exactly like REDIS_URL gates the Redis repositories --
 * without it every test run would spend its timeout retrying a connection to a
 * collector that is not there.
 */
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

let sdk: NodeSDK | null = null;

if (!endpoint) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level: "info", message: "tracing disabled (OTEL_EXPORTER_OTLP_ENDPOINT not set)" }));
} else {
  sdk = new NodeSDK({
    /**
     * The resource describes WHO is emitting the spans and is attached to every one.
     * service.name is the single most important attribute in tracing: it is what
     * Grafana groups by and what Tempo's service graph is built from. Without it
     * every span shows up as "unknown_service".
     *
     * The SDK also merges OTEL_RESOURCE_ATTRIBUTES from the environment, which the
     * Deployment uses to add k8s.pod.name and k8s.namespace.name via the downward API.
     * Alloy's k8sattributes processor fills in the rest (deployment, node, container).
     */
    resource: new Resource({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "unknown-service",
      [ATTR_SERVICE_VERSION]: process.env.SERVICE_VERSION ?? "0.0.0"
    }),

    /**
     * OTLP over HTTP/protobuf on port 4318 rather than gRPC on 4317. Both are open on
     * the agent; HTTP needs no native gRPC dependency and a failing export is a plain
     * HTTP status reproducible with curl. The exporter appends /v1/traces itself.
     */
    traceExporter: new OTLPTraceExporter({
      url: `${endpoint.replace(/\/$/, "")}/v1/traces`
    }),

    instrumentations: [
      getNodeAutoInstrumentations({
        /**
         * Filesystem instrumentation turns every internal file read into a span. It is
         * the single largest source of trace noise for almost no diagnostic value.
         */
        "@opentelemetry/instrumentation-fs": { enabled: false },

        "@opentelemetry/instrumentation-express": {
          /**
           * Express emits one span per middleware layer (jsonParser, expressInit,
           * query, our own requestLogger...) -- about ten per request, each a few
           * microseconds long and all telling you the same thing. Measured on this
           * cluster they were ~85% of all spans. They inflate storage and sampling
           * cost and bury the spans that matter. Only the request handler span is
           * kept; the HTTP server span above it already carries route and status.
           */
          ignoreLayersType: [ExpressLayerType.MIDDLEWARE, ExpressLayerType.ROUTER]
        },

        "@opentelemetry/instrumentation-http": {
          /**
           * Drop spans for probes. The kubelet hits /health every 10s on every pod,
           * and Prometheus scrapes /metrics every 30s. Left in, probes are the large
           * majority of all spans and distort any latency percentile computed from
           * them. Requests that are never traced also never carry a trace id into
           * the logs, which is exactly right for a probe.
           */
          ignoreIncomingRequestHook: (req) => {
            const url = req.url ?? "";
            return url === "/health" || url.startsWith("/health?") || url === "/metrics";
          }
        }
      })
    ]
  });

  sdk.start();
}

/**
 * Flush buffered spans. Spans are batched for up to a few seconds before export, so
 * a process that exits on SIGTERM without this loses precisely the spans from the
 * shutdown you most want to investigate. index.ts awaits this AFTER the HTTP server
 * has drained and BEFORE process.exit(), so the final requests' spans are included.
 *
 * Resolves (never rejects) so a collector outage can never block a pod from exiting.
 */
export async function shutdownTracing(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch {
    // Nothing useful to do: the process is exiting and the logger may already be gone.
  }
}
