import baseWorker, {
  verifyGatePaySignature,
  verifyInternalSecret,
} from "./index.js";

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

function logDbError(event, error, details = {}) {
  console.error(JSON.stringify({
    event,
    ...details,
    message: error?.message || "unknown_error",
  }));
}

async function safeDb(operation, event, details = {}) {
  try {
    return await operation();
  } catch (error) {
    logDbError(event, error, details);
    return null;
  }
}

export async function recordCreatedOrder(env, input, responseBody) {
  if (!env.DB || !responseBody?.order) return false;

  const order = responseBody.order;
  const now = unixNow();
  const expiresIn = Number(order.expires_in || 900);
  const source = String(input.source || (/^web:/i.test(input.reference || "") ? "aichatapi" : "telegram"));
  const userId = source === "aichatapi"
    ? String(input.account_email || "")
    : String(input.telegram_id || "");

  const result = await safeDb(
    () => env.DB.prepare(`
      INSERT INTO payment_orders (
        id, reference, provider, source, user_id, username, email,
        base_amount, unique_amount, currency, status, checkout_url,
        expires_at, paid_at, settlement_status, created_at, updated_at
      ) VALUES (?, ?, 'gatepay', ?, ?, ?, ?, ?, ?, 'IDR', ?, ?, ?, NULL, 'pending', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        reference = excluded.reference,
        source = excluded.source,
        user_id = excluded.user_id,
        username = excluded.username,
        email = excluded.email,
        base_amount = excluded.base_amount,
        unique_amount = excluded.unique_amount,
        status = CASE WHEN payment_orders.status = 'paid' THEN 'paid' ELSE excluded.status END,
        checkout_url = excluded.checkout_url,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `).bind(
      String(order.id),
      String(input.reference || ""),
      source,
      userId || null,
      input.username ? String(input.username).replace(/^@/, "").slice(0, 64) : null,
      input.account_email ? String(input.account_email).slice(0, 120) : null,
      Number(order.base_amount || input.base_amount),
      Number(order.unique_amount || input.base_amount),
      String(order.status || "pending"),
      String(order.checkout_url || ""),
      now + Math.max(0, expiresIn),
      now,
      now,
    ).run(),
    "payment_order_store_failed",
    { order_id: String(order.id) },
  );

  return Boolean(result);
}

export async function recordPaidEvent(env, event, settlementStatus = "received") {
  if (!env.DB) return false;

  const now = unixNow();
  const paidAt = Number(event.paid_at || now);
  const reference = String(event.reference || "");
  const source = /^web:/i.test(reference) ? "aichatapi" : "telegram";

  const result = await safeDb(
    () => env.DB.prepare(`
      INSERT INTO payment_orders (
        id, reference, provider, source, user_id, username, email,
        base_amount, unique_amount, currency, status, checkout_url,
        expires_at, paid_at, settlement_status, created_at, updated_at
      ) VALUES (?, ?, 'gatepay', ?, NULL, NULL, NULL, ?, ?, 'IDR', 'paid', NULL, NULL, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        reference = CASE WHEN excluded.reference <> '' THEN excluded.reference ELSE payment_orders.reference END,
        base_amount = excluded.base_amount,
        unique_amount = excluded.unique_amount,
        status = 'paid',
        paid_at = excluded.paid_at,
        settlement_status = excluded.settlement_status,
        updated_at = excluded.updated_at
    `).bind(
      String(event.order_id),
      reference,
      source,
      Number(event.base_amount || 0),
      Number(event.unique_amount || 0),
      paidAt,
      settlementStatus,
      now,
      now,
    ).run(),
    "payment_paid_store_failed",
    { order_id: String(event.order_id) },
  );

  return Boolean(result);
}

async function updateSettlementStatus(env, orderId, status) {
  if (!env.DB) return false;
  const result = await safeDb(
    () => env.DB.prepare(`
      UPDATE payment_orders
      SET settlement_status = ?, updated_at = ?
      WHERE id = ?
    `).bind(status, unixNow(), String(orderId)).run(),
    "payment_settlement_status_failed",
    { order_id: String(orderId), settlement_status: status },
  );
  return Boolean(result);
}

async function paymentDbHealth(request, env) {
  if (!(await verifyInternalSecret(
    request.headers.get("x-internal-secret"),
    env.QRIS_INTERNAL_SECRET,
  ))) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  if (!env.DB) {
    return Response.json({ ok: false, configured: false, error: "d1_not_bound" }, { status: 503 });
  }

  try {
    const row = await env.DB.prepare("SELECT COUNT(*) AS total FROM payment_orders").first();
    return Response.json({
      ok: true,
      configured: true,
      payment_orders: Number(row?.total || 0),
    });
  } catch (error) {
    logDbError("payment_db_health_failed", error);
    return Response.json({ ok: false, configured: true, error: "d1_query_failed" }, { status: 500 });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/internal/payment-db/health" && request.method === "GET") {
      return paymentDbHealth(request, env);
    }

    let orderInput = null;
    if (url.pathname === "/internal/orders" && request.method === "POST") {
      try {
        orderInput = await request.clone().json();
      } catch {
        // Base Worker tetap menangani invalid JSON dan mengembalikan error yang sama seperti sebelumnya.
      }
    }

    let verifiedPaidEvent = null;
    if (url.pathname === "/webhook/gatepay" && request.method === "POST") {
      try {
        const rawBody = await request.clone().text();
        const signature = request.headers.get("x-signature");
        const verified = await verifyGatePaySignature(
          rawBody,
          signature,
          env.GATEPAY_CALLBACK_SECRET,
        );
        if (verified) {
          const event = JSON.parse(rawBody);
          if (event.event === "order.paid" && event.order_id) {
            verifiedPaidEvent = event;
            await recordPaidEvent(env, event, "received");
          }
        }
      } catch (error) {
        logDbError("payment_webhook_prestore_failed", error);
      }
    }

    const response = await baseWorker.fetch(request, env, ctx);

    if (orderInput && response.ok && env.DB) {
      try {
        const body = await response.clone().json();
        if (body?.ok && body?.order) {
          await recordCreatedOrder(env, orderInput, body);
        }
      } catch (error) {
        logDbError("payment_order_response_store_failed", error);
      }
    }

    if (verifiedPaidEvent && env.DB) {
      await updateSettlementStatus(
        env,
        verifiedPaidEvent.order_id,
        response.ok ? "delivered" : "retry_needed",
      );
    }

    return response;
  },
};
