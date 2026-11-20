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
git clone <https://github.com/fahimrahat58/pizzahub-server>
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

## 🧠 Challenges & Technical Implementation

This section explains the major engineering challenges in PizzaHub Server and how each one was implemented using Express 5, TypeScript, MongoDB, Better Auth, Stripe, and external services.

### Challenge 1: Advanced Menu API Filtering, Sorting & Pagination

**Problem**

A pizza marketplace needs flexible menu discovery. Customers should be able to search for pizzas, filter by category, location, restaurant, vendor, and price, and sort results without downloading the entire menu.

**Implementation**

Implemented in:

- `src/controllers/menu.controller.ts`
- `src/services/menu.service.ts`
- `src/utils/query.ts`

**API Endpoint**

```http
GET /api/menu
```

**Supported Query Parameters**

| Parameter | Function | Example |
|---|---|---|
| `search` | Searches pizza name, description, and ingredients | `search=cheese` |
| `category` | Filters by category | `category=Classic Pizzas` |
| `location` | Filters by menu-item location or restaurant address | `location=Dhaka` |
| `vendorId` | Filters menu items by vendor | `vendorId=65f...` |
| `restaurantId` | Filters menu items by restaurant | `restaurantId=65f...` |
| `minPrice` | Sets minimum price | `minPrice=8` |
| `maxPrice` | Sets maximum price | `maxPrice=25` |
| `featured` | Returns featured items when `true` | `featured=true` |
| `sort` | Controls sorting | `sort=price_asc` |
| `page` | Selects the result page | `page=2` |
| `limit` | Controls items per page; maximum 50 | `limit=12` |

**Supported Sorting Options**

- `price_asc` — Lowest price first.
- `price_desc` — Highest price first.
- `rating` — Highest-rated items first.
- `oldest` — Oldest items first.
- `newest` — Newest items first (default).

**Example Request**

```http
GET /api/menu?search=cheese&category=Classic%20Pizzas&location=Dhaka&minPrice=8&maxPrice=25&sort=rating&page=1&limit=12
```

**How It Was Built**

1. Query parameters are extracted using the `firstString()` utility.
2. `getPagination()` normalizes the page and limit values.
3. The limit is restricted to a maximum of 50 to prevent excessively large database responses.
4. Vendor and restaurant IDs are validated before converting them into MongoDB ObjectIds.
5. Search input is escaped using `escapeRegex()` before constructing a case-insensitive regular expression.
6. Category filtering uses a category matcher.
7. Location filtering searches both the menu item's location and matching restaurant addresses. This supports legacy menu items that rely on their restaurant's address.
8. Price filtering uses MongoDB `$gte` and `$lte`.
9. Sorting is mapped to predefined MongoDB sort objects instead of accepting arbitrary client-provided database fields.
10. `menuWithRatingsPipeline()` enriches menu results with restaurant and rating information.
11. MongoDB aggregation and `countDocuments()` execute together using `Promise.all()`.
12. The API returns the filtered items and pagination metadata.

**Response Structure**

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

**Result**

Filtering, sorting, and pagination are handled on the backend, reducing unnecessary data transfer and keeping menu queries controlled.

---

### Challenge 2: Secure JWT Authentication with Better Auth JWKS

**Problem**

The backend needs to authenticate users created through the Next.js Better Auth integration. It must also detect expired sessions, blocked accounts, and invalid user roles instead of trusting information supplied by the frontend.

**Implementation**

Implemented in:

```text
src/middleware/auth.middleware.ts
```

Uses:

- Better Auth
- `jose`
- MongoDB session and user collections
- `verifyToken`
- `requireRole`

**Authentication Middleware Flow**

```text
Incoming API Request
        |
        v
Authorization Header
        |
        v
Bearer Token Present?
        |
        +---- No ----> 401 Unauthorized
        |
        v
Fetch Better Auth JWKS
        |
        v
Verify JWT with jose
        |
        v
Validate Signature, Issuer,
Audience and Expiration
        |
        v
Validate User ID and Session ID
        |
        v
Check Live MongoDB Session
        |
        v
Load Current User from MongoDB
        |
        v
Check isBlocked and Current Role
        |
        v
requireRole()
        |
        +---- Wrong Role ----> 403 Forbidden
        |
        v
Controller Executes
```

