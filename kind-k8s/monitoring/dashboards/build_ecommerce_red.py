#!/usr/bin/env python3
"""
Builds the "Ecommerce – RED" Grafana dashboard (v2 schema) as code.

    python3 kind-k8s/monitoring/dashboards/build_ecommerce_red.py
    kubectl apply --server-side --force-conflicts \
        -f kind-k8s/monitoring/dashboards/dashboard-ecommerce-red.yaml

(--server-side because the ConfigMap is over 256 KiB: a plain client-side apply stores
a full copy in the last-applied-configuration annotation, and annotations are capped
at 256 KiB, so it fails with "metadata.annotations: Too long".)

Writes two files next to this script:
    ecommerce-red.json             the dashboard, for import / review
    dashboard-ecommerce-red.yaml   the ConfigMap the Grafana sidecar provisions from

WHY A GENERATOR
---------------
The dashboard uses Grafana's v2 schema: panels live in `spec.elements` and are placed by
a separate `spec.layout` tree. Hand-editing that across ~30 panels is how a stray
datasource uid or a duplicated panel id gets in -- and Grafana's file provisioning fails
QUIETLY, keeping the old version and logging an error nobody reads. Every panel here is
built by the same few helpers, so datasource references, ids and grid positions are
correct by construction.

THE FOUR ORIGINAL RED PANELS
----------------------------
panel-1..panel-4 (request rate, error %, latency, slowest routes) were built in the
Grafana UI. They are read from the existing ecommerce-red.json and carried over
unchanged, apart from removing "hide series" overrides that the UI stores when you click
a legend entry (one hid every service except order-service from "Request rate").
Edit those four in Grafana, export, and re-run this script; everything else is defined
below.

DATASOURCES ARE REFERENCED BY UID
---------------------------------
prometheus / loki / tempo are fixed uids set in kube-prometheus-stack-values.yaml. A
datasource provisioned without a uid gets a random one on every Grafana restart (Grafana
has no PVC here), which is exactly how panel-5 once ended up pointing at "ffzzoqcxmeccgf".
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
EXISTING = HERE / "ecommerce-red.json"
OUT_JSON = HERE / "ecommerce-red.json"
OUT_CM = HERE / "dashboard-ecommerce-red.yaml"

VERSION = "13.2.2"          # Grafana version the panel options were checked against
PROM, LOKI, TEMPO = "prometheus", "loki", "tempo"

# The dashboard's UID. In the v2 schema this is metadata.name, and it is also the URL:
#   http://grafana.localhost/d/ecommerce-red
# Fixed and readable on purpose. Alert rules (via __dashboardUid__), links from other
# dashboards and annotations all point at a dashboard BY UID, so changing it later breaks
# every one of them. It was the UI-generated "adktkg4" until 2026-11-11.
# Allowed: letters, digits, "-" and "_", at most 40 characters.
DASHBOARD_UID = "ecommerce-red"

# Namespaces the logs and traces rows cover.
APP_NS = "ecommerce-dev"
MON_NS = "monitoring"

# Latency SLO threshold. Kept identical to the gateway's tail-sampling "keep-slow" policy
# (alloy-gateway-values.yaml) and to a histogram bucket boundary in the services'
# metrics.ts, so a trace, a log line and a metric all mean the same thing by "slow".
SLOW_MS = 500


# ---------------------------------------------------------------------------------------
# Query builders
# ---------------------------------------------------------------------------------------
def prom(ref, expr, legend="", instant=False, fmt="time_series"):
    return {"kind": "PanelQuery", "spec": {"hidden": False, "refId": ref, "query": {
        "kind": "DataQuery", "group": "prometheus", "version": "v0",
        "datasource": {"name": PROM},
        "spec": {"editorMode": "code", "expr": expr.strip(), "legendFormat": legend,
                 "instant": instant, "range": not instant, "format": fmt,
                 "exemplar": False}}}}


def loki(ref, expr, legend="", logs=False):
    spec = {"editorMode": "code", "expr": expr.strip(), "queryType": "range"}
    if logs:
        spec["direction"] = "backward"
    else:
        spec["legendFormat"] = legend
    return {"kind": "PanelQuery", "spec": {"hidden": False, "refId": ref, "query": {
        "kind": "DataQuery", "group": "loki", "version": "v0",
        "datasource": {"name": LOKI}, "spec": spec}}}


def tempo(ref, traceql, limit=20):
    return {"kind": "PanelQuery", "spec": {"hidden": False, "refId": ref, "query": {
        "kind": "DataQuery", "group": "tempo", "version": "v0",
        "datasource": {"name": TEMPO},
        "spec": {"queryType": "traceql", "query": traceql, "limit": limit,
                 "tableType": "traces", "filters": []}}}}


# ---------------------------------------------------------------------------------------
# Panel builders
# ---------------------------------------------------------------------------------------
_ids = iter(range(100, 1000))


def panel(title, viz, queries, *, desc="", defaults=None, overrides=None, options=None,
          transformations=None):
    return {"kind": "Panel", "spec": {
        "id": next(_ids), "title": title, "description": desc, "links": [],
        "data": {"kind": "QueryGroup", "spec": {
            "queries": queries, "queryOptions": {},
            "transformations": [
                {"kind": "Transformation", "group": t["id"], "spec": t}
                for t in (transformations or [])]}},
        "vizConfig": {"kind": "VizConfig", "group": viz, "version": VERSION, "spec": {
            "fieldConfig": {"defaults": defaults or {}, "overrides": overrides or []},
            "options": options or {}}}}}


def steps(*pairs):
    """steps(("green", None), ("red", 80)) -> threshold steps; None = base."""
    return {"mode": "absolute",
            "steps": [{"color": c, "value": v} for c, v in pairs]}


REDUCE_LAST = {"calcs": ["lastNotNull"], "fields": "", "values": False}

# 1 = up/healthy, 0 = down. Used by every health tile.
HEALTH_MAPPING = [{"type": "value", "options": {
    "1": {"text": "UP", "color": "green", "index": 0},
    "0": {"text": "DOWN", "color": "red", "index": 1}}}]


def health_stat(title, queries, desc):
    return panel(title, "stat", queries, desc=desc,
                 defaults={"mappings": HEALTH_MAPPING, "noValue": "NO DATA",
                           "color": {"mode": "thresholds"},
                           "thresholds": steps(("red", None), ("green", 1))},
                 options={"colorMode": "background", "graphMode": "none",
                          "justifyMode": "center", "orientation": "auto",
                          "textMode": "value_and_name", "wideLayout": True,
                          "showPercentChange": False, "reduceOptions": REDUCE_LAST})


def number_stat(title, queries, desc, thresholds, unit="none", decimals=0):
    return panel(title, "stat", queries, desc=desc,
                 defaults={"unit": unit, "decimals": decimals, "noValue": "0",
                           "color": {"mode": "thresholds"}, "thresholds": thresholds},
                 options={"colorMode": "background", "graphMode": "area",
                          "justifyMode": "center", "orientation": "auto",
                          "textMode": "value_and_name", "wideLayout": True,
                          "showPercentChange": False, "reduceOptions": REDUCE_LAST})


def timeseries(title, queries, desc, unit, *, stack=False, bars=False,
               thresholds=None, show_thresholds=False, min_=None, max_=None):
    defaults = {
        "unit": unit, "color": {"mode": "palette-classic"},
        "custom": {
            "drawStyle": "bars" if bars else "line", "lineWidth": 1,
            "fillOpacity": 60 if bars else 10, "lineInterpolation": "smooth",
            "showPoints": "never", "spanNulls": False,
            "stacking": {"group": "A", "mode": "normal" if stack else "none"},
            "thresholdsStyle": {"mode": "line+area" if show_thresholds else "off"},
            "axisPlacement": "auto", "gradientMode": "none"},
        "thresholds": thresholds or steps(("green", None))}
    if min_ is not None:
        defaults["min"] = min_
    if max_ is not None:
        defaults["max"] = max_
    return panel(title, "timeseries", queries, desc=desc, defaults=defaults, options={
        "legend": {"displayMode": "table", "placement": "right", "showLegend": True,
                   "calcs": ["lastNotNull", "max"], "sortBy": "Last *", "sortDesc": True},
        "tooltip": {"mode": "multi", "sort": "desc"}})


def gauge(title, queries, desc):
    return panel(title, "gauge", queries, desc=desc,
                 defaults={"unit": "percent", "min": 0, "max": 100, "decimals": 1,
                           "color": {"mode": "thresholds"},
                           "thresholds": steps(("green", None), ("yellow", 70), ("red", 90))},
                 options={"reduceOptions": REDUCE_LAST, "orientation": "auto",
                          "showThresholdLabels": False, "showThresholdMarkers": True,
                          "sizing": "auto", "minVizHeight": 75, "minVizWidth": 75})


def bargauge(title, queries, desc, thresholds, max_=100):
    return panel(title, "bargauge", queries, desc=desc,
                 defaults={"unit": "percent", "min": 0, "max": max_, "decimals": 0,
                           "noValue": "no pods with this resource set",
                           "color": {"mode": "thresholds"}, "thresholds": thresholds},
                 options={"displayMode": "gradient", "orientation": "horizontal",
                          "valueMode": "color", "namePlacement": "left",
                          "showUnfilled": True, "sizing": "manual",
                          "minVizHeight": 14, "maxVizHeight": 18, "minVizWidth": 8,
                          "reduceOptions": REDUCE_LAST, "legend": {"showLegend": False}})


def logs_panel(title, query, desc):
    return panel(title, "logs", [query], desc=desc, options={
        "showTime": True, "showLabels": False, "showCommonLabels": False,
        "wrapLogMessage": True, "prettifyLogMessage": False, "enableLogDetails": True,
        "enableInfiniteScrolling": True, "dedupStrategy": "none",
        "sortOrder": "Descending"})


def traces_table(title, query, desc):
    return panel(title, "table", [query], desc=desc,
                 defaults={"custom": {"align": "auto", "cellOptions": {"type": "auto"}},
                           "noValue": "No traces in this time range"},
                 options={"showHeader": True, "cellHeight": "sm",
                          "footer": {"show": False}})


# ---------------------------------------------------------------------------------------
# Layout builders
# ---------------------------------------------------------------------------------------
elements = {}


def place(name, el, x, y, w, h):
    elements[name] = el
    return {"kind": "GridLayoutItem", "spec": {
        "element": {"kind": "ElementReference", "name": name},
        "x": x, "y": y, "width": w, "height": h}}


def row(title, items, collapse=False):
    return {"kind": "RowsLayoutRow", "spec": {
        "title": title, "collapse": collapse,
        "layout": {"kind": "GridLayout", "spec": {"items": items}}}}


# ---------------------------------------------------------------------------------------
# Variables
# ---------------------------------------------------------------------------------------
def query_var(name, label, query, *, all_value=".*", desc=""):
    return {"kind": "QueryVariable", "spec": {
        "name": name, "label": label, "description": desc,
        "query": {"kind": "DataQuery", "group": "prometheus", "version": "v0",
                  "datasource": {"name": PROM},
                  "spec": {"qryType": 1, "query": query, "refId": f"{name}-var"}},
        "definition": query,
        "current": {"text": ["All"], "value": ["$__all"]},
        "options": [], "multi": True, "includeAll": True, "allValue": all_value,
        "refresh": "onTimeRangeChanged", "regex": "", "sort": "alphabeticalAsc",
        "hide": "dontHide", "skipUrlSync": False, "allowCustomValue": True}}


def text_var(name, label, desc=""):
    return {"kind": "TextVariable", "spec": {
        "name": name, "label": label, "description": desc, "query": "",
        "current": {"text": "", "value": ""}, "hide": "dontHide", "skipUrlSync": False}}


# ---------------------------------------------------------------------------------------
# Load the existing dashboard: keep panels 1-4, the service variable and settings
# ---------------------------------------------------------------------------------------
existing = json.loads(EXISTING.read_text())
old = existing["spec"]


def strip_ui_hidden_series(el):
    """Drop the 'hideSeriesFrom' overrides the UI saves when a legend item is clicked."""
    fc = el["spec"]["vizConfig"]["spec"].get("fieldConfig", {})
    fc["overrides"] = [o for o in fc.get("overrides", [])
                       if o.get("__systemRef") != "hideSeriesFrom"]
    return el


for k in ("panel-1", "panel-2", "panel-3", "panel-4"):
    elements[k] = strip_ui_hidden_series(old["elements"][k])

service_var = next(v for v in old["variables"] if v["spec"]["name"] == "service")

ns = '{namespace=~"$namespace"}'   # pod-health and resources rows follow $namespace

# =======================================================================================
# ROW 1 -- Service RED (the original panels)
# =======================================================================================
# Node.js event-loop lag (prom-client default metrics). The one signal that explains a
# trace with a long gap and NO child spans: the process was alive but its single thread
# was busy (CPU-bound work such as pure-JS bcrypt, GC, or CPU throttling), so the request
# simply waited. Request latency rises with no error anywhere.
evloop = timeseries("Event-loop lag p99 by service", [
    prom("A", 'max by (service) (nodejs_eventloop_lag_p99_seconds{namespace="ecommerce-dev", service=~"$service"})', "{{service}}"),
], "Time a callback waited for the single Node.js thread. Every request on that pod pays "
   "it. Sustained > 100ms means the process is CPU-starved or blocked. Alert: > 200ms "
   "for 5m.", "s", thresholds=steps(("green", None), ("yellow", 0.1), ("red", 0.2)),
    show_thresholds=True, min_=0)

row_red = row("Service RED — rate, errors, duration", [
    {"kind": "GridLayoutItem", "spec": {"element": {"kind": "ElementReference", "name": "panel-1"}, "x": 0, "y": 0, "width": 12, "height": 8}},
    {"kind": "GridLayoutItem", "spec": {"element": {"kind": "ElementReference", "name": "panel-2"}, "x": 12, "y": 0, "width": 12, "height": 8}},
    {"kind": "GridLayoutItem", "spec": {"element": {"kind": "ElementReference", "name": "panel-3"}, "x": 0, "y": 8, "width": 12, "height": 8}},
    {"kind": "GridLayoutItem", "spec": {"element": {"kind": "ElementReference", "name": "panel-4"}, "x": 12, "y": 8, "width": 12, "height": 8}},
    place("evloop", evloop, 0, 16, 24, 7),
])

# =======================================================================================
# ROW 2 -- Control plane & pod health
# =======================================================================================
# kind binds etcd, the scheduler and the controller-manager to 127.0.0.1, so their
# metrics are NOT scraped (kubeEtcd/kubeScheduler/kubeControllerManager are disabled in
# kube-prometheus-stack-values.yaml). For those, health = "is the static pod Ready",
# read from kube-state-metrics. Where a real scrape exists (API server, CoreDNS, kubelet),
# health = Prometheus can reach it (`up`). `or vector(0)` turns a MISSING component into
# DOWN instead of a blank tile -- a vanished etcd pod must not look like "no data".
def pod_ready(prefix):
    return (f'min(kube_pod_status_ready{{namespace="kube-system",pod=~"{prefix}-.*",'
            f'condition="true"}}) or vector(0)')


cp = health_stat("Control plane components", [
    prom("A", 'min(up{job="apiserver"}) or vector(0)', "API server", instant=True),
    prom("B", pod_ready("etcd"), "etcd", instant=True),
    prom("C", pod_ready("kube-scheduler"), "Scheduler", instant=True),
    prom("D", pod_ready("kube-controller-manager"), "Controller manager", instant=True),
    prom("E", 'min(up{job="coredns"}) or vector(0)', "CoreDNS", instant=True),
    prom("F", 'min(up{job="kubelet", metrics_path="/metrics"}) or vector(0)', "Kubelets", instant=True),
    prom("G", pod_ready("kube-proxy"), "kube-proxy", instant=True),
    prom("H", pod_ready("kindnet"), "CNI (kindnet)", instant=True),
    prom("I", pod_ready("metrics-server"), "metrics-server", instant=True),
], desc=("UP/DOWN per control-plane component. API server, CoreDNS and kubelets: can "
         "Prometheus scrape them (`up`). etcd, scheduler, controller-manager, kube-proxy, "
         "kindnet, metrics-server: is their pod Ready (kube-state-metrics) -- kind binds "
         "their metrics to localhost, so they are not scraped. Multi-instance components "
         "show DOWN if ANY instance is down. Alert: any tile == 0 for 2m."))

nodes = number_stat("Nodes", [
    prom("A", 'sum(kube_node_status_condition{condition="Ready",status="true"})', "Ready", instant=True),
    prom("B", 'count(kube_node_info) - sum(kube_node_status_condition{condition="Ready",status="true"})', "Not ready", instant=True),
    prom("C", 'sum(kube_node_status_condition{condition=~"MemoryPressure|DiskPressure|PIDPressure",status="true"}) or vector(0)', "Under pressure", instant=True),
], "Node readiness and kubelet-reported pressure. Alert: Not ready > 0 or Under pressure > 0 for 5m.",
    steps(("green", None)))
# colour the 'bad' counts red when non-zero
nodes["spec"]["vizConfig"]["spec"]["fieldConfig"]["overrides"] = [
    {"matcher": {"id": "byName", "options": n},
     "properties": [{"id": "thresholds", "value": steps(("green", None), ("red", 1))}]}
    for n in ("Not ready", "Under pressure")]

pod_summary = number_stat("Pods ($namespace)", [
    prom("A", f'sum(kube_pod_status_phase{{namespace=~"$namespace",phase="Running"}}) or vector(0)', "Running", instant=True),
    prom("B", f'sum(kube_pod_status_phase{{namespace=~"$namespace",phase="Pending"}}) or vector(0)', "Pending", instant=True),
    prom("C", f'sum(kube_pod_status_phase{{namespace=~"$namespace",phase="Failed"}}) or vector(0)', "Failed", instant=True),
    prom("D", f'''count(
  (kube_pod_status_ready{{namespace=~"$namespace",condition="true"}} == 0)
  unless on (namespace, pod) (kube_pod_status_phase{{phase="Succeeded"}} == 1)
) or vector(0)''', "Not ready", instant=True),
    prom("E", f'count(kube_pod_container_status_waiting_reason{{namespace=~"$namespace",reason="CrashLoopBackOff"}} == 1) or vector(0)', "CrashLoopBackOff", instant=True),
    prom("F", f'round(sum(increase(kube_pod_container_status_restarts_total{{namespace=~"$namespace"}}[1h]))) or vector(0)', "Restarts (1h)", instant=True),
], "Pod counts by state for the selected namespaces. Every tile except Running should be 0. "
   "Alerts: CrashLoopBackOff > 0 for 5m; Not ready > 0 for 10m; Restarts (1h) > 3 per pod.",
    steps(("green", None)))
pod_summary["spec"]["vizConfig"]["spec"]["fieldConfig"]["overrides"] = [
    {"matcher": {"id": "byName", "options": n},
     "properties": [{"id": "thresholds", "value": steps(("green", None), ("red", 1))}]}
    for n in ("Pending", "Failed", "Not ready", "CrashLoopBackOff")] + [
    {"matcher": {"id": "byName", "options": "Restarts (1h)"},
     "properties": [{"id": "thresholds", "value": steps(("green", None), ("yellow", 1), ("red", 5))}]}]

# --- Pod health table: one row per pod, merged from four instant queries ---------------
PHASE_MAP = [{"type": "value", "options": {
    "Running": {"color": "green", "index": 0}, "Pending": {"color": "yellow", "index": 1},
    "Failed": {"color": "red", "index": 2}, "Succeeded": {"color": "blue", "index": 3},
    "Unknown": {"color": "orange", "index": 4}}}]
READY_MAP = [{"type": "value", "options": {
    "1": {"text": "Ready", "color": "green", "index": 0},
    "0": {"text": "Not ready", "color": "red", "index": 1}}}]


def col(name, props):
    return {"matcher": {"id": "byName", "options": name}, "properties": props}


pod_table = panel("Pod health — all pods in $namespace", "table", [
    prom("A", f'max by (namespace, pod, node) (kube_pod_info{ns})', fmt="table", instant=True),
    prom("B", f'max by (namespace, pod, phase) (kube_pod_status_phase{ns} == 1)', fmt="table", instant=True),
    prom("C", f'max by (namespace, pod) (kube_pod_status_ready{{namespace=~"$namespace",condition="true"}})', fmt="table", instant=True),
    prom("D", f'sum by (namespace, pod) (kube_pod_container_status_restarts_total{ns})', fmt="table", instant=True),
    prom("E", f'round(sum by (namespace, pod) (increase(kube_pod_container_status_restarts_total{ns}[1h])))', fmt="table", instant=True),
], desc=("Every pod with its node, phase, readiness and restarts. Built from four "
         "kube-state-metrics queries merged on (namespace, pod). Sorted with not-ready "
         "pods first. Restarts (1h) is the column to alert on; the lifetime total only "
         "tells you a pod has a history."),
    transformations=[
        {"id": "merge", "options": {}},
        {"id": "organize", "options": {
            "excludeByName": {"Time": True, "Value #A": True, "Value #B": True},
            "indexByName": {"namespace": 0, "pod": 1, "phase": 2, "Value #C": 3,
                            "Value #E": 4, "Value #D": 5, "node": 6},
            "renameByName": {"namespace": "Namespace", "pod": "Pod", "phase": "Phase",
                             "Value #C": "Ready", "Value #D": "Restarts (total)",
                             "Value #E": "Restarts (1h)", "node": "Node"}}},
    ],
    defaults={"custom": {"align": "auto", "cellOptions": {"type": "auto"},
                         "filterable": True}},
    overrides=[
        col("Phase", [{"id": "mappings", "value": PHASE_MAP},
                      {"id": "custom.cellOptions", "value": {"type": "color-text"}}]),
        col("Ready", [{"id": "mappings", "value": READY_MAP},
                      {"id": "custom.cellOptions", "value": {"type": "color-background", "mode": "basic"}},
                      {"id": "custom.width", "value": 110}]),
        col("Restarts (1h)", [{"id": "thresholds", "value": steps(("green", None), ("yellow", 1), ("red", 3))},
                              {"id": "custom.cellOptions", "value": {"type": "color-background", "mode": "basic"}},
                              {"id": "custom.width", "value": 120}]),
        col("Restarts (total)", [{"id": "custom.width", "value": 130}]),
    ],
    options={"showHeader": True, "cellHeight": "sm", "footer": {"show": False},
             "sortBy": [{"displayName": "Ready", "desc": False}]})

unhealthy = panel("Unhealthy pods right now", "table", [
    prom("A", f'''
max by (namespace, pod, reason) (kube_pod_container_status_waiting_reason{ns} == 1)
or
max by (namespace, pod, reason) (
  label_replace(
    (kube_pod_status_ready{{namespace=~"$namespace",condition="true"}} == 0)
      unless on (namespace, pod) (kube_pod_status_phase{{phase="Succeeded"}} == 1),
    "reason", "NotReady", "", "")
)
or
max by (namespace, pod, reason) (
  (kube_pod_container_status_last_terminated_reason{{namespace=~"$namespace",reason=~"OOMKilled|Error"}} == 1)
  and on (namespace, pod, container)
  (increase(kube_pod_container_status_restarts_total[1h]) > 0)
)''', fmt="table", instant=True),
], desc=("Only pods with a problem: a waiting reason (CrashLoopBackOff, ImagePullBackOff, "
         "CreateContainerConfigError...), not Ready, or a container that RESTARTED IN THE "
         "LAST HOUR after exiting OOMKilled/Error. The restart condition matters: "
         "last_terminated_reason is kept forever once a container has ever restarted, so "
         "without it pods that are healthy today (restarted by a node reboot weeks ago) "
         "show up -- six did on this cluster. Empty means healthy. This table is the "
         "shape of a good pod alert: the reason label tells the on-call what is broken."),
    transformations=[{"id": "organize", "options": {
        "excludeByName": {"Time": True, "Value": True},
        "renameByName": {"namespace": "Namespace", "pod": "Pod", "reason": "Reason"}}}],
    defaults={"custom": {"align": "auto", "cellOptions": {"type": "auto"}},
              "noValue": "All pods healthy"},
    overrides=[col("Reason", [{"id": "custom.cellOptions", "value": {"type": "color-text"}},
                              {"id": "color", "value": {"mode": "fixed", "fixedColor": "red"}}])],
    options={"showHeader": True, "cellHeight": "sm", "footer": {"show": False}})

api_err = timeseries("API server — 5xx error %", [
    prom("A", '''100 * sum(rate(apiserver_request_total{code=~"5.."}[$__rate_interval]))
/ sum(rate(apiserver_request_total[$__rate_interval]))''', "5xx %"),
], "Share of Kubernetes API requests failing server-side. A sick API server breaks "
   "deploys, HPA and every controller at once. Alert: > 1% for 10m.",
    "percent", thresholds=steps(("green", None), ("red", 1)), show_thresholds=True, min_=0)

api_lat = timeseries("API server — p99 latency (excl. WATCH)", [
    prom("A", '''histogram_quantile(0.99,
  sum by (le, verb) (rate(apiserver_request_duration_seconds_bucket{verb!~"WATCH|CONNECT"}[$__rate_interval])))''',
         "{{verb}}"),
], "p99 per verb. WATCH and CONNECT are long-lived by design and would read as 'slow' "
   "forever, so they are excluded. Alert: mutating verbs p99 > 1s for 10m.",
    "s", thresholds=steps(("green", None), ("red", 1)), show_thresholds=True, min_=0)

row_health = row("Control plane & pod health", [
    place("cp-health", cp, 0, 0, 16, 5),
    place("nodes", nodes, 16, 0, 8, 5),
    place("pod-summary", pod_summary, 0, 5, 24, 4),
    place("pod-table", pod_table, 0, 9, 16, 12),
    place("unhealthy", unhealthy, 16, 9, 8, 12),
    place("api-err", api_err, 0, 21, 12, 7),
    place("api-lat", api_lat, 12, 21, 12, 7),
])

# =======================================================================================
# ROW 3 -- ingress-nginx
# =======================================================================================
# Needs --enable-metrics=true and --metrics-per-host=false on the controller plus the
# ServiceMonitor in monitoring/ingress-nginx-metrics.yaml. Filtered on `ingress`: the
# scrape target's own namespace/service labels win, so the request's are renamed to
# exported_namespace / exported_service.
NGX = 'job="ingress-nginx-controller-metrics"'
REQ = f"nginx_ingress_controller_requests{{{NGX}}}"

ingress_health = health_stat("Ingress controller", [
    prom("A", f'min(up{{{NGX}}}) or vector(0)', "Controller scraped", instant=True),
    prom("B", f'min(nginx_ingress_controller_config_last_reload_successful{{{NGX}}}) or vector(0)', "Last config reload OK", instant=True),
], desc=("Controller scraped: Prometheus can reach :10254. Last config reload OK: the most "
         "recent nginx.conf reload succeeded -- when it is 0, nginx keeps serving the OLD "
         "config, so new Ingress rules silently do nothing. Alert: either == 0 for 5m."))

ingress_kpi = number_stat("Ingress — now", [
    prom("A", f'sum(rate({REQ}[$__rate_interval]))', "Requests/s", instant=True),
    prom("B", f'''100 * (sum(rate(nginx_ingress_controller_requests{{{NGX},status=~"5.."}}[$__rate_interval])) or vector(0))
/ sum(rate({REQ}[$__rate_interval]))''', "5xx %", instant=True),
    prom("C", f'sum(nginx_ingress_controller_nginx_process_connections{{{NGX},state="active"}})', "Active conns", instant=True),
], "Edge view of the whole site: what users experience before any service is involved.",
    steps(("green", None)), decimals=2)
ingress_kpi["spec"]["vizConfig"]["spec"]["fieldConfig"]["overrides"] = [
    col("5xx %", [{"id": "unit", "value": "percent"},
                  {"id": "thresholds", "value": steps(("green", None), ("yellow", 0.5), ("red", 1))}]),
    col("Requests/s", [{"id": "unit", "value": "reqps"}])]

ingress_rps = timeseries("Ingress — requests/s by ingress & status class", [
    prom("A", f'''sum by (ingress, status_class) (
  label_replace(rate({REQ}[$__rate_interval]), "status_class", "${{1}}xx", "status", "(.).."))''',
         "{{ingress}} {{status_class}}"),
], "Traffic per Ingress split into 2xx/3xx/4xx/5xx. A rising 4xx band usually means a "
   "client or routing problem; 5xx means the backend or nginx itself.", "reqps", stack=True)

ingress_5xx = timeseries("Ingress — 5xx error % by ingress", [
    prom("A", f'''100 * (
  sum by (ingress) (rate(nginx_ingress_controller_requests{{{NGX},status=~"5.."}}[$__rate_interval]))
  or sum by (ingress) (rate({REQ}[$__rate_interval])) * 0
) / sum by (ingress) (rate({REQ}[$__rate_interval]))''', "{{ingress}}"),
], "Error ratio at the edge. The `or ... * 0` keeps a flat 0 line when there are no 5xx, "
   "instead of no line at all. Alert: > 1% for 5m (pair with a minimum request rate so "
   "one failed request at 3am does not page).",
    "percent", thresholds=steps(("green", None), ("red", 1)), show_thresholds=True, min_=0)

ingress_lat = timeseries("Ingress — latency p95 / p99 by ingress", [
    prom("A", f'histogram_quantile(0.95, sum by (le, ingress) (rate(nginx_ingress_controller_request_duration_seconds_bucket{{{NGX}}}[$__rate_interval])))', "p95 {{ingress}}"),
    prom("B", f'histogram_quantile(0.99, sum by (le, ingress) (rate(nginx_ingress_controller_request_duration_seconds_bucket{{{NGX}}}[$__rate_interval])))', "p99 {{ingress}}"),
], f"Total time nginx spent on the request, including the upstream. Red line = the "
   f"{SLOW_MS}ms latency threshold used everywhere else on this dashboard.",
    "s", thresholds=steps(("green", None), ("red", SLOW_MS / 1000)), show_thresholds=True, min_=0)

row_ingress = row("Ingress — ingress-nginx", [
    place("ingress-health", ingress_health, 0, 0, 8, 4),
    place("ingress-kpi", ingress_kpi, 8, 0, 16, 4),
    place("ingress-rps", ingress_rps, 0, 4, 12, 8),
    place("ingress-5xx", ingress_5xx, 12, 4, 12, 8),
    place("ingress-lat", ingress_lat, 0, 12, 24, 7),
])

# =======================================================================================
# ROW -- Abuse & safety (production-readiness Phase 0)
# =======================================================================================
# Every Phase 0 protection, visible: what the edge refused, what user-service refused,
# what checkout de-duplicated, and how much malformed input arrived. Quiet is normal;
# the value of this row is spotting the moment it stops being quiet.
abuse_tiles = number_stat("Refused & absorbed — last 15m", [
    prom("A", f'sum(increase(nginx_ingress_controller_requests{{{NGX},status="429"}}[15m])) or vector(0)',
         "Edge 429s", instant=True),
    prom("B", 'sum(increase(auth_throttled_total{reason=~"login_ip|register_ip"}[15m])) or vector(0)',
         "Per-IP throttles", instant=True),
    prom("C", 'sum(increase(auth_throttled_total{reason="account_locked"}[15m])) or vector(0)',
         "Locked-account attempts", instant=True),
    prom("D", 'sum(increase(auth_login_attempts_total{outcome="failure"}[15m])) or vector(0)',
         "Failed logins", instant=True),
    prom("E", 'sum(increase(checkout_idempotency_total{outcome=~"replayed|in_progress"}[15m])) or vector(0)',
         "Duplicate checkouts absorbed", instant=True),
    prom("F", 'sum(increase(http_request_duration_seconds_count{service=~".*-service",status_code="400"}[15m])) or vector(0)',
         "Rejected input (400)", instant=True),
], ("Edge 429s: ingress-nginx refused a client over 20 rps (burst 100). Per-IP throttles: "
    "user-service refused >20 logins/min or >10 registrations/10min from one address. "
    "Locked-account attempts: tries against an account locked after 5 wrong passwords. "
    "Duplicate checkouts absorbed: retries/double-clicks that would have been second "
    "orders before the Idempotency-Key. Alerts: failed logins > 50 in 15m (credential "
    "stuffing); locked-account attempts > 20 in 15m; edge 429s sustained 10m."),
    steps(("green", None)))
abuse_tiles["spec"]["vizConfig"]["spec"]["fieldConfig"]["overrides"] = [
    col("Edge 429s", [{"id": "thresholds", "value": steps(("green", None), ("yellow", 50), ("red", 500))}]),
    col("Per-IP throttles", [{"id": "thresholds", "value": steps(("green", None), ("yellow", 1), ("red", 50))}]),
    col("Locked-account attempts", [{"id": "thresholds", "value": steps(("green", None), ("yellow", 1), ("red", 20))}]),
    col("Failed logins", [{"id": "thresholds", "value": steps(("green", None), ("yellow", 20), ("red", 50))}]),
    col("Duplicate checkouts absorbed", [{"id": "thresholds", "value": steps(("blue", None))}]),
    col("Rejected input (400)", [{"id": "thresholds", "value": steps(("green", None), ("yellow", 100))}]),
]

abuse_429 = timeseries("Throttled requests — where they were refused", [
    prom("A", f'sum(rate(nginx_ingress_controller_requests{{{NGX},status="429"}}[$__rate_interval]))',
         "edge (ingress-nginx)"),
    prom("B", 'sum by (reason) (rate(auth_throttled_total[$__rate_interval]))', "user-service: {{reason}}"),
], ("Two layers. The edge refuses floods before any app code runs; user-service refuses "
    "credential guessing the edge cannot see (20 rps is plenty for a slow password "
    "spray). Edge-only = a noisy client; account_locked = someone targeting accounts."),
    "reqps", min_=0)

abuse_logins = timeseries("Login outcomes", [
    prom("A", 'sum by (outcome) (rate(auth_login_attempts_total[$__rate_interval]))', "{{outcome}}"),
    prom("B", 'sum(rate(auth_password_rehash_total[$__rate_interval]))', "bcrypt -> scrypt upgrades"),
], ("failure rising with success flat = guessing; failure and success both rising = a "
    "traffic spike. Upgrades fall to zero as every pre-v2.7 account has logged in once."),
    "reqps", min_=0)

abuse_idem = timeseries("Checkout idempotency", [
    prom("A", 'sum by (outcome) (rate(checkout_idempotency_total[$__rate_interval]))', "{{outcome}}"),
], ("processed = first request for a key; replayed = a retry answered from the stored "
    "order; in_progress = a double-click while the first was running; mismatch = a client "
    "reusing a key for a different cart (a client bug -- should be 0)."),
    "reqps", min_=0)

abuse_400 = timeseries("Rejected input (400) by route", [
    prom("A", 'sum by (service, route) (rate(http_request_duration_seconds_count{service=~".*-service",status_code="400"}[$__rate_interval])) > 0',
         "{{service}} {{route}}"),
], ("Requests refused by the Zod schemas (or malformed JSON). A sudden rise on one route "
    "right after a frontend deploy usually means the client and API disagree on a field."),
    "reqps", min_=0)

row_abuse = row("Abuse & safety — rate limits, lockouts, idempotency", [
    place("abuse-tiles", abuse_tiles, 0, 0, 24, 4),
    place("abuse-429", abuse_429, 0, 4, 12, 8),
    place("abuse-logins", abuse_logins, 12, 4, 12, 8),
    place("abuse-idem", abuse_idem, 0, 12, 12, 8),
    place("abuse-400", abuse_400, 12, 12, 12, 8),
])

# =======================================================================================
# ROW -- Orders & inventory (production-readiness P1.1 + P1.2)
# =======================================================================================
orders_tiles = number_stat("Orders & stock — last 15m", [
    prom("A", 'sum(increase(order_transitions_total{from="",to="pending_payment"}[15m])) or vector(0)',
         "Checkouts", instant=True),
    prom("B", 'sum(increase(order_transitions_total{to="paid"}[15m])) or vector(0)', "Confirmed", instant=True),
    prom("C", 'sum(increase(order_transitions_total{to="cancelled"}[15m])) or vector(0)', "Cancelled", instant=True),
    prom("D", 'sum(increase(inventory_reservations_total{outcome="out_of_stock"}[15m])) or vector(0)',
         "Refused: out of stock", instant=True),
    prom("E", 'sum(increase(inventory_reservations_total{outcome="expired"}[15m])) or vector(0)',
         "Reservations expired", instant=True),
    prom("F", 'sum(increase(order_stock_release_failures_total[15m])) or vector(0)',
         "Stock release failures", instant=True),
], ("Checkouts = orders created (pending_payment). Confirmed = moved to paid. Refused: out "
    "of stock = a checkout that would have oversold before v2.8. Reservations expired = "
    "stock held for an order that was never confirmed and was returned by the sweeper -- "
    "normally 0 until online payment exists. Stock release failures = a cancelled order "
    "whose units could NOT be returned (they are missing from the shelf). Alerts: release "
    "failures > 0 (page); expired > 0 sustained; out-of-stock rate rising."),
    steps(("green", None)))
orders_tiles["spec"]["vizConfig"]["spec"]["fieldConfig"]["overrides"] = [
    col("Checkouts", [{"id": "thresholds", "value": steps(("blue", None))}]),
    col("Confirmed", [{"id": "thresholds", "value": steps(("blue", None))}]),
    col("Cancelled", [{"id": "thresholds", "value": steps(("blue", None))}]),
    col("Refused: out of stock", [{"id": "thresholds", "value": steps(("green", None), ("yellow", 1))}]),
    col("Reservations expired", [{"id": "thresholds", "value": steps(("green", None), ("orange", 1))}]),
    col("Stock release failures", [{"id": "thresholds", "value": steps(("green", None), ("red", 1))}]),
]

stock_levels = bargauge("Stock on hand — units available to reserve", [
    # Every product-service replica reports the same shared Redis value: max, not sum.
    prom("A", 'max by (product_id) (inventory_stock_units)', "{{product_id}}", instant=True),
], ("Live stock from the shared store. Red at 0 = sold out (checkouts refused); orange "
    "under 10 = restock soon. Alert: any product at 0 for 30m."),
    steps(("red", None), ("orange", 1), ("green", 10)), max_=250)
_sd = stock_levels["spec"]["vizConfig"]["spec"]["fieldConfig"]["defaults"]
_sd["unit"] = "none"
_sd["noValue"] = "no stock data yet"

order_flow = timeseries("Order status changes", [
    prom("A", 'sum by (to) (rate(order_transitions_total[$__rate_interval]))', "→ {{to}}"),
], ("Every lifecycle change by target status. pending_payment and paid should track each "
    "other closely; a growing gap means confirmations are failing. The k6 run cancels "
    "each of its own orders, so cancelled follows paid while it runs."),
    "reqps", min_=0)

reservation_flow = timeseries("Stock reservations", [
    prom("A", 'sum by (outcome) (rate(inventory_reservations_total[$__rate_interval]))', "{{outcome}}"),
], ("held = stock taken for a new order; committed = sold; released = returned on "
    "cancel; expired = returned by the sweeper; out_of_stock = refused."),
    "reqps", min_=0)

row_orders = row("Orders & inventory — lifecycle and stock", [
    place("orders-tiles", orders_tiles, 0, 0, 24, 4),
    place("stock-levels", stock_levels, 0, 4, 8, 9),
    place("order-flow", order_flow, 8, 4, 8, 9),
    place("reservation-flow", reservation_flow, 16, 4, 8, 9),
])

# =======================================================================================
# ROW 4 -- Cluster capacity
# =======================================================================================
# Requests and limits count only Pending/Running pods: kube-state-metrics keeps reporting
# the spec of Succeeded/Failed pods, which the scheduler no longer reserves.
ACTIVE = 'max by (namespace, pod) (kube_pod_status_phase{phase=~"Pending|Running"} == 1)'


def reserved(resource, kind):
    return (f'100 * sum(kube_pod_container_resource_{kind}{{resource="{resource}"}} '
            f'* on (namespace, pod) group_left() {ACTIVE})\n'
            f'/ sum(kube_node_status_allocatable{{resource="{resource}"}})')


cpu_gauge = gauge("Cluster CPU — usage / requests / limits", [
    prom("A", '''100 * sum(rate(container_cpu_usage_seconds_total{container!="", image!=""}[$__rate_interval]))
/ sum(kube_node_status_allocatable{resource="cpu"})''', "Usage", instant=True),
    prom("B", reserved("cpu", "requests"), "Requests", instant=True),
    prom("C", reserved("cpu", "limits"), "Limits", instant=True),
], ("All as % of allocatable CPU across nodes. REQUESTS is what the scheduler has promised "
    "away: near 100% means new pods go Pending even if Usage is low. LIMITS above 100% is "
    "overcommit -- fine for CPU (it throttles), so watch Requests. Alert: Requests > 85%."))

mem_gauge = gauge("Cluster memory — usage / requests / limits", [
    prom("A", '''100 * sum(container_memory_working_set_bytes{container!="", image!=""})
/ sum(kube_node_status_allocatable{resource="memory"})''', "Usage", instant=True),
    prom("B", reserved("memory", "requests"), "Requests", instant=True),
    prom("C", reserved("memory", "limits"), "Limits", instant=True),
], ("All as % of allocatable memory. Usage is working set, the number the kubelet uses for "
    "eviction. Memory LIMITS above 100% is dangerous in a way CPU is not: memory cannot be "
    "throttled, so overcommitted pods get OOMKilled when they all grow at once. "
    "Alerts: Usage > 85%; Limits > 100% as a warning."))

node_bars = bargauge("Per node — CPU and memory used", [
    prom("A", '''100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[$__rate_interval])))
* on (instance) group_left (nodename) node_uname_info''', "CPU {{nodename}}", instant=True),
    prom("B", '''100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)
* on (instance) group_left (nodename) node_uname_info''', "Mem {{nodename}}", instant=True),
], "From node-exporter, so it includes the OS and kubelet, not just pods. One hot node "
   "with a cool cluster average is a scheduling/affinity problem, not a capacity one.",
    steps(("green", None), ("yellow", 70), ("red", 90)))

row_capacity = row("Cluster capacity — CPU & memory", [
    place("cpu-gauge", cpu_gauge, 0, 0, 8, 8),
    place("mem-gauge", mem_gauge, 8, 0, 8, 8),
    place("node-bars", node_bars, 16, 0, 8, 8),
])

# =======================================================================================
# ROW 5 -- Per-pod resources
# =======================================================================================
def pod_ratio(metric_expr, resource, kind):
    return (f'sort_desc(100 *\n  {metric_expr}\n/ sum by (namespace, pod) '
            f'(kube_pod_container_resource_{kind}{{namespace=~"$namespace",resource="{resource}"}}))')


CPU_USE = ('sum by (namespace, pod) (rate(container_cpu_usage_seconds_total'
           '{namespace=~"$namespace",container!="",image!=""}[$__rate_interval]))')
MEM_USE = ('sum by (namespace, pod) (container_memory_working_set_bytes'
           '{namespace=~"$namespace",container!="",image!=""})')

# Thresholds differ on purpose. Over 100% of REQUEST is normal (requests are a floor).
# Near 100% of a CPU LIMIT means throttling; near 100% of a MEMORY LIMIT means an
# imminent OOMKill.
cpu_req = bargauge("CPU used — % of request", [prom("A", pod_ratio(CPU_USE, "cpu", "requests"), "{{namespace}}/{{pod}}", instant=True)],
                   "Per pod. Consistently < 20% = request too high (wasted reservation). "
                   "Consistently > 100% = request too low (scheduler is placing it on "
                   "false information).", steps(("blue", None), ("green", 20), ("yellow", 100), ("red", 200)), max_=200)
cpu_lim = bargauge("CPU used — % of limit", [prom("A", pod_ratio(CPU_USE, "cpu", "limits"), "{{namespace}}/{{pod}}", instant=True)],
                   "Per pod. Near 100% the container is being CPU-throttled: latency rises "
                   "with no error anywhere. Alert: > 90% for 15m.",
                   steps(("green", None), ("yellow", 70), ("red", 90)))
mem_req = bargauge("Memory used — % of request", [prom("A", pod_ratio(MEM_USE, "memory", "requests"), "{{namespace}}/{{pod}}", instant=True)],
                   "Per pod. Pods above 100% of their memory request are the first "
                   "evicted when a node runs short.",
                   steps(("blue", None), ("green", 20), ("yellow", 100), ("red", 150)), max_=200)
mem_lim = bargauge("Memory used — % of limit", [prom("A", pod_ratio(MEM_USE, "memory", "limits"), "{{namespace}}/{{pod}}", instant=True)],
                   "Per pod. THE OOMKill early-warning: at 100% the kernel kills the "
                   "container. Alert: > 90% for 10m.",
                   steps(("green", None), ("yellow", 75), ("red", 90)))

no_limits = number_stat("Pods missing requests / limits ($namespace)", [
    prom("A", f'count(max by (namespace, pod) (kube_pod_info{ns}) unless on (namespace, pod) kube_pod_container_resource_requests{{resource="cpu"}}) or vector(0)', "No CPU request", instant=True),
    prom("B", f'count(max by (namespace, pod) (kube_pod_info{ns}) unless on (namespace, pod) kube_pod_container_resource_limits{{resource="memory"}}) or vector(0)', "No memory limit", instant=True),
], "Pods with no CPU request are invisible to the scheduler's accounting; pods with no "
   "memory limit can consume a whole node. They also never appear in the bars above.",
    steps(("green", None), ("yellow", 1)))

row_pods = row("Pod resources — usage vs requests & limits ($namespace)", [
    place("no-limits", no_limits, 0, 0, 24, 3),
    place("cpu-req", cpu_req, 0, 3, 12, 12),
    place("cpu-lim", cpu_lim, 12, 3, 12, 12),
    place("mem-req", mem_req, 0, 15, 12, 12),
    place("mem-lim", mem_lim, 12, 15, 12, 12),
])

# =======================================================================================
# ROW 5b -- Horizontal Pod Autoscalers
# =======================================================================================
# All from kube-state-metrics. Every query is reduced with max by (namespace,
# horizontalpodautoscaler) to drop the scrape labels (pod/instance of kube-state-metrics),
# so the table's merge has a clean join key.
HPA_BY = "max by (namespace, horizontalpodautoscaler)"
HPA_NS = 'namespace=~"$namespace"'


def hpa_q(metric, extra=""):
    sel = HPA_NS + ("," + extra if extra else "")
    return f"{HPA_BY} (kube_horizontalpodautoscaler_{metric}{{{sel}}})"


AT_MAX = (hpa_q("status_current_replicas") + " >= on (namespace, horizontalpodautoscaler) "
          + hpa_q("spec_max_replicas"))
WANTS_MORE = (hpa_q("status_desired_replicas") + " > on (namespace, horizontalpodautoscaler) "
              + hpa_q("status_current_replicas"))
CANNOT = hpa_q("status_condition", 'condition=~"ScalingActive|AbleToScale",status="false"')

hpa_tiles = number_stat("Autoscaling — now ($namespace)", [
    prom("A", "count(" + hpa_q("spec_max_replicas") + ") or vector(0)", "HPAs", instant=True),
    prom("B", "count(" + AT_MAX + ") or vector(0)", "At max replicas", instant=True),
    prom("C", "count(" + WANTS_MORE + ") or vector(0)", "Wants more pods", instant=True),
    prom("D", "count(" + CANNOT + " == 1) or vector(0)", "Cannot scale", instant=True),
    # changes() needs a RANGE vector, so it is applied to the raw series and aggregated
    # afterwards. Wrapping an aggregation as max(...)[30m] is a parse error (HTTP 400).
    prom("E", "max(changes(kube_horizontalpodautoscaler_status_current_replicas{" + HPA_NS + "}[30m])) or vector(0)",
         "Most scale events (30m)", instant=True),
], ("At max replicas: the autoscaler has hit its ceiling, so any more load becomes latency. "
    "Wants more pods: desired > current -- usually new pods are Pending because the cluster "
    "has no room (check Requests on the CPU/memory gauges). Cannot scale: the HPA has no "
    "metric to act on (metrics-server down, or a missing resource request) and is frozen. "
    "Scale events: many changes in 30m means flapping. Alerts: At max for 15m; Wants more "
    "for 10m; Cannot scale for 5m; scale events > 6 in 30m."), steps(("green", None)))
hpa_tiles["spec"]["vizConfig"]["spec"]["fieldConfig"]["overrides"] = [
    col("HPAs", [{"id": "thresholds", "value": steps(("blue", None))}]),
    col("At max replicas", [{"id": "thresholds", "value": steps(("green", None), ("orange", 1))}]),
    col("Wants more pods", [{"id": "thresholds", "value": steps(("green", None), ("red", 1))}]),
    col("Cannot scale", [{"id": "thresholds", "value": steps(("green", None), ("red", 1))}]),
    col("Most scale events (30m)", [{"id": "thresholds", "value": steps(("green", None), ("yellow", 4), ("red", 7))}]),
]

YES_NO_GOOD = [{"type": "value", "options": {
    "1": {"text": "Yes", "color": "green", "index": 0},
    "0": {"text": "NO", "color": "red", "index": 1}}}]
YES_NO_WARN = [{"type": "value", "options": {
    "1": {"text": "Yes", "color": "orange", "index": 0},
    "0": {"text": "No", "color": "green", "index": 1}}}]

hpa_table = panel("HPA status — $namespace", "table", [
    prom("A", hpa_q("status_current_replicas"), fmt="table", instant=True),
    prom("B", hpa_q("status_desired_replicas"), fmt="table", instant=True),
    prom("C", hpa_q("spec_min_replicas"), fmt="table", instant=True),
    prom("D", hpa_q("spec_max_replicas"), fmt="table", instant=True),
    prom("E", "100 * " + hpa_q("status_current_replicas")
         + " / on (namespace, horizontalpodautoscaler) " + hpa_q("spec_max_replicas"),
         fmt="table", instant=True),
    prom("F", hpa_q("status_target_metric", 'metric_name="cpu",metric_target_type="utilization"'), fmt="table", instant=True),
    prom("G", hpa_q("spec_target_metric", 'metric_name="cpu",metric_target_type="utilization"'), fmt="table", instant=True),
    prom("H", hpa_q("status_target_metric", 'metric_name="memory",metric_target_type="utilization"'), fmt="table", instant=True),
    prom("I", hpa_q("spec_target_metric", 'metric_name="memory",metric_target_type="utilization"'), fmt="table", instant=True),
    prom("J", hpa_q("status_condition", 'condition="ScalingActive",status="true"'), fmt="table", instant=True),
    prom("K", hpa_q("status_condition", 'condition="ScalingLimited",status="true"'), fmt="table", instant=True),
], desc=("One row per autoscaler. CPU % and Memory % are the AVERAGE utilisation across the "
         "target's pods, as a percentage of their REQUESTS -- which is why an HPA is only as "
         "good as the requests it divides by. '% of max' near 100 means no headroom left. "
         "Metrics OK = ScalingActive (the HPA can read its metric). At limit = ScalingLimited "
         "(desired was clamped to min or max)."),
    transformations=[
        {"id": "merge", "options": {}},
        {"id": "organize", "options": {
            "excludeByName": {"Time": True, "namespace": True},
            "indexByName": {"horizontalpodautoscaler": 0, "Value #A": 1, "Value #B": 2,
                            "Value #C": 3, "Value #D": 4, "Value #E": 5, "Value #F": 6,
                            "Value #G": 7, "Value #H": 8, "Value #I": 9, "Value #J": 10,
                            "Value #K": 11},
            "renameByName": {"horizontalpodautoscaler": "HPA", "Value #A": "Replicas",
                             "Value #B": "Desired", "Value #C": "Min", "Value #D": "Max",
                             "Value #E": "% of max", "Value #F": "CPU %",
                             "Value #G": "CPU target", "Value #H": "Memory %",
                             "Value #I": "Memory target", "Value #J": "Metrics OK",
                             "Value #K": "At limit"}}},
    ],
    defaults={"custom": {"align": "center", "cellOptions": {"type": "auto"}}, "decimals": 0},
    overrides=[
        col("HPA", [{"id": "custom.align", "value": "left"}]),
        col("% of max", [{"id": "unit", "value": "percent"},
                         {"id": "thresholds", "value": steps(("green", None), ("yellow", 67), ("red", 100))},
                         {"id": "custom.cellOptions", "value": {"type": "gauge", "mode": "basic", "valueDisplayMode": "text"}},
                         {"id": "min", "value": 0}, {"id": "max", "value": 100}]),
        col("CPU %", [{"id": "unit", "value": "percent"},
                      {"id": "thresholds", "value": steps(("green", None), ("yellow", 65), ("red", 90))},
                      {"id": "custom.cellOptions", "value": {"type": "color-text"}}]),
        col("Memory %", [{"id": "unit", "value": "percent"},
                         {"id": "thresholds", "value": steps(("green", None), ("yellow", 75), ("red", 90))},
                         {"id": "custom.cellOptions", "value": {"type": "color-text"}}]),
        col("CPU target", [{"id": "unit", "value": "percent"}]),
        col("Memory target", [{"id": "unit", "value": "percent"}]),
        col("Metrics OK", [{"id": "mappings", "value": YES_NO_GOOD},
                           {"id": "custom.cellOptions", "value": {"type": "color-background", "mode": "basic"}}]),
        col("At limit", [{"id": "mappings", "value": YES_NO_WARN},
                         {"id": "custom.cellOptions", "value": {"type": "color-background", "mode": "basic"}}]),
    ],
    options={"showHeader": True, "cellHeight": "sm", "footer": {"show": False},
             "sortBy": [{"displayName": "% of max", "desc": True}]})

DASHED = {"fill": "dash", "dash": [10, 10]}


def dashed(regex):
    return {"matcher": {"id": "byRegexp", "options": regex},
            "properties": [{"id": "custom.lineStyle", "value": DASHED}]}


hpa_replicas = timeseries("Replicas over time — current vs desired", [
    prom("A", hpa_q("status_current_replicas"), "{{horizontalpodautoscaler}}"),
    prom("B", hpa_q("status_desired_replicas"), "desired {{horizontalpodautoscaler}}"),
], ("Solid = running replicas, dashed = what the HPA wants. A dashed line sitting ABOVE its "
    "solid line means the HPA asked for pods that did not start (Pending -- no capacity). "
    "A sawtooth means flapping: lengthen behavior.scaleDown.stabilizationWindowSeconds."),
    "short", min_=0)
_fc = hpa_replicas["spec"]["vizConfig"]["spec"]["fieldConfig"]
_fc["overrides"] = [dashed("/^desired /")]
_fc["defaults"]["custom"]["lineInterpolation"] = "stepAfter"
_fc["defaults"]["decimals"] = 0


def util_vs_target(title, resource):
    sel = f'metric_name="{resource}",metric_target_type="utilization"'
    p = timeseries(title, [
        prom("A", hpa_q("status_target_metric", sel), "{{horizontalpodautoscaler}}"),
        prom("B", hpa_q("spec_target_metric", sel), "target {{horizontalpodautoscaler}}"),
    ], (f"Average {resource} utilisation the HPA sees (% of request); dashed = its target. "
        f"Above the dashed line the HPA adds pods; well below it, it removes them once the "
        f"scale-down stabilisation window has passed."), "percent", min_=0)
    p["spec"]["vizConfig"]["spec"]["fieldConfig"]["overrides"] = [dashed("/^target /")]
    return p


hpa_cpu = util_vs_target("HPA CPU utilisation vs target", "cpu")
hpa_mem = util_vs_target("HPA memory utilisation vs target", "memory")

row_hpa = row("Autoscaling — HPA ($namespace)", [
    place("hpa-tiles", hpa_tiles, 0, 0, 24, 4),
    place("hpa-table", hpa_table, 0, 4, 24, 7),
    place("hpa-replicas", hpa_replicas, 0, 11, 8, 8),
    place("hpa-cpu", hpa_cpu, 8, 11, 8, 8),
    place("hpa-mem", hpa_mem, 16, 11, 8, 8),
])

# =======================================================================================
# ROW 6 -- Logs
# =======================================================================================
# Matches both JSON  "level":"error"  (our services) and logfmt  level=error  (Grafana,
# Loki, Tempo, Alloy). Case-sensitive on purpose: "error" inside a message body is not an
# error-level line.
ERR_RE = r'level[=\":]+\"?(error|err|fatal)'


def stream(namespace):
    return f'{{namespace="{namespace}", pod=~"$pod"}}'


log_volume = timeseries("Log lines/s by namespace & app", [
    loki("A", f'sum by (namespace, app) (rate({{namespace=~"{APP_NS}|{MON_NS}", pod=~"$pod"}} [$__auto]))', "{{namespace}}/{{app}}"),
], "Volume, not content. A sudden step usually means a retry loop or a new noisy log "
   "statement -- and it is what Loki bills you for.", "short", stack=True, bars=True)

log_errors = timeseries("Error-level log lines/s by app", [
    loki("A", f'sum by (namespace, app) (rate({{namespace=~"{APP_NS}|{MON_NS}", pod=~"$pod"}} |~ `{ERR_RE}` [$__auto]))', "{{namespace}}/{{app}}"),
], "Lines whose level is error/err/fatal, in JSON or logfmt. Candidate for a Loki ruler "
   "alert: rate > 0.1/s for 10m on any app.", "short", stack=True, bars=True,
    thresholds=steps(("green", None), ("red", 0.1)))

logs_app = logs_panel(f"Logs — {APP_NS}", loki("A", f'{stream(APP_NS)} |~ `(?i)$search`', logs=True),
                      f"Live logs from every pod in {APP_NS}. Use the Pod and Search "
                      "variables at the top; Search is a case-insensitive regex.")
logs_mon = logs_panel(f"Logs — {MON_NS}", loki("A", f'{stream(MON_NS)} |~ `(?i)$search`', logs=True),
                      f"Live logs from every pod in {MON_NS} -- Grafana, Prometheus, Loki, "
                      "Tempo, Alloy. Look here first when a panel above is empty.")

row_logs = row(f"Logs — {APP_NS} & {MON_NS}", [
    place("log-volume", log_volume, 0, 0, 12, 7),
    place("log-errors", log_errors, 12, 0, 12, 7),
    place("logs-app", logs_app, 0, 7, 12, 14),
    place("logs-mon", logs_mon, 12, 7, 12, 14),
])

# =======================================================================================
# ROW 7 -- Traces
# =======================================================================================
# Tempo holds what the gateway's tail sampling kept: every error, every trace over
# 500ms, and 10% of the rest. "Recent" panels therefore show a sample; the error and slow
# panels are complete.
def ns_filter(namespace):
    return f'resource.k8s.namespace.name = "{namespace}"'


traces_app = traces_table(f"Recent traces — {APP_NS}", tempo("A", f'{{ {ns_filter(APP_NS)} }}'),
                          "Click a Trace ID to open the waterfall. This is a 10% sample of "
                          "healthy traffic plus everything errored or slow.")
traces_err = traces_table(f"Error traces — {APP_NS}", tempo("A", f'{{ {ns_filter(APP_NS)} && status = error }}'),
                          "Every trace containing a failed span. Complete, not sampled -- "
                          "the gateway keeps 100% of these.")
traces_slow = traces_table(f"Slow traces (> {SLOW_MS}ms) — {APP_NS}",
                           tempo("A", f'{{ {ns_filter(APP_NS)} && traceDuration > {SLOW_MS}ms }}'),
                           "Every trace over the latency threshold. Complete, not sampled.")
traces_mon = traces_table(f"Recent traces — {MON_NS}", tempo("A", f'{{ {ns_filter(MON_NS)} }}'),
                          "Grafana traces itself into the same pipeline (grafana.ini "
                          "tracing.opentelemetry in kube-prometheus-stack-values.yaml). "
                          "A slow dashboard shows here as a slow Grafana trace, with the "
                          "datasource call that took the time.")

row_traces = row(f"Traces — {APP_NS} & {MON_NS}", [
    place("traces-app", traces_app, 0, 0, 12, 9),
    place("traces-err", traces_err, 12, 0, 12, 9),
    place("traces-slow", traces_slow, 0, 9, 12, 9),
    place("traces-mon", traces_mon, 12, 9, 12, 9),
])

# ---------------------------------------------------------------------------------------
# Assemble
# ---------------------------------------------------------------------------------------
spec = {
    "title": "Ecommerce – RED",
    "description": ("Service RED, control-plane and pod health, ingress, capacity, and the "
                    "logs and traces behind them. Generated by build_ecommerce_red.py."),
    "tags": ["ecommerce", "red", "kubernetes", "generated"],
    "editable": True, "liveNow": False, "preload": False, "cursorSync": "Crosshair",
    "links": [],
    "annotations": old["annotations"],
    "timeSettings": {**old["timeSettings"], "from": "now-30m"},
    "variables": [
        service_var,
        query_var("namespace", "Namespace", "label_values(kube_pod_info, namespace)",
                  desc="Filters the pod-health and pod-resources rows."),
        query_var("pod", "Pod (logs)",
                  f'label_values(kube_pod_info{{namespace=~"{APP_NS}|{MON_NS}"}}, pod)',
                  desc=f"Filters the logs row ({APP_NS} and {MON_NS} pods)."),
        text_var("search", "Log search (regex)",
                 desc="Case-insensitive regex applied to the log panels. Empty = everything."),
    ],
    "elements": elements,
    "layout": {"kind": "RowsLayout", "spec": {"rows": [
        # Infrastructure first: is the platform healthy and does it have room? Then the
        # services running on it, the edge in front of them, and the evidence behind both.
        row_health, row_capacity, row_pods, row_hpa, row_red, row_orders, row_ingress, row_abuse,
        row_logs, row_traces]}},
}

dashboard = {"apiVersion": "dashboard.grafana.app/v2", "kind": "Dashboard",
             "metadata": {"name": DASHBOARD_UID}, "spec": spec}

# Sanity checks that would otherwise only surface as a silent provisioning failure.
ids = [e["spec"]["id"] for e in elements.values()]
assert len(ids) == len(set(ids)), "duplicate panel ids"
placed = {i["spec"]["element"]["name"]
          for r in spec["layout"]["spec"]["rows"]
          for i in r["spec"]["layout"]["spec"]["items"]}
assert placed == set(elements), f"placed/defined mismatch: {placed ^ set(elements)}"

body = json.dumps(dashboard, indent=2, ensure_ascii=False)
OUT_JSON.write_text(body + "\n")
indented = "\n".join("    " + line for line in body.splitlines())
OUT_CM.write_text(
    "# GENERATED by build_ecommerce_red.py -- edit the script, not this file.\n"
    "apiVersion: v1\n"
    "data:\n"
    "  ecommerce-red.json: |-\n"
    f"{indented}\n"
    "kind: ConfigMap\n"
    "metadata:\n"
    "  labels:\n"
    '    grafana_dashboard: "1"\n'
    "  name: ecommerce-red-dashboard\n"
    "  namespace: monitoring\n")
print(f"wrote {OUT_JSON.name} and {OUT_CM.name}: {len(elements)} panels in "
      f"{len(spec['layout']['spec']['rows'])} rows")
