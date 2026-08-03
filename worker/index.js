const MAX_WEBHOOK_BYTES = 64 * 1024;

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function readBodyLimited(request) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_WEBHOOK_BYTES) throw new Error("payload_too_large");

  const reader = request.body?.getReader();
  if (!reader) return "";

  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_WEBHOOK_BYTES) {
      await reader.cancel();
      throw new Error("payload_too_large");
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function hexToBytes(value) {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  return Uint8Array.from(value.match(/.{2}/g), (byte) => Number.parseInt(byte, 16));
}

export async function verifyGatePaySignature(rawBody, signature, secret) {
  const signatureBytes = hexToBytes(signature || "");
  if (!signatureBytes || !secret) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, signatureBytes, encoder.encode(rawBody));
}

export async function verifyInternalSecret(provided, expected) {
  if (!provided || !expected) return false;
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(providedHash);
  const right = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function formatRupiah(value) {
  return new Intl.NumberFormat("id-ID").format(Number(value));
}

function formatPaidAt(unixSeconds) {
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(Number(unixSeconds) * 1000));
}

export function formatTelegramMessage(event) {
  const reference = event.reference ? String(event.reference) : "-";
  return [
    "✅ Transaksi QRIS berhasil",
    "",
    `Order: ${String(event.order_id)}`,
    `Referensi: ${reference}`,
    `Nominal: Rp${formatRupiah(event.unique_amount)}`,
    `Nominal dasar: Rp${formatRupiah(event.base_amount)}`,
    `Waktu: ${formatPaidAt(event.paid_at)} WIB`,
  ].join("\n");
}

async function sendTelegramMessage(env, message) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.ADMIN_TELEGRAM_ID, text: message }),
  });
  if (!response.ok) throw new Error(`telegram_http_${response.status}`);

  const result = await response.json();
  if (!result.ok) throw new Error("telegram_rejected_message");
}

async function createGatePayOrder(request, env) {
  if (!env.GATEPAY_API_KEY || !env.QRIS_INTERNAL_SECRET) {
    return json({ ok: false, error: "server_not_configured" }, 500);
  }
  if (!(await verifyInternalSecret(request.headers.get("x-internal-secret"), env.QRIS_INTERNAL_SECRET))) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let input;
  try {
    input = JSON.parse(await readBodyLimited(request));
  } catch (error) {
    if (error.message === "payload_too_large") return json({ ok: false, error: "payload_too_large" }, 413);
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const amount = Number(input.base_amount);
  const reference = String(input.reference || "");
  if (!Number.isSafeInteger(amount) || amount < 1_000 || amount > 1_000_000) {
    return json({ ok: false, error: "invalid_amount" }, 400);
  }
  if (!/^deposit:\d+:\d+$/.test(reference)) {
    return json({ ok: false, error: "invalid_reference" }, 400);
  }

  const gatePayResponse = await fetch("https://gatepay.biz.id/api/orders", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.GATEPAY_API_KEY,
    },
    body: JSON.stringify({ base_amount: amount, reference, ttl_seconds: 900 }),
  });
  let gatePayOrder;
  try {
    gatePayOrder = await gatePayResponse.json();
  } catch {
    gatePayOrder = {};
  }
  if (!gatePayResponse.ok || !gatePayOrder.id || !gatePayOrder.checkout_url) {
    const upstreamMessage = String(
      gatePayOrder.error || gatePayOrder.message || gatePayOrder.detail || "",
    ).slice(0, 300);
    console.error(
      JSON.stringify({
        event: "gatepay_create_order_failed",
        status: gatePayResponse.status,
        upstream_message: upstreamMessage || null,
      }),
    );
    return json(
      {
        ok: false,
        error: "gatepay_order_failed",
        upstream_status: gatePayResponse.status,
        upstream_message: upstreamMessage || null,
      },
      502,
    );
  }

  const order = {
    id: String(gatePayOrder.id),
    status: String(gatePayOrder.status || "pending"),
    base_amount: Number(gatePayOrder.base_amount || amount),
    unique_amount: Number(gatePayOrder.unique_amount || amount),
    checkout_url: String(gatePayOrder.checkout_url),
    expires_in: Number(gatePayOrder.expires_in || 900),
  };

  if (env.TELEGRAM_BOT_TOKEN && env.ADMIN_TELEGRAM_ID) {
    try {
      await sendTelegramMessage(
        env,
        [
          "🟡 Transaksi QRIS pending",
          "",
          `Order: ${order.id}`,
          `Referensi: ${reference}`,
          `Nominal saldo: Rp${formatRupiah(order.base_amount)}`,
          `Total pembayaran: Rp${formatRupiah(order.unique_amount)}`,
          `Checkout: ${order.checkout_url}`,
        ].join("\n"),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "gatepay_order_pending_notification_failed",
          order_id: order.id,
          message: error.message,
        }),
      );
    }
  }

  return json({ ok: true, order });
}