**Technical Implementation**

1. Every protected request must contain:

   ```http
   Authorization: Bearer <token>
   ```

2. The middleware retrieves the public signing keys from:

   ```text
   ${BETTER_AUTH_URL}/api/auth/jwks
   ```

3. `jose` verifies the JWT signature using the remote JWKS.

4. The verification checks:
   - Token signature.
   - Issuer.
   - Audience.
   - Expiration.
   - Allowed signing algorithm (`EdDSA`).

5. The middleware validates the token's `sub` and `sessionId` as MongoDB ObjectIds.

6. It queries the Better Auth `session` collection and checks:
   - Session ID matches.
   - Session belongs to the authenticated user.
   - `expiresAt` is later than the current time.

7. The current user is loaded from MongoDB with the required identity, role, and blocked-status fields.

8. Blocked accounts are rejected with `403` and the `ACCOUNT_BLOCKED` error code.

9. Only the supported roles are accepted:

   ```ts
   ["admin", "vendor", "customer"]
   ```

10. The verified user is attached to `req.user`.

11. `requireRole()` performs the final role authorization check before the controller executes.

**Example Route**

```ts
router.get(
  "/vendor/mine",
  verifyToken,
  requireRole("vendor"),
  listVendorMenu
);
```

**HTTP Responses**

| Status | Meaning |
|---|---|
| `401` | Missing, invalid, or expired token/session |
| `403` | Blocked account or insufficient permissions |
| `503` | Authentication infrastructure is unavailable |

**Important Security Decision**

The backend does not trust the role contained in the frontend request or use token claims as the final authorization source. It checks the current role and blocked status directly from MongoDB.

---

### Challenge 3: Centralized Request Validation with Zod

**Problem**

API endpoints receive data from external clients. Invalid MongoDB IDs, malformed request bodies, and unexpected query values can cause runtime errors or unsafe database operations.

**Implementation**

Implemented in:

```text
src/middleware/validate.ts
```

Uses Zod to validate incoming request data.

**Available Validation Middleware**

| Middleware | Responsibility |
|---|---|
| `validateBody(schema)` | Validates request body |
| `validateParams(schema)` | Validates route parameters |
| `validateQuery(schema)` | Validates query parameters |

**MongoDB ObjectId Validation**

```ts
export const objectIdSchema = z
  .string()
  .regex(/^[a-fA-F0-9]{24}$/, "Invalid id");

export const objectIdParamSchema = z
  .object({ id: objectIdSchema })
  .strict();
```

**Example Route**

```ts
router.patch(
  "/:id",
  verifyToken,
  requireRole("vendor"),
  validateParams(objectIdParamSchema),
  validateBody(updateMenuItemSchema),
  updateMenuItem
);
```

**How It Works**

1. The request reaches the validation middleware.
2. Zod checks the incoming data using `safeParse()`.
3. Invalid data is passed to the centralized error handler.
4. Valid request-body data is replaced with the parsed and validated result.
5. The controller receives validated input.

**Express 5 Compatibility**

Express 5 exposes `req.query` as a getter. Therefore, the query validator checks the original query without attempting to replace `req.query`.

This avoids a common compatibility problem when implementing query validation in Express 5.

---

### Challenge 4: Vendor Menu Approval and Premium Publishing Limits

**Problem**

Vendors should be able to create and manage menu items, but unapproved products must not become publicly available. Premium subscriptions must also control publishing limits.

**Implementation**

Implemented in:

- `src/controllers/menu.controller.ts`
- `src/services/menu.service.ts`
- `src/routes/menu.routes.ts`

**Vendor Menu Creation Flow**

