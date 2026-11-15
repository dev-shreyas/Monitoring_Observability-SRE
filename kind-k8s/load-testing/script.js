// Continuous, open-model load for the Aether shop (roadmap 9.1).
//
// Open model: every scenario uses `constant-arrival-rate`, so k6 starts N iterations per
// second no matter how slow the app gets. With a fixed pool of VUs, a slow app would make
// the generator send LESS traffic and hide the very slowdown you want to see. If the app
// is so slow that k6 runs out of VUs, it records `dropped_iterations` instead -- watch
// that panel; non-zero means the measured load is lower than the configured load.
//
// Traffic is weighted like real shoppers: mostly browsing, some search, a smaller share of
// logged-in activity, and (opt-in, see CHECKOUT_PER_MIN) occasional checkout.
//
// Every knob is an env var so `kubectl set env` can change load without editing this file:
//   BASE_URL          where to send traffic          (default: the ingress controller Service)
//   RATE              multiplier on every rate below (default 1; 2 = double the traffic)
//   DURATION          how long one run lasts         (default 24h; the pod then restarts)
//   USERS             shopper accounts per run       (default 20)
//   CHECKOUT_PER_MIN  add-to-cart + checkout per min (default 0 = off, see checkout())

import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';

const BASE_URL = __ENV.BASE_URL || 'http://ingress-nginx-controller.ingress-nginx.svc.cluster.local';
const RATE = parseFloat(__ENV.RATE || '1');
const DURATION = __ENV.DURATION || '24h';
const USERS = parseInt(__ENV.USERS || '20', 10);
const CHECKOUT_PER_MIN = parseFloat(__ENV.CHECKOUT_PER_MIN || '0');
const PASSWORD = 'LoadTest123!';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const SEARCH_TERMS = ['laptop', 'phone', 'headphones', 'shoe', 'watch', 'camera', 'bag', 'aether', 'zzz-no-match'];

// `rate` iterations per `timeUnit`, scaled by RATE. Rounded up so a small RATE never
// silently turns a scenario off.
function arrival(name, rate, timeUnit, maxVUs) {
  return {
    executor: 'constant-arrival-rate',
    exec: name,
    rate: Math.max(1, Math.ceil(rate * RATE)),
    timeUnit,
    duration: DURATION,
    preAllocatedVUs: Math.ceil(maxVUs / 4),
    maxVUs,
    tags: { flow: name },
  };
}

const scenarios = {
  browse: arrival('browse', 6, '1s', 60), //   ~6 visits/s   -> ~16 req/s
  search: arrival('search', 2, '1s', 20), //   ~2 searches/s -> ~2 req/s
  shopper: arrival('shopper', 1, '1s', 20), // ~1 visit/s     -> ~4.5 req/s
};
if (CHECKOUT_PER_MIN > 0) scenarios.checkout = arrival('checkout', CHECKOUT_PER_MIN, '1m', 10);

// Product ids end up in URLs, so every request sets a fixed `name` tag ('/products/:id').
// Without it each id would become its own time series in Prometheus. The `url` system tag
// is dropped in the Deployment (K6_SYSTEM_TAGS) for the same reason.
export const options = {
  scenarios,
  // Printed in the pod log at the end of each run. Not enforced (no abortOnFail): this is
  // background traffic, and the SLOs/alerts in Prometheus are what judge the app.
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
};

// ---------------------------------------------------------------------------------------
// KNOWN APP LIMITATION this script works around:
//
// FIXED 2026-11-11: user-service and order-service now share state in Redis, so any pod
// can serve any request. Previously they kept their data in in-memory Maps, one copy PER
// POD, and with 2+ replicas behind a Service consecutive requests landed on different pods:
//   - a user registered on pod A did not exist on pod B -> ~50% of logins returned 401
//   - an item added to the cart on pod A was not in the cart on pod B -> checkout 400d
//     "Cart is empty" about half the time
// The workarounds this script carried for that are no longer needed:
//   - setup() registered each account 12 TIMES hoping to hit every pod. One is now enough.
//     The repeats were not harmless: 11 of every 12 returned 409 "account already exists",
//     which logged ~180 error lines per run and made the error SLI meaningless.
//   - checkout was off by default (CHECKOUT_PER_MIN=0) purely to keep this bug out of the
//     error SLI. It is now safe to turn on:
//       kubectl set env deploy/k6-load -n load-testing CHECKOUT_PER_MIN=6
//
// product-service still uses an in-memory repository, which is FINE: its catalogue is
// read-only seed data, identical in every pod, and nothing mutates stock.
// ---------------------------------------------------------------------------------------