async function forwardPaidEvent(env, event) {
  if (!env.BIKIN_FOTO_URL || !env.QRIS_INTERNAL_SECRET) throw new Error("internal_forward_not_configured");
  const target = new URL("/internal/payment-paid", env.BIKIN_FOTO_URL);
  if (target.protocol !== "https:") throw new Error("invalid_bikin_foto_url");

  const response = await fetch(target, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-secret": env.QRIS_INTERNAL_SECRET,
    },
    body: JSON.stringify({
      event: "order.paid",
      order_id: String(event.order_id),
      reference: event.reference ? String(event.reference) : null,
      base_amount: Number(event.base_amount),
      unique_amount: Number(event.unique_amount),
      paid_at: Number(event.paid_at),
    }),
  });
  if (!response.ok) throw new Error(`bikin_foto_http_${response.status}`);
}

async function handleGatePayWebhook(request, env) {
  if (!env.GATEPAY_CALLBACK_SECRET || !env.TELEGRAM_BOT_TOKEN || !env.ADMIN_TELEGRAM_ID) {
    console.error(JSON.stringify({ event: "missing_required_secret" }));
    return json({ ok: false, error: "server_not_configured" }, 500);
  }

  let rawBody;
  try {
    rawBody = await readBodyLimited(request);
  } catch (error) {
    if (error.message === "payload_too_large") return json({ ok: false, error: "payload_too_large" }, 413);
    throw error;
  }

  const signature = request.headers.get("x-signature");
  if (!(await verifyGatePaySignature(rawBody, signature, env.GATEPAY_CALLBACK_SECRET))) {
    return json({ ok: false, error: "invalid_signature" }, 401);
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  if (event.event !== "order.paid") return json({ ok: true, ignored: true });
  if (!event.order_id || !Number.isFinite(Number(event.unique_amount)) || !Number.isFinite(Number(event.paid_at))) {
    return json({ ok: false, error: "invalid_event" }, 400);
  }

  await forwardPaidEvent(env, event);
  await sendTelegramMessage(env, formatTelegramMessage(event));
  console.log(JSON.stringify({ event: "gatepay_order_paid_notified", order_id: String(event.order_id) }));
  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, service: "qris-dinamis-telegram" });
    }

    if (url.pathname === "/webhook/gatepay") {
      if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
      try {
        return await handleGatePayWebhook(request, env);
      } catch (error) {
        console.error(JSON.stringify({ event: "gatepay_webhook_failed", message: error.message }));
        return json({ ok: false, error: "notification_failed" }, 502);
      }
    }

    if (url.pathname === "/internal/orders") {
      if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
      try {
        return await createGatePayOrder(request, env);
      } catch (error) {
        console.error(JSON.stringify({ event: "internal_order_failed", message: error.message }));
        return json({ ok: false, error: "order_failed" }, 502);
      }
    }

    return env.ASSETS.fetch(request);
  },
};
