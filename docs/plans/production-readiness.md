# Aether Commerce — production-readiness plan

**Status:** Phase 0 shipped as v2.7.0, P1.1 + P1.2 as v2.8.0 (2026-11-12). Next: P1.3 (needs D1) · **Written:** 2026-11-11 · **Owner:** Shreyas

How to use this file: ask for one work item at a time by its ID (for example
"implement P0.3"). Each item lists what changes, why, what it depends on, and the
check that proves it is done. Tick the box here when it is merged.

---

## Where the app is today

What exists:

- **user-service** — register, login, profile, wishlist
- **product-service** — products (paged), product detail, search, categories, reviews
- **order-service** — cart, checkout with coupons, orders, cancel
- **frontend** — single-page app (`frontend/app.js`, ~1,230 lines) behind nginx
- **Shared state** in Redis (carts, accounts, wishlists, orders); catalogue is seed data
  in `product-service` source
- **Observability**: metrics, logs (Loki), traces (Tempo via two-tier Alloy with tail
  sampling), the generated `Ecommerce – RED` dashboard
- **Azure infra** modules for AKS, ACR, Key Vault, SQL, Cosmos, Service Bus, Storage,
  private endpoints — mostly not yet used by the application code

What a code survey found **missing** (none of these appear anywhere in `services/*/src`):
input validation, security headers, rate limiting, idempotency, payments, admin roles,
notifications, retries/circuit breakers, caching. `pipelines/` is empty: there is no CI/CD.

Correctness gaps found in the code:

| Gap | Evidence |
|---|---|
| Stock is checked but never decremented — overselling | `orders.ts` checks `product.stock < item.quantity`; nothing reduces stock |
| Orders never leave `placed` | `paid`/`shipped` exist only in the `OrderStatus` type |
| Double-submit creates two orders | no idempotency on `POST /checkout` |
| `order.placed` events go nowhere | publisher logs locally; no consumer exists |
| A missing env var silently switches checkout to stub prices | `productClient.ts:70` falls back to a hard-coded catalogue when `PRODUCT_SERVICE_URL` is empty |
| JWT secret stored in plaintext in the repo working tree | `kind-k8s/base/secrets.yaml` (not committed yet) |
| Duplicate-email registration race | known issue in `CHANGELOG.md`; check-then-write without `SET NX` |
| Services fail Pod Security `restricted` | every rollout warns: no `capabilities.drop: [ALL]`, no `seccompProfile` |

---

## Decisions needed before the items that depend on them

| # | Decision | Options | Recommendation | Blocks |
|---|---|---|---|---|
| D1 | Payment gateway | Razorpay (test mode) · Stripe (test mode) · mock only | **Razorpay test mode** behind a provider interface, with a mock provider for kind and tests. Prices are INR. | P1.3 |
| D2 | Relational DB for orders, locally and in Azure | Azure SQL (kind needs an amd64-only SQL Server image; Azure SQL Edge is retired) · **PostgreSQL** (Azure Database for PostgreSQL in cloud) | **PostgreSQL** — runs natively on the arm64 kind nodes; means replacing the `infra/modules/sql` module | P4.1 |
| D3 | Event transport on kind | Service Bus only (not runnable locally) · **Redis Streams locally, Service Bus on AKS** behind one interface | Redis Streams locally — already deployed, supports consumer groups | P1.4, P1.5 |
| D4 | Email | **Mailpit on kind** (catches mail, web UI) · Azure Communication Services on AKS | Both, behind one interface | P1.5, P2.2 |
| D5 | Admin UI | Admin section inside the existing SPA · separate admin app | Separate small app on its own Ingress path, so admin code never ships to shoppers | P3.3 |
| D6 | Search backend | Postgres full-text · Azure AI Search · OpenSearch | Postgres full-text first (no new system); revisit at scale | P7.2 |

---

## Conventions for every item

- Work on kind first, then make it AKS-ready. Nothing is "done" if it only works in one.
- Existing tests keep passing, and the item adds its own tests.
- In-memory implementations stay as the test path, gated the way `REDIS_URL` gates
  repositories today.
- Shopper-visible changes get a **What's New** entry (`frontend/app.js` `RELEASE_NOTES`);
  everything gets a `CHANGELOG.md` entry.
- New behaviour gets a dashboard panel or alert where it can fail
  (`build_ecommerce_red.py`).
- Sizes: **S** ≈ under half a day · **M** ≈ 1–2 days · **L** ≈ 3+ days.

---

## Phase 0 — Close the holes (do first; all small)

- [x] **P0.1 Secrets out of the repo** · S
  - Stop storing secrets in `kind-k8s/base/secrets.yaml`: generate them at setup with
    `kubectl create secret` (the pattern already used for `grafana-admin`), add the file to
    `.gitignore`, document it in `kind-k8s/README.md`, and rotate the JWT secret.
  - Make every service **refuse to start** in production if `JWT_SECRET` is missing or
    equals the code default (user-service partly does this; order-service does not).
  - Manual, by you: rotate the two leaked Azure service-principal credentials.
    **Still open** — the only part of P0.1 not done.
  - *Done when:* no secret value is anywhere in the working tree; a pod with
    `NODE_ENV=production` and no `JWT_SECRET` crash-loops with a clear log line.

