# Phase 7 — Traces

**Time:** 8–10 hours · **Prerequisite:** Phase 6 · **The longest phase; split it over several sessions**

## Why this phase

Metrics say *that* it is slow. Logs say *what* happened in one service. Only a trace says
*where the time went* across services — and in a system where checkout calls the catalog
synchronously, that is the question you will actually need answered.

This is also the phase where you touch application code. That is deliberate: an SRE who
cannot instrument an application is limited to what the platform hands them.

## Understand first

1. What is a span? A trace? A trace **context**? What is actually propagated between two
   services, and in which HTTP header?
2. What is the W3C `traceparent` header, and why does using it rather than a vendor header
   matter commercially?
3. What is **context propagation** inside one Node process? How does a logger called deep
   in a request handler know which trace it belongs to, without anything being passed
   down the call stack?
4. Head sampling vs tail sampling: what can each one do that the other cannot? Which one
   can keep "all the traces that errored", and why can the other never do that?
5. Why is the OpenTelemetry SDK usually started before any other import? What exactly
   breaks otherwise, and what is the symptom? (There is no error message. That is the
   point of the question.)
6. What does the Collector's `k8sattributes` processor do, and what does it need from the
   Kubernetes API to do it?

## Read

- [OpenTelemetry — concepts: traces](https://opentelemetry.io/docs/concepts/signals/traces/)
- [OpenTelemetry — JS getting started & auto-instrumentation](https://opentelemetry.io/docs/languages/js/)
- [OpenTelemetry Collector — architecture](https://opentelemetry.io/docs/collector/architecture/)
  and [deployment patterns](https://opentelemetry.io/docs/collector/deployment/) — agent vs
  gateway
- [Tempo — architecture](https://grafana.com/docs/tempo/latest/operations/architecture/)
  and the metrics-generator page
- [W3C Trace Context](https://www.w3.org/TR/trace-context/) — skim, but know what the
  header looks like

## Build

### 7.1 Instrument one service

Start with `product-service` only. Add the OTel Node SDK with auto-instrumentation for
HTTP and Express, exporting OTLP over HTTP.

Rules for yourself:

- configure everything through the standard `OTEL_*` environment variables, not
  hard-coded values in the code — then the same image runs locally, on kind, and on AKS
  with different behaviour
- make it a no-op when the exporter endpoint is unset, so `npm test` does not spend five
  seconds retrying a dead collector
- suppress spans for `/health` and `/metrics` — otherwise ~90% of your spans are probes
- handle SIGTERM: flush before exit, or you lose exactly the spans from the shutdown you
  most want to investigate

For now, export to the console or to a temporary collector to see output.

**Prove it:** hit the service and see a span with a trace id, a span id, and HTTP
attributes.

### 7.2 The Collector, agent tier

Deploy the contrib Collector as a DaemonSet. Pods should send to the agent on **their own
node** — work out how a pod discovers its node's IP without hard-coding anything.

Build the pipeline yourself and be able to justify the processor order. One ordering rule
is non-negotiable: the memory limiter goes first (it must be able to shed load before
anything else allocates) and batching goes last (batch before enrichment and you enrich a
whole batch with one pod's identity).

Add `k8sattributes`. When it silently enriches nothing, check RBAC before anything else.

**Prove it:** the Collector's own metrics show spans received and exported; the collector
logs no permission errors.

### 7.3 Tempo

Install Tempo (single binary, local storage) and point the Collector at it. Add it as a
Grafana datasource.

**Prove it:** you can find a trace in Grafana by its id, and see the span waterfall.

### 7.4 All three services, and propagation

Instrument the other two. Now the interesting part: make a request that crosses services
— checkout calls the catalog — and confirm **one** trace contains spans from both.

If you get two separate traces, propagation is broken. Debug it properly: look at the
actual outbound HTTP headers rather than guessing.

**Prove it:** one trace, multiple services, and a waterfall where the parent span visibly
contains the child.

### 7.5 Gateway tier and tail sampling

Add a second Collector as a Deployment. Agents forward to it. The gateway does what needs
either the whole trace in one place or credentials you do not want on every node:

- tail sampling: keep 100% of errors, 100% of anything slower than your SLO threshold, and
  a small percentage of the rest
- attribute scrubbing: strip anything that must never leave the cluster (authorization
  headers, emails)
- later, in phase 10, fan-out to vendors

Then answer, in the notebook: **what breaks if you scale this gateway to three replicas
behind a normal Service?** Work it out from first principles — it follows directly from
how tail sampling works. Then find out what the standard fix is called.

**Prove it:** generate traffic with a small percentage of errors; confirm every errored
trace is in Tempo and most successful ones are not.

## Self-check

- Tracing adds latency and cost to every request. How do you justify it to a sceptical
  team, and what is the actual overhead?
- You sample at 5%. A customer reports a specific slow request. Can you find it? What
  would you have to build if the answer must be yes?
- A trace shows a 2-second gap with no child spans. Name three causes.
- Which service is the "root" of a trace in your system, and what happens if a client
  sends its own `traceparent`?
- Your spans have an attribute with the full URL including a product id. What is the
  consequence in Tempo? In Datadog? In Loki?

## If you're stuck

- **No spans at all, no errors anywhere:** the import-order problem from question 5. This
  is the single most common OpenTelemetry mistake and it fails silently.
- **Spans arrive but with no Kubernetes attributes:** RBAC for the processor. It needs to
  read pods, and usually namespaces, cluster-wide.
- **Two traces instead of one across a service boundary:** the outbound HTTP client is not
  instrumented, or the incoming context is not being extracted. Log the headers on the
  receiving side.
- **Collector logs "queue is full":** the backend is slower than ingest. Look at the queue
  size against capacity before raising limits — and decide whether the honest answer is to
  sample harder.
- **Tempo returns nothing for a trace id you can see in the logs:** check the retention
  window, then whether tail sampling dropped it. A sampled-out trace is *gone*, which is a
  real consequence worth feeling once.

## Review checkpoint

Show me:

1. Your `tracing` bootstrap file and how it is loaded
2. Both Collector configs
3. A screenshot of one cross-service trace waterfall
4. Your notebook answer on scaling the gateway

I will push on: processor order and why; what you sample and what that costs you; whether
your instrumentation is portable or has quietly become vendor-specific; and the gap
between what the app's own latency histogram measures and what the trace measures.

## After this phase you can say

> "The services are instrumented with the OpenTelemetry SDK, so the instrumentation is
> mine and the backend is a routing decision. Collectors run in two tiers: node-local
> agents so a pod never crosses a node boundary to emit telemetry and a gateway outage
> cannot stall application threads, and a gateway that does tail sampling — keeping every
> error and everything slow, which head sampling structurally cannot do because it decides
> before it knows the outcome."
