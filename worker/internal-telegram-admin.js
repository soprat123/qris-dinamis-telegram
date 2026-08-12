import { constantTimeEqual } from "./internal-gateway-core.js";
import {
  adminCancelOrder,
  markOrderPaid,
  retryPaymentWebhook,
} from "./internal-gateway-admin.js";

function adminIds(env) {
  return [...new Set(
    [env.ADMIN_TELEGRAM_ID, env.ADMIN2_TELEGRAM_ID]
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  )];
}

function rupiah(value) {
  return `Rp${Number(value || 0).toLocaleString("id-ID")}`;
}

function wib(unixSeconds) {
  const value = Number(unixSeconds);
  if (!Number.isFinite(value) || value <= 0) return "-";
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value * 1000)).replace(".", ":") + " WIB";
}

function sourceLabel(order) {
  if (order?.source === "aichatapi" || /^web:/i.test(String(order?.reference || ""))) {
    return "AIChatAPI Web";
  }
  if (order?.source === "telegram" || /^deposit:/i.test(String(order?.reference || ""))) {
    return "Telegram Bikin Foto";
  }
  return String(order?.source || "API");
}

function customerLabel(order) {
  if (order?.username) return `@${String(order.username).replace(/^@/, "")}`;
  if (order?.customer_name) return String(order.customer_name);
  if (order?.email) return String(order.email);
  return order?.customer_id ? `ID ${String(order.customer_id)}` : "-";
}

export function pendingOrderKeyboard(orderId) {
  const id = String(orderId);
  return {
    inline_keyboard: [
      [
        { text: "✅ Verifikasi Dibayar", callback_data: `qris_check:${id}` },
        { text: "❌ Batalkan", callback_data: `qris_cancel_check:${id}` },
      ],
    ],
  };
}

function paidConfirmKeyboard(orderId) {
  const id = String(orderId);
  return {
    inline_keyboard: [
      [{ text: "✅ YA, tandai PAID", callback_data: `qris_paid:${id}` }],
      [{ text: "↩️ Kembali", callback_data: `qris_back:${id}` }],
    ],
  };
}

function cancelConfirmKeyboard(orderId) {
  const id = String(orderId);
  return {
    inline_keyboard: [
      [{ text: "❌ YA, batalkan order", callback_data: `qris_cancel:${id}` }],
      [{ text: "↩️ Kembali", callback_data: `qris_back:${id}` }],
    ],
  };
}

function retryKeyboard(orderId) {
  return {
    inline_keyboard: [
      [{ text: "🔁 Retry pengiriman saldo", callback_data: `qris_retry:${String(orderId)}` }],
    ],
  };
}

export function buildPendingAdminMessage(order) {
  const identityLine = order?.source === "aichatapi"
    ? `Email/ID: ${order.email || order.customer_id || "-"}`
    : `ID Telegram: ${order.customer_id || order.user_id || "-"}`;
  return [
    "🟡 TOP UP BARU — MENUNGGU PEMBAYARAN",
    "",
    `Sumber: ${sourceLabel(order)}`,
    `Pengguna: ${customerLabel(order)}`,
    identityLine,
    `Order: ${String(order.id)}`,
    `Referensi: ${String(order.reference || "-")}`,
    `Saldo/Credit yang masuk: ${rupiah(order.base_amount)}`,
    `Total yang harus dibayar: ${rupiah(order.unique_amount)}`,
    `Kedaluwarsa: ${wib(order.expires_at)}`,
    "",
    "Periksa mutasi merchant terlebih dahulu. Jangan tandai PAID sebelum dana benar-benar masuk.",
  ].join("\n");
}

async function telegramSecret(env) {
  const bytes = new TextEncoder().encode(String(env.QRIS_INTERNAL_SECRET || ""));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function telegramApi(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("telegram_bot_not_configured");
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  let result = {};
  try { result = await response.json(); } catch { /* handled below */ }
  if (!response.ok || !result.ok) {
    throw new Error(result.description || `telegram_http_${response.status}`);
  }
  return result.result;
}

async function ensureCallbackWebhook(env, origin) {
  if (!env.QRIS_INTERNAL_SECRET || !env.TELEGRAM_BOT_TOKEN) return false;
  const url = new URL("/webhook/telegram", origin);
  if (url.protocol !== "https:") return false;
  await telegramApi(env, "setWebhook", {
    url: url.toString(),
    secret_token: await telegramSecret(env),
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  });
  return true;
}

export async function notifyPendingOrder(env, origin, order) {
  const targets = adminIds(env);
  if (!targets.length || !env.TELEGRAM_BOT_TOKEN) {
    console.warn(JSON.stringify({ event: "pending_order_admin_notification_skipped", reason: "telegram_not_configured" }));
    return false;
  }

  try {
    await ensureCallbackWebhook(env, origin);
  } catch (error) {
    console.error(JSON.stringify({
      event: "telegram_callback_webhook_setup_failed",
      message: String(error?.message || "failed").slice(0, 160),
    }));
  }

  const text = buildPendingAdminMessage(order);
  const keyboard = pendingOrderKeyboard(order.id);
  const results = await Promise.allSettled(targets.map((chatId) => telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: keyboard,
    disable_web_page_preview: true,
  })));

  const delivered = results.filter((result) => result.status === "fulfilled").length;
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error(JSON.stringify({
        event: "pending_order_admin_notification_failed",
        chat_id: targets[index],
        order_id: String(order.id),
        message: String(result.reason?.message || "failed").slice(0, 160),
      }));
    }
  });
  return delivered > 0;
}

