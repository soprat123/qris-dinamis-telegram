import {
  GatewayError,
  ORDER_STATUSES,
  createAuditId,
  errorResponse,
  findOrder,
  json,
  nowSeconds,
  orderSelect,
  publicOrder,
  transitionPendingAtomic,
  writeAudit,
} from "./internal-gateway-core.js";

function adminOrder(order) {
  return {
    ...publicOrder(order),
    provider: String(order.provider || "internal"),
    reference: String(order.reference || ""),
    customer_id: order.customer_id ? String(order.customer_id) : null,
    customer_name: order.customer_name ? String(order.customer_name) : null,
    username: order.username ? String(order.username) : null,
    email: order.email ? String(order.email) : null,
    approved_by: order.approved_by ? String(order.approved_by) : null,
    settlement_status: String(order.settlement_status || "pending"),
  };
}

async function hmacHex(secret, body) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig), (x) => x.toString(16).padStart(2, "0")).join("");
}

async function internalOrder(env, orderId) {
  const order = await findOrder(env, orderId);
  if (!order) throw new GatewayError("order_not_found", 404);
  if (String(order.provider || "") !== "internal") throw new GatewayError("legacy_order_not_supported", 409);
  return order;
}

async function updateSettlementAtomic(env, order, status, action, metadata = {}) {
  const now = nowSeconds();
  const results = await env.DB.batch([
    env.DB.prepare(
      "UPDATE payment_orders SET settlement_status = ?, updated_at = ? WHERE id = ? AND provider = 'internal' AND status = 'paid'",
    ).bind(status, now, String(order.id)),
    env.DB.prepare(
      `INSERT INTO payment_audit_logs
        (id, order_id, action, old_status, new_status, admin_id, metadata, created_at)
       SELECT ?, ?, ?, 'paid', 'paid', NULL, ?, ? WHERE changes() = 1`,
    ).bind(createAuditId(), String(order.id), action, JSON.stringify({ settlement_status: status, ...metadata }), now),
  ]);
  if (Number(results?.[0]?.meta?.changes ?? 0) !== 1 || Number(results?.[1]?.meta?.changes ?? 0) !== 1) {
    throw new Error("settlement_audit_failed");
  }
}

function destination(env, order) {
  const web = order.source === "aichatapi" || /^web:/i.test(String(order.reference || ""));
  const base = web ? env.AICHATAPI_URL : env.BIKIN_FOTO_URL;
  if (!base || !env.QRIS_INTERNAL_SECRET) throw new Error("internal_forward_not_configured");
  const url = new URL("/internal/payment-paid", base);
  if (url.protocol !== "https:") throw new Error("invalid_payment_destination");
  return url;
}

async function deliver(env, order) {
  const payload = {
    event: "order.paid",
    order_id: String(order.id),
    reference: order.reference ? String(order.reference) : null,
    base_amount: Number(order.base_amount),
    unique_amount: Number(order.unique_amount),
    paid_at: Number(order.paid_at),
  };
  const body = JSON.stringify(payload);
  const response = await fetch(destination(env, order), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-secret": env.QRIS_INTERNAL_SECRET,
      "x-webhook-signature": `sha256=${await hmacHex(env.QRIS_INTERNAL_SECRET, body)}`,
      "x-idempotency-key": String(order.id),
      "x-payment-event": "order.paid",
    },
    body,
    signal: AbortSignal.timeout ? AbortSignal.timeout(10_000) : undefined,
  });
  if (!response.ok) throw new Error(`payment_destination_http_${response.status}`);
}

async function settle(env, order, retried = false) {
  try {
    await updateSettlementAtomic(env, order, "received", retried ? "webhook.retried" : "webhook.received", {
      destination: order.source === "aichatapi" || /^web:/i.test(String(order.reference || "")) ? "aichatapi" : "bikin_foto",
    });
    await deliver(env, order);
    await updateSettlementAtomic(env, order, "delivered", "webhook.delivered");
    return { delivered: true, settlement_status: "delivered" };
  } catch (error) {
    console.error(JSON.stringify({ event: "payment_webhook_delivery_failed", order_id: String(order.id), message: String(error?.message || "failed").slice(0, 160) }));
    await updateSettlementAtomic(env, order, "retry_needed", "webhook.failed", {
      error: String(error?.message || "failed").slice(0, 160),
    });
    return { delivered: false, settlement_status: "retry_needed" };
  }
}

