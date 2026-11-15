# ecommerce-azure-devops — application layer

The three Node.js/TypeScript microservices that the *Azure Cloud E-Commerce
Platform* guide assumes already exist. The guide (sections 5–13) shows you the
folder structure and the Dockerfiles but never the application itself — this is
the missing piece.

**Containerisation is deliberately not included here.** No `Dockerfile`, no
`.dockerignore`, no `docker-compose.yml`. You write those from PDF sections 9
and 10; everything below is built to satisfy exactly what those Dockerfiles
expect.

## What each service does

| Service | Port | Data store (guide) | Endpoints |
|---|---|---|---|
| `user-service` | 3001 | Azure SQL | `POST /register`, `POST /login`, `GET /profile`, `GET/POST /wishlist`, `DELETE /wishlist/:productId` |
| `product-service` | 3002 | Cosmos DB | `GET /products`, `GET /products/:id`, `GET /search`, `GET /categories`, `GET/POST /products/:id/reviews` |
| `order-service` | 3003 | Azure SQL + Service Bus | `GET/POST /cart`, `POST /checkout`, `GET /orders`, `GET /orders/:id`, `POST /orders/:id/cancel`, `GET /coupons` |

All three also expose `GET /health` and `GET /metrics`.

## The contract with the PDF's Dockerfile

The Dockerfile on page 12 does four things that constrain this code:

| Dockerfile line | What the app must therefore provide |
|---|---|
| `COPY package*.json ./` + `RUN npm ci` | a `package.json` **and** a committed `package-lock.json` |
| `RUN npm run build` | a `build` script — here `tsc -p tsconfig.json` |
| `COPY --from=build /app/dist ./dist` | the build must emit to `dist/` |
| `CMD ["node", "dist/index.js"]` | entry point compiles to exactly `dist/index.js` |
| `HEALTHCHECK ... /health` | a `/health` route with no auth |
| `EXPOSE 3001/3002/3003` | the port defaults match |

> **One fix to make in the PDF.** Page 12 comments that `npm run build` is a
> "No-op for plain JS", but the production stage only copies `/app/dist`. With
> plain JavaScript nothing lands there and the container starts against an
> empty directory. These services use TypeScript, so `dist/` is real and the
> Dockerfile works as printed.

## Run it locally, without Docker

```bash
cd services/user-service && npm install && npm run build && npm start
```

Then in another terminal:

```bash
curl http://localhost:3001/health
```

Run all three (each in its own terminal), giving order-service the addresses of
its neighbours:




`JWT_SECRET` must be **identical** for user-service and order-service — the
first signs tokens, the second verifies them.

Run the tests (no database, no network, no Docker needed):

```bash
npm test
```

## Every file, and why it exists

### Files identical in all three services

| File | Purpose |
|---|---|
| `package.json` | Dependencies and the `build` / `start` / `test` scripts the Dockerfile and CI call. |
| `package-lock.json` | Exact dependency versions. **Must be committed** — `npm ci` fails without it, and it is what makes the image reproducible. |
| `tsconfig.json` | Compiler settings. The three that matter: `outDir: dist`, `rootDir: src`, `strict: true`. `tests` is excluded so test code never ships in the image. |
| `jest.config.js` | Runs the TypeScript sources through `ts-jest`, so tests do not require a build first. |
| `.gitignore` | Keeps `node_modules`, `dist` and `.env` out of git. |
| `.env.example` | Documents every environment variable. Copy to `.env` locally; in AKS these come from a ConfigMap and Key Vault. |
| `src/index.ts` | **The process.** Opens the port, handles `SIGTERM` for graceful shutdown, exits on unhandled errors. This is what `CMD` runs. |
| `src/app.ts` | **The application.** Builds the Express app and exports it without listening — which is what lets tests drive it in-process. |
| `src/config.ts` | The only file that reads `process.env`. One place to see the whole configuration surface. |
| `src/logger.ts` | One-line JSON logs to stdout, so Log Analytics can query fields with KQL. |
| `src/metrics.ts` | Prometheus registry + a latency histogram middleware, scraped at `/metrics`. |
| `src/errors.ts` | `AppError` plus the 404 and error-handler middlewares. Every failure leaves as JSON with a correct status code. |
| `src/middleware/requestLogger.ts` | One structured log line per completed request; skips probe traffic. |
| `src/routes/health.ts` | The `/health` payload the guide documents, used by the Docker HEALTHCHECK and both Kubernetes probes. |