```text
Vendor Creates Menu Item
        |
        v
Verify JWT
        |
        v
requireRole("vendor")
        |
        v
Validate Request Body
        |
        v
Verify Restaurant Ownership
        |
        v
Save Menu Item
        |
        v
approvalStatus = pending
isActive = false
        |
        v
Admin Reviews Menu Item
        |
        +---- Rejected ----> Remains Hidden
        |
        +---- Approved
                 |
                 v
          Vendor Can Publish
                 |
                 v
          Check Publishing Limit
                 |
                 v
          Public Menu Visibility
```

**Technical Decisions**

- Newly created menu items always start with `approvalStatus: "pending"`.
- Newly created items always start with `isActive: false`.
- Client-provided `isActive` values cannot bypass the approval process.
- Vendors can only manage menu items belonging to their own account.
- Vendors must own the restaurant associated with the menu item.
- Only administrators can approve pending items or restore rejected items.
- Rejected items cannot be republished by vendors.
- Publishing checks the vendor's current subscription state.

**Premium Publishing Logic**

The service checks the vendor's subscription state using MongoDB.

- Active approved menu items are counted.
- Premium subscription status is resolved from stored subscription data.
- Vendors without an eligible Premium subscription fall back to the Free publishing limit.
- Premium vendors receive the configured Premium publishing allowance.

**Result**

The approval workflow and subscription limits are enforced by the backend, not merely by hiding frontend buttons.

---

### Challenge 5: Taste DNA — Personalized Recommendation Engine

**Problem**

A traditional menu displays the same products to every customer. PizzaHub needed a recommendation system that could understand customer preferences and explain why particular pizzas are recommended.

**Implementation**

Implemented in:

```text
src/services/recommendation.service.ts
src/controllers/recommendations.controller.ts
src/routes/recommendations.routes.ts
```

Taste DNA is a deterministic recommendation engine built from real customer activity stored in MongoDB. It does not depend on an external AI API or fabricated preference data.

**API Endpoint**

```http
GET /api/recommendations/taste-dna?limit=8
Authorization: Bearer <customer-jwt>
```

| Parameter | Description |
|---|---|
| `limit` | Number of recommendations to return |
| Default | `8` |
| Minimum | `1` |
| Maximum | `12` |

Only authenticated customers can access the endpoint. The customer identity is obtained from `req.user`, never from a user ID supplied through query parameters.

**Data Sources**

The recommendation engine reads:

1. Delivered orders.
2. Customer favorites.
3. Visible menu-item reviews.
4. Approved and active menu items.

These sources are queried concurrently using `Promise.all()`.

**Preference Signal Weights**

| Customer Activity | Weight |
|---|---:|
| Delivered order | `3` per unit, maximum 3 units |
| Favorite | `2.5` |
| 4–5 star review | `2` |
| 3 star review | `0.5` |
| 1–2 star review | `-2.5` |

Positive and negative signals are stored separately. Negative signals are subtracted from category and ingredient preferences.

Menu items rated 1–2 stars by the customer are excluded from direct recommendations.

**Recommendation Scoring Formula**

```text
score =
  15
  + 30 * categoryScore / (categoryScore + 3)
  + 35 * ingredientScore / (ingredientScore + 4)
  + 20 * priceFit
  - 8 if already purchased
```

The final score is clamped between `0` and `100` and rounded to a whole number.

**Scoring Breakdown**

| Component | Maximum Points |
|---|---:|
| Publicly available baseline | 15 |
| Category affinity | 30 |
| Ingredient affinity | 35 |
| Historical budget fit | 20 |
| Already-purchased penalty | -8 |

**Budget Intelligence**

The system uses unit prices from delivered orders to understand historical spending.

- Calculates the average historical purchase price.
- Uses the 10th percentile as the lower budget boundary.
- Uses the 90th percentile as the upper budget boundary.
- Compares the average customer price with catalog price distribution.
- Calculates how closely each candidate's price fits the historical budget.

Budget labels include:

- Budget-friendly
- Mid-range
- Premium
- Not enough purchase history

