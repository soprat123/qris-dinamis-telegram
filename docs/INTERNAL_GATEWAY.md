# Internal Manual QRIS Gateway

This branch adds a first-party QRIS order engine while keeping the existing GatePay routes available as a legacy fallback.

## Payment lifecycle

1. A trusted application creates an order with `POST /api/orders`.
2. The Worker reserves an active unique amount, converts the configured static merchant QRIS to that amount, and stores the order in D1 as `pending`.
3. The customer opens `/pay/:orderId` and pays the exact `unique_amount` shown.
4. Payment detection is manual. An authorized admin checks the merchant account and uses `/admin/payments` to mark the order as paid.
5. `pending -> paid`, the audit record, and release of the unique-amount reservation are executed together through a D1 batch.
6. The Worker sends an idempotent `order.paid` callback to AIChatAPI or Bikin Foto. A failed callback leaves the payment `paid` with `settlement_status=retry_needed` and can be retried from the admin page.
7. Unpaid orders expire after `INTERNAL_ORDER_TTL_SECONDS` (default 900 seconds); the scheduled handler checks every five minutes, and public status reads also expire overdue orders.

## New routes

- `POST /api/orders` — create an internal order. Requires `x-internal-secret` or a valid gateway API key.
- `GET /api/orders/:id` — safe public status response.
- `GET /api/orders/:id/qris` — QRIS PNG for the stored order.
- `POST /api/orders/:id/cancel` — cancel a pending order using a trusted internal secret or the returned one-time cancel token.
- `GET /pay/:id` — mobile checkout page.
- `GET /admin/payments` — admin dashboard UI.
- `GET /api/admin/payments?status=...` — protected admin order list.
- `POST /api/admin/payments/:id/mark-paid` — protected manual paid confirmation.
- `POST /api/admin/payments/:id/cancel` — protected admin cancellation.
- `POST /api/admin/payments/:id/retry-webhook` — protected settlement retry.

Legacy `/internal/orders` and `/webhook/gatepay` are not removed; requests outside the new gateway routes continue through the existing Worker.

## Required configuration

Existing configuration must be preserved:

- D1 binding: `DB` -> `qris-payment-orders`
- `QRIS_STATIC_PAYLOAD`
- `QRIS_API_KEY`
- `QRIS_INTERNAL_SECRET`
- `GATEPAY_API_KEY`
- `GATEPAY_CALLBACK_SECRET`
- Telegram/admin secrets already used by the legacy Worker
- `AICHATAPI_URL`
- `BIKIN_FOTO_URL`

New secret:

- `QRIS_ADMIN_TOKEN` — required for the admin payment API/dashboard. Set it directly as a Cloudflare Worker Secret; do not commit its value.

Optional Wrangler variable:

- `INTERNAL_ORDER_TTL_SECONDS` — default `900`, clamped to 60–86400 seconds.

## D1 migration

Apply `migrations/0002_internal_qris_gateway.sql` exactly once to the existing `qris-payment-orders` production database before promoting this Worker version. It adds nullable columns, active unique-amount reservations, payment audit logs, and hashed API-key storage. It does not delete or rewrite existing GatePay rows.

## Safe rollout order

1. Keep production on the existing version.
2. Add `QRIS_ADMIN_TOKEN` as a Worker Secret.
3. Apply `migrations/0002_internal_qris_gateway.sql` to the production D1 database.
4. Deploy this branch/version without changing the existing application callers yet.
5. Verify `/health`, create a low-value internal test order, confirm it appears in D1/admin dashboard, then manually mark it paid and verify callback delivery/idempotency.
6. Only after the gateway is verified, migrate `bikin-foto` and `aichatapi-worker` from legacy `/internal/orders` to the new `/api/orders` path.

## Security notes

- The admin token is never stored in `localStorage` or `sessionStorage`; the dashboard keeps it only in the current input field.
- The browser cannot choose the audit `approved_by` identity; the server records the authenticated admin-token principal.
- Public order IDs are random and non-sequential.
- Cancel tokens are returned once and only their SHA-256 hashes are stored.
- Payment status cannot be set by public customer endpoints.
- Manual paid confirmation is conditional on the current `pending` state, preventing repeated paid transitions.
- Downstream callbacks include the order ID as an idempotency key and retain the existing internal secret for compatibility.
