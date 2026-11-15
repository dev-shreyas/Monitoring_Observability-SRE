# Monitoring & Observability — a build-it-yourself roadmap

Twelve phases that take `ecommerce-azure-devops` from "three services with a `/metrics`
endpoint nobody scrapes" to a full SRE platform you built with your own hands, and can
defend line by line in an interview.

**Nothing here hands you a working config.** Each step says what to build, what to
understand before you build it, which official page to read, and how to prove it works.
The YAML is yours. That is the entire point: an interviewer can tell within two questions
whether you wrote a file or copied it, and the difference is whether you can say *why*
each field is there.

---

## How to use this

Work through the phases in order. They build on each other — phase 4 alerts on the
recording rules from phase 3, which measure the metrics from phase 2.

Every phase file has the same shape:

| Section | What it is for |
|---|---|
| **Why this phase** | What this buys you. If you cannot answer this, skip nothing — read it again. |
| **Understand first** | Questions to answer *before* you touch a keyboard. Answer them out loud. |
| **Read** | Specific pages, not whole sites. Usually 20–40 minutes. |
| **Build** | Numbered tasks, each small enough to finish in one sitting. |
| **Prove it** | The acceptance test. A command whose output tells you it genuinely works. |
| **Self-check** | Questions an interviewer would actually ask about what you just built. |
| **If you're stuck** | The exact field, flag or concept that trips most people. Not the answer. |
| **Review checkpoint** | What to show me, and what I will push back on. |

### The rules that make this work

1. **Answer "Understand first" before building.** Building without the concept produces
   a working cluster and no knowledge, which is the thing you are trying to avoid.
2. **Type the config; do not paste it.** Including from the official docs. Typing a field
   you do not understand is how you notice you do not understand it.
3. **Break it on purpose after every phase.** Delete the label a selector depends on.
   Change a port. Watch exactly how it fails, and what the failure looks like from the
   outside. That is the muscle interviews test.
4. **Keep a lab notebook.** `docs/roadmap/notebook.md` — one entry per session: what you
   built, what broke, what the error actually said, what fixed it. In eight weeks this is
   the single most valuable file in the repo, and it is where your interview stories come
   from.
5. **Commit after every task.** `git log` becomes a record of how you think.

### Review checkpoints

At the end of each phase, show me what you built:

```
Phase N done. Here's my <file>:
<paste>
Output of the acceptance test:
<paste>
```

I will review it the way a senior SRE reviews a PR — what breaks in production, what the
field you copied actually does, what you have not thought about yet. I will not hand you
a corrected file. If something is wrong I will tell you *what* is wrong and let you fix
it, because fixing it is where the learning is.

Ask me questions at any point. "Why does the ServiceMonitor need a namespaceSelector"
is a great question. "Give me the ServiceMonitor" is not, and I will push back on it.

---

## The twelve phases

| # | Phase | Time | What you end up with |
|---|---|---|---|
| 1 | [Foundations](01-foundations.md) | 4–6h | The app running on a local kind cluster that behaves like AKS |
| 2 | [Metrics](02-metrics.md) | 6–8h | Prometheus scraping your services, and PromQL you can write from memory |
| 3 | [SLIs & SLOs](03-slis-and-slos.md) | 5–7h | Objectives with rationale, recording rules, an error budget you can read off a graph |
| 4 | [Alerting](04-alerting.md) | 6–8h | Multi-window burn-rate alerts, routed, grouped, inhibited — and unit-tested |
| 5 | [Dashboards](05-dashboards.md) | 5–6h | SLO, RED and USE dashboards, provisioned from git |
| 6 | [Logs](06-logs.md) | 5–6h | Loki with a label set you can defend on cost grounds |
| 7 | [Traces](07-traces.md) | 8–10h | OpenTelemetry in the apps, Collector in two tiers, Tempo, sampling |
| 8 | [Correlation](08-correlation.md) | 3–4h | Metric spike → log line → trace, in three clicks |
| 9 | [Chaos & incidents](09-chaos-and-incidents.md) | 6–8h | Drills, runbooks, postmortems, and alerts you have actually seen fire |
| 10 | [Vendors](10-vendors.md) | 4–6h | Datadog and Dynatrace next to the OSS stack, and an informed opinion |
| 11 | [Production on AKS](11-production-aks.md) | 6–8h | What changes when it is real: managed services, cost, long-term storage, CI |
| 12 | [The interview](12-interview.md) | ongoing | The story, the demo, and answers that come from experience |

Roughly 70–85 hours. At 8–10 hours a week that is 8–10 weeks. Phases 1–5 are the
non-negotiable core; if you get an interview before you finish, those five plus phase 9
are what you talk about.

Track yourself in [progress.md](progress.md).

---

## Before phase 1

Install: Docker Desktop (8GB+ allocated), `kind`, `kubectl`, `helm`, `k9s` (optional but
you will use it constantly), `promtool` (ships with Prometheus — you need it in phase 4).

Know already, or brush up first — this roadmap assumes them:

- `kubectl` basics: get, describe, logs, exec, port-forward
- what a Deployment, Service, ConfigMap and Secret are
- reading YAML without flinching
- basic `curl` and shell

You have the DevOps half of this already. What the roadmap adds is the reliability
engineering on top — and that framing matters when you interview. You are not a beginner
SRE; you are a platform engineer adding the discipline that most SRE candidates have read
about and not built.
