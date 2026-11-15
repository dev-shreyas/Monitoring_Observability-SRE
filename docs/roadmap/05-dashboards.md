# Phase 5 — Dashboards

**Time:** 5–6 hours · **Prerequisite:** Phase 4

## Why this phase

A dashboard is not for watching. Nobody watches dashboards; that is what alerts are for. A
dashboard is for the ten minutes *after* an alert, when a tired person needs to go from
"something is wrong" to "it is this endpoint on this pod since that deploy" without
writing PromQL.

Design them for that moment and they are useful. Design them to look impressive and you
get forty panels nobody can read under pressure.

## Understand first

1. What question does each of RED and USE answer, and why do you need both?
2. Which of the four golden signals do people most often leave out, and why is it the
   leading indicator?
3. Your services are Node.js — single-threaded. What is the right saturation signal for
   them, and why is CPU utilisation misleading?
4. Why should a dashboard never show a **mean** latency?
5. What is the difference between `container_memory_usage_bytes` and
   `container_memory_working_set_bytes`, and which one does the OOM killer care about?

## Read

- [Grafana — provisioning dashboards](https://grafana.com/docs/grafana/latest/administration/provisioning/)
- [Grafana — dashboard best practices](https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/best-practices/)
- [Brendan Gregg — the USE method](https://www.brendangregg.com/usemethod.html)
- [Google SRE Book — Monitoring distributed systems](https://sre.google/sre-book/monitoring-distributed-systems/)
  (the golden signals chapter)

## Build

### 5.1 Access and datasource

Get into Grafana and confirm the Prometheus datasource works. Pin its UID explicitly
rather than letting it be generated — dashboards reference datasources by UID, and a
regenerated UID on reinstall silently breaks every provisioned panel.

### 5.2 RED dashboard

One dashboard, per-service. Rate, Errors, Duration, plus saturation.

- a `service` template variable, so one dashboard serves all three
- a per-route breakdown table — during an incident this is usually the panel that names
  the culprit endpoint in ten seconds
- `topk` on anything that could draw forty lines
- the Node saturation signals from question 3

Two things to get right and be able to defend:

- **Colour.** Assign a fixed colour per service and use it on every dashboard, forever.
  Never let Grafana cycle palette colours — "orange" must mean product-service everywhere,
  or people misread graphs under pressure. Avoid relying on red/green alone to carry
  meaning: roughly 1 in 12 men cannot separate them.
- **Deploy annotations.** Add an annotation query that marks deployments on every graph.
  This is the highest-value thing you can add to any dashboard — it turns "when did this
  start?" into a one-second question. Find a metric that changes on deploy.

### 5.3 USE dashboard

Nodes and containers. Utilisation, Saturation and Errors for each resource. Include:

- CPU usage against requests *and* limits on the same panel — and be able to explain what
  each of those two lines actually controls
- CPU throttling as a fraction of periods (the panel almost nobody has, and the failure
  mode people hunt for days)
- memory working set against limit
- restarts and OOM kills
- HPA current / desired / max
- run-queue saturation for nodes, not just CPU percentage

### 5.4 SLO dashboard

The one your manager would look at. Top row: stat panels for 30-day attainment, budget
remaining, current burn rate, hours-to-exhaustion. Below: burn rate over time with the
four thresholds drawn on it, budget remaining over time, and observed-vs-allowed ratio per
SLI.

Colour thresholds here are meaningful, not decorative — green/amber/red should map to
your error-budget policy tiers from phase 3, so the panel and the policy agree.

### 5.5 Dashboards as code

Now stop clicking. Export each dashboard's JSON, commit it, and get Grafana to load it
from git on startup — the Grafana chart runs a sidecar that watches for ConfigMaps with a
particular label. Find it.

Then go one better: **generate** the SLO dashboard from your `slo-definitions.yaml`, so a
change to an objective updates the rules, the alert thresholds and the panels in the same
commit. A small Python script is plenty. This is the thing that makes an interviewer sit
up, because almost nobody does it.

**Prove it:** delete a dashboard in the UI, restart Grafana, and it comes back.

## Self-check

- Your p99 panel is flat at exactly 5 seconds. What does that mean?
- Error rate is 100% and the traffic panel shows 0.02 req/s. Is this an incident?
- A panel shows CPU at 40% and users report slowness. Which panel do you look at next?
- Why does the SLO dashboard matter more than an uptime percentage to a business
  stakeholder?
- Someone asks for "a dashboard with everything on it". What do you say?

## If you're stuck

- **Panel shows "No data" but the query works in Prometheus:** check the dashboard's
  datasource UID and the time range; a `$service` template variable with no value expands
  to an empty string, not to everything — use an `allValue`.
- **Sidecar does not pick up the ConfigMap:** it matches on a specific label *and value*,
  and on the namespace it is told to search. Check both, then check the sidecar container's
  own logs.
- **Every series is a different colour after a filter change:** you are relying on the
  auto palette. Colour must follow the entity, not its position in the result set.
- **Table panel shows raw JSON-ish columns:** instant queries in table format, then
  transformations to join and rename.

## Review checkpoint

Show me:

1. Screenshots or JSON of the three dashboards
2. Your provisioning setup
3. The generator script if you wrote one

I will push on: whether each panel earns its place; whether the SLO thresholds match your
error-budget policy; what you would remove; and whether you can navigate from "alert
fired" to "root cause" using only your own dashboards, in under two minutes, out loud.

## After this phase you can say

> "Three dashboards, each answering one question: the SLO one says whether it matters, RED
> says which service and which endpoint, USE says which resource ran out. They are
> generated from the SLO definitions and provisioned from git, so an objective change
> moves the rules, the alert thresholds and the panels together — nothing is clicked
> together in the UI where it cannot be reviewed."