**Recommendation Explainability**

Each recommendation contains:

- The recommended menu item.
- A match score.
- Reasons explaining the match.

Example reasons include:

- The customer frequently chooses this category.
- The pizza contains ingredients the customer prefers.
- The item matches the customer's usual price range.

**Taste Profile Status**

| Status | Meaning |
|---|---|
| `empty` | No usable preference signals |
| `developing` | Preference signals exist, but there is no delivered-order history |
| `ready` | Delivered-order history is available |

The engine evaluates up to 400 approved and active menu candidates before ranking the recommendations.

**Result**

Taste DNA makes recommendations more personal and explainable. Customers can understand both what is recommended and why it matches their preferences.

---

### Challenge 6: Stripe Checkout, Webhook Verification & Payment Integrity

**Problem**

A customer should not be marked as paid simply because the browser redirects to a success page. Payment confirmation must come from Stripe, and webhook events must not be processed repeatedly or applied to the wrong order.

**Implementation**

Implemented in:

- `src/app.ts`
- `src/routes/webhooks.routes.ts`
- `src/controllers/webhooks.controller.ts`
- `src/services/payment.service.ts`
- `src/services/subscription.service.ts`
- `src/config/stripe.ts`

**Raw-Body Webhook Handling**

Stripe signature verification requires the original request body.

The webhook router is therefore registered before `express.json()`:

```ts
app.use("/api/stripe", webhookRoutes);

app.use(express.json({ limit: "8mb" }));
```

The webhook route uses:

```ts
router.post(
  "/webhook",
  express.raw({ type: "*/*" }),
  stripeWebhook
);
```

**Webhook Processing Flow**

```text
Stripe Sends Webhook
        |
        v
Receive Original Raw Body
        |
        v
Read Stripe-Signature
        |
        v
Verify Signature
        |
        +---- Invalid ----> Reject Request
        |
        v
Identify Stripe Event
        |
        v
Claim Event for Idempotency
        |
        v
Determine Event Type
        |
        +---- Customer Payment
        |        |
        |        v
        |   Verify Order Metadata
        |        |
        |        v
        |   Verify Payment Status
        |        |
        |        v
        |   Update Order & Transaction
        |
        +---- Vendor Subscription
        |        |
        |        v
        |   Resolve Vendor Identity
        |        |
        |        v
        |   Synchronize Subscription
        |
        +---- Refund
                 |
                 v
          Update Refund Ledger
```

**Payment Security Decisions**

- Stripe signature verification happens before processing the event.
- The webhook uses the raw request body.
- Event IDs are recorded for idempotent processing.
- Customer order events and vendor subscription events are classified separately.
- Customer orders are settled only after Stripe confirms `payment_status: "paid"`.
- The checkout session must match the stored order.
- The PaymentIntent is verified before the order is marked paid.
- Transaction records are updated alongside payment state.
- The customer's cart is cleared after successful payment settlement.
- Failed and expired Checkout Sessions are handled separately.
- Refund events update transaction and order payment states.

**Important Rule**

The frontend never activates Premium or marks an order as paid by itself. Verified Stripe webhook events are the trusted source for payment and subscription updates.

---

### Challenge 7: Vendor Premium Subscription Synchronization

**Problem**

Subscription state can change outside the application. A customer may cancel a subscription, Stripe may retry payments, or webhook events may arrive late or more than once.

The backend needs to keep MongoDB subscription information synchronized with Stripe without allowing old events to overwrite newer state.

**Implementation**

Implemented in:

```text
src/services/subscription.service.ts
src/controllers/subscriptions.controller.ts
src/controllers/webhooks.controller.ts
```

**Subscription Flow**

1. A vendor requests available Premium plans.
2. The backend validates the requested plan.
3. The server checks the configured Stripe Price ID.
4. The backend creates or retrieves the Stripe customer.
5. Existing active or trialing subscriptions are checked against Stripe.
6. A Checkout Session is created using the server-side Price ID.
7. Stripe sends subscription lifecycle webhooks.
8. The webhook handler verifies the event.
9. The backend resolves the vendor using stored Stripe customer or subscription mappings.
10. The subscription state is synchronized into MongoDB.

