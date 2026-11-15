# Phase 12 — The interview

**Time:** ongoing · **Prerequisite:** Phases 1–9 at minimum

## The framing that matters most

You are not a beginner SRE. You are a DevOps engineer with five years of Azure, Terraform,
Kubernetes and CI/CD who has added the reliability engineering discipline on top. That is
a stronger position than most SRE candidates, who have read the Google book and never run
a cluster.

Lead with the platform experience, then show the SRE depth. Never open with an apology for
not having had "SRE" in a job title.

## The two-minute story

Write it out, then say it out loud until it is natural. Structure:

1. **Context** — what the system is: three Node services on AKS, Terraform-provisioned,
   Azure DevOps pipelines.
2. **The gap** — it had metrics endpoints and structured logs and nothing consuming them.
   No SLOs, no alerting anyone trusted.
3. **What you built** — one sentence per layer, in the order you built them, ending at
   SLO-based alerting rather than starting there.
4. **The thing that makes it yours** — pick one: the unit-tested alert rules, the
   dashboards generated from the SLO definitions, or the drill programme.
5. **What you learned** — name a specific mistake and what it taught you. This is the part
   that makes it credible.

Two minutes. Practise it against a clock.

## The demo

Have this ready to run in under five minutes, and rehearse it:

1. SLO dashboard — budget remaining, not uptime. Explain why that distinction matters.
2. Inject a fault live.
3. The alert arrives; show the severity and the runbook link.
4. Follow the correlation path: spike → log line → trace.
5. Stop the fault; show the short window clearing while the long one stays elevated, and
   explain why that design exists.

If you can only show one thing, show step 4. It is the thing most candidates cannot do.

## The artefacts

Have these open in tabs:

1. **The promtool test file.** Almost nobody unit-tests alerting rules. Lead with it.
2. **The SLO definitions with rationales.** The rationale is the part that shows judgement.
3. **A postmortem from a drill.** Even self-inflicted, it proves you can write.
4. **The cascade trace screenshot.** One picture that explains distributed tracing's value.
5. **The kind/AKS overlay diff.** A two-minute answer to environment management.
6. **Your cost table** (if you did phase 11). Very few candidates can discuss observability
   cost with numbers.

## Question bank

Work through these out loud, recorded if you can bear it. Anything you cannot answer in 90
seconds, go back to that phase.

**SLOs**
- SLI vs SLO vs SLA vs error budget?
- How did you choose those targets?
- What counts as a valid event, and what did you exclude and why?
- What happens when the budget is exhausted? Who decides?
- Is a service that never spends its budget doing well?

**Alerting**
- How do you alert on an SLO?
- Why two windows? What does each one buy?
- How do you stop alert fatigue?
- What would silently disable all your alerts?
- How do you know your alerts work?

**Kubernetes**
- Readiness vs liveness vs startup probes?
- Requests vs limits, and what each one actually controls?
- Walk me through a CrashLoopBackOff.
- How do you get zero-downtime deploys?
- What does a PodDisruptionBudget do, and how can it hurt you?

**Observability**
- Metrics, logs or traces — which would you drop?
- Histogram vs summary, and why?
- How do you control cardinality? What does it cost in each system?
- Head vs tail sampling?
- How do you correlate the three signals?

**Incidents**
- Walk me through an incident you handled.
- Mitigate or investigate first?
- What is a blameless postmortem, and what is it not?
- What is toil, and what have you automated?

**Judgement** — the ones with no single right answer, where they are watching how you think
- Your SLO is met but users are complaining. What now?
- You inherit a system with 200 alerts and no SLOs. First week?
- A team wants to ship on a Friday with 5% budget left. What do you say?
- How do you monitor the monitoring?
- What is the first thing you would change about what you built?

That last one is important. Have a real answer — the known gaps from your own README are
exactly this. Someone who can criticise their own work is trusted more than someone who
cannot.

## Questions to ask them

These signal seniority better than anything you say about yourself:

- What are your SLOs, and what happens when the budget runs out? *(No answer is itself
  information about the role.)*
- How many pages did on-call get last week, and how many were actionable?
- What is the ratio of toil to project work right now?
- Who writes the postmortems, and what happens to the action items?
- What is the last incident that changed how you build things?

## Honesty

Do not claim production experience you do not have. Say "I built this as a lab on kind,
with the AKS path in Terraform — here is exactly how it differs from production, and here
is what I would do differently at scale." That answer beats an inflated claim every time,
because the follow-up questions will find the inflation within two minutes and then
everything else you said is suspect.

## Review checkpoint

Record your two-minute story and your answers to five questions from the bank, and send me
the transcript. I will tell you where you are vague, where you are over-claiming, and
where you have a good answer buried under a weak opening.
