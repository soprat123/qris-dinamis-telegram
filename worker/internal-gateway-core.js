const MAX_BODY_BYTES = 64 * 1024;
export const MIN_ORDER_AMOUNT = 1_000;
export const MAX_ORDER_BASE_AMOUNT = 1_000_000;
export const ORDER_STATUSES = ["pending", "paid", "expired", "cancelled", "failed"];

export class GatewayError extends Error {
  constructor(code, status = 400, details = {}) {
    super(code);
    this.name = "GatewayError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function json(data, status = 200) {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function bytes(size) {
  const out = new Uint8Array(size);
  crypto.getRandomValues(out);
  return out;
}

function hex(value) {
  return Array.from(value, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function createPublicOrderId() {
  return `QR-${hex(bytes(12)).toUpperCase()}`;
}

export function createAuditId() {
  return `AUD-${hex(bytes(16)).toUpperCase()}`;
}

function createCancelToken() {
  return hex(bytes(24));
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return hex(new Uint8Array(digest));
}

export async function constantTimeEqual(left, right) {
  if (!left || !right) return false;
  const [aBuf, bBuf] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(left))),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(right))),
  ]);
  const a = new Uint8Array(aBuf);
  const b = new Uint8Array(bBuf);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function readJson(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) throw new GatewayError("payload_too_large", 413);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    throw new GatewayError("payload_too_large", 413);
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new GatewayError("invalid_json", 400);
  }
}

function safeString(value, max) {
  const text = String(value ?? "").trim();
  return text && text.length <= max && !/[\r\n]/.test(text) ? text : "";
}

function optionalString(value, max) {
  return safeString(value, max) || null;
}

export function normalizeOrderInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new GatewayError("invalid_json", 400);
  }
  const base = Number(input.base_amount);
  if (!Number.isSafeInteger(base) || base < MIN_ORDER_AMOUNT || base > MAX_ORDER_BASE_AMOUNT) {
    throw new GatewayError("invalid_amount", 400);
  }
  const reference = safeString(input.reference, 128);
  if (!reference) throw new GatewayError("invalid_reference", 400);
  const source = safeString(input.source || "api", 32).toLowerCase();
  if (!["telegram", "aichatapi", "api"].includes(source)) {
    throw new GatewayError("invalid_source", 400);
  }
  const email = optionalString(input.customer_email ?? input.account_email, 160);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new GatewayError("invalid_email", 400);
  }
  return {
    base_amount: base,
    reference,
    source,
    customer_id: optionalString(input.customer_id ?? input.telegram_id ?? input.account_email, 128),
    customer_name: optionalString(input.customer_name ?? input.account_name ?? input.first_name, 120),
    username: optionalString(input.username, 64)?.replace(/^@/, "") || null,
    email,
  };
}