### user-service only

| File | Purpose |
|---|---|
| `src/middleware/auth.ts` | Signs **and** verifies JWTs. This service is the only one allowed to mint tokens. |
| `src/repository/userRepository.ts` | `UserRepository` interface + in-memory implementation. The marked seam where Azure SQL goes. |
| `src/routes/users.ts` | Register (bcrypt hashing, 409 on duplicate), login (identical 401s to prevent account enumeration), profile (id read from the token, never the query string). |
| `src/types/express.d.ts` | Type-only: teaches TypeScript that `req.user` exists. Emits no JavaScript. |
| `tests/users.test.ts` | 11 tests covering the full auth flow and its failure modes. |

### product-service only

| File | Purpose |
|---|---|
| `src/repository/productRepository.ts` | `ProductRepository` interface, seed catalog, in-memory implementation. The Cosmos DB seam. |
| `src/routes/products.ts` | List with category filter and bounded pagination, fetch by id, free-text search. All public — anonymous shoppers browse the catalog. |
| `tests/products.test.ts` | 11 tests, including that `?limit=100000` is rejected rather than dumping the catalog. |

### order-service only

| File | Purpose |
|---|---|
| `src/middleware/auth.ts` | Verify **only** — no `signToken`. Uses the same `JWT_SECRET` as user-service. |
| `src/clients/productClient.ts` | HTTP client for product-service, with a mandatory request timeout (no timeout = cascading failure). Falls back to an offline stub when `PRODUCT_SERVICE_URL` is unset. |
| `src/messaging/orderEventPublisher.ts` | The Service Bus seam. Defines the `order.placed` event contract; logs events locally instead of publishing. |
| `src/repository/orderRepository.ts` | Carts and orders. The Azure SQL seam. Order lookups are scoped by user id — an authorization check, not just a filter. |
| `src/routes/orders.ts` | Cart, checkout, order history. Prices the cart from the catalog at checkout time and publishes one event after the order is persisted. |
| `tests/orders.test.ts` | 11 tests, including that a client-supplied price is ignored and that a failed checkout publishes nothing. |

## Design decisions worth understanding

**`app.ts` and `index.ts` are separate.** The app knows nothing about ports or
signals; the process knows nothing about routes. That is what makes the tests
possible without opening a socket, and it is the shape the guide's own test
snippet (`require("../src/app")`) assumes.

**Everything external sits behind an interface.** `UserRepository`,
`ProductRepository`, `OrderRepository`, `ProductClient`, `OrderEventPublisher`.
Each has an in-memory implementation today and a `<<< REPLACE ME >>>` comment
marking exactly where the Azure SDK call goes. This is why the whole platform
runs and tests with zero cloud resources, and why adding Azure SQL later
touches one file per service.

**Money is an integer in minor units.** `priceMinor: 649900` is ₹6,499.00.
Floating point cannot represent 0.1 exactly; a currency total built from floats
drifts. Never use `number` for rupees.

**Graceful shutdown is not optional.** Without the `SIGTERM` handler in
`index.ts`, every rolling update in AKS drops in-flight requests and users see
502s during each deploy.

**Secrets have dev fallbacks, but only in dev.** `config.ts` throws on a
missing secret when `NODE_ENV=production`. A pod that crash-loops visibly is
better than one quietly running with a placeholder signing key.

## Where this does not go far enough

Honest gaps, in case an interviewer asks:

- Carts and orders are in-memory, so they vanish on restart and are not shared
  between replicas. Real deployment needs the SQL implementations.
- Checkout writes the order and then publishes the event. A crash in between
  loses the event. The production fix is the transactional outbox pattern.
- Stock is checked but never decremented — that belongs to an inventory
  service consuming `order.placed`.
- No rate limiting here; the guide puts that in Azure API Management.
- No distributed tracing yet. Guide section 26 adds Application Insights.

## Next step

Add the Dockerfiles from PDF section 9 (one per service, plus a
`.dockerignore`), then the root `docker-compose.yml` from section 10. Every
path and port in those pages already lines up with this code.


export ARM_SUBSCRIPTION_ID="<your-subscription-id>"
export ARM_TENANT_ID="<your-tenant-id>"
export ARM_CLIENT_ID="<your-client-id>"
export ARM_CLIENT_SECRET="<your-client-secret>"   # never commit a real value here
terraform init
