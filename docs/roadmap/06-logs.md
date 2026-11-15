# Phase 6 — Logs

**Time:** 5–6 hours · **Prerequisite:** Phase 5

## Why this phase

Metrics told you the error rate went up. Logs tell you what the error actually was. They
are the most expensive of the three signals per unit of insight, which is why the design
work here is mostly about deciding what *not* to keep and what *not* to index.

Your services already log correctly: one JSON object per line to stdout
(`src/logger.ts` — read it and the comment about why stdout and not a file). That is
half the battle already won.

## Understand first

1. Why do containers log to stdout instead of to files? What does the kubelet do with it,
   and where does it end up on the node?
2. What does Loki index, and what does it *not*? How is that different from Elasticsearch,
   and what is the consequence for cost and for query speed?
3. What is a **stream** in Loki, and how many streams do you create if you add a label
   whose value is a request id?
4. Your pods log a line for every health probe, every 10 seconds, per pod. With your
   replica count, how many lines a day is that, and what fraction of your total volume?
5. Why is `log_level` a good label and `user_id` a terrible one — in one sentence each?
6. Promtail is end-of-life. What replaced it, and why does that matter for what you
   install?

## Read

- [Loki — labels and cardinality](https://grafana.com/docs/loki/latest/get-started/labels/)
  — the most important page here
- [Loki — deployment modes](https://grafana.com/docs/loki/latest/get-started/deployment-modes/)
- [LogQL](https://grafana.com/docs/loki/latest/query/) — log queries and metric queries
- [Grafana Alloy — components](https://grafana.com/docs/alloy/latest/) — enough to write a
  pipeline

## Build

### 6.1 Loki

Install it in single-binary mode with filesystem storage. Laptop-sized.

Two traps in the modern chart: the distributed-topology replica counts default to non-zero
even in single-binary mode, and the caches default to multi-gigabyte memcached instances.
If your install eats 6GB and never becomes Ready, that is why.

Set a retention period and ingestion rate limits deliberately, and be able to say what
happens when a service exceeds them mid-incident.

**Prove it:** Loki's own `/ready` endpoint, and a Grafana Loki datasource that connects.

### 6.2 Ship the logs

Install a collector as a DaemonSet. It needs to read the container log files on the node,
which has implications for the security context — understand them rather than copying a
config that runs as root.

Your pipeline should:

- discover pods, and **keep only the namespaces you care about** (shipping kube-system's
  chatter is how a log bill quadruples for no diagnostic value)
- parse the CRI envelope, then parse your JSON payload
- use the app's own timestamp rather than ingest time — work out why this matters during a
  collector restart, and what your incident timeline looks like if you get it wrong
- drop successful health-probe lines

**Prove it:** `{namespace="ecommerce-dev"}` in Grafana Explore returns live logs.

### 6.3 Label design — the real exercise

Decide your label set and justify it in writing. For each candidate label, state the
cardinality and whether it is bounded:

`namespace` · `service` · `pod` · `container` · `node` · `level` · `route` ·
`status` · `trace_id` · `user_id`

Some belong as labels. Some belong in the line. At least one belongs as **structured
metadata** — find out what that is and why it exists, because it is exactly the mechanism
for the high-cardinality field you will need in phase 8.

Write the justification in `observability/docs/log-labels.md`. One line per label with the
reasoning. This document is worth more in an interview than the config itself.

### 6.4 LogQL drills

Write these yourself:

1. All errors from one service in the last hour
2. Errors grouped by route, as a rate — a metric query over logs
3. Requests slower than 500ms, parsed from the JSON field
4. The count of distinct pods that logged an error
5. A log line filtered by a field that is *not* a label

Note which of these are fast and which scan a lot of data, and why. That intuition is the
whole difference between Loki and an indexed log store.

### 6.5 Retention, limits and the cost conversation

Answer, with numbers from your cluster:

- how many bytes a day do your three services produce?
- at that rate, what does 30 days cost in a managed log service at roughly $0.50/GB
  ingested? (Look up the current Azure Monitor Logs and Datadog per-GB prices for a real
  figure.)
- which single change would cut it most, and what would you lose?

## Self-check

- A developer asks you to add `request_id` as a Loki label so they can filter on it. What
  do you say, and what do you offer instead?
- Loki returns 5xx on writes during an incident. Most likely cause?
- Why might you deliberately sample or drop info-level logs in production but never error
  logs?
- Your log volume triples overnight with no traffic change. Where do you look?
- What is the failure mode of logging to a file inside a container?

## If you're stuck

- **Loki never becomes Ready:** the replica counts and caches from 6.1.
- **No logs arriving:** check the collector's own logs first. Then check that its pod can
  actually read the host log path, then that your relabel rules are not dropping
  everything (a `keep` action with a regex that matches nothing drops all targets).
- **Logs arrive but the JSON fields are not queryable:** you need a parser stage in the
  pipeline, or `| json` at query time. Know the difference — one costs at write time, the
  other at read time.
- **Timestamps are all bunched at the same instant:** you are using ingest time. Find the
  stage that sets the timestamp from a parsed field, and get the format string right.
- **"maximum active stream limit exceeded":** a label with unbounded values. Find it with
  the label-values API before guessing.

## Review checkpoint

Show me:

1. Your Loki values and collector pipeline
2. `log-labels.md`
3. Your five LogQL queries
4. Your volume and cost numbers

I will push on: every label in your set; the timestamp decision; what happens when one pod
starts logging a stack trace per request; and whether your retention would survive a real
incident investigation three weeks later.

## After this phase you can say

> "Logs are JSON to stdout, shipped by a DaemonSet collector into Loki. The label set is
> deliberately small — Loki indexes only labels, so a label per request id would create a
> stream per request. High-cardinality fields stay in the line and in structured metadata,
> which keeps them queryable without becoming an index. Probe traffic is dropped at the
> collector, which is the single biggest volume saving available."
