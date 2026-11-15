# Phase 3 — SLIs and SLOs

**Time:** 5–7 hours · **Prerequisite:** Phase 2

## Why this phase

This is the phase that separates "I set up Prometheus" from "I do SRE". Anyone can install
a monitoring stack. Deciding what *working* means as a measurable ratio, justifying the
target, and knowing what changes when you run out of budget — that is the job.

Do not rush it. Phases 4 and 5 are mechanical once this is right, and worthless if it is
wrong.

## Understand first

1. Define SLI, SLO, SLA and error budget in one sentence each. Then answer: what is
   missing from "our SLO is 99.9%"?
2. 99.9% over 30 days — how many minutes of full outage is that? 99.5%? 99.99%?
   Do the arithmetic by hand once.
3. Why is an SLI a **ratio of events** rather than a gauge? What breaks if you define
   availability as "the percentage of time the service was up"?
4. Your services return 401 to a bad password. Is that a failed request for SLO purposes?
   What about a 429 from a rate limiter you own? What about a 404 on a URL that never
   existed? Justify each.
5. kubelet probes `/health` every 10 seconds on every pod. If you include that traffic in
   the SLI, what does a *complete outage* read as? Estimate it with your actual replica
   count and traffic level.
6. What does it mean if a service ends every month with 100% of its budget unspent? Is
   that good?

## Read

- [Google SRE Workbook — Implementing SLOs](https://sre.google/workbook/implementing-slos/)
  — the most important single document in this roadmap. Read the whole chapter.
- [Google SRE Book — Service Level Objectives](https://sre.google/sre-book/service-level-objectives/)
- [Prometheus — recording rules and naming](https://prometheus.io/docs/practices/rules/)

## Build

### 3.1 Decide what a valid event is

Before any YAML, write down — in prose — the answer to: *which requests count, and which
are excluded from both the numerator and the denominator?* Justify each exclusion. You
should end up excluding at least probe traffic, scrape traffic, and one class of status
code.

This paragraph is the foundation. If it is wrong, every number downstream is a
confident-looking lie.

### 3.2 Write the SLO document

Create `observability/slo/slo-definitions.yaml` (or `.md` — your call, but machine-readable
ages better). For each of the three services, one availability objective and one latency
objective. Each one needs:

- the target and the window
- the threshold, for latency
- **a rationale** — one or two sentences on why that number and not one nine more

The rationale is not decoration. A target without a stated reason gets negotiated away in
the first planning meeting, and "why 99.9 and not 99.99" is a guaranteed interview
question.

Think about: which service is on the critical path for everything else? Which is highest
traffic and cheapest to make reliable? Which failure costs money rather than annoyance?
Which has a synchronous dependency that bounds how good it can be?

**Constraint you must discover:** your latency threshold has to be an existing histogram
bucket boundary. Look at the buckets in `metrics.ts` and work out why a 300ms threshold
would give you a number that is partly invented.

### 3.3 Availability recording rules

Write recording rules producing a **bad-event ratio** per service, over these windows:
5m, 30m, 1h, 2h, 6h, 1d, 3d. (Phase 4 explains why exactly those.)

Three decisions to make consciously:

- Record the *bad* ratio, not the good one. Why? (Hint: what is the budget made of?)
- Name them by the `level:metric:operation` convention.
- **The trap:** if a service has had zero errors in the window, the numerator selector
  matches no series, the division returns nothing, and the recorded series *disappears*.
  What does an alert on a missing series do? Find the idiom that forces a zero numerator.

**Prove it:** query your recorded metric; you get one series per service including a
service with zero errors.

### 3.4 Latency recording rules

Fraction of requests **slower than** the threshold, from the histogram buckets. Not
`histogram_quantile`. Understand why: a percentile is not a ratio of events and cannot be
compared to a budget.

Since the threshold differs per service, you will need either one rule per service or a
join. Do it the simple way first, then think about how you would generalise it.

### 3.5 Error budget and burn rate

Two more rules:

- **Budget remaining** over the 30-day window: `1 − (bad ratio / allowed bad ratio)`.
  1.0 means untouched; 0 means exhausted; negative means over budget.
- **Burn rate**: observed bad ratio ÷ allowed bad ratio. 1 means you will spend the budget
  in exactly 30 days; 14.4 means 2% of it per hour.

Here is the design problem worth solving properly: your three services have three
different targets. Do you hard-code `0.001` in every rule and every alert, or do you
publish the objective itself as a time series and join against it? Try the second. It is
more work now and it is why one alert rule can serve every service in phase 4.

**Prove it:** a single query shows budget remaining for all three services, and changing
a target in one place changes the output.

### Also write

`observability/slo/error-budget-policy.md` — what actually changes at 50%, 25%, 10% and 0%
remaining, who decides, and what the exceptions are. One page. An SLO without a policy is
a dashboard.

## Self-check

- Your availability SLI reads 100% for the last hour. Name three ways that can be true
  while the service is completely broken for users.
- Why is 30 days the conventional window? What changes with a 7-day or 90-day window?
- Your Prometheus keeps 15 days of data. Your SLO window is 30 days. What is wrong with
  your budget number, and what would you do about it in production?
- A dependency your service calls has a 99.5% SLO. What is the highest availability SLO
  you can honestly promise for a synchronous path through it?

## If you're stuck

- **Ratio series vanishes for a healthy service:** the numerator matches no series.
  `or vector(0)` on the numerator, scaled from the denominator so the labels survive.
- **The join against the objective returns nothing:** `group_left()` and which side is
  "many" — the side with more series keeps its labels.
- **`vector(0.999)` has no labels:** recording rules let you attach labels to the result.
- **30d `increase()` is painfully slow:** put those rules in their own group with a longer
  `interval`. Think about why that is safe here and not for the 5m rules.
- **Rules referencing other rules produce stale values:** rules evaluate in order *within
  a group*; groups run independently.

## Review checkpoint

Show me:

1. Your valid-events paragraph and `slo-definitions.yaml`
2. Your recording rules
3. `error-budget-policy.md`
4. The output of your budget-remaining query

I will push hard here — this is the phase interviews probe most. Expect questions on: each
rationale; whether your exclusions can be defended; the zero-numerator trap; whether your
latency SLI is a ratio or a disguised percentile; and what happens to your policy when a
product manager wants to ship during a freeze.

## After this phase you can say

> "Each service has an availability and a latency objective with a written rationale, and
> the SLI is a ratio of good to valid events — probe traffic and client errors excluded,
> because a correct 401 is the service working. The objective is published as a metric and
> joined against, so one rule serves services with different targets and changing an
> objective changes the alerting automatically."
