 <div align="center">

# 🍕 PizzaHub Server

### Powering a Smarter Pizza Marketplace

**A secure REST API built with Express 5, TypeScript, and MongoDB — supporting role-based access, personalized Taste DNA recommendations, order workflows, Stripe payments, image uploads, and transactional email.**

[![Live Website](https://img.shields.io/badge/Live%20Website-PizzaHub-E64B35?style=for-the-badge&logo=vercel&logoColor=white)](https://pizzahub-mocha.vercel.app/)
[![Express](https://img.shields.io/badge/Express-5-000000?style=flat-square&logo=express)](https://expressjs.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-7-3178C6?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![MongoDB](https://img.shields.io/badge/MongoDB-7-47A248?style=flat-square&logo=mongodb)](https://www.mongodb.com/)
[![Stripe](https://img.shields.io/badge/Stripe-23-635BFF?style=flat-square&logo=stripe)](https://stripe.com/)

</div>

---

## 📖 Overview

PizzaHub Server is the backend API for **PizzaHub**, a full-stack pizza discovery and ordering marketplace. It provides the business logic and data layer for customers, restaurant vendors, and administrators.

Built with **Express 5 and TypeScript**, the API uses MongoDB for marketplace data and Better Auth JWTs for authentication. It supports public restaurant and menu discovery, role-protected dashboards, cart and favorites, reviews, order management, payments, vendor subscriptions, image uploads, and email notifications.

A key feature is **Taste DNA**, a deterministic and explainable recommendation engine. It analyzes a customer's delivered orders, saved pizzas, and reviews to build a taste profile and rank menu items using category affinity, ingredient affinity, and historical price preferences. Recommendations include match scores and human-readable reasons.

🌐 **Live Website:** [https://pizzahub-mocha.vercel.app/](https://pizzahub-mocha.vercel.app/)

---

## ✨ Key Features

### 🧬 Taste DNA Recommendation Engine

- Builds a taste profile from the authenticated customer's own MongoDB activity.
- Uses delivered orders, favorites, and visible menu-item reviews as preference signals.
- Calculates category affinity and favorite ingredient scores.
- Learns a budget range from historical delivered-order prices.
- Scores available menu items and returns ranked recommendations.
- Provides a match score and reasons for each recommendation.
- Excludes menu items the customer rated 1–2 stars.
- Uses a soft penalty for items the customer has already purchased.
- Includes `empty`, `developing`, and `ready` profile states.
- Does not depend on an external AI service or synthetic preference data.

### 🍕 Menu & Restaurant Discovery

- Public restaurant and menu endpoints.
- Menu search, category, location, vendor, and restaurant filters.
- Minimum and maximum price filtering.
- Featured menu filtering and sorting.
- Pagination with page, limit, total, and page count.
- Menu item ratings and restaurant information enrichment.
- Vendor menu management.
- Admin menu moderation and approval workflows.
- Public menu visibility restricted to approved and active items.

### 👤 Authentication & Authorization

- Better Auth JWT verification using remote JWKS.
- JWT signature, issuer, audience, and expiration validation.
- Live Better Auth session verification against MongoDB.
- Current user role and blocked status loaded from MongoDB.
- Role-based access control for `customer`, `vendor`, and `admin`.
- Protected route groups and ownership checks.
- Blocked-account rejection.
- Consistent `401`, `403`, and authentication dependency `503` responses.

### 🛍️ Marketplace & Order Management

- Customer cart and favorites.
- Customer order creation and order history.
- Vendor order management.
- Order acceptance and rejection.
- Order status transitions and timeline/details.
- Vendor unseen-order count and seen-order handling.
- Admin order and transaction oversight.
- Email notifications for new orders and order status updates.

### 💳 Payments & Premium Subscriptions

- Stripe Checkout for customer payments.
- Vendor Premium monthly and yearly subscription checkout.
- Stripe billing portal sessions.
- Subscription status and plan endpoints.
- Stripe webhook signature verification using the raw request body.
- Webhook event idempotency.
- Subscription activation based on verified webhook events.
- Server-side Stripe Price ID validation.

### 🖼️ Secure Image Uploads

- Backend image upload proxy to ImgBB.
- JPEG, PNG, WebP, and GIF support.
- Raw image body and legacy JSON data-URL support.
- MIME, file signature, and size validation.
- Per-IP throttling.
- ImgBB API key remains server-side.

### 📧 Transactional Email

- Vendor notification and customer confirmation after a new order.
- Customer email after vendor acceptance or rejection.
- Resend SDK integration.
- Recipient addresses are read from stored order/vendor data, not trusted from request bodies.
- Email provider failure does not roll back a successful order transition.
- Development-only verified test recipient override.

---

## 🧰 Technology Stack

### Runtime & Backend

| Package | Version | Purpose |
|---|---:|---|
| `express` | ^5.3.0 | HTTP server, routing, and middleware |
| `typescript` | ^7.0.2 | Static typing |
| `mongodb` | ^7.9.0 | MongoDB driver and data access |
| `better-auth` | ^1.7.25 | Better Auth integration |
| `jose` | ^6.2.17 | JWT and remote JWKS verification |
| `cors` | ^2.8.6 | Cross-origin resource sharing |
| `dotenv` | ^18.0.10 | Environment variable loading |
| `zod` | ^4.6.7 | Request schema validation |
| `stripe` | ^23.1.0 | Checkout, subscriptions, and webhooks |
| `resend` | ^6.38.1 | Transactional email delivery |

### Development Dependencies

| Package | Version | Purpose |
|---|---:|---|
| `tsx` | ^4.23.15 | TypeScript development runner and watch mode |
| `@types/cors` | ^2.8.19 | CORS type definitions |
| `@types/express` | ^5.0.6 | Express type definitions |
| `@types/node` | ^26.6.6 | Node.js type definitions |

### External Services

| Service | Purpose |
|---|---|
| MongoDB | Marketplace, user, session, order, and subscription data |
| Better Auth | Authentication and JWT issuance |
| Stripe | Customer payments and vendor Premium billing |
| ImgBB | Image hosting through the server-side upload proxy |
| Resend | Order and order-status emails |
| Vercel | Production deployment |

---

## 🏗️ Architecture

The server follows a route → middleware → controller → service/data-access flow.

```text
src/
├── app.ts
├── index.ts
├── config/
│   ├── bootstrap.ts
│   ├── database.ts
│   ├── env.ts
│   ├── indexes.ts
│   ├── migrations.ts
│   └── stripe.ts
├── controllers/
├── middleware/
│   ├── auth.middleware.ts
│   └── validate.ts
├── routes/
├── services/
├── types/
│   ├── express/
│   └── models.ts
└── utils/
    ├── errors.ts
    ├── query.ts
    └── serialize.ts
```

| Layer | Responsibility |
|---|---|
| `routes/` | Declares API endpoints and middleware order |
| `middleware/` | Authentication, role authorization, and request validation |
| `controllers/` | Reads request data, applies endpoint rules, and returns responses |
| `services/` | Reusable business logic such as recommendations, email, payments, and menu operations |
| `config/` | Environment configuration, MongoDB connection, indexes, migrations, and Stripe setup |
| `types/` | Shared TypeScript models and Express request types |
| `utils/` | Query parsing, serialization, and centralized error helpers |

---

## 🧠 Important Implementation Challenges

### 1. Advanced Menu API Query Parameters

The public menu endpoint supports multiple filters and sorting options through URL query parameters.

**Endpoint**

```http
GET /api/menu
```

**Supported query parameters**

| Parameter | Description | Example |
|---|---|---|
| `search` | Searches menu item name, description, and ingredients | `search=cheese` |
| `category` | Filters by menu category | `category=Classic Pizzas` |
| `location` | Filters by menu-item location or restaurant address | `location=Dhaka` |
| `vendorId` | Filters by vendor ObjectId | `vendorId=65f...` |
| `restaurantId` | Filters by restaurant | `restaurantId=65f...` |
| `minPrice` | Minimum menu-item price | `minPrice=8` |
| `maxPrice` | Maximum menu-item price | `maxPrice=25` |
| `featured` | Returns featured items when set to `true` | `featured=true` |
| `sort` | Controls result ordering | `sort=price_asc` |
| `page` | Page number; defaults to `1` | `page=2` |
| `limit` | Items per page; defaults to `12`, maximum `50` | `limit=12` |

**Supported sort values**

- `price_asc`
- `price_desc`
- `rating`
- `oldest`
- `newest` (default)

**Example request**

```http
GET /api/menu?search=cheese&category=Classic%20Pizzas&location=Dhaka&minPrice=8&maxPrice=25&sort=rating&page=1&limit=12
```

**How it is implemented**

1. The controller reads query values using `firstString()` so it can safely handle string query values.
2. Pagination is normalized by `getPagination()`. Page is at least `1`; limit is between `1` and `50`.
3. `vendorId` and restaurant filters are validated before being used in MongoDB queries.
4. Search input is escaped before it is used in a case-insensitive regular expression.
5. Location filtering checks both the menu item's own location and matching restaurant addresses. This supports newer menu records and legacy records that rely on the restaurant address.
6. Price filters are assembled as MongoDB `$gte` and `$lte` conditions.
7. Sort values are mapped to explicit MongoDB sort objects rather than passed directly into a database query.
8. The aggregation pipeline enriches menu results with ratings and related restaurant data.
9. Items and total count are fetched together, and the response includes pagination metadata.

**Example response shape**

```json
{
  "success": true,
  "items": [],
  "pagination": {
    "page": 1,
    "limit": 12,
    "total": 0,
    "pages": 0
  }
}
```

This approach keeps filtering, sorting, and pagination on the server rather than downloading the entire menu to the frontend.

### 2. JWT Authentication & Role-Based Middleware Flow

Protected API routes use `verifyToken` and `requireRole` from:

```text
src/middleware/auth.middleware.ts
```

**Authentication flow**

1. The request must include `Authorization: Bearer <token>`.
2. The API verifies the JWT using the Better Auth remote JWKS endpoint:

   ```text
   ${BETTER_AUTH_URL}/api/auth/jwks
   ```

3. `jose` validates the token signature, issuer, audience, expiration, and allowed EdDSA algorithm.
4. The API validates the token's `sub` and `sessionId` as MongoDB ObjectIds.
5. It checks the Better Auth session collection and confirms that the session belongs to the user and has not expired.
6. It loads the user's current role and blocked status from MongoDB.
7. Blocked accounts are rejected, and only the supported roles — `customer`, `vendor`, and `admin` — are accepted.
8. The verified user is attached to `req.user`.
9. `requireRole()` checks whether the authenticated user is allowed to access the requested route.
10. The controller runs only after the authentication and authorization middleware pass.

**Middleware usage**

```ts
router.get(
  "/vendor/mine",
  verifyToken,
  requireRole("vendor"),
  listVendorMenu
);
```

**Validation and authorization responses**

| Status | Meaning |
|---|---|
| `401 Unauthorized` | Missing, invalid, or expired token/session |
| `403 Forbidden` | Wrong role, blocked account, or insufficient permission |
| `503 Service Unavailable` | Authentication dependency such as JWKS or MongoDB is unavailable |

The backend does not trust a role supplied by the frontend or rely only on JWT role claims. It loads the current role and blocked status from MongoDB for authorization decisions.

### 3. Request Validation

Request validation is centralized in:

```text
src/middleware/validate.ts
```

The project uses Zod schemas for request bodies, route parameters, and query validation.

- `validateBody(schema)` validates and replaces `req.body` with parsed data.
- `validateParams(schema)` validates route parameters.
- `validateQuery(schema)` validates query parameters.
- `objectIdParamSchema` validates MongoDB ObjectId route parameters.

Express 5 exposes `req.query` as a getter, so the query validator checks the original query without attempting to assign a replacement object.

Invalid schemas are forwarded to the centralized error handler.

### 4. Taste DNA — Personalized and Explainable Recommendations

**Endpoint**

```http
GET /api/recommendations/taste-dna?limit=8
Authorization: Bearer <customer-jwt>
```

- Default recommendation limit: `8`
- Maximum recommendation limit: `12`
- Only authenticated customers can access this endpoint.

**How the recommendation engine works**

Taste DNA is implemented in:

```text
src/services/recommendation.service.ts
```

It is a deterministic recommendation algorithm built from the signed-in customer's own MongoDB activity. It does not call an external AI API or generate synthetic preference signals.

**Preference signal weights**

| Customer activity | Weight |
|---|---:|
| Delivered order | `3` per unit, maximum 3 units |
| Favorite | `2.5` |
| 4–5 star review | `2` |
| 3 star review | `0.5` |
| 1–2 star review | `-2.5` |

Negative review signals reduce category and ingredient affinity. A menu item rated 1–2 stars by the customer is excluded from direct recommendations.

**Recommendation score**

The score is calculated from four components:

```text
score =
  15
  + 30 * categoryScore / (categoryScore + 3)
  + 35 * ingredientScore / (ingredientScore + 4)
  + 20 * priceFit
  - 8 if already purchased
```

The final score is clamped between `0` and `100` and rounded to a whole number.

| Component | Maximum contribution |
|---|---:|
| Publicly available baseline | 15 |
| Category affinity | 30 |
| Ingredient affinity | 35 |
| Historical budget fit | 20 |
| Already-purchased penalty | -8 |

**Budget intelligence**

- Uses unit prices from delivered orders.
- Calculates the 10th and 90th percentiles for the customer's historical price range.
- Compares the customer's average purchase price with the public catalog price distribution.
- Labels the budget as `Budget-friendly`, `Mid-range`, or `Premium` when enough catalog price data exists.
- Returns an insufficient-history label when no purchase price samples are available.

**Recommendation explainability**

Each recommendation includes reasons such as:

- The customer tends to enjoy the item's category.
- The item includes ingredients the customer likes.
- The item fits the customer's usual price range.

Candidates are selected from approved and active menu items. The engine evaluates up to 400 candidates, ranks explainable matches, and returns the requested number of recommendations.

**Taste profile status**

| Status | Meaning |
|---|---|
| `empty` | No usable preference signals yet |
| `developing` | Preference signals exist, but no delivered orders are available |
| `ready` | The customer has delivered-order history |

This makes recommendations understandable: users can see not only what is recommended, but also why it matches their preferences.

### 5. Stripe Webhook & Subscription Safety

Stripe webhook handling is mounted before `express.json()` in `src/app.ts`.

```text
POST /api/stripe/webhook
```

**Why raw-body handling matters**

Stripe signature verification requires the original request bytes. Parsing the webhook body as JSON before verification would change the payload representation and prevent reliable signature verification.

**Webhook flow**

1. Stripe sends the webhook request.
2. The webhook route reads the raw request body.
3. The server verifies the `Stripe-Signature` header using `STRIPE_WEBHOOK_SECRET`.
4. The event is checked for prior processing to support idempotency.
5. Only a verified and relevant event can update subscription state.
6. The database is updated after successful verification and event handling.

Premium subscription checkout uses server-side Stripe Price IDs. The backend expects `price_...` identifiers, not Product IDs (`prod_...`).

Stripe credentials are optional during startup so unrelated API functionality can remain available. Billing endpoints return a clear service-unavailable response when the required Stripe configuration is incomplete.

### 6. Reliable Email Delivery

The email service is implemented in:

```text
src/services/email.service.ts
```

- New orders trigger vendor notifications and customer confirmations.
- Vendor acceptance and rejection trigger customer status emails.
- Recipient addresses are resolved from stored order/vendor data rather than request-body values.
- Email delivery failure returns a warning and does not undo the order or status transition.
- In development only, `RESEND_TEST_EMAIL` can route both test messages to a verified recipient.
- The test-recipient override is ignored outside `NODE_ENV=development`.

### 7. Secure Image Upload Proxy

The upload endpoint is:

```http
POST /api/uploads/image
```

The server accepts raw image data and a legacy JSON data-URL format. It validates supported image MIME types, file signatures, and size, and applies per-IP throttling before forwarding the upload to ImgBB.

The ImgBB API key is stored only in the backend environment and is never sent to the browser.

---

## 🛣️ API Route Groups

All routes use the `/api` prefix unless otherwise specified.

| Route group | Purpose | Access |
|---|---|---|
| `/api/health` | Server health check | Public |
| `/api/auth` | Verify token and get authenticated user | Protected |
| `/api/users` | User profile and admin user management | Protected / Admin |
| `/api/restaurants` | Public restaurant discovery and vendor restaurant management | Public / Vendor |
| `/api/menu` | Public menu, vendor menu management, and admin moderation | Public / Vendor / Admin |
| `/api/orders` | Create, view, and manage orders | Customer / Vendor / Admin |
| `/api/cart` | Customer cart operations | Customer |
| `/api/payments` | Checkout, payment sessions, and payment history | Customer / Vendor / Admin |
| `/api/favorites` | Customer wishlist | Customer |
| `/api/reviews` | Menu and restaurant reviews | Public / Customer / Vendor |
| `/api/recommendations` | Taste DNA recommendations | Customer |
| `/api/admin` | Admin dashboard, transactions, and review moderation | Admin |
| `/api/dashboard` | Role-based dashboard summary | Authenticated roles |
| `/api/uploads/image` | Validated image upload proxy | Public endpoint |
| `/api/subscriptions` | Vendor Premium plans, checkout, and billing portal | Vendor |
| `/api/stripe/webhook` | Stripe webhook processing | Stripe signature |
| `/api/test` | Development integration probes | Non-production only |

### Useful Endpoints

```http
GET    /api/health

GET    /api/menu
GET    /api/menu/featured
GET    /api/menu/categories
GET    /api/menu/locations
GET    /api/menu/:id

GET    /api/restaurants
GET    /api/restaurants/:id

GET    /api/recommendations/taste-dna?limit=8

GET    /api/cart
POST   /api/cart
DELETE /api/cart

POST   /api/orders
GET    /api/orders/my
GET    /api/orders/vendor
GET    /api/orders/admin

POST   /api/payments/checkout
GET    /api/payments/my
GET    /api/payments/vendor

GET    /api/subscriptions/plans
GET    /api/subscriptions/status
POST   /api/subscriptions/create-checkout-session
POST   /api/subscriptions/create-portal-session

POST   /api/uploads/image
POST   /api/stripe/webhook
```

Protected endpoints require a valid bearer token and may require a specific role.

---

## ⚙️ Getting Started

### Prerequisites

- Node.js
- npm
- MongoDB database
- PizzaHub frontend for complete end-to-end testing
- Better Auth configuration shared with the frontend
- Stripe account and test-mode credentials for payment testing
- ImgBB API key for image uploads
- Resend API key and verified sender for email delivery

### 1. Clone the Repository

```bash
git clone <SERVER_REPOSITORY_URL>
cd pizzahub-server
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment Variables

Copy the example file:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Update `.env` with your local configuration.

### 4. Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `NODE_ENV` | Recommended | Set to `development` locally; enables the development-only Resend test recipient override. |
| `PORT` | No | Express port; defaults to `5000`. |
| `FRONTEND_URL` | Recommended | Comma-separated list of allowed frontend CORS origins. |
| `MONGODB_URI` | Yes | MongoDB connection string. |
| `DB_NAME` | Yes | MongoDB database name. |
| `BETTER_AUTH_URL` | For protected auth | Better Auth base URL; must match the frontend issuer/audience and JWKS host. Defaults to `http://localhost:3000`. |
| `BETTER_AUTH_SECRET` | Shared configuration | Better Auth secret; keep it aligned with the frontend configuration. |
| `IMGBB_API_KEY` | Upload feature | Server-side ImgBB API key. |
| `STRIPE_SECRET_KEY` | Payment/billing | Stripe secret key; use a test-mode key during development. |
| `STRIPE_WEBHOOK_SECRET` | Payment/billing | Stripe webhook signing secret. |
| `STRIPE_PRICE_ID_MONTHLY` | Vendor Premium | Monthly Stripe Price ID (`price_...`). |
| `STRIPE_PRICE_ID_YEARLY` | Vendor Premium | Yearly Stripe Price ID (`price_...`). |
| `RESEND_API_KEY` | Email feature | Resend API key. |
| `EMAIL_FROM` | Email feature | Verified sender address used by Resend. |
| `RESEND_TEST_EMAIL` | Development only | Verified recipient used instead of stored customer/vendor recipients when `NODE_ENV=development`. |

**Important configuration notes**

- `MONGODB_URI` and `DB_NAME` are required for server startup.
- Stripe and Resend credentials are optional at startup. Features that depend on missing provider configuration return a controlled response or warning.
- `BETTER_AUTH_URL` must match the frontend Better Auth URL so JWKS, issuer, and audience verification work.
- `BETTER_AUTH_SECRET` must match the frontend configuration.
- `FRONTEND_URL` accepts multiple comma-separated origins. The deployed PizzaHub frontend and `http://localhost:3000` are also explicitly allowed by the server.
- Never expose server credentials through `NEXT_PUBLIC_*` variables.
- Never commit `.env` to Git.

### Example `.env`

```env
NODE_ENV=development
PORT=5000
FRONTEND_URL=http://localhost:3000

MONGODB_URI=mongodb+srv://<username>:<password>@<cluster-url>/
DB_NAME=pizzahub

BETTER_AUTH_URL=http://localhost:3000
BETTER_AUTH_SECRET=your_shared_better_auth_secret

IMGBB_API_KEY=your_imgbb_api_key

STRIPE_SECRET_KEY=sk_test_your_secret_key
STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret
STRIPE_PRICE_ID_MONTHLY=price_your_monthly_price_id
STRIPE_PRICE_ID_YEARLY=price_your_yearly_price_id

RESEND_API_KEY=re_your_resend_api_key
EMAIL_FROM=PizzaHub <orders@your-verified-domain.com>
RESEND_TEST_EMAIL=your-verified-test-email@example.com
```

### 5. Run the Development Server

```bash
npm run dev
```

The server starts at:

```text
http://localhost:5000
```

Health check:

[http://localhost:5000/api/health](http://localhost:5000/api/health)

Expected response:

```json
{
  "success": true,
  "message": "Server is healthy"
}
```

### 6. Run the Frontend

For the complete local application, start the PizzaHub frontend in a separate terminal and configure its API URL to:

```text
http://localhost:5000
```

The frontend and backend must use matching Better Auth configuration.

---

## 📜 Available Scripts

| Command | Description |
|---|---|
| `npm run dev` | Runs the API with `tsx watch` for local development. |
| `npm run build` | Compiles TypeScript into `dist/`. |
| `npm start` | Runs the compiled server from `dist/index.js`. |
| `npm run test:integration` | Runs the API integration test script. |

The integration suite requires the frontend and backend applications and configured providers. The repository also includes dedicated scripts for billing audits and Taste DNA checks.

---

## 🚀 Deployment

The server includes a `vercel.json` configuration and exports the Express application from `src/index.ts` for Vercel's serverless runtime.

For deployment:

1. Import the server repository into your hosting provider.
2. Configure all required and feature-specific environment variables.
3. Set `BETTER_AUTH_URL` and the frontend's Better Auth configuration to the same production URL.
4. Configure `FRONTEND_URL` with the deployed frontend origin.
5. Configure Stripe webhook forwarding to the production endpoint:

   ```text
   https://<your-api-domain>/api/stripe/webhook
   ```

6. Add the production Stripe webhook signing secret to `STRIPE_WEBHOOK_SECRET`.
7. Confirm the health endpoint and test the required customer/vendor/admin workflows.

---

## 🔗 Project Links

| Resource | Link |
|---|---|
| **Live Website** | [PizzaHub](https://pizzahub-mocha.vercel.app/) |
| **Client Repository** | `https://github.com/fahimrahat58/pizzahub-client` |
| **Server Repository** | `https://github.com/fahimrahat58/pizzahub-server` |

---

## 🔒 Security Practices

- Verify JWTs through Better Auth remote JWKS.
- Validate issuer, audience, signature, algorithm, and expiration.
- Verify the live database session on protected requests.
- Load current role and blocked status from MongoDB.
- Apply role-based authorization at the route layer.
- Validate request bodies and ObjectId parameters.
- Escape user search input before building MongoDB regex filters.
- Use explicit sort mappings and bounded pagination.
- Verify Stripe webhook signatures against raw request bytes.
- Make webhook processing idempotent.
- Keep ImgBB, Stripe, and Resend secrets on the server.
- Never let email delivery failure undo an otherwise successful order operation.

---

## 🧪 Testing & Verification

Build the TypeScript project:

```bash
npm run build
```

Run the integration suite:

```bash
npm run test:integration
```

The integration test script requires the frontend and backend applications and configured providers. The repository also includes dedicated scripts for billing audits and Taste DNA checks.

---

## 🤝 Contributing

1. Fork the repository.
2. Create a feature branch.
3. Keep route, middleware, controller, and service responsibilities separated.
4. Validate incoming data with the existing Zod middleware patterns.
5. Preserve backend authorization and ownership checks.
6. Run the TypeScript build and relevant integration tests.
7. Submit a pull request with a clear description of the change.

---

<div align="center">

### Built with 🍕 for better pizza discovery.

**[Explore PizzaHub](https://pizzahub-mocha.vercel.app/)**

</div>