// One registration is sufficient now that the account lands in shared storage. login()
// keeps its retry, which still earns its place for a pod that is briefly unready.
const REGISTER_ATTEMPTS = 1;

export function setup() {
  const runId = `${Date.now()}`;
  const users = [];
  for (let i = 0; i < USERS; i++) {
    const email = `loadtest-${runId}-${i}@load.test`;
    let ok = false;
    for (let attempt = 0; attempt < REGISTER_ATTEMPTS; attempt++) {
      const res = http.post(
        `${BASE_URL}/register`,
        JSON.stringify({ email, password: PASSWORD, displayName: `Load Test ${i}` }),
        // 409 = "already registered on the pod that answered" -- expected when seeding.
        { headers: JSON_HEADERS, tags: { name: '/register' }, responseCallback: http.expectedStatuses(201, 409) },
      );
      ok = ok || res.status === 201 || res.status === 409;
    }
    if (ok) users.push(email);
  }
  if (users.length === 0) {
    exec.test.abort(`could not register any load-test users at ${BASE_URL}/register`);
  }

  const res = http.get(`${BASE_URL}/products`, { tags: { name: '/products' } });
  // Only products with stock: checkout now really reserves stock (v2.8), so a sold-out
  // item would fail every checkout that picked it.
  const productIds =
    res.status === 200 ? (res.json('items') || []).filter((p) => p.stock > 0).map((p) => p.id) : [];
  if (productIds.length === 0) {
    exec.test.abort(`no products returned by ${BASE_URL}/products (status ${res.status})`);
  }

  return { users, productIds };
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// --- auth: tokens cached per VU, refreshed before the 1h JWT expiry ------------------
// Module-level variables are per-VU in k6, so this cache is never shared between VUs.
// JWTs are verified with a shared secret, so a token from one user-service pod is valid on
// every pod -- only the login itself depends on which pod answers.
const tokens = {}; // email -> { token, at }
const TOKEN_TTL_MS = 45 * 60 * 1000;
const LOGIN_ATTEMPTS = 5;

function login(email) {
  for (let attempt = 1; attempt <= LOGIN_ATTEMPTS; attempt++) {
    const last = attempt === LOGIN_ATTEMPTS;
    const res = http.post(`${BASE_URL}/login`, JSON.stringify({ email, password: PASSWORD }), {
      headers: JSON_HEADERS,
      tags: { name: '/login' },
      // A 401 from a pod that never saw this account is the in-memory-store issue above,
      // not an outage; only the final attempt's 401 counts as a failed request.
      responseCallback: last ? http.expectedStatuses(200) : http.expectedStatuses(200, 401),
    });
    if (res.status === 200) return res.json('token');
  }
  return null;
}

function authHeaders(email) {
  const cached = tokens[email];
  if (!cached || !cached.token || Date.now() - cached.at > TOKEN_TTL_MS) {
    const token = login(email);
    check(token, { 'login ok': (t) => !!t });
    tokens[email] = { token, at: Date.now() };
  }
  return { ...JSON_HEADERS, Authorization: `Bearer ${tokens[email].token}` };
}

// --- scenarios -------------------------------------------------------------------------

// Anonymous visitor: landing page, catalogue, one product and (half the time) its reviews.
export function browse(data) {
  check(http.get(`${BASE_URL}/`, { tags: { name: '/' } }), { 'home 200': (r) => r.status === 200 });
  check(http.get(`${BASE_URL}/categories`, { tags: { name: '/categories' } }), {
    'categories 200': (r) => r.status === 200,
  });
  check(http.get(`${BASE_URL}/products`, { tags: { name: '/products' } }), {
    'products 200': (r) => r.status === 200,
  });

  const id = pick(data.productIds);
  check(http.get(`${BASE_URL}/products/${id}`, { tags: { name: '/products/:id' } }), {
    'product 200': (r) => r.status === 200,
  });
  if (Math.random() < 0.5) {
    check(http.get(`${BASE_URL}/products/${id}/reviews`, { tags: { name: '/products/:id/reviews' } }), {
      'reviews 200': (r) => r.status === 200,
    });
  }
}

export function search() {
  const q = encodeURIComponent(pick(SEARCH_TERMS));
  check(http.get(`${BASE_URL}/search?q=${q}`, { tags: { name: '/search' } }), {
    'search 200': (r) => r.status === 200,
  });
}

// Logged-in shopper looking around: wishlist, cart, past orders, coupons. Every request
// here is self-contained (reads, or a single write), so none depends on which pod answered
// the previous one.
export function shopper(data) {
  const headers = authHeaders(data.users[exec.vu.idInTest % data.users.length]);
  const id = pick(data.productIds);

  check(http.get(`${BASE_URL}/wishlist`, { headers, tags: { name: '/wishlist' } }), {
    'wishlist 200': (r) => r.status === 200,
  });
  if (Math.random() < 0.2) {
    check(http.post(`${BASE_URL}/wishlist`, JSON.stringify({ productId: id }), { headers, tags: { name: '/wishlist' } }), {
      'add to wishlist 201': (r) => r.status === 201,
    });
  }
  check(http.get(`${BASE_URL}/cart`, { headers, tags: { name: '/cart' } }), {
    'cart 200': (r) => r.status === 200,
  });
  check(http.get(`${BASE_URL}/orders`, { headers, tags: { name: '/orders' } }), {
    'orders 200': (r) => r.status === 200,
  });
  check(http.get(`${BASE_URL}/coupons`, { headers, tags: { name: '/coupons' } }), {
    'coupons 200': (r) => r.status === 200,
  });
}

// Buyer: add to cart, then check out. Opt-in via CHECKOUT_PER_MIN -- see the in-memory
// store note above (fixed since v2.6.0 by the shared Redis store).
// Checkout reserves stock; the order is cancelled right after, so this can run forever.
//
// The account rotates per ITERATION, not per VU: two concurrent checkouts on one account
// would race on the same cart, an error caused by the load generator rather than the app.
export function checkout(data) {
  const headers = authHeaders(data.users[exec.scenario.iterationInTest % data.users.length]);
  const res = http.post(
    `${BASE_URL}/cart`,
    JSON.stringify({ productId: pick(data.productIds), quantity: 1 }),
    { headers, tags: { name: '/cart' } },
  );
  check(res, { 'add to cart 201': (r) => r.status === 201 });
  sleep(0.5); // a human takes a moment between "add" and "buy"
  // Same contract as the real frontend: one Idempotency-Key per checkout attempt. Unique
  // per VU and iteration, so it never collides with another attempt.
  const idempotencyKey = `k6-${exec.vu.idInTest}-${exec.scenario.iterationInTest}-${Date.now()}`;
  const order = http.post(`${BASE_URL}/checkout`, '{}', {
    headers: { ...headers, 'Idempotency-Key': idempotencyKey },
    tags: { name: '/checkout' },
  });
  check(order, { 'checkout 201': (r) => r.status === 201 });

  // Cancel straight away. Since v2.8 a checkout really takes stock, so a 24h run would
  // otherwise empty the shelves within hours and turn every later checkout into a 409.
  // Cancelling returns the units -- and exercises the release path under load too.
  if (order.status === 201) {
    sleep(0.5);
    check(
      http.post(`${BASE_URL}/orders/${order.json('id')}/cancel`, '{}', {
        headers,
        tags: { name: '/orders/:id/cancel' },
      }),
      { 'cancel 200': (r) => r.status === 200 },
    );
  }
}
