import legacyD1Worker from "./index-d1.js";
import { convertToDynamic, renderQrisPng } from "./index.js";
import {
  authorizeAdminRequest,
  cancelOrder,
  createInternalOrder,
  errorResponse,
  expirePendingOrders,
  getOrderQrisPayload,
  getPublicOrder,
  json,
} from "./internal-gateway-core.js";
import {
  adminCancelOrder,
  listAdminOrders,
  markOrderPaid,
  retryPaymentWebhook,
} from "./internal-gateway-admin.js";

function decodeId(value) {
  try {
    const id = decodeURIComponent(value);
    return /^[A-Za-z0-9_-]{3,128}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function html(body) {
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; connect-src 'self'; img-src 'self' data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

async function adminApi(request, env, url) {
  const admin = await authorizeAdminRequest(request, env);
  if (!admin) return json({ ok: false, error: "unauthorized" }, 401);

  if (url.pathname === "/api/admin/payments" && request.method === "GET") {
    return listAdminOrders(env, url.searchParams.get("status") || "all");
  }

  const match = url.pathname.match(
    /^\/api\/admin\/payments\/([^/]+)\/(mark-paid|cancel|retry-webhook)$/,
  );
  if (!match) return json({ ok: false, error: "not_found" }, 404);

  const id = decodeId(match[1]);
  if (!id) return json({ ok: false, error: "invalid_order_id" }, 400);
  if (request.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  if (match[2] === "mark-paid") return markOrderPaid(env, id, admin.id);
  if (match[2] === "cancel") return adminCancelOrder(env, id, admin.id);
  return retryPaymentWebhook(env, id, admin.id);
}

export default {
  async scheduled(_controller, env, ctx) {
    const task = expirePendingOrders(env).catch((error) => {
      console.error(JSON.stringify({
        event: "payment_expiry_failed",
        message: error?.message || "unknown_error",
      }));
    });
    if (ctx?.waitUntil) ctx.waitUntil(task);
    else await task;
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return json({
        ok: true,
        service: "qris-dinamis-telegram",
        database: Boolean(env.DB),
        payment_engine: "internal",
        legacy_gatepay: true,
      });
    }

    if (url.pathname.startsWith("/pay/")) {
      const id = decodeId(url.pathname.slice(5));
      if (request.method !== "GET" || !id) {
        return json({ ok: false, error: "invalid_order_id" }, 400);
      }
      const { checkoutPage } = await import("./internal-ui.js");
      return html(checkoutPage(id));
    }

    if (url.pathname === "/admin/payments" && request.method === "GET") {
      const { adminPaymentsPage } = await import("./internal-ui.js");
      return html(adminPaymentsPage());
    }

    if (
      url.pathname === "/api/admin/payments" ||
      url.pathname.startsWith("/api/admin/payments/")
    ) {
      return adminApi(request, env, url);
    }

    const match = url.pathname.match(/^\/api\/orders\/([^/]+)(\/qris|\/cancel)?$/);
    if (match) {
      const id = decodeId(match[1]);
      if (!id) return json({ ok: false, error: "invalid_order_id" }, 400);

      if (!match[2] && request.method === "GET") {
        return getPublicOrder(request, env, id);
      }
      if (match[2] === "/cancel" && request.method === "POST") {
        return cancelOrder(request, env, id);
      }
      if (match[2] === "/qris" && request.method === "GET") {
        try {
          const order = await getOrderQrisPayload(env, id);
          return new Response(await renderQrisPng(order.payload), {
            headers: {
              "content-type": "image/png",
              "cache-control": "no-store",
              "x-qris-order-status": order.status,
            },
          });
        } catch (error) {
          return errorResponse(error);
        }
      }
      return json({ ok: false, error: "method_not_allowed" }, 405);
    }

    if (url.pathname === "/api/orders" && request.method === "POST") {
      return createInternalOrder(
        request,
        env,
        (payload, amount) => convertToDynamic(payload, amount),
      );
    }

    // Everything that is not part of the new gateway continues through the
    // existing D1 + GatePay Worker so the legacy production flow stays intact.
    return legacyD1Worker.fetch(request, env, ctx);
  },
};