**Important Safeguards**

- Only configured `price_...` identifiers are accepted.
- Product IDs (`prod_...`) are not accepted as subscription Price IDs.
- Stripe is treated as the authority for live subscription state.
- Stored customer identity cannot be reassigned to another vendor.
- Conflicting vendor metadata is rejected.
- Delayed events cannot overwrite newer subscription state.
- Event timestamps are used to protect against stale webhook updates.
- A terminal subscription can only be replaced under the configured active-subscription rules.

**Billing Configuration**

Stripe credentials are optional during server startup. If billing is not fully configured, billing endpoints return a controlled `503` response instead of preventing unrelated marketplace functionality from running.

---

### Challenge 8: Secure Image Upload Through ImgBB

**Problem**

Sending large base64-encoded images in JSON increases request payload size. The application also needs to prevent unsupported files, fake MIME types, and oversized uploads.

**Implementation**

Implemented in:

```text
src/controllers/uploads.controller.ts
src/services/image.service.ts
```

**API Endpoint**

```http
POST /api/uploads/image
```

**Supported Formats**

- JPEG
- PNG
- WebP
- GIF

**Maximum Image Size**

```text
5 MB
```

**Upload Flow**

1. The frontend sends raw image bytes with the correct content type.
2. The backend applies a per-IP upload throttle.
3. The controller checks whether the request contains raw bytes or legacy JSON image data.
4. The image service validates the declared MIME type.
5. It checks the actual file signature using magic bytes.
6. It validates the decoded image size.
7. The validated image is converted to base64 for the ImgBB API.
8. The backend sends the upload request to ImgBB.
9. The resulting HTTPS image URL is returned to the frontend.

**Rate Limiting**

The upload endpoint uses a lightweight in-memory per-IP throttle:

- Maximum 12 uploads.
- Within a 10-minute window.
- Excess requests receive `429 Too Many Requests`.

**Why Raw Bytes?**

Base64 increases payload size. Sending raw image bytes from the frontend avoids this extra encoding overhead on the request and helps stay within serverless request-body limits.

The backend still converts the validated bytes to base64 when communicating with ImgBB.

**Security**

The ImgBB API key is stored only in the backend environment. It is never exposed to the browser.

---

### Challenge 9: Reliable Transactional Emails with Resend

**Problem**

Customers and vendors need order notifications, but an email provider outage should never cancel a successfully created order or undo a valid order-status transition.

**Implementation**

Implemented in:

```text
src/services/email.service.ts
```

Uses the Resend SDK.

**Email Events**

| Event | Recipient |
|---|---|
| New order | Vendor |
| New order confirmation | Customer |
| Order accepted | Customer |
| Order rejected | Customer |
| Payment notifications | Relevant customer/vendor |
| Payment failure | Customer |
| Refund notification | Customer |

**New Order Email Flow**

1. The order information is stored and the relevant recipient snapshots are obtained.
2. The email service receives the stored vendor and customer details.
3. It generates HTML and plain-text email content.
4. The Resend SDK sends the vendor notification.
5. The Resend SDK sends the customer confirmation.
6. Each delivery result is returned separately.

**Order Status Email Flow**

When a vendor accepts or rejects an order:

1. The backend validates the status transition.
2. The order is updated in MongoDB.
3. The email service receives the customer's stored snapshot information.
4. Resend sends the relevant status notification.
5. The API includes an `email` result in the response.

**Failure Handling**

Email delivery is treated as a side effect.

- Missing Resend configuration returns a warning.
- Provider rejection returns a warning.
- Network failure returns a warning.
- Email failure does not roll back the order transition.
- API responses can include `email: { sent, warning? }`.

**Development Test Recipient**

For development testing:

```env
NODE_ENV=development
RESEND_TEST_EMAIL=your-verified-email@example.com
```

