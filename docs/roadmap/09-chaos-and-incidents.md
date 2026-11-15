# Phase 9 — Chaos and incident response

**Time:** 6–8 hours, spread over at least a week · **Prerequisite:** Phase 8

## Why this phase

Everything so far is untested. An alert that has never fired is an alert you do not know
works. A runbook nobody has followed under pressure is a wiki page.

This phase is also where your interview stories come from. "I built a monitoring stack" is
a claim. "I injected a 5% error rate, the fast-burn alert paged in four minutes, the
runbook sent me to the route breakdown, and I found it was one endpoint" is a story, and
stories survive follow-up questions.

## Understand first

1. Why do you practise incidents rather than waiting for real ones?
2. During an incident, what comes first: understanding the cause, or stopping the bleeding?
   What decides?
3. What is the difference between **time to detect** and **time to mitigate**, and which
   one does better monitoring improve?
4. Why is a rollback usually the right first move, and what is the argument against?
5. What does "blameless" mean in a postmortem, and what does it *not* mean?

## Read

- [Google SRE Book — Managing incidents](https://sre.google/sre-book/managing-incidents/)
- [Google SRE Book — Postmortem culture](https://sre.google/sre-book/postmortem-culture/)
- [Google SRE Book — Emergency response](https://sre.google/sre-book/emergency-response/)
- Skim one real published postmortem — Cloudflare's and GitLab's public ones are excellent
  and very readable

## Build

### 9.1 Continuous load

Without traffic, every SLI reads "perfect" and no alert can fire. Deploy a load generator.

Use an **open model** — constant arrival rate, not a fixed number of virtual users. Work
out why this matters: with fixed VUs, when the service slows down your load generator
automatically sends less traffic, masking exactly the degradation you are trying to
measure. k6's `constant-arrival-rate` executor is the standard way.

Weight the traffic like real shoppers: mostly browsing, some search, occasional checkout.
Uniform traffic gives you a dashboard that looks nothing like production.

Bonus, and genuinely valuable: have the load generator write its own metrics into
Prometheus. That gives you a **client-side** SLI next to the server-side one. When they
disagree, the difference is happening outside your application — and that gap is where
the interesting incidents live.

### 9.2 A way to break things on demand

You need fault injection you control. Options, in increasing order of realism:

- scale a deployment to zero, or delete pods
- squeeze resources (`kubectl set resources` with a tiny CPU or memory limit)
- add a small middleware to the services, off by default, that injects errors or latency
  when an environment variable is set

Do the third one too — it is the only way to produce a *specific* error rate and burn the
budget at a rate you choose. Two rules: it must never affect `/health` (or Kubernetes will
restart the pod and you will debug the drill instead of the service), and it must count as
a real failure in your metrics (which constrains where in the middleware chain it goes —
work out where).

### 9.3 Drill: the error burn

Inject 5% errors into product-service. Then, with a timer running:

1. When does the 5m SLI move? When does the 1h one?
2. When does the alert fire? Is that acceptable?
3. Does the notification reach your webhook sink with the right severity and grouping?
4. Follow the runbook link. Does it help? (It does not exist yet — note what you *wish*
   it had said.)
5. How much budget did this cost? Read it off the dashboard before and after.
6. Turn it off. How long until the alert resolves? Explain the difference between that and
   how long until the long window recovers.

Write the whole thing up in the notebook, with times.

### 9.4 Drill: latency, and a cascade

Inject latency into product-service — on a *fraction* of requests, not all, since real
degradation is rarely uniform.

- Watch p50 versus p99. Which moves, and what does that asymmetry tell you?
- Now watch **order-service**, which calls product-service synchronously at checkout. What
  happens to its latency, its error rate, and its event-loop lag?
- Open one slow checkout trace. The waterfall should show exactly why the order span is
  long. Screenshot it — this is the single best artefact you will produce in this roadmap.
- Would scaling order-service help? Reason it through before you try it, then try it.

Then read about timeouts, circuit breakers and bulkheads, and write down which of the
three this system has, which it does not, and what you would add first.

### 9.5 Drill: the infrastructure failures

One per session, each with a written prediction *before* you run it:

- delete a single pod — prediction: zero user-visible errors. If you see 5xx, you have
  found a real bug; chase it down (graceful shutdown and endpoint de-registration).
- scale a service to zero — which alerts fire, and which of your SLO alerts stay silent?
- cut a memory limit until it OOMKills — where is the evidence, and why are the container
  logs silent?
- cut a CPU limit until it throttles — what does the CPU utilisation panel show, and why
  is that misleading?
- `kubectl drain` a node — does your PodDisruptionBudget allow it, or does it hang?

The prediction-first habit is the point. Being wrong is the useful outcome.

### 9.6 Write the runbooks

Now write them, from what you actually needed. One per alert, linked from the alert's
`runbook_url`. Keep the structure the same for all of them:

1. What the user is experiencing (the symptom, not the metric)
2. Mitigate or investigate? — and what decides
3. Triage steps in order, with the exact commands
4. Mitigations, cheapest and most reversible first
5. What to do when the runbook runs out
6. What to record for the postmortem

Short. A runbook nobody finishes reading is worse than none, because it looks like
coverage. And if a step turned out to be useless during your drill, leave it out — writing
only the steps you actually used is the whole value of writing them after the drills.

### 9.7 A real postmortem

Take your best drill and write it up properly: timeline with real timestamps, impact in
requests and budget, detection (how long before you knew?), root cause with the "why"
chain followed until it reaches something you can change, what went well, what went badly,
and action items with owners — at least one of which must *prevent* rather than detect.

Then act on one of them. That closes the loop, and "we changed X because of this
postmortem" is the sentence that makes an interviewer believe you.

## Self-check

- Your time to detect on the error drill was N minutes. Can it be shorter? What would you
  trade for that?
- During the cascade, what would have happened without a timeout on the product client?
- A pod delete caused 5xx. Walk through why, mechanically — SIGTERM, endpoint removal,
  in-flight connections.
- Which of your alerts has never fired in any drill? Is it dead code?

## If you're stuck

- **Alert takes far longer than expected:** check the long window's arithmetic against
  your traffic rate. At low request rates, a 1h window needs a lot of errors to move.
- **Injected errors do not move the SLI:** they are not being counted. Where in the
  middleware chain did you put the injection relative to the metrics middleware?
- **Deleting a pod causes errors:** that is the finding. Look at the order of SIGTERM,
  endpoint de-registration and connection draining, and at whether the process actually
  stops accepting new connections before it exits.
- **The drain hangs:** your PDB. Compare `minAvailable` with your replica count and work
  out why one specific combination makes voluntary eviction impossible.

## Review checkpoint

Show me:

1. Your postmortem from 9.7
2. Two runbooks
3. The cascade trace screenshot
4. Your detection times across drills

I will review the postmortem the way a real review works: is the root cause actually a
root cause or a stopping point that was convenient? Are the action items small enough to
finish? Is there a prevent item? And I will ask what you changed in the monitoring
*because* of what a drill taught you — that answer is what separates someone who ran a
drill from someone who learned from it.

## After this phase you can say

> "Every alert in the repo has been seen firing, deliberately. I run drills — injected
> error rates, latency, pod kills, OOMs, throttling — and time myself from alert to
> mitigation. The runbooks were written after the drills, from what I actually needed,
> which is why they are short. The cascade drill is the one I talk about: order-service
> was breaching, everything in its own runbook looked fine, and the trace waterfall showed
> a product-service child span was the whole problem."