- [x] **P0.2 Fail closed on stub prices** · S
  - `productClient.ts`: if `PRODUCT_SERVICE_URL` is empty and `NODE_ENV=production`,
    throw at startup. Stub stays available for tests only.
  - *Done when:* a test covers it; deploying without the URL fails the rollout rather
    than taking orders at stub prices.

- [x] **P0.3 Checkout idempotency** · S
  - `POST /checkout` accepts an `Idempotency-Key` header. Store the key in Redis with
    `SET NX` and a 24h TTL: first request processes and stores its response; repeats
    return the stored response; a repeat while the first is still running gets `409`.
  - Frontend generates one key per checkout attempt and reuses it on retry.
  - *Done when:* two concurrent checkouts with the same key create exactly one order.

- [x] **P0.4 Registration race** · S
  - Claim the email key with `SET NX` before writing the account; `409` if taken.
  - *Done when:* 20 concurrent registrations of one email produce exactly one account.

- [x] **P0.5 Rate limiting and login protection** · M
  - Ingress: `nginx.ingress.kubernetes.io/limit-rps` on the shop Ingress.
  - user-service: per-IP and per-email login limits in Redis; temporary lockout after
    repeated failures.
  - Move password hashing off the main thread (native `bcrypt` or `argon2`) — today
    pure-JS `bcryptjs` lets a burst of logins stall every request on the pod.
  - *Done when:* a k6 login burst gets `429`s, and event-loop lag (dashboard) stays flat
    during it.
  - *Result:* edge and app 429s verified; event-loop p99 stayed ≤ 0.2 s. Scrypt replaced
    bcryptjs (built in, no native addon). 2.8.0 lowered the scrypt cost back to the old
    bcrypt's CPU (the 2.7 setting was 3.3x and overloaded the cluster) and added load
    shedding; raise N once user-service has more CPU.

- [x] **P0.6 Input validation and security headers** · M
  - Zod schemas on every route body, params and query; one error format.
  - Helmet headers on the services; CSP and related headers on the frontend nginx.
  - *Done when:* malformed input returns `400` with a field-level message on every route.

- [ ] **P0.7 Pod hardening** · S — *partly done*: seccomp, capabilities and `restricted`
  enforcement are live. NetworkPolicies are verified (every allowed flow works, every
  other path blocked) but **not kept enabled on kind**: under the k6 load kindnet's NRI
  plugin drops out and enforcement fails closed for new pods. Needs Calico, AKS, or more
  CPU (see `kind-k8s/security/network-policies.yaml`).
  - Add `capabilities.drop: [ALL]` and `seccompProfile: RuntimeDefault` to all workloads,
    then label `ecommerce-dev` to **enforce** `restricted`.
  - NetworkPolicies: default-deny; frontend → services; services → Redis; Alloy → OTLP.
  - *Done when:* rollouts produce no PodSecurity warnings; a pod outside the allowed set
    cannot reach Redis.

---

## Phase 1 — Make it a real store