function bearer(request, name) {
  const direct = request.headers.get(name);
  if (direct) return direct.trim();
  return (request.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
}

export async function authorizeTrustedRequest(request, env) {
  if (await constantTimeEqual(request.headers.get("x-internal-secret"), env.QRIS_INTERNAL_SECRET)) {
    return { type: "internal", id: "internal" };
  }
  const apiKey = bearer(request, "x-api-key");
  if (!apiKey || !env.DB) return null;
  const hash = await sha256Hex(apiKey);
  const row = await env.DB.prepare(
    "SELECT id FROM payment_api_keys WHERE key_hash = ? AND status = 'active' LIMIT 1",
  ).bind(hash).first();
  if (!row?.id) return null;
  await env.DB.prepare(
    "UPDATE payment_api_keys SET last_used_at = ? WHERE id = ? AND status = 'active'",
  ).bind(nowSeconds(), String(row.id)).run();
  return { type: "api_key", id: String(row.id) };
}

export async function authorizeAdminRequest(request, env) {
  if (!env.QRIS_ADMIN_TOKEN) return null;
  const provided = bearer(request, "x-admin-token");
  if (!(await constantTimeEqual(provided, env.QRIS_ADMIN_TOKEN))) return null;
  return { type: "admin_token", id: "admin-token" };
}

export function publicOrder(order) {
  return {
    id: String(order.id),
    source: String(order.source || "api"),
    base_amount: Number(order.base_amount),
    unique_amount: Number(order.unique_amount),
    currency: String(order.currency || "IDR"),
    status: String(order.status),
    checkout_url: order.checkout_url ? String(order.checkout_url) : null,
    expires_at: order.expires_at == null ? null : Number(order.expires_at),
    paid_at: order.paid_at == null ? null : Number(order.paid_at),
    cancelled_at: order.cancelled_at == null ? null : Number(order.cancelled_at),
    created_at: Number(order.created_at),
    updated_at: Number(order.updated_at),
  };
}

export function orderSelect() {
  return `SELECT id, reference, provider, source, customer_id, customer_name,
    user_id, username, email, base_amount, unique_amount, currency, status,
    qris_payload, checkout_url, expires_at, paid_at, cancelled_at, approved_by,
    settlement_status, created_at, updated_at, cancel_token_hash
    FROM payment_orders`;
}

export async function findOrder(env, orderId) {
  return env.DB.prepare(`${orderSelect()} WHERE id = ? LIMIT 1`).bind(String(orderId)).first();
}

async function activeLegacyAmount(env, amount, now) {
  return env.DB.prepare(
    `SELECT id FROM payment_orders WHERE unique_amount = ? AND status = 'pending'
     AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`,
  ).bind(amount, now).first();
}

function randomInt(maxExclusive) {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 1) return 0;
  const b = bytes(2);
  return (b[0] * 256 + b[1]) % maxExclusive;
}

export async function reserveUniqueAmount(env, baseAmount, orderId, expiresAt, now = nowSeconds()) {
  const maxSuffix = Math.min(999, Math.max(0, MAX_ORDER_BASE_AMOUNT - baseAmount));
  const candidateCount = maxSuffix + 1;
  const attempts = Math.min(candidateCount, 100);
  const start = randomInt(candidateCount);

  await env.DB.prepare("DELETE FROM payment_pending_amounts WHERE expires_at <= ?").bind(now).run();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const candidate = baseAmount + ((start + attempt) % candidateCount);
    if (await activeLegacyAmount(env, candidate, now)) continue;
    try {
      await env.DB.prepare(
        `INSERT INTO payment_pending_amounts (unique_amount, order_id, expires_at, created_at)
         VALUES (?, ?, ?, ?)`,
      ).bind(candidate, orderId, expiresAt, now).run();
      return candidate;
    } catch (error) {
      if (attempt === attempts - 1) {
        throw new GatewayError("unique_amount_unavailable", 503, { cause: error?.message || "collision" });
      }
    }
  }
  throw new GatewayError("unique_amount_unavailable", 503);
}

export async function releaseReservation(env, orderId) {
  await env.DB.prepare("DELETE FROM payment_pending_amounts WHERE order_id = ?")
    .bind(String(orderId)).run();
}