When enabled, both vendor and customer test emails are routed to the verified test recipient.

The original recipient information stored in MongoDB is not changed.

This override is disabled in production.

**Security**

Recipient addresses are derived from stored order and vendor data, not trusted from the incoming request body. The Resend API key is never logged.

---

### Challenge 10: CORS, Runtime Initialization & Centralized Error Handling

**Problem**

The API needs to support local and deployed frontend origins, maintain Better Auth cookie compatibility, and ensure that database initialization completes before requests access application collections.

**Implementation**

Implemented in:

```text
src/app.ts
src/config/bootstrap.ts
src/config/database.ts
src/config/env.ts
src/utils/errors.ts
```

**Middleware Order**

The application initializes middleware in a deliberate order:

1. CORS middleware.
2. Shared runtime initialization.
3. Stripe webhook router using raw request bodies.
4. JSON body parser.
5. Health and application routes.
6. Not-found handler.
7. Centralized error handler.

**CORS Configuration**

- Uses an explicit allowlist of origins.
- Supports comma-separated `FRONTEND_URL` values.
- Enables credentials for Better Auth cookies.
- Handles preflight requests.
- Avoids reflecting arbitrary untrusted origins.

**Runtime Initialization**

Every request waits for the shared initialization function.

The initialization process handles MongoDB connectivity and the required indexes and migrations. After the first successful initialization, subsequent calls reuse the initialized runtime.

**Error Handling**

The centralized error handler provides consistent API error responses and avoids duplicating response logic in every controller.

---

### Challenge 11: Order Ownership, Status Transitions & Delivery-Date Protection

**Problem**

Customers, vendors, and administrators need different levels of order access. Order statuses must also follow a valid sequence, and vendors must not be able to mark an order delivered before the customer's requested delivery date.

**Implementation**

Implemented in:

```text
src/controllers/orders.controller.ts
src/routes/orders.routes.ts
```

**Role-Based Order Access**

| Role | Access |
|---|---|
| Customer | Own orders |
| Vendor | Orders belonging to their vendor account |
| Admin | All orders |

The `findOrderForRequest()` helper checks ownership before returning an order. If an order exists but belongs to another user, the backend returns `403 Forbidden`.

**Order Status Flow**

```text
Pending
   |
   +---- Customer Cancellation
   |
   +---- Vendor Accepts
             |
             v
          Accepted
             |
             v
          Preparing
             |
             v
       Out for Delivery
             |
             v
          Delivered
```

Vendors can also reject pending orders.

**Allowed Transitions**

| Action | Allowed Previous Status | Next Status |
|---|---|---|
| Customer cancellation | `pending` | `cancelled` |
| Vendor acceptance | `pending` | `accepted` |
| Vendor rejection | `pending` | `rejected` |
| Start preparation | `accepted` | `preparing` |
| Dispatch order | `preparing` | `out_for_delivery` |
| Complete delivery | `out_for_delivery` | `delivered` |

**Delivery-Date Validation**

Before an order can be marked as delivered, the backend checks the requested delivery date using `deliveryDateReached()`.

If the requested date has not been reached, the API rejects the status update with a `400 Bad Request`.

**Payment Protection**

Fulfillment statuses such as accepted, preparing, out for delivery, and delivered require the order's payment status to be `paid`.

**Atomic Status Updates**

MongoDB `findOneAndUpdate()` is used with the allowed previous statuses and ownership filter. This helps prevent concurrent requests from applying an invalid transition.

Each successful transition appends a timeline entry containing the new status, actor, note, and timestamp.

---

### Challenge 12: Vendor Unseen Order Notifications

**Problem**

A vendor dashboard needs to show newly received orders. A simple timestamp-based notification system can miss orders because of clock differences, multiple server instances, or requests happening at the same time.

**Implementation**

Implemented in:

```text
src/controllers/orders.controller.ts
```

**Database-Based Approach**

Instead of relying only on a vendor's last-viewed timestamp, PizzaHub stores `vendorSeen` on each order.

**How It Works**

