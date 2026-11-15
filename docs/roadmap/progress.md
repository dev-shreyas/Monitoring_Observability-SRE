# Progress

Tick as you go. Add the date — seeing the pace is motivating, and the dates become the
timeline you describe in an interview.

## Phase 1 — Foundations
- [ ] 1.1 kind cluster with zone labels
- [ ] 1.2 ingress-nginx + metrics-server
- [ ] 1.3 images built and loaded
- [ ] 1.4 kustomize base + kind overlay
- [ ] 1.5 app reachable, HPAs reporting
- [ ] Review checkpoint

## Phase 2 — Metrics
- [ ] 2.1 kube-prometheus-stack installed
- [ ] 2.2 Understand what the chart gave you
- [ ] 2.3 ServiceMonitors for the three services
- [ ] 2.4 PromQL drills
- [ ] 2.5 Cardinality audit
- [ ] Review checkpoint

## Phase 3 — SLIs & SLOs
- [ ] 3.1 Define valid events
- [ ] 3.2 Write the SLO document
- [ ] 3.3 Availability recording rules
- [ ] 3.4 Latency recording rules
- [ ] 3.5 Error budget + burn rate rules
- [ ] Review checkpoint

## Phase 4 — Alerting
- [ ] 4.1 First (deliberately bad) alert
- [ ] 4.2 Multi-window burn-rate alerts
- [ ] 4.3 The blind-spot alerts
- [ ] 4.4 Alertmanager routing, grouping, inhibition
- [ ] 4.5 Unit-test the rules
- [ ] Review checkpoint

## Phase 5 — Dashboards
- [ ] 5.1 Grafana access + datasource
- [ ] 5.2 RED dashboard
- [ ] 5.3 USE dashboard
- [ ] 5.4 SLO dashboard
- [ ] 5.5 Dashboards as code
- [ ] Review checkpoint

## Phase 6 — Logs
- [ ] 6.1 Loki installed
- [ ] 6.2 Collector shipping logs
- [ ] 6.3 Label design
- [ ] 6.4 LogQL drills
- [ ] 6.5 Retention and limits
- [ ] Review checkpoint

## Phase 7 — Traces
- [x] 7.1 OTel SDK in one service
- [x] 7.2 Collector agent tier
- [x] 7.3 Tempo
- [x] 7.4 All three services + context propagation
- [x] 7.5 Gateway tier + tail sampling
- [ ] Review checkpoint

## Phase 8 — Correlation
- [ ] 8.1 trace_id in logs
- [ ] 8.2 Derived fields in Grafana
- [ ] 8.3 Exemplars
- [ ] 8.4 Service graph / span metrics
- [ ] Review checkpoint

## Phase 9 — Chaos & incidents
- [ ] 9.1 Load generator
- [ ] 9.2 Fault injection
- [ ] 9.3 Drill: error burn
- [ ] 9.4 Drill: latency + cascade
- [ ] 9.5 Drill: pod kill, OOM, throttling
- [ ] 9.6 Runbooks
- [ ] 9.7 A real postmortem
- [ ] Review checkpoint

## Phase 10 — Vendors
- [ ] 10.1 Datadog
- [ ] 10.2 Dynatrace
- [ ] 10.3 The comparison
- [ ] Review checkpoint

## Phase 11 — Production on AKS
- [ ] 11.1 Managed Prometheus + Grafana
- [ ] 11.2 Container Insights and what it costs
- [ ] 11.3 Long-term storage
- [ ] 11.4 Rules and dashboards in CI
- [ ] 11.5 Cost model
- [ ] Review checkpoint

## Phase 12 — Interview
- [ ] 12.1 The two-minute story
- [ ] 12.2 The demo
- [ ] 12.3 Question bank, out loud
- [ ] 12.4 Mock interview