export async function writeAudit(env, { orderId, action, oldStatus = null, newStatus = null, adminId = null, metadata = null }) {
  await env.DB.prepare(
    `INSERT INTO payment_audit_logs
      (id, order_id, action, old_status, new_status, admin_id, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    createAuditId(), String(orderId), String(action), oldStatus, newStatus,
    adminId ? String(adminId).slice(0, 120) : null,
    metadata == null ? null : JSON.stringify(metadata), nowSeconds(),
  ).run();
}

export async function transitionPendingAtomic(env, { orderId, newStatus, updateSql, updateArgs, auditAction, adminId = null, metadata = null }) {
  if (typeof env.DB.batch !== "function") throw new Error("d1_batch_required_for_atomic_transition");
  const auditId = createAuditId();
  const timestamp = nowSeconds();
  const results = await env.DB.batch([
    env.DB.prepare(updateSql).bind(...updateArgs),
    env.DB.prepare(
      `INSERT INTO payment_audit_logs
        (id, order_id, action, old_status, new_status, admin_id, metadata, created_at)
       SELECT ?, ?, ?, 'pending', ?, ?, ?, ? WHERE changes() = 1`,
    ).bind(
      auditId, String(orderId), auditAction, newStatus,
      adminId ? String(adminId).slice(0, 120) : null,
      metadata == null ? null : JSON.stringify(metadata), timestamp,
    ),
    env.DB.prepare("DELETE FROM payment_pending_amounts WHERE order_id = ?").bind(String(orderId)),
  ]);
  const changed = Number(results?.[0]?.meta?.changes ?? 0);
  if (changed !== 1) return false;
  if (Number(results?.[1]?.meta?.changes ?? 0) !== 1) throw new Error("audit_write_failed");
  return true;
}

function ttlSeconds(env) {
  const n = Number(env.INTERNAL_ORDER_TTL_SECONDS || 900);
  return Number.isSafeInteger(n) ? Math.min(Math.max(n, 60), 86_400) : 900;
}

export async function createInternalOrder(request, env, buildDynamicQris) {
  try {
    const actor = await authorizeTrustedRequest(request, env);
    if (!actor) throw new GatewayError("unauthorized", 401);
    if (!env.DB) throw new GatewayError("d1_not_bound", 503);
    if (!env.QRIS_STATIC_PAYLOAD) throw new GatewayError("server_not_configured", 500);
    const input = normalizeOrderInput(await readJson(request));
    const duplicate = await env.DB.prepare(
      "SELECT id FROM payment_orders WHERE reference = ? AND provider = 'internal' LIMIT 1",
    ).bind(input.reference).first();
    if (duplicate?.id) throw new GatewayError("duplicate_reference", 409, { order_id: String(duplicate.id) });

    const now = nowSeconds();
    const ttl = ttlSeconds(env);
    const expiresAt = now + ttl;
    const orderId = createPublicOrderId();
    const cancelToken = createCancelToken();
    const cancelHash = await sha256Hex(cancelToken);
    const uniqueAmount = await reserveUniqueAmount(env, input.base_amount, orderId, expiresAt, now);
    let qrisPayload;
    try {
      qrisPayload = await buildDynamicQris(String(env.QRIS_STATIC_PAYLOAD).trim(), uniqueAmount);
    } catch (error) {
      await releaseReservation(env, orderId);
      throw new GatewayError(error?.message === "invalid_amount" ? "invalid_amount" : "invalid_static_qris", error?.message === "invalid_amount" ? 400 : 500);
    }
    const checkoutUrl = new URL(`/pay/${encodeURIComponent(orderId)}`, request.url).toString();
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO payment_orders
            (id, reference, provider, source, customer_id, customer_name, user_id, username, email,
             base_amount, unique_amount, currency, status, qris_payload, checkout_url, expires_at,
             paid_at, cancelled_at, approved_by, settlement_status, created_at, updated_at, cancel_token_hash)
           VALUES (?, ?, 'internal', ?, ?, ?, ?, ?, ?, ?, ?, 'IDR', 'pending', ?, ?, ?, NULL, NULL, NULL, 'pending', ?, ?, ?)`,
        ).bind(
          orderId, input.reference, input.source, input.customer_id, input.customer_name,
          input.customer_id, input.username, input.email, input.base_amount, uniqueAmount,
          qrisPayload, checkoutUrl, expiresAt, now, now, cancelHash,
        ),
        env.DB.prepare(
          `INSERT INTO payment_audit_logs
            (id, order_id, action, old_status, new_status, admin_id, metadata, created_at)
           VALUES (?, ?, 'order.created', NULL, 'pending', ?, ?, ?)`,
        ).bind(createAuditId(), orderId, actor.id, JSON.stringify({ source: input.source, actor: actor.type }), now),
      ]);
    } catch (error) {
      await releaseReservation(env, orderId);
      throw error;
    }
    return json({
      ok: true,
      order: { id: orderId, provider: "internal", reference: input.reference, source: input.source,
        base_amount: input.base_amount, unique_amount: uniqueAmount, currency: "IDR", status: "pending",
        checkout_url: checkoutUrl, expires_at: expiresAt, expires_in: ttl, paid_at: null,
        cancelled_at: null, created_at: now, updated_at: now },
      cancel_token: cancelToken,
    }, 201);
  } catch (error) {
    return errorResponse(error);
  }
}

