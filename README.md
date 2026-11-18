# PizzaHub Server

Express 5 + TypeScript API for PizzaHub. It stores marketplace data in MongoDB, verifies Better Auth JWTs through JWKS, proxies ImgBB uploads, sends new-order and order-status email through the Resend SDK, and handles Stripe Checkout webhooks for vendor Premium subscriptions.

## Quick start

```bash
cp .env.example .env
npm install
npm run dev
```

Health check: <http://localhost:5000/api/health>.

Scripts:

- `npm run dev` — tsx watch server
- `npm run build` — compile TypeScript to `dist/`
- `npm start` — run the compiled server
- `npm run test:integration` — end-to-end API suite (requires both apps running and configured providers)

## Environment

| Variable | Purpose |
| --- | --- |
| `PORT` | Express port, default `5000`. |
| `FRONTEND_URL` | Comma-separated allowed CORS origins. |
| `MONGODB_URI`, `DB_NAME` | MongoDB connection and database name. |
| `BETTER_AUTH_URL` | Must match the client so JWKS, issuer, and audience checks pass. |
| `BETTER_AUTH_SECRET` | Must match the client secret. |
| `IMGBB_API_KEY` | Server-only upload key. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe TEST credentials for Premium billing. |
| `STRIPE_PRICE_ID_MONTHLY`, `STRIPE_PRICE_ID_YEARLY` | Stripe Price IDs (`price_...`), not Product IDs. |
| `RESEND_API_KEY`, `EMAIL_FROM` | New-order vendor/customer notifications and accepted/rejected status email. |

Stripe and email credentials are optional at startup. Billing endpoints return a clear 503 when Stripe is incomplete; email delivery logs a warning when Resend is not configured but never blocks an order transition or a status change.

## Route groups

- `/api/auth` — Better Auth proxy and user profile data
- `/api/menu`, `/api/restaurants`, `/api/categories`, `/api/locations` — public discovery
- `/api/reviews` — menu item and restaurant ratings
- `/api/favorites` — customer wishlist
- `/api/orders` — checkout, status transitions, timeline, and details
- `/api/admin` — approvals and moderation
- `/api/uploads/image` — validated ImgBB proxy
- `/api/subscriptions` — vendor Premium Checkout and billing portal
- `/api/webhooks/stripe` — raw-body signature verification and activation
- `/api/test` — integration probes

## Advanced menu query parameters

`GET /api/menu` accepts `search`, `category`, `location`, `vendorId`, `restaurantId`, `minPrice`, `maxPrice`, `featured=true`, `sort=price_asc|price_desc|rating|newest`, `page`, and `limit` (max 50). Responses include `pagination`. Search strings are escaped before regex use, ids are validated, and sort maps to explicit MongoDB sort objects.

## JWT middleware flow

Protected routes use `verifyToken` from `src/middleware/auth.middleware.ts`:

1. Require `Authorization: Bearer <token>`.
2. Resolve `${BETTER_AUTH_URL}/api/auth/jwks` and verify signature, issuer, audience, and expiry with `jose`.
3. Confirm the token's `sessionId` still points to an unexpired Better Auth session.
4. Read the current role and `isBlocked` from MongoDB, attach the fresh user to `req.user`, and reject blocked/unknown roles.
5. `requireRole("customer" | "vendor" | "admin")` adds the final role gate and returns 401/403.

The client's `src/lib/api.ts` fetches `/api/auth/token`, caches it until near expiry, sends the bearer header, and retries once after a forced refresh on 401.

## Emails and webhooks

`POST /api/orders` stores the order and then uses `sendNewOrderEmails` from `src/services/email.service.ts` to notify the vendor and confirm to the customer with the `resend` SDK. `POST /api/orders/:id/accept` and `/reject` use the same service to email the customer a status update. Both flows read recipients from MongoDB snapshots, never from the request body, and return `email: { sent, warning? }` results without changing the order outcome when delivery fails. Configure `RESEND_API_KEY` and a verified `EMAIL_FROM` in production.

Stripe Checkout is redirect-based. The browser never activates Premium itself: `POST /api/webhooks/stripe` verifies the signature, records the event id for idempotency, and only then updates the subscription. Price IDs are server-side; product IDs are rejected at startup checks.

See `../README.md` for the full stack overview and verification commands.
