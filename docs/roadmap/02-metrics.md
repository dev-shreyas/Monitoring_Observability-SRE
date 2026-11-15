# Phase 2 — Metrics

**Time:** 6–8 hours · **Prerequisite:** Phase 1

## Why this phase

Metrics are the cheap signal: numbers over time, bounded in size, fast to query. They tell
you *that* something is wrong and *how much*. They will not tell you why — that is phases
6 and 7 — but every alert and every SLO you build rests on them.

Your services already expose `/metrics` (`src/metrics.ts` — read it before you start,
including the comment about why `route` uses the Express template rather than the URL).
Nothing scrapes them yet.

## Understand first

1. What are Prometheus's four metric types, and what is the one operation you must never
   apply to a counter? What must you never apply to a gauge?
2. Why can a **summary**'s p99 not be aggregated across pods, when a **histogram**'s can?
   This is the single most common metrics interview question — be able to explain it with
   the arithmetic, not just assert it.
3. Prometheus is a **pull** system. Name two things that become easy because of that, and
   one case where it genuinely does not work.
4. What exactly is a "time series" to Prometheus, and how many series does one metric with
   three labels of 10 values each produce?
5. A ServiceMonitor references a Service. Does Prometheus scrape *through* the Service's
   ClusterIP? What would go wrong if it did?

## Read

- [Prometheus — metric types](https://prometheus.io/docs/concepts/metric_types/)
- [Prometheus — histograms and summaries](https://prometheus.io/docs/practices/histograms/)
  (read it twice; phase 3 depends on it)
- [Prometheus — querying basics and functions](https://prometheus.io/docs/prometheus/latest/querying/basics/)
- [Prometheus Operator — ServiceMonitor design](https://prometheus-operator.dev/docs/api-reference/api/)
  plus the "Getting started" page
- Your own `services/product-service/src/metrics.ts`

## Build

### 2.1 Install kube-prometheus-stack

Use the `prometheus-community/kube-prometheus-stack` chart with a values file you keep in
git, not `--set` flags. Size it for a laptop.

One setting will cost you an hour if you miss it: by default the chart tells Prometheus to
adopt only ServiceMonitors carrying its own Helm release label. Your monitors will live in
git next to the app and will not carry it. Find the four or five `*SelectorNilUsesHelmValues`
settings and decide deliberately.

Also disable the control-plane component scrapes that cannot work on kind. Leaving
permanently-red targets on the dashboard teaches you to ignore red targets, which
eventually costs you an incident.

**Prove it:** Prometheus UI → Status → Targets, all green.

### 2.2 Understand what you just installed

Do not skip this. The chart installed six or seven things. For each, answer: what does it
expose, and what would you lose without it?

- Prometheus Operator · Prometheus · Alertmanager · Grafana · node-exporter ·
  kube-state-metrics · (and what it did to CRDs)

Specifically: **what is the difference between kube-state-metrics and metrics-server?**
Both "give you Kubernetes metrics" and they are completely different things. If you cannot
answer that, read both READMEs.

### 2.3 ServiceMonitors for your three services

Write one per service. Your Services declare unnamed ports, which affects how you select
the endpoint — find the two ways and pick one.

Add relabeling so each sample carries the pod and node it came from. Be careful: your app
already sets a `service` label on every metric (see `metrics.ts`). What happens if a
target label collides with a label the app already sent? Find out, then decide.

**Prove it:** in Prometheus, `up{job=~".*service.*"}` returns one series per pod, and
`http_request_duration_seconds_count` has data.

### 2.4 PromQL until it is boring

Generate traffic first — a `curl` loop is enough for now. Then write these yourself, in
the Prometheus expression browser, without looking anything up twice:

1. Requests per second per service
2. Error ratio (5xx / all) per service
3. p50, p95 and p99 latency per service, **aggregating buckets before taking the quantile**
4. The slowest route across all services
5. Memory working-set as a fraction of the container's limit (needs a join)
6. Pods that restarted in the last 15 minutes
7. CPU throttled periods as a fraction of all periods
8. Requests per second, excluding health and metrics traffic

Numbers 3 and 5 are the ones that teach you something. For 5 you will need `on(...)` and
possibly `group_left` — when you get "no data", the cause is almost always that the two
sides have different label sets.

Keep the queries in `docs/roadmap/promql-drills.md` with a one-line note on what each
taught you.

### 2.5 Cardinality audit

Find your most expensive metrics:

- how many active series does your Prometheus hold?
- which metric name has the most series?
- how many series does *one* `http_request_duration_seconds` produce, and what is the
  arithmetic — buckets × routes × status codes × methods × pods?

Then answer: if someone changed `metrics.ts` to label by `req.path` instead of
`req.route.path`, what happens? Estimate the number.

**Prove it:** a paragraph in your notebook with the real numbers from your cluster.

## Self-check

- Why must a `rate()` range cover at least four scrape intervals?
- When would you use `irate()` and why is it wrong in an alert?
- A counter resets when a pod restarts. Why does `rate()` handle that correctly but
  `x - x offset 5m` does not?
- Your histogram's buckets are `[.005 .01 .025 .05 .1 .25 .5 1 2.5 5]`. What p99 do you
  get if every request takes 8 seconds, and why is that number a lie?
- What is the difference between `relabelings` and `metricRelabelings`, and at which point
  in the pipeline does each run?

## If you're stuck

- **Targets missing entirely (not red, absent):** service discovery is not matching. Check
  the ServiceMonitor's `selector` against the Service's *labels* (not the pod's), the
  `namespaceSelector`, and the chart's selector settings from 2.1.
- **Target is up but the metric has odd labels:** look for `exported_service` in the
  output. That is Prometheus renaming a collision — the app sent a label the target
  configuration also sets. Decide which one wins.
- **`histogram_quantile` returns NaN:** you probably dropped the `le` label in your
  aggregation, or you are taking the quantile before aggregating.
- **A join returns nothing:** without `on(...)` or `ignoring(...)`, PromQL requires *every*
  label to match on both sides. Print both sides separately and compare label sets.
- **Prometheus OOMs:** it is cardinality. `prometheus_tsdb_head_series` and
  `topk(10, count by (__name__)({__name__=~".+"}))`.

## Review checkpoint

Show me:

1. Your kube-prometheus-stack values file
2. One ServiceMonitor
3. `promql-drills.md` with your eight queries
4. Your cardinality numbers

I will push on: the selector settings and whether you understand *why* you changed them;
the label-collision decision; whether your p95 query aggregates in the right order; and
your cardinality arithmetic.

## After this phase you can say

> "Prometheus discovers the services through ServiceMonitors and scrapes the pods
> directly — the Service is only used for endpoint discovery. The app exposes a latency
> histogram rather than a summary, because summaries compute quantiles per process and
> percentiles cannot be aggregated across pods. Cardinality is controlled at the source:
> the route label is the Express template, not the URL."