- [x] **P1.1 Inventory reservation** · M · *after P0.3*
  - product-service owns stock. An internal API reserves stock atomically (a Redis Lua
    script: check then decrement, all or nothing across the order's lines), with a TTL.
  - Checkout reserves; payment confirms; cancel or expiry releases.
  - *Done when:* 50 concurrent checkouts for the last 5 units produce exactly 5 orders
    and 45 clean `409 out of stock` responses.
  - *Result (v2.8.0):* exactly that, on the cluster through the Ingress; stock ended at 0.

- [x] **P1.2 Order state machine** · M
  - States: `pending_payment → paid → packed → shipped → delivered`, plus `cancelled`,
    `refunded`. One module owns the allowed transitions; every change is recorded with
    who, when and why.
  - *Done when:* illegal transitions (e.g. `delivered → paid`) are rejected in tests; an
    order's history is visible via the API.
  - *Result (v2.8.0):* done, in tests and on the cluster. Payment confirmation is automatic
    until P1.3 and recorded as such in the history.

- [ ] **P1.3 Payments** · L · *needs D1, after P1.1 and P1.2*
  - Provider interface; mock provider for kind and tests; real provider in test mode.
  - Create the payment at checkout; confirm **only via the provider's signed webhook**,
    never the browser redirect. Webhook handling is idempotent.
  - Unpaid orders expire and release their stock reservation.
  - *Done when:* an end-to-end test pays with a test card; a replayed webhook changes
    nothing; a forged webhook signature is rejected.

- [ ] **P1.4 Reliable order events (transactional outbox)** · M · *needs D3*
  - Write the order and its event together; a relay publishes from the outbox, so a crash
    between "saved" and "published" can no longer lose an event.
  - Event bus interface: Redis Streams on kind, Service Bus on AKS.
  - *Done when:* killing order-service mid-checkout still results in exactly one event.

- [ ] **P1.5 notification-service** · M · *needs D4, after P1.4*
  - New service consuming order events: confirmation, shipped and cancelled emails.
  - Mailpit on kind so emails can be viewed in a browser.
  - *Done when:* placing an order shows the email in Mailpit; the consumer survives a
    restart without re-sending or losing mail.

---

## Phase 2 — Accounts and checkout completeness

- [ ] **P2.1 Addresses, shipping and GST** · M · *after P1.2*
  - Address book; shipping methods with cost; GST calculation; full price breakdown on
    the order (subtotal, discount, shipping, tax, total).
- [ ] **P2.2 Password reset and email verification** · M · *after P1.5*
- [ ] **P2.3 Short-lived access tokens with refresh tokens** · M
  - Logout and revocation; refresh-token rotation with reuse detection.
- [ ] **P2.4 Guest cart and merge at login** · S
- [ ] **P2.5 Paginated order history and PDF invoices** · S

---

## Phase 3 — Admin and roles

- [ ] **P3.1 Roles** · S — `role` claim in the JWT (`customer`, `admin`); `requireRole`
  middleware; at least one test per protected route proving a customer gets `403`.
- [ ] **P3.2 Admin APIs** · L — products and stock, prices and sales, coupons, order
  transitions, refunds (after P1.3).
- [ ] **P3.3 Admin UI** · L · *needs D5* — catalogue, stock, orders, coupons.
- [ ] **P3.4 Audit log** · S — every admin action: actor, action, before/after.

---

## Phase 4 — Data and reliability

- [ ] **P4.1 Orders in a relational database** · L · *needs D2*
  - Repository implementation for orders and order lines; migrations run as a Kubernetes
    Job; Terraform module updated for the chosen database.
  - Redis stays for carts, sessions, idempotency keys and reservations.
- [ ] **P4.2 Catalogue out of source code** · M — products in a database managed via
  admin APIs; images in Blob Storage behind a CDN instead of hotlinked Unsplash URLs.
- [ ] **P4.3 Resilience on service calls** · S — retries with backoff and a circuit
  breaker on order-service → product-service; readiness probes check dependencies while
  liveness stays dependency-free.
- [ ] **P4.4 Managed Redis with high availability on AKS** · M — Azure Cache for Redis
  Terraform module; the in-cluster StatefulSet remains for kind.
- [ ] **P4.5 Backups and a restore drill** · S — scheduled backups and one tested
  restore, written up in the runbook.
- [ ] **P4.6 Catalogue caching** · S — cache product reads, invalidate on admin change.

---

## Phase 5 — Delivery platform

- [ ] **P5.1 CI pipeline (Azure DevOps)** · M — typecheck, test, build, Trivy scan,
  secret scan, push to ACR tagged with the **git commit SHA** (ends the `:local` stale
  image problems).
- [ ] **P5.2 Environment overlays** · M — Kustomize `dev` / `stage` / `prod` in
  `aks-k8s/overlays/` (currently empty); image tags set per environment.
- [ ] **P5.3 GitOps** · M — Argo CD syncs each environment from git.
- [ ] **P5.4 Canary releases** · M · *after P6.2* — Argo Rollouts with automated
  analysis against the RED metrics; automatic rollback on error-rate or latency breach.
- [ ] **P5.5 Feature flags** · S — OpenFeature with flagd, so payments and other risky
  features ship dark.
- [ ] **P5.6 Frontend build step** · S — content-hashed asset filenames with long-lived
  caching; removes the `no-cache` workaround.

---

## Phase 6 — Observability for the business

- [ ] **P6.1 Business metrics** · S — orders per minute, revenue, payment failure rate,
  cart abandonment, view → cart → checkout → paid funnel; a "Business" dashboard row.
- [ ] **P6.2 SLOs and alert rules** · M — turn the dashboard's "Alert:" lines into
  `PrometheusRule`s; multi-window burn-rate alerts for checkout; Alertmanager routing.
- [ ] **P6.3 Logs ↔ traces** · S — `trace_id` in every log line; Grafana derived fields
  and trace-to-logs links (roadmap phase 8).
- [ ] **P6.4 Real-user and synthetic monitoring** · M — Grafana Faro in the frontend; a
  k6 checkout journey every 5 minutes as a synthetic probe.

---

## Phase 7 — Growth features

- [ ] **P7.1 Product variants** (size/colour) with per-variant stock · L · *after P4.2*
- [ ] **P7.2 Real search** with filters, counts and typo tolerance · M · *needs D6*
- [ ] **P7.3 Recently viewed and "frequently bought together"** · M
- [ ] **P7.4 Verified-purchase reviews and moderation** · S
- [ ] **P7.5 Returns and refunds flow** · M · *after P1.3*

---

## Suggested sequence

1. **Phase 0** — all seven items; small and independent, so in any order.
2. **P1.1 → P1.2 → P1.3** — stock, lifecycle, payments (the real-store core).
3. **P1.4 → P1.5** — reliable events, then notifications.
4. **P5.1 + P5.2** early, so everything after ships through a pipeline.
5. **Phase 3** (admin) and **P4.1** (orders in a database), then the rest by need.
