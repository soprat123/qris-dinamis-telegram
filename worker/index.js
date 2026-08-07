import QRCode from "qrcode";

const MAX_WEBHOOK_BYTES = 64 * 1024;
const MIN_QRIS_AMOUNT = 1_000;
const MAX_QRIS_AMOUNT = 1_000_000;

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

function parseTLV(payload) {
  const items = [];
  let offset = 0;

  while (offset < payload.length) {
    if (offset + 4 > payload.length) throw new Error("invalid_qris_payload");
    const tag = payload.slice(offset, offset + 2);
    const lengthText = payload.slice(offset + 2, offset + 4);
    if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(lengthText)) {
      throw new Error("invalid_qris_payload");
    }

    const valueStart = offset + 4;
    const valueEnd = valueStart + Number(lengthText);
    if (valueEnd > payload.length) throw new Error("invalid_qris_payload");
    items.push({ tag, value: payload.slice(valueStart, valueEnd) });
    offset = valueEnd;
  }

  return items;
}

function encodeTLV(tag, value) {
  const text = String(value);
  if (text.length > 99) throw new Error("invalid_qris_payload");
  return tag + String(text.length).padStart(2, "0") + text;
}

function crc16(text) {
  let crc = 0xffff;
  for (let index = 0; index < text.length; index += 1) {
    crc ^= text.charCodeAt(index) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function validateQRIS(payload) {
  const normalized = String(payload || "").trim();
  const items = parseTLV(normalized);
  const crcItem = items.at(-1);
  if (!items.some((item) => item.tag === "00" && item.value === "01")) {
    throw new Error("invalid_qris_payload");
  }
  if (!crcItem || crcItem.tag !== "63" || crcItem.value.length !== 4) {
    throw new Error("invalid_qris_payload");
  }
  if (crc16(normalized.slice(0, -4)) !== crcItem.value.toUpperCase()) {
    throw new Error("invalid_qris_payload");
  }
  return items;
}

export function convertToDynamic(payload, amount) {
  if (!Number.isSafeInteger(amount) || amount < MIN_QRIS_AMOUNT || amount > MAX_QRIS_AMOUNT) {
    throw new Error("invalid_amount");
  }

  const items = validateQRIS(payload)
    .filter((item) => !["54", "63"].includes(item.tag))
    .map((item) => item.tag === "01" ? { ...item, value: "12" } : item);
  if (!items.some((item) => item.tag === "01")) {
    items.splice(1, 0, { tag: "01", value: "12" });
  }

  const insertAt = items.findIndex((item) => Number(item.tag) > 54);
  items.splice(insertAt === -1 ? items.length : insertAt, 0, {
    tag: "54",
    value: String(amount),
  });
  const body = items.map(({ tag, value }) => encodeTLV(tag, value)).join("") + "6304";
  return body + crc16(body);
}

async function authorizeQrisApi(request, env) {
  const authorization = request.headers.get("authorization") || "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  const provided = bearer || request.headers.get("x-api-key");
  return verifyInternalSecret(provided, env.QRIS_API_KEY);
}

function uint32(value) {
  return Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

function concatBytes(...parts) {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = new Uint8Array()) {
  const typeBytes = new TextEncoder().encode(type);
  const body = concatBytes(typeBytes, data);
  return concatBytes(uint32(data.length), body, uint32(crc32(body)));
}

async function deflate(bytes) {
  const compressed = new Blob([bytes])
    .stream()
    .pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}

export async function renderQrisPng(payload) {
  const qr = QRCode.create(payload, { errorCorrectionLevel: "M" });
  const moduleCount = qr.modules.size;
  const margin = 4;
  const scale = 8;
  const width = (moduleCount + margin * 2) * scale;
  const rows = new Uint8Array((width + 1) * width);
  rows.fill(255);

  for (let y = 0; y < width; y += 1) {
    const rowStart = y * (width + 1);
    rows[rowStart] = 0;
    const moduleY = Math.floor(y / scale) - margin;
    if (moduleY < 0 || moduleY >= moduleCount) continue;

    for (let x = 0; x < width; x += 1) {
      const moduleX = Math.floor(x / scale) - margin;
      if (
        moduleX >= 0 &&
        moduleX < moduleCount &&
        qr.modules.get(moduleX, moduleY)
      ) {
        rows[rowStart + x + 1] = 0;
      }
    }
  }

  const ihdr = new Uint8Array(13);
  ihdr.set(uint32(width), 0);
  ihdr.set(uint32(width), 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const signature = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
  return concatBytes(
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", await deflate(rows)),
    pngChunk("IEND"),
  );
}

async function handleQrisApi(request, env, dynamic) {
  if (!env.QRIS_API_KEY || !env.QRIS_STATIC_PAYLOAD) {
    return json({ ok: false, error: "server_not_configured" }, 500);
  }
  if (!(await authorizeQrisApi(request, env))) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let payload = String(env.QRIS_STATIC_PAYLOAD).trim();
  try {
    validateQRIS(payload);
  } catch {
    return json({ ok: false, error: "invalid_static_qris" }, 500);
  }

  let amount = null;
  if (dynamic) {
    let input;
    try {
      input = JSON.parse(await readBodyLimited(request));
    } catch (error) {
      if (error.message === "payload_too_large") return json({ ok: false, error: "payload_too_large" }, 413);
      return json({ ok: false, error: "invalid_json" }, 400);
    }
    amount = Number(input.amount);
    try {
      payload = convertToDynamic(payload, amount);
    } catch (error) {
      if (error.message === "invalid_amount") return json({ ok: false, error: "invalid_amount" }, 400);
      return json({ ok: false, error: "invalid_static_qris" }, 500);
    }
  }

  const png = await renderQrisPng(payload);
  return new Response(png, {
    headers: {
      "content-type": "image/png",
      "content-disposition": `inline; filename="qris-${dynamic ? amount : "statis"}.png"`,
      "cache-control": "no-store",
      "x-qris-type": dynamic ? "dynamic" : "static",
      ...(dynamic ? { "x-qris-amount": String(amount) } : {}),
    },
  });
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

export function formatTelegramMessage(event, settlement = {}) {
  const reference = event.reference ? String(event.reference) : "-";
  const user = settlement.user || {};
  const username = user.username ? `@${String(user.username).replace(/^@/, "")}` : "-";
  const telegramId = user.telegram_id ? String(user.telegram_id) : "-";
  return [
    "✅ Transaksi QRIS berhasil",
    "",
    `Username: ${username}`,
    `ID Telegram: ${telegramId}`,
    `Order: ${String(event.order_id)}`,
    `Referensi: ${reference}`,
    `Nominal: Rp${formatRupiah(event.unique_amount)}`,
    `Nominal dasar: Rp${formatRupiah(event.base_amount)}`,
    `Waktu: ${formatPaidAt(event.paid_at)} WIB`,
  ].join("\n");
}

function getAdminTelegramIds(env) {
  return [...new Set(
    [env.ADMIN_TELEGRAM_ID, env.ADMIN2_TELEGRAM_ID]
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  )];
}

async function sendTelegramMessage(env, message) {
  const chatIds = getAdminTelegramIds(env);
  if (!chatIds.length) throw new Error("telegram_admin_not_configured");

  const results = await Promise.allSettled(
    chatIds.map(async (chatId) => {
      const response = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: message }),
        },
      );
      if (!response.ok) throw new Error(`telegram_http_${response.status}`);

      const result = await response.json();
      if (!result.ok) throw new Error("telegram_rejected_message");
      return chatId;
    }),
  );

  const delivered = results.filter((result) => result.status === "fulfilled").length;
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error(
        JSON.stringify({
          event: "telegram_admin_notification_failed",
          chat_id: chatIds[index],
          message: result.reason?.message || "unknown_error",
        }),
      );
    }
  });
  if (!delivered) throw new Error("telegram_all_admin_notifications_failed");
}

