# Lab notebook

One entry per session. Be honest about what broke — in eight weeks this file is where
your interview stories come from, and "it failed and here is exactly why" is a far better
story than "it worked".

Template:

```
## YYYY-MM-DD — Phase N, task N.N

**Built:**

**Broke:**

**The error actually said:**

**Fixed by:**

**Understood today:**

**Still don't understand:**
```

That last line is the most valuable one. Carry it into the next session and close it.

---

## 2026-11-11 — Phase 7, tasks 7.1–7.5

**Built:**
- OTel Node SDK in all three services (`src/tracing.ts`, first import in `index.ts`), OTLP
  over HTTP/protobuf, configured only through `OTEL_*` env vars. No-op without an endpoint,
  `/health` and `/metrics` suppressed, Express middleware/router layers suppressed, spans
  flushed in graceful shutdown after the HTTP server drains.
- Agent tier: Alloy DaemonSet, OTLP on hostPorts 4317/4318. Pods find their node with the
  downward API (`status.hostIP`) and send to `http://$(NODE_IP):4318`. Pipeline:
  receiver → memory_limiter → k8sattributes → batch → loadbalancing exporter.
- Gateway tier: Alloy Deployment (`alloy-gateway-values.yaml`) behind a headless Service.
  receiver → memory_limiter → attribute scrub → tail_sampling → batch → Tempo.
- Tempo provisioned as a Grafana datasource (uid `tempo`).

**Proved:**
- 7.2: no refused spans at either tier, 0 RBAC errors in any agent; spans carry
  k8s.deployment/pod/node.
- 7.3: trace `d25f612c…` fetched by id through Grafana's datasource proxy (HTTP 200, 9 spans).
- 7.4: one checkout trace, 2 services on 2 nodes, `product-service` server span nested inside
  `order-service`'s outbound GET, 0 children outside their parent's time window.
- 7.5: 200 labelled test traces → errors 10/10 kept, slow (800ms) 10/10 kept, healthy 17/179
  (9%) kept. A planted `user.email` attribute was absent from every kept trace. Gateway in the
  same window: ~39.7k spans in, ~4.9k out.

**Broke:**
- `resourceFromAttributes` does not exist in `@opentelemetry/resources` 1.30 — it is a 2.x
  API. 1.x uses `new Resource({...})`.
- Editing `frontend/nginx.conf` did nothing on kind: the Deployment mounts a ConfigMap over
  `/etc/nginx/nginx.conf` with `subPath`, which shadows the image's copy and never live-updates.
- My own Python patch of `alloy-values.yaml` deleted two processor blocks with an over-greedy
  regex. Caught by printing the wiring (`grep traces = [`) and fixed before applying;
  `alloy validate` then passed.

**The error actually said:**
`TS2724: '"@opentelemetry/resources"' has no exported member named 'resourceFromAttributes'`

**Understood today:**
- Processor order is not style. memory_limiter first: everything after the receiver allocates,
  so a limiter further down protects memory that is already spent. batch last: k8sattributes
  works per span, and batching first would stamp a whole batch with one pod's identity.
- Middleware spans were ~2/3 of every request's spans (25 → 9 per checkout once filtered).
- A client-supplied `traceparent` is honoured: the trace adopts the client's trace id and our
  server span's parent is the client's span, which is not in Tempo — Grafana shows a missing
  root. Verified on trace `24169ccd…`.

### What breaks if the gateway is scaled to three replicas behind a normal Service?

Tail sampling decides per **trace**, after waiting `decision_wait` for all of that trace's
spans to arrive, and the buffer it waits in is **per replica** — replicas share nothing.

A trace's spans are produced by different services on different nodes, so they reach the
gateway through different agents, on different connections. A normal ClusterIP Service
balances **connections**, not traces, so the spans of one checkout get spread over all three
replicas. Each replica then decides on a fragment:

- replica A holds the `product-service` spans: status OK, 2ms → not an error, not slow →
  10% chance of keeping
- replica B holds the `order-service` root that carries the 500 → keeps its fragment
- replica C holds the Redis spans → 10% chance

So an errored trace arrives in Tempo **with holes**, or for the latency policy (which needs the
full trace duration) not at all — and a trace whose error lives only in a child span on one
replica is judged "healthy" by the replicas holding the rest. The policy "keep 100% of
errors" quietly stops being true, with no error anywhere. Tail sampling also gets more
expensive, since every replica buffers partial traces it can never fully judge.

**The standard fix: trace-ID-aware load balancing** — the collector's `loadbalancing`
exporter (`otelcol.exporter.loadbalancing` in Alloy) on the agents, with `routing_key =
"traceID"`, resolving the gateway pods through a **headless** Service so it can address each
replica individually and consistently hash every span of a trace to the same one. That is
already in place here (`alloy-gateway-headless`), so raising `controller.replicas` on the
gateway is safe. Remaining caveat: when a replica is added or removed the hash ring
reshuffles, and traces in flight at that moment can still be split once.

**Still don't understand:**
- How the probabilistic policy and the SDK's own sampler interact if both are ever set — does
  a head-sampled-out trace even reach the gateway? (Answer: no; it is never recorded. Test it.)
- What `traceparent` flags `00` from a client does here: the default sampler is ParentBased,
  so a caller may be able to switch our tracing off for its own requests. Not yet verified.
