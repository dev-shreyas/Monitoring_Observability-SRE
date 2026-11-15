# Phase 4 — Alerting

**Time:** 6–8 hours · **Prerequisite:** Phase 3

## Why this phase

Alerting is where most monitoring setups quietly fail. Not because alerts do not fire —
because too many do, people mute them, and the one that mattered arrives in a channel
nobody reads. Every design decision here exists to protect a human's attention.

You will also do something most candidates have never done: **unit-test your alerting
rules**.

## Understand first

1. What is the difference between alerting on a **symptom** and alerting on a **cause**?
   Give an example of each from your own services.
2. "CPU is at 95%" — should that page someone? Under what circumstances is the answer yes?
3. A burn rate of 14.4 on a 30-day window means what, in plain English and in minutes?
4. Why does a burn-rate alert need **two** windows? Reason it through separately:
   what goes wrong with only a long window, and what goes wrong with only a short one?
5. What does Alertmanager's `group_by` do, and what happens if you include `pod` in it
   during a rolling deploy of 6 replicas?
6. What is an inhibition rule, and which of your alerts should suppress which?
7. If a service scales to zero, which of your phase-3 alerts fire? (Work through it
   honestly — the answer is the reason for two extra alerts in this phase.)

## Read

- [Google SRE Workbook — Alerting on SLOs](https://sre.google/workbook/alerting-on-slos/)
  — the whole chapter; the six approaches build to the answer, and seeing the earlier ones
  fail is what makes the last one make sense
- [Prometheus — alerting rules](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/)
- [Alertmanager — configuration](https://prometheus.io/docs/alerting/latest/configuration/)
  — routing tree, grouping, inhibition
- [promtool — unit testing rules](https://prometheus.io/docs/prometheus/latest/configuration/unit_testing_rules/)

## Build

### 4.1 Write a deliberately bad alert first

Before the good one: write `error rate > 1% for 5 minutes`, deploy it, and generate a
30-second burst of errors with a `curl` loop against a bad path or by scaling a service to
zero briefly.

Watch what it does. Then write in your notebook: how long after recovery did it stop
firing? How many times would this have paged you in a week of normal deploys? Would it
have caught a slow 0.2% leak that exhausts the budget in three days?

Keep the notes. This is the alert everyone writes first, and being able to explain
precisely why it is wrong is worth more than having never written it.

### 4.2 Multi-window multi-burn-rate alerts

Now the real ones. Four rows, from the Workbook chapter:

| Long window | Short window | Burn rate | Severity |
|---|---|---|---|
| 1h | 5m | 14.4 | page |
| 6h | 30m | 6 | page |
| 1d | 2h | 3 | ticket |
| 3d | 6h | 1 | ticket |

Both windows must breach for the alert to fire. Build these for **both** SLIs
(availability and latency) using the recording rules from phase 3 — the alert expression
should be short, because the rules did the work.

Two design points to get right:

- The threshold must come from the objective metric you published in 3.5, not a hard-coded
  number. One rule, three services, three different targets.
- Do you need a `for:` clause? Think about what the long window already does. Decide, and
  be able to defend it.

Every alert needs: `severity`, a `summary` that names the service and the burn rate, a
`description` a woken human can act on, and a `runbook_url`. The runbook does not exist
yet — phase 9 — but the link is part of the alert contract, so write it now.

**Prove it:** Prometheus → Alerts shows eight rules, all green, with your labels.

### 4.3 The alerts that cover the blind spot

Your ratio SLIs read "perfect" when there is no traffic at all. Write two alerts that
cover it:

- one that fires when a service serves zero real requests for N minutes
- one that fires when an **SLI recording rule itself** stops producing a series

For the second, look up `absent()`. Then answer in your notebook: why does an alert on a
missing series never fire on its own, and why is "no alerts firing" not evidence of
health?

Also add a small set of cause-based alerts as **tickets** (not pages): crash looping,
OOMKilled, CPU throttling, memory near limit, HPA pinned at max. Two of those should
arguably be pages — work out which, and why the symptom alerts cannot see them.

### 4.4 Alertmanager

Configure the routing tree:

- pages route to one receiver, fast, with a short group wait and aggressive repeat
- tickets route elsewhere, batched, with a long repeat interval
- informational alerts go nowhere

Then grouping (`group_by`, `group_wait`, `group_interval`, `repeat_interval` — know what
each one does; they are easy to confuse) and at least two inhibition rules.

You have no PagerDuty. Deploy something tiny that receives webhooks and logs them — a
`node:alpine` pod running a 15-line HTTP server from a ConfigMap is enough. That log is
your pager, and it is how you *see* grouping and inhibition working rather than assuming
they do.

**Prove it:** break something, watch one notification arrive with several alerts grouped
into it, and watch the inhibited ones not arrive. Then fix it and watch the resolved
notification.

### 4.5 Unit-test the rules

`promtool test rules`. Write at least four scenarios:

1. A real sustained burn fires the right alert at the right severity — and **include an
   hour of healthy traffic first**. If your series starts at t=0 with errors already
   flowing, `rate()` over 1h computes the bad ratio from three samples and the long window
   protects nothing. The healthy prefix is what makes the test meaningful.
2. A healthy service fires nothing **and** still produces its SLI series (the phase-3 trap).
3. A short blip does not page. Pick the blip size deliberately — small enough that it
   genuinely should not page, and be able to justify the arithmetic.
4. Traffic stopping is caught by your no-traffic alert and *not* by the burn-rate alerts.

promtool needs a plain rules file; your rules are `PrometheusRule` custom resources. Write
a small script that unwraps them so you test exactly what you ship, rather than
maintaining two copies.

**Prove it:** `promtool test rules` prints SUCCESS. Put it in a Makefile target.

## Self-check

- Your fast-burn alert fires. What is the first thing you look at, and why?
- Two services are both breaching. How do you decide which to work on first?
- Why might an alert that fires correctly still be a bad alert?
- Your `description` uses `{{ $value }}`. Which value is it, on an expression with `and`
  between two sides?
- What is the failure mode of `repeat_interval: 5m` on a page?

## If you're stuck

- **Alert never fires in the test:** print the recording rule's value at the eval time
  with `promql_expr_test` before debugging the alert. Usually the rule, not the alert.
- **Test fails only on annotations:** promtool compares annotations too. If a templated
  value makes the text unstable, that is a signal the annotation is doing too much —
  consider whether a `query()` call belongs in an annotation at all.
- **The join in the alert returns nothing:** the same `group_left` problem as phase 3.
  Evaluate each side alone in the expression browser.
- **Alertmanager silently drops alerts:** a route with `continue: false` stops evaluation
  at the first match. Check the order of your routes, and use the routing tree visualiser
  in the Alertmanager UI.
- **Everything arrives as one notification:** that is `group_by` working. Decide whether
  the grouping is right rather than turning it off.

## Review checkpoint

Show me:

1. Your burn-rate rules and your blind-spot alerts
2. Your Alertmanager config
3. Your promtool test file and its output
4. The notebook entry about the bad alert from 4.1

I will push on: whether severity is a function of burn rate or of raw error rate; whether
your test's healthy prefix is long enough to be honest; your inhibition rules; and what
happens when all four rows fire at once.

## After this phase you can say

> "Alerts fire on error-budget burn rate, not on causes. Four rows pairing a long window
> with a short one — the long window kills blips, the short one makes the alert stop fast
> after a fix, which is what stops people ignoring the pager. The rules are unit-tested
> with promtool in CI, including the case where a healthy service produces no error series
> at all, which silently disables ratio alerting if you have not handled it."