async function handleManualTopupNotification(request, env) {
  if (
    !env.QRIS_INTERNAL_SECRET ||
    !env.TELEGRAM_BOT_TOKEN ||
    !getAdminTelegramIds(env).length
  ) {
    return json({ ok: false, error: "server_not_configured" }, 500);
  }
  if (!(await verifyInternalSecret(
    request.headers.get("x-internal-secret"),
    env.QRIS_INTERNAL_SECRET,
  ))) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let input;
  try {
    input = JSON.parse(await readBodyLimited(request));
  } catch (error) {
    if (error.message === "payload_too_large") {
      return json({ ok: false, error: "payload_too_large" }, 413);
    }
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const amount = Number(input.amount);
  const telegramId = String(input.telegram_id || "").slice(0, 32);
  const orderId = String(input.order_id || "").slice(0, 32);
  const username = String(input.username || "")
    .replace(/^@/, "")
    .replace(/[^a-zA-Z0-9_]/g, "")
    .slice(0, 32);
  const firstName = String(input.first_name || "").replace(/[\r\n]/g, " ").slice(0, 80);
  if (
    !Number.isSafeInteger(amount) ||
    amount < MIN_QRIS_AMOUNT ||
    amount > MAX_QRIS_AMOUNT ||
    !/^\d{1,32}$/.test(telegramId) ||
    !/^\d{1,32}$/.test(orderId)
  ) {
    return json({ ok: false, error: "invalid_notification" }, 400);
  }

  await sendTelegramMessage(
    env,
    [
      "🟡 PERIKSA PEMBAYARAN MANUAL",
      "",
      `Pengguna: ${firstName || "-"}`,
      `Username: ${username ? `@${username}` : "-"}`,
      `ID Telegram: ${telegramId}`,
      `Order ID: #${orderId}`,
      `Nominal: Rp${formatRupiah(amount)}`,
      "",
      "Periksa mutasi merchant. Jika pembayaran masuk, tambahkan saldo menggunakan command admin.",
    ].join("\n"),
  );
  console.log(JSON.stringify({
    event: "manual_topup_notification_sent",
    order_id: orderId,
    telegram_id: telegramId,
  }));
  return json({ ok: true });
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
  const username = String(input.username || "").replace(/^@/, "").slice(0, 64);
  const firstName = String(input.first_name || "").slice(0, 80);
  const telegramId = String(input.telegram_id || "").slice(0, 32);
  const displayUser = username ? `@${username}` : (firstName || "-");
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

  if (env.TELEGRAM_BOT_TOKEN && getAdminTelegramIds(env).length) {
    try {
      await sendTelegramMessage(
        env,
        [
          "🟡 Transaksi QRIS pending",
          "",
          `Pengguna: ${displayUser}`,
          `ID Telegram: ${telegramId || "-"}`,
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
  let result = {};
  try {
    result = await response.json();
  } catch {
    // Status HTTP tetap diperiksa di bawah.
  }
  if (!response.ok) throw new Error(`bikin_foto_http_${response.status}`);
  return result;
}

async function handleGatePayWebhook(request, env) {
  if (
    !env.GATEPAY_CALLBACK_SECRET ||
    !env.TELEGRAM_BOT_TOKEN ||
    !getAdminTelegramIds(env).length
  ) {
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

  const settlement = await forwardPaidEvent(env, event);
  await sendTelegramMessage(env, formatTelegramMessage(event, settlement));
  console.log(JSON.stringify({ event: "gatepay_order_paid_notified", order_id: String(event.order_id) }));
  return json({ ok: true });
}

async function telegramWebhookSecret(env) {
  const bytes = new TextEncoder().encode(String(env.QRIS_INTERNAL_SECRET || ""));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function sendTelegramToChat(env, chatId, text, replyMarkup) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
    },
  );
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(result.description || `telegram_http_${response.status}`);
  }
  return result;
}

function parseCreditAmount(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/^rp\s*/, "");
  const amount = raw.endsWith("k")
    ? Math.round(Number(raw.slice(0, -1).replace(",", ".")) * 1000)
    : Number(raw.replace(/[.,\s]/g, ""));
  return Number.isSafeInteger(amount) && amount > 0 && amount <= 1_000_000_000
    ? amount
    : 0;
}

function rupiah(value) {
  return `Rp${Number(value || 0).toLocaleString("id-ID")}`;
}

function userLabel(user) {
  if (user?.username) return `@${user.username}`;
  return user?.first_name || `ID ${user?.telegram_id || "-"}`;
}

async function callBikinFotoAdmin(env, payload) {
  if (!env.BIKIN_FOTO_URL || !env.QRIS_INTERNAL_SECRET) {
    throw new Error("internal_admin_not_configured");
  }
  const target = new URL("/internal/admin-command", env.BIKIN_FOTO_URL);
  const response = await fetch(target, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-secret": env.QRIS_INTERNAL_SECRET,
    },
    body: JSON.stringify(payload),
  });
  let result = {};
  try {
    result = await response.json();
  } catch {
    throw new Error(`bikin_foto_invalid_response_${response.status}`);
  }
  if (!response.ok || !result.ok) {
    const error = new Error(result.error || `bikin_foto_http_${response.status}`);
    error.result = result;
    throw error;
  }
  return result;
}