function parseCallback(data) {
  const match = String(data || "").match(/^qris_(check|paid|cancel_check|cancel|back|retry):(QR-[A-F0-9]{24})$/i);
  if (!match) return null;
  return { action: match[1].toLowerCase(), orderId: match[2].toUpperCase() };
}

async function responseJson(response) {
  try { return await response.json(); } catch { return {}; }
}

async function answer(env, callbackId, text, showAlert = false) {
  try {
    await telegramApi(env, "answerCallbackQuery", {
      callback_query_id: callbackId,
      text,
      show_alert: showAlert,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "telegram_callback_answer_failed", message: error?.message || "failed" }));
  }
}

async function editKeyboard(env, callback, replyMarkup) {
  if (!callback.message?.chat?.id || !callback.message?.message_id) return;
  await telegramApi(env, "editMessageReplyMarkup", {
    chat_id: callback.message.chat.id,
    message_id: callback.message.message_id,
    reply_markup: replyMarkup,
  });
}

async function finishMessage(env, callback, suffix, replyMarkup = { inline_keyboard: [] }) {
  if (!callback.message?.chat?.id || !callback.message?.message_id) return;
  const original = String(callback.message.text || "").replace(/\n\n(?:✅|❌|⚠️).+$/s, "");
  await telegramApi(env, "editMessageText", {
    chat_id: callback.message.chat.id,
    message_id: callback.message.message_id,
    text: `${original}\n\n${suffix}`,
    reply_markup: replyMarkup,
    disable_web_page_preview: true,
  });
}

export async function handleInternalTelegramCallback(request, env, update) {
  if (!env.QRIS_INTERNAL_SECRET || !env.TELEGRAM_BOT_TOKEN) {
    return Response.json({ ok: false, error: "server_not_configured" }, { status: 500 });
  }
  const expected = await telegramSecret(env);
  if (!(await constantTimeEqual(
    request.headers.get("X-Telegram-Bot-Api-Secret-Token"),
    expected,
  ))) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const callback = update?.callback_query;
  const parsed = parseCallback(callback?.data);
  if (!callback?.id || !callback.from?.id || !parsed) {
    return Response.json({ ok: true, ignored: true });
  }

  const adminId = String(callback.from.id);
  if (!adminIds(env).includes(adminId)) {
    await answer(env, callback.id, "Akses ditolak. Tombol ini hanya untuk admin.", true);
    return Response.json({ ok: true, denied: true });
  }

  if (parsed.action === "check") {
    await answer(env, callback.id, "Pastikan dana sudah masuk sebelum konfirmasi.");
    await editKeyboard(env, callback, paidConfirmKeyboard(parsed.orderId));
    return Response.json({ ok: true });
  }
  if (parsed.action === "cancel_check") {
    await answer(env, callback.id, "Konfirmasi pembatalan order.");
    await editKeyboard(env, callback, cancelConfirmKeyboard(parsed.orderId));
    return Response.json({ ok: true });
  }
  if (parsed.action === "back") {
    await answer(env, callback.id, "Kembali.");
    await editKeyboard(env, callback, pendingOrderKeyboard(parsed.orderId));
    return Response.json({ ok: true });
  }

  await answer(env, callback.id, "Memproses…");
  const principal = `telegram:${adminId}`;
  let response;
  if (parsed.action === "paid") {
    response = await markOrderPaid(env, parsed.orderId, principal);
  } else if (parsed.action === "cancel") {
    response = await adminCancelOrder(env, parsed.orderId, principal);
  } else {
    response = await retryPaymentWebhook(env, parsed.orderId, principal);
  }
  const body = await responseJson(response);

  if (!response.ok || !body.ok) {
    const labels = {
      order_already_paid: "Order sudah berstatus PAID.",
      order_not_pending: "Order sudah tidak berstatus pending.",
      order_expired: "Order sudah kedaluwarsa.",
      order_not_paid: "Order belum berstatus PAID.",
    };
    await answer(env, callback.id, labels[body.error] || `Gagal: ${body.error || response.status}`, true);
    return Response.json({ ok: true, action_failed: true, error: body.error || "unknown" });
  }

  if (parsed.action === "cancel") {
    await finishMessage(env, callback, `❌ DIBATALKAN oleh admin ${adminId}.`);
    return Response.json({ ok: true });
  }

  const settlement = body.settlement || {};
  if (settlement.delivered || settlement.settlement_status === "delivered") {
    await finishMessage(
      env,
      callback,
      `✅ PAID — disetujui admin ${adminId}.\n✅ Saldo/credit sudah dikirim ke aplikasi.`,
    );
  } else {
    await finishMessage(
      env,
      callback,
      `✅ PAID — disetujui admin ${adminId}.\n⚠️ Pengiriman saldo/credit perlu dicoba ulang.`,
      retryKeyboard(parsed.orderId),
    );
  }
  return Response.json({ ok: true });
}
