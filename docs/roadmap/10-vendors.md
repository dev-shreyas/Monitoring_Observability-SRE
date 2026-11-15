# Phase 10 — Datadog and Dynatrace

**Time:** 4–6 hours · **Prerequisite:** Phase 9 · **Both are free trials; set a spending limit on day one**

## Why this phase

Most SRE job descriptions name a commercial APM. Having an *informed opinion* about one —
what it does that your stack does not, what it costs, and where it hides things from you —
is worth far more than having clicked around in it.

Run them **alongside** the OSS stack, on the same traffic, with the same faults. The
comparison is the learning; the screenshots are not.

## Before you start: money

- 14-day Datadog trial, 15-day Dynatrace trial. Both bill by host and by ingested volume
  afterwards.
- Set a usage alert / spending limit **first**, in both. Datadog: Plan & Usage → Usage
  Alerts. Dynatrace: Settings → Consumption.
- Remove the agents when you stop practising. A kind cluster left running for a week
  ingests a surprising amount.
- Never point a trial account at anything real.

## Understand first

1. Your services already emit OTLP. What does that mean for how much work adding a new
   backend is? Why is that the commercial argument for OpenTelemetry?
2. Datadog bills partly per **custom metric**. A Prometheus histogram with 10 buckets, 3
   status codes, 12 routes and 2 methods — how many custom metrics is that from *one*
   metric? Do the arithmetic before you install anything.
3. Dynatrace's OneAgent instruments processes without a code change. Mechanically, how can
   that work? What does it require that an SDK does not?
4. What is the difference between an agent that *observes* your process and an SDK you
   *call*? Which gives you more control, which gives you more coverage?

## Read

- [Datadog — OTLP ingest in the Agent](https://docs.datadoghq.com/opentelemetry/setup/otlp_ingest_in_the_agent/)
- [Datadog — custom metrics billing](https://docs.datadoghq.com/account_management/billing/custom_metrics/)
  — read this one carefully; it is the exam question
- [Dynatrace — Kubernetes deployment options](https://docs.dynatrace.com/docs/ingest-from/setup-on-k8s)
  — application-only vs cloud-native full-stack
- [Dynatrace — DynaKube parameters](https://docs.dynatrace.com/docs/ingest-from/setup-on-k8s/reference/dynakube-parameters)

## Build

### 10.1 Datadog

Install the Agent via Helm with a values file in git. Turn on: APM, logs, the Cluster
Agent, and **OTLP ingest** — because your services already speak OTLP, no code change is
needed. That is the point; notice it.

Then deliberately do the cardinality experiment: enable Prometheus scraping of your
services' `/metrics` with no filter for one hour, look at your custom-metric count, then
add an allowlist. Write both numbers in your notebook. This is a lesson that usually costs
a team real money to learn.

Finally, recreate **one SLO and one burn-rate alert** in Datadog. Do it as code — the
Terraform provider, not clicks. Notice that Datadog's burn-rate alert asks you for a long
window and a short window: the vendor feature *is* the SRE Workbook recipe, not a
proprietary invention. Recognising that is the insight worth carrying into an interview.

### 10.2 Dynatrace

Install the Operator and create a DynaKube. Two deployment modes — read about both and
choose deliberately for a laptop; understand what the heavier one gives you and why it is
awkward on kind.

Restrict injection to your own namespaces. Injecting into everything on a trial account
burns the trial in two days.

Then explore: Smartscape, Davis, Service Flow. Ask yourself at each one — *how would I
build this with what I already have?* You built a service graph in phase 8. How does
theirs differ?

Optional and worthwhile: also send telemetry to Dynatrace as plain OTLP via your gateway
collector, with no agent. Compare what arrives. That comparison is the clearest possible
demonstration of the agent-versus-SDK trade-off.

### 10.3 Run the drills again, in triplicate

Re-run the error drill and the cascade drill from phase 9 with all three backends running.
For each, write down:

- which tool told you *first*
- which tool told you *most precisely*
- how many clicks from "something is wrong" to "this service, this endpoint, this cause"
- what each one hid from you

Then write `observability/docs/vendor-comparison.md` — one page, your own words, with a
table across: how data gets in, topology, root-cause help, cost model, and the catch for
each. End with which you would choose for a 10-person startup and which for a 500-engineer
company, and why they are different answers.

That document is a genuinely strong interview artefact, because it is an opinion with
evidence behind it.

### 10.4 Tear down

Run the uninstall. Confirm in each vendor's UI that ingestion has stopped.

## Self-check

- Your manager says "let's just buy Datadog and delete all this Prometheus work". Make the
  case for and against, honestly, in two minutes.
- What is the single biggest driver of a surprise Datadog bill, and how do you prevent it?
- Dynatrace's Davis names a root cause. It is wrong. How do you find that out, and what do
  you do next?
- If you had to migrate from one vendor to another, what in your setup makes that easy and
  what makes it hard?

## If you're stuck

- **No data in Datadog:** the `site` setting must match your account's region exactly, or
  everything is silently sent to the wrong endpoint.
- **Traces in Datadog but not in Tempo (or vice versa):** decide deliberately whether the
  fan-out happens in the agent or in your gateway collector. Doing both double-bills you
  and is a classic accident.
- **Dynatrace pods not injecting:** the webhook must be ready before the DynaKube is
  applied, and your namespace must match the selector you configured.
- **Trial data volume alarming:** check what you enabled cluster-wide versus namespace-
  scoped. Logs from `kube-system` are the usual culprit.

## Review checkpoint

Show me:

1. `vendor-comparison.md`
2. Your two custom-metric counts from the cardinality experiment
3. Your Datadog SLO/monitor as code

I will push on: whether your comparison is an opinion or a feature list; whether you can
defend the "startup vs large company" split; and what you would do differently if the
budget were fixed at a number you cannot exceed.

## After this phase you can say

> "I ran Datadog and Dynatrace alongside the open-source stack on the same traffic and the
> same injected faults. Because the services emit OTLP, adding a backend was a collector
> exporter, not a code change. The honest summary: the OSS stack gives the deepest
> understanding and the most operational work, Dynatrace gives the fastest answer and the
> least control, Datadog sits between with the widest integration surface and the sharpest
> cardinality bill — I measured that one."