const ADMIN_MENU = {
  keyboard: [
    [{ text: "/addcredit" }, { text: "/minuscredit" }],
    [{ text: "/blokir" }, { text: "/start" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

const FORCE_REPLY = { force_reply: true, selective: true };

async function executeAdminCommand(env, chatId, adminId, action, target, amount) {
  try {
    const result = await callBikinFotoAdmin(env, {
      action,
      target,
      amount,
      admin_id: adminId,
    });
    const user = result.user;
    const messages = {
      addcredit: `✅ SALDO DITAMBAHKAN\n\nUser: ${userLabel(user)}\nID: ${user.telegram_id}\nNominal: ${rupiah(amount)}\nSaldo sekarang: ${rupiah(user.balance)}`,
      minuscredit: `✅ SALDO DIKURANGI\n\nUser: ${userLabel(user)}\nID: ${user.telegram_id}\nNominal: ${rupiah(amount)}\nSaldo sekarang: ${rupiah(user.balance)}`,
      blokir: `⛔ USER DIBLOKIR\n\nUser: ${userLabel(user)}\nID: ${user.telegram_id}`,
    };
    await sendTelegramToChat(env, chatId, messages[action], ADMIN_MENU);
  } catch (error) {
    const labels = {
      user_not_found: "User tidak ditemukan. User harus pernah membuka bot Bikin Foto.",
      invalid_amount: "Nominal tidak valid.",
      insufficient_balance: `Saldo user tidak cukup. Saldo saat ini: ${rupiah(error.result?.user?.balance)}`,
      unauthorized: "Koneksi internal ditolak. Periksa QRIS_INTERNAL_SECRET.",
    };
    await sendTelegramToChat(
      env,
      chatId,
      `⚠️ ${labels[error.message] || `Perintah gagal: ${error.message}`}`,
      ADMIN_MENU,
    );
  }
}

async function handleTelegramAdminWebhook(request, env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.QRIS_INTERNAL_SECRET) {
    return json({ ok: false, error: "server_not_configured" }, 500);
  }
  const expectedSecret = await telegramWebhookSecret(env);
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== expectedSecret) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  const message = update.message;
  if (!message?.chat?.id || !message.from?.id) return json({ ok: true, ignored: true });

  const chatId = message.chat.id;
  const adminId = String(message.from.id);
  if (!getAdminTelegramIds(env).includes(adminId)) {
    await sendTelegramToChat(env, chatId, "⛔ Bot ini hanya dapat digunakan admin.");
    return json({ ok: true });
  }

  const text = String(message.text || "").trim();
  const replyText = String(message.reply_to_message?.text || "");
  const parts = text.split(/\s+/);
  const command = parts[0].split("@")[0].toLowerCase();

  if (command === "/start") {
    await sendTelegramToChat(
      env,
      chatId,
      "🛠 BOT ADMIN TRANSAKSI QRIS\n\n/addcredit — tambah saldo\n/minuscredit — kurangi saldo\n/blokir — blokir user\n\nCommand juga dapat ditulis langsung, contoh:\n/addcredit @username 10000",
      ADMIN_MENU,
    );
    return json({ ok: true });
  }

  if (["/addcredit", "/minuscredit"].includes(command)) {
    const action = command.slice(1);
    if (parts[1] && parts[2]) {
      const amount = parseCreditAmount(parts[2]);
      if (!amount) {
        await sendTelegramToChat(env, chatId, "Nominal tidak valid.", ADMIN_MENU);
      } else {
        await executeAdminCommand(env, chatId, adminId, action, parts[1], amount);
      }
      return json({ ok: true });
    }
    const title = action === "addcredit" ? "ADD CREDIT" : "MINUS CREDIT";
    await sendTelegramToChat(
      env,
      chatId,
      `${title}\n\nBalas pesan ini dengan @username atau ID Telegram user.`,
      FORCE_REPLY,
    );
    return json({ ok: true });
  }

  if (command === "/blokir") {
    if (parts[1]) {
      await executeAdminCommand(env, chatId, adminId, "blokir", parts[1]);
    } else {
      await sendTelegramToChat(
        env,
        chatId,
        "BLOKIR USER\n\nBalas pesan ini dengan @username atau ID Telegram user.",
        FORCE_REPLY,
      );
    }
    return json({ ok: true });
  }

  if (replyText.startsWith("ADD CREDIT") || replyText.startsWith("MINUS CREDIT")) {
    const isAmountStep = replyText.includes("\nTarget: ");
    const action = replyText.startsWith("ADD CREDIT") ? "addcredit" : "minuscredit";
    const title = action === "addcredit" ? "ADD CREDIT" : "MINUS CREDIT";
    if (!isAmountStep) {
      if (!text) return json({ ok: true });
      await sendTelegramToChat(
        env,
        chatId,
        `${title}\nTarget: ${text}\n\nBalas pesan ini dengan nominal saldo.`,
        FORCE_REPLY,
      );
    } else {
      const target = replyText.match(/\nTarget: ([^\n]+)/)?.[1] || "";
      const amount = parseCreditAmount(text);
      if (!amount) {
        await sendTelegramToChat(env, chatId, "Nominal tidak valid. Ulangi command.", ADMIN_MENU);
      } else {
        await executeAdminCommand(env, chatId, adminId, action, target, amount);
      }
    }
    return json({ ok: true });
  }

  if (replyText.startsWith("BLOKIR USER")) {
    if (text) await executeAdminCommand(env, chatId, adminId, "blokir", text);
    return json({ ok: true });
  }

  await sendTelegramToChat(env, chatId, "Command tidak dikenal. Gunakan /start.", ADMIN_MENU);
  return json({ ok: true });
}

async function setupTelegramWebhook(request, env) {
  const url = new URL(request.url);
  if (!env.SETUP_KEY || url.searchParams.get("key") !== env.SETUP_KEY) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  if (!env.TELEGRAM_BOT_TOKEN || !env.QRIS_INTERNAL_SECRET) {
    return json({ ok: false, error: "server_not_configured" }, 500);
  }
  const secretToken = await telegramWebhookSecret(env);
  const webhookUrl = `${url.origin}/webhook/telegram`;
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: secretToken,
        allowed_updates: ["message"],
        drop_pending_updates: true,
      }),
    },
  );
  const result = await response.json();
  return json(
    { ok: Boolean(response.ok && result.ok), webhook_url: webhookUrl, telegram: result },
    response.ok && result.ok ? 200 : 502,
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/setup/telegram" && request.method === "GET") {
      return setupTelegramWebhook(request, env);
    }

    if (url.pathname === "/webhook/telegram" && request.method === "POST") {
      try {
        return await handleTelegramAdminWebhook(request, env);
      } catch (error) {
        console.error(JSON.stringify({ event: "telegram_admin_webhook_failed", message: error.message }));
        return json({ ok: false, error: "telegram_admin_failed" }, 500);
      }
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, service: "qris-dinamis-telegram" });
    }

    if (url.pathname === "/api/qris/static") {
      if (request.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);
      try {
        return await handleQrisApi(request, env, false);
      } catch (error) {
        console.error(JSON.stringify({ event: "qris_static_api_failed", message: error.message }));
        return json({ ok: false, error: "qris_generation_failed" }, 500);
      }
    }

    if (url.pathname === "/api/qris/dynamic") {
      if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
      try {
        return await handleQrisApi(request, env, true);
      } catch (error) {
        console.error(JSON.stringify({ event: "qris_dynamic_api_failed", message: error.message }));
        return json({ ok: false, error: "qris_generation_failed" }, 500);
      }
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

    if (url.pathname === "/internal/manual-topup-notify") {
      if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
      try {
        return await handleManualTopupNotification(request, env);
      } catch (error) {
        console.error(JSON.stringify({ event: "manual_topup_notification_failed", message: error.message }));
        return json({ ok: false, error: "notification_failed" }, 502);
      }
    }

    return env.ASSETS.fetch(request);
  },
};