async function expireOne(env, order, now = nowSeconds()) {
  if (!order || order.provider !== "internal" || order.status !== "pending" || order.expires_at == null || Number(order.expires_at) > now) return false;
  return transitionPendingAtomic(env, {
    orderId: order.id,
    newStatus: "expired",
    updateSql: `UPDATE payment_orders SET status = 'expired', updated_at = ?
      WHERE id = ? AND provider = 'internal' AND status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`,
    updateArgs: [now, String(order.id), now],
    auditAction: "order.expired",
    metadata: { reason: "ttl_elapsed" },
  });
}

export async function getPublicOrder(_request, env, orderId) {
  try {
    if (!env.DB) throw new GatewayError("d1_not_bound", 503);
    const order = await findOrder(env, orderId);
    if (!order) throw new GatewayError("order_not_found", 404);
    if (order.provider !== "internal") throw new GatewayError("legacy_order_not_supported", 409);
    await expireOne(env, order);
    return json({ ok: true, order: publicOrder((await findOrder(env, orderId)) || order) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function getOrderQrisPayload(env, orderId) {
  if (!env.DB) throw new GatewayError("d1_not_bound", 503);
  const row = await env.DB.prepare(
    "SELECT id, status, qris_payload FROM payment_orders WHERE id = ? AND provider = 'internal' LIMIT 1",
  ).bind(String(orderId)).first();
  if (!row) throw new GatewayError("order_not_found", 404);
  if (!row.qris_payload) throw new GatewayError("qris_not_available", 404);
  return { id: String(row.id), status: String(row.status), payload: String(row.qris_payload) };
}

export async function cancelOrder(request, env, orderId) {
  try {
    if (!env.DB) throw new GatewayError("d1_not_bound", 503);
    const input = await readJson(request);
    const trusted = await authorizeTrustedRequest(request, env);
    const order = await findOrder(env, orderId);
    if (!order) throw new GatewayError("order_not_found", 404);
    if (order.provider !== "internal") throw new GatewayError("legacy_order_not_supported", 409);
    if (order.status === "cancelled") return json({ ok: true, order: publicOrder(order), idempotent: true });
    if (order.status === "paid") throw new GatewayError("order_already_paid", 409);
    if (order.status !== "pending") throw new GatewayError("order_not_pending", 409);
    const now = nowSeconds();
    if (order.expires_at != null && Number(order.expires_at) <= now) {
      await expireOne(env, order, now);
      throw new GatewayError("order_expired", 409);
    }
    if (!trusted) {
      const provided = request.headers.get("x-order-cancel-token") || input.cancel_token || "";
      if (!order.cancel_token_hash || !(await constantTimeEqual(await sha256Hex(provided), order.cancel_token_hash))) {
        throw new GatewayError("unauthorized", 401);
      }
    }
    const changed = await transitionPendingAtomic(env, {
      orderId,
      newStatus: "cancelled",
      updateSql: `UPDATE payment_orders SET status = 'cancelled', cancelled_at = ?, updated_at = ?
        WHERE id = ? AND provider = 'internal' AND status = 'pending'`,
      updateArgs: [now, now, String(orderId)],
      auditAction: "order.cancelled",
      adminId: trusted?.id || null,
      metadata: { actor: trusted?.type || "cancel_token" },
    });
    if (!changed) throw new GatewayError("order_not_pending", 409);
    return json({ ok: true, order: publicOrder((await findOrder(env, orderId)) || order) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function expirePendingOrders(env, now = nowSeconds(), limit = 100) {
  if (!env.DB) return { expired: 0, skipped: true };
  const rows = await env.DB.prepare(
    `${orderSelect()} WHERE provider = 'internal' AND status = 'pending' AND expires_at IS NOT NULL
      AND expires_at <= ? ORDER BY expires_at ASC LIMIT ?`,
  ).bind(now, Math.min(Math.max(Number(limit) || 100, 1), 500)).all();
  let expired = 0;
  for (const order of rows?.results || []) if (await expireOne(env, order, now)) expired += 1;
  return { expired };
}

export function errorResponse(error) {
  if (error instanceof GatewayError) return json({ ok: false, error: error.code, ...error.details }, error.status);
  console.error(JSON.stringify({ event: "internal_gateway_error", message: error?.message || "unknown_error" }));
  return json({ ok: false, error: "database_or_gateway_failure" }, 502);
}
