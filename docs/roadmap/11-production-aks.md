# Phase 11 — Production on AKS

**Time:** 6–8 hours · **Prerequisite:** Phase 10 · **This one costs Azure credits — read the cost section first**

## Why this phase

Everything so far runs on a laptop with single replicas and local disks. The gap between
that and production is not a small one, and an interviewer will probe it: "you ran
Prometheus on kind — what changes on a real cluster?"

You do not have to run this for weeks. Deploy it, measure it, understand the cost model,
and tear it down. What you keep is the Terraform and the answers.

## Understand first

1. Prometheus keeps ~15 days on local disk. Your SLO window is 30 days and audits ask
   about last quarter. What are the three standard answers, and what does each cost?
2. Your local Prometheus is one pod with one PVC. What happens when it restarts? What
   happens when the node dies? Is that acceptable, and for which of your alerts is it
   *not*?
3. What is the difference between Azure Monitor **managed Prometheus**, **Container
   Insights**, and **Log Analytics**? Which of your three signals does each cover, and
   where do they overlap?
4. What is the actual billing unit for each Azure Monitor service you would use? (Look it
   up. "Per GB" is not specific enough to plan with.)
5. Your alert rules live in a `PrometheusRule` CRD. Does Azure managed Prometheus read
   those? How do rules get there instead?

## Read

- [Azure Monitor managed service for Prometheus](https://learn.microsoft.com/en-us/azure/azure-monitor/essentials/prometheus-metrics-overview)
- [Container Insights overview](https://learn.microsoft.com/en-us/azure/azure-monitor/containers/container-insights-overview)
  and its [cost optimisation settings](https://learn.microsoft.com/en-us/azure/azure-monitor/containers/container-insights-cost-config)
- [Azure Managed Grafana](https://learn.microsoft.com/en-us/azure/managed-grafana/overview)
- [Thanos](https://thanos.io/tip/thanos/getting-started.md/) or
  [Mimir](https://grafana.com/docs/mimir/latest/) — read one, understand the pattern
- [Prometheus — remote write tuning](https://prometheus.io/docs/practices/remote_write/)

## Build

### 11.1 Decide the architecture before you deploy anything

Write `observability/docs/production-architecture.md` first. For each signal, choose and
justify:

- **Metrics:** self-managed Prometheus in the cluster, Azure managed Prometheus, or both
  (local for alerting, remote-write for long-term)?
- **Logs:** self-managed Loki, Container Insights into Log Analytics, or both?
- **Traces:** self-managed Tempo, or Application Insights?
- **Dashboards:** self-managed Grafana or Azure Managed Grafana?
- **Alerting:** Prometheus + Alertmanager, or Azure Monitor alert rules + Action Groups?

For each, state the trade: cost, operational burden, portability, and what you lose. There
is no single right answer — there is an answer you can defend, which is what the interview
actually wants. Pay attention to the portability question: a pipeline where changing cloud
means changing a Terraform module is different from one where it means re-instrumenting.

### 11.2 Add monitoring to your Terraform

Your `infra/modules/monitoring` currently creates a Log Analytics workspace and nothing
else. Extend it — and keep the module boundaries clean:

- an Azure Monitor workspace for managed Prometheus, if you chose it
- Container Insights on the AKS cluster, with the cost-control settings deliberately set
  rather than defaulted
- data collection rules — understand what a DCR and a DCE actually are before you write
  them
- Azure Managed Grafana, if you chose it, with the role assignment that lets it read your
  metrics workspace
- diagnostic settings on the AKS control plane: which log categories, and why not all of
  them?

**Prove it:** `terraform plan` is clean; after apply, metrics appear in the workspace.

### 11.3 Long-term storage

Implement whichever of the three answers from question 1 you chose. If you go the
remote-write route, tune it: queue capacity, max shards, batch size. Then answer — what
happens to remote write when the remote end is down for twenty minutes, and how much
memory does that cost you locally?

### 11.4 Rules and dashboards in CI

This is the phase where your work becomes a platform rather than a project. Build an Azure
DevOps pipeline (you already know this half) that on every PR touching
`observability/`:

- lints the YAML
- runs `promtool check rules` and your unit tests from phase 4
- validates the dashboard JSON
- on merge to main, applies the rules and dashboards to the cluster

Then answer the harder question: how do you handle a rule change that is *valid* but
wrong — one that disables an alert by making it unreachable? What review process catches
that? (Hint: it is the same answer as for any other production code, and it is why the
unit tests matter.)

### 11.5 The cost model

Build a real spreadsheet or a markdown table, with real prices looked up today, for a
hypothetical 20-node, 200-pod production cluster:

- metrics: active series estimate → cost per month, self-managed vs managed
- logs: GB/day estimate → cost per month, at full volume and with probe traffic dropped
- traces: spans/day → cost at 100% sampling, at 5%, and with tail sampling
- what the same workload costs in Datadog and in Dynatrace

Then: which single change saves the most money, and what does it cost you in visibility?

This table is one of the strongest artefacts you can bring to an interview. Very few
candidates can talk about observability cost with actual numbers, and platform teams care
about it enormously.

## Self-check

- You need to answer "what was our p99 last March". Walk through where that data is and
  what you had to decide six months earlier for the answer to exist.
- Managed Prometheus means you do not run Prometheus. What do you *lose*?
- Your cluster has 20 nodes and Container Insights is on with defaults. Estimate the
  monthly log bill. Now estimate it with the recommended cost settings.
- An auditor asks for proof you met your SLO last quarter. What do you show them?

## If you're stuck

- **Managed Prometheus shows nothing:** the data collection rule association to the
  cluster, and whether the ama-metrics pods are running and can reach the endpoint.
- **Custom scrape targets ignored:** managed Prometheus takes scrape config through a
  specific ConfigMap, not through your ServiceMonitors. Find out which, and note that this
  is exactly the portability cost you were asked to weigh in 11.1.
- **Azure Managed Grafana cannot see the workspace:** it is a role assignment, and it
  takes a few minutes to propagate.
- **Costs climbing faster than expected:** Container Insights defaults. Check what
  collection level is enabled and which namespaces are included.

## Review checkpoint

Show me:

1. `production-architecture.md` with your decisions and trade-offs
2. Your Terraform additions
3. Your CI pipeline
4. The cost table

I will push on: whether each decision is justified or just a preference; what your
portability story is if the company moves cloud; how a bad-but-valid rule change gets
caught; and whether your cost numbers are real or estimated (say which).

## After this phase you can say

> "On AKS the split is deliberate: Prometheus in-cluster for alerting because alerting
> must survive losing connectivity to the control plane, remote-write to a managed
> workspace for long-term storage because Prometheus is not a long-term store. The rules
> are unit-tested in CI before they reach the cluster. I have a cost model for it — metric
> series, log GB and span volume — and I know which single change saves the most and what
> visibility it costs."