export async function listAdminOrders(env, status = "all") {
  try {
    if (!env.DB) throw new GatewayError("d1_not_bound", 503);
    const normalized = String(status || "all").toLowerCase();
    if (normalized !== "all" && !ORDER_STATUSES.includes(normalized)) throw new GatewayError("invalid_status", 400);
    const query = normalized === "all"
      ? `${orderSelect()} WHERE provider = 'internal' ORDER BY created_at DESC LIMIT 200`
      : `${orderSelect()} WHERE provider = 'internal' AND status = ? ORDER BY created_at DESC LIMIT 200`;
    const result = normalized === "all" ? await env.DB.prepare(query).all() : await env.DB.prepare(query).bind(normalized).all();
    return json({ ok: true, orders: (result?.results || []).map(adminOrder) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function markOrderPaid(env, orderId, adminId) {
  try {
    if (!env.DB) throw new GatewayError("d1_not_bound", 503);
    const order = await internalOrder(env, orderId);
    if (order.status === "paid") throw new GatewayError("order_already_paid", 409, { settlement_status: order.settlement_status });
    if (order.status !== "pending") throw new GatewayError("order_not_pending", 409, { status: order.status });
    const now = nowSeconds();
    if (!Number.isSafeInteger(Number(order.base_amount)) || !Number.isSafeInteger(Number(order.unique_amount)) || Number(order.unique_amount) < Number(order.base_amount)) {
      throw new GatewayError("invalid_order_amount", 409);
    }
    if (order.expires_at != null && Number(order.expires_at) <= now) throw new GatewayError("order_expired", 409);
    const changed = await transitionPendingAtomic(env, {
      orderId,
      newStatus: "paid",
      updateSql: `UPDATE payment_orders
        SET status = 'paid', paid_at = ?, approved_by = ?, settlement_status = 'received', updated_at = ?
        WHERE id = ? AND provider = 'internal' AND status = 'pending' AND (expires_at IS NULL OR expires_at > ?)`,
      updateArgs: [now, String(adminId).slice(0, 120), now, String(orderId), now],
      auditAction: "order.marked_paid",
      adminId,
      metadata: { settlement_status: "received" },
    });
    if (!changed) throw new GatewayError("order_not_pending", 409);
    const paid = await findOrder(env, orderId);
    const settlement = await settle(env, paid, false);
    return json({ ok: true, order: publicOrder((await findOrder(env, orderId)) || paid), settlement });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function retryPaymentWebhook(env, orderId, adminId) {
  try {
    const order = await internalOrder(env, orderId);
    if (order.status !== "paid") throw new GatewayError("order_not_paid", 409);
    if (order.settlement_status === "delivered") {
      return json({ ok: true, order: publicOrder(order), settlement: { delivered: true, settlement_status: "delivered", idempotent: true } });
    }
    const settlement = await settle(env, order, true);
    await writeAudit(env, { orderId, action: "webhook.retry_requested", oldStatus: "paid", newStatus: "paid", adminId, metadata: { settlement_status: settlement.settlement_status } });
    return json({ ok: true, order: publicOrder((await findOrder(env, orderId)) || order), settlement });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function adminCancelOrder(env, orderId, adminId) {
  try {
    const order = await internalOrder(env, orderId);
    if (order.status === "cancelled") return json({ ok: true, order: publicOrder(order), idempotent: true });
    if (order.status === "paid") throw new GatewayError("order_already_paid", 409);
    if (order.status !== "pending") throw new GatewayError("order_not_pending", 409);
    const now = nowSeconds();
    const changed = await transitionPendingAtomic(env, {
      orderId,
      newStatus: "cancelled",
      updateSql: `UPDATE payment_orders SET status = 'cancelled', cancelled_at = ?, updated_at = ?
        WHERE id = ? AND provider = 'internal' AND status = 'pending'`,
      updateArgs: [now, now, String(orderId)],
      auditAction: "order.cancelled",
      adminId,
      metadata: { actor: "admin_dashboard" },
    });
    if (!changed) throw new GatewayError("order_not_pending", 409);
    return json({ ok: true, order: publicOrder((await findOrder(env, orderId)) || order) });
  } catch (error) {
    return errorResponse(error);
  }
}