1. When a vendor first uses the unseen-order feature, existing orders are marked as seen.
2. The user's `vendorBadgeInitialized` field records that the initial baseline has been created.
3. New orders are unseen by default.
4. The unseen count is calculated by counting orders where `vendorSeen` is not `true`.
5. When the vendor opens the relevant dashboard section, the backend marks the vendor's unseen orders as seen.
6. The API recalculates the count after the update.

**Endpoints**

```http
GET  /api/orders/vendor/unseen
POST /api/orders/vendor/seen
```

**Result**

The notification count is based on individual order records rather than relying on a single wall-clock timestamp.

---

### Challenge 13: Customer Payment and Transaction Consistency

**Problem**

A customer order must be connected to a verified Stripe payment. Failed or expired checkout sessions must not leave an order permanently marked as pending, and repeated webhook delivery must not create duplicate transaction records.

**Implementation**

Implemented in:

```text
src/services/payment.service.ts
src/controllers/webhooks.controller.ts
src/controllers/payments.controller.ts
```

**Important Checkout Rule**

Direct unpaid order placement through the legacy `POST /api/orders` route is disabled. The route returns a clear error instructing customers to use the cart and Stripe Checkout.

**Payment Processing**

- Stripe Checkout is used for customer payments.
- The verified webhook identifies the associated order.
- The Checkout Session is matched against stored order data.
- Payment status must be `paid` before fulfillment.
- The verified PaymentIntent ID is stored.
- The transaction ledger is updated.
- The cart is cleared after successful payment settlement.

**Failure and Expiration Handling**

- Failed checkout events update eligible pending orders to failed.
- Expired checkout sessions release the checkout idempotency key so the customer can retry.
- Refund events update the transaction ledger.
- Full refunds also update the associated order's payment status.
- Duplicate refund records are avoided using the Stripe refund ID.

**Admin Refund Protection**

Admin refunds are restricted to eligible customer-order transactions. The backend checks the remaining refundable amount and uses a Stripe idempotency key for the refund request.

**Result**

Payment state is controlled by verified Stripe events and server-side database checks rather than frontend success-page navigation.

---

## 📌 Implementation Summary

| Challenge | Main Technical Solution |
|---|---|
| Advanced menu discovery | MongoDB filters, aggregation, sorting, and pagination |
| Authentication | Better Auth JWKS and `jose` JWT verification |
| Authorization | Live MongoDB session and role verification |
| Request validation | Zod middleware |
| Menu approval | Vendor ownership and admin approval workflow |
| Premium publishing | Database-based subscription and publishing-limit checks |
| Personalized recommendations | Taste DNA scoring and preference signals |
| Payment security | Raw-body Stripe webhook verification |
| Subscription synchronization | Idempotent event processing and vendor identity checks |
| Image upload | MIME, magic-byte, size validation, and ImgBB proxy |
| Transactional emails | Resend with non-blocking failure handling |
| CORS and initialization | Explicit origin allowlist and shared runtime bootstrap |
| Order lifecycle | Ownership checks, atomic transitions, and delivery-date validation |
| Order notifications | Per-order `vendorSeen` tracking |
| Payment consistency | Stripe-confirmed settlement and transaction ledger |

---

## 🔍 Key Engineering Principles

PizzaHub Server was designed around the following principles:

- **Backend-first security:** Authorization and ownership checks are enforced by the API.
- **Data integrity:** Payment, subscription, and order state changes are validated before database updates.
- **Explainability:** Taste DNA provides understandable recommendation reasons rather than unexplained scores.
- **Controlled API queries:** Search input is escaped, ObjectIds are validated, and pagination is bounded.
- **Reliable integrations:** Email failures do not undo successful business operations.
- **Idempotent processing:** Repeated Stripe events and refund notifications are handled safely.
- **Separation of concerns:** Routes, middleware, controllers, services, configuration, and utilities have separate responsibilities.
- **Type safety:** TypeScript and Zod are used to improve consistency across application boundaries.



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
