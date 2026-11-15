# Phase 8 — Correlation

**Time:** 3–4 hours · **Prerequisite:** Phase 7

## Why this phase

You now have three signals in three systems. Most teams stop here and call it
observability. It is not — it is three tools you switch between by hand, copying
timestamps and guessing.

The value is the **join**. One identifier that lets a metric spike become a log line
become the exact trace, without leaving the page. This is a short phase and it is the one
that makes everything before it pay off.

## Understand first

1. What is the one identifier that can connect all three signals, and which of the three
   naturally has it?
2. Why can a logger add that identifier without anyone passing it down the call stack?
   (You answered this in phase 7 — say it again, precisely.)
3. What is a Prometheus **exemplar**? What does it attach to, and why is it a different
   mechanism from a label?
4. Grafana can link from a log line to a trace. Mechanically, how — what does it do to the
   log line to find the id?
5. Tempo can generate metrics from spans. Name two useful things that produces that your
   application metrics cannot give you, and one reason you would still keep the app's own
   metrics.

## Read

- [Grafana — derived fields in the Loki datasource](https://grafana.com/docs/grafana/latest/datasources/loki/configure-loki-data-source/)
- [Grafana — Tempo datasource: trace to logs, trace to metrics](https://grafana.com/docs/grafana/latest/datasources/tempo/configure-tempo-data-source/)
- [Prometheus — exemplars](https://prometheus.io/docs/prometheus/latest/feature_flags/#exemplars-storage)
  and the OpenMetrics exemplar concept
- [Tempo — metrics-generator](https://grafana.com/docs/tempo/latest/metrics-generator/)

## Build

### 8.1 Trace id in the log line

Modify the logger so every line carries the trace id and span id of the request that
produced it — read from the ambient context, not from a parameter.

Two details that matter:

- outside a request (startup, shutdown, a timer) there is no active span. The keys should
  be **absent**, not null or empty strings — think about what a null does to a query.
- do not change the logger's public API. Every call site should keep working untouched.
  If you find yourself editing call sites, you are solving it at the wrong layer.

**Prove it:** `kubectl logs` shows a trace id on request lines and not on startup lines.

### 8.2 Log → trace in Grafana

Configure the Loki datasource so the trace id in a log line becomes a clickable link into
Tempo. Then configure the reverse on the Tempo datasource: from a span, jump to that pod's
logs in the surrounding time window.

**Prove it:** from a log line in Explore, one click lands you in the right trace. From
that trace, one click lands you back in the logs.

### 8.3 Exemplars

Make your latency histogram attach exemplars, so a point on a p99 graph carries a trace id
and Grafana shows a "view trace" dot on the panel.

This needs three things to line up: the client library must emit them, the exposition
format must support them (which format? not the default one), and Prometheus must be told
to store them (which feature flag?). If any one is missing, exemplars are silently dropped
— which is its own useful lesson about how much of this stack fails quietly.

**Prove it:** a diamond marker on the latency panel that opens a trace.

### 8.4 Span metrics and the service graph

Turn on Tempo's metrics-generator and have it write into Prometheus. You get two things:
RED metrics derived from spans for every service, and a service graph showing which
service calls which, with error rates on the edges.

Nobody declared that topology anywhere. Sit with that for a second — it is the open-source
equivalent of the "automatic dependency map" that vendors charge for, and phase 10 will
let you compare them directly.

Then compare the span-derived p95 with your application's own p95 for the same service.
They will not be identical. **Work out why**, and write it in the notebook. The gap is
one of the more interesting things this whole stack can tell you.

### 8.5 The correlation dashboard

One dashboard that puts the workflow on a single page: an error-rate graph at the top, a
logs panel below it, a service graph, and the span-derived latency. Selecting a spike on
the top panel should narrow the others.

**Prove it:** with a fault injected, go from spike to root-cause trace in three clicks,
timed. Write the time down.

## Self-check

- A log line has no trace id. Give three reasons that is legitimate.
- Why does the trace id belong in the log *line* rather than as a Loki label?
- You sample 5% of traces. A log line references a trace that was not sampled. What does
  the user see when they click, and how would you make that less confusing?
- Which of the three signals would you keep if you could only afford one, and what would
  you lose?

## If you're stuck

- **No trace id in logs:** either the logger is called outside a span's context, or the
  context is not propagating through an async boundary. Log the span context directly at
  the top of a route handler to isolate which.
- **The derived field never produces a link:** the regex must match the *raw* log line as
  Loki stores it, escaping included. Test it against a line you copied from Loki, not from
  `kubectl logs`.
- **Exemplars never appear:** check all three prerequisites from 8.3 separately. The
  exposition format is the one people miss.
- **Service graph is empty:** the generator needs both client and server spans to see an
  edge, and it needs time — check its own metrics before concluding it is broken.

## Review checkpoint

Show me:

1. Your logger change
2. The datasource configuration for both links
3. Your three-click timing, and your explanation of the p95 gap from 8.4

I will push on: the absent-vs-null decision; whether the correlation actually works from a
cold start or only for the trace you already had open; and what your answer is when
someone asks for the trace of a request that was sampled out.

## After this phase you can say

> "Every log line carries the trace id of the request that produced it, so a metric spike
> leads to a log line leads to the exact trace in three clicks — and back again from a
> span to that pod's logs. Exemplars put trace links directly on the latency panels. The
> correlation is the product; the three pillars on their own are three tools you switch
> between by hand."
