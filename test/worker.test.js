import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  convertToDynamic,
  formatTelegramMessage,
  verifyGatePaySignature,
  verifyInternalSecret,
} from "../worker/index.js";

const STATIC_QRIS = "0002010102115802ID6304A3CF";

test("verifies GatePay HMAC and rejects a modified body", async () => {
  const secret = "callback-test-secret";
  const body = JSON.stringify({ event: "order.paid", order_id: "ord_test" });
  const signature = createHmac("sha256", secret).update(body).digest("hex");

  assert.equal(await verifyGatePaySignature(body, signature, secret), true);
  assert.equal(await verifyGatePaySignature(`${body} `, signature, secret), false);
});

test("verifies the shared internal secret", async () => {
  assert.equal(await verifyInternalSecret("same-secret", "same-secret"), true);
  assert.equal(await verifyInternalSecret("wrong-secret", "same-secret"), false);
});

test("formats a paid notification in WIB", () => {
  const message = formatTelegramMessage({
    order_id: "ord_test",
    reference: "INV-001",
    base_amount: 10000,
    unique_amount: 10237,
    paid_at: 1784351000,
  });

  assert.match(message, /Transaksi QRIS berhasil/);
  assert.match(message, /Order: ord_test/);
  assert.match(message, /Referensi: INV-001/);
  assert.match(message, /Nominal: Rp10\.237/);
  assert.match(message, /WIB/);
});

test("converts a static QRIS payload to a dynamic amount", () => {
  const dynamic = convertToDynamic(STATIC_QRIS, 10_000);

  assert.match(dynamic, /^000201010212/);
  assert.match(dynamic, /540510000/);
  assert.match(dynamic, /6304[0-9A-F]{4}$/);
});

test("rejects dynamic amounts outside the configured range", () => {
  assert.throws(() => convertToDynamic(STATIC_QRIS, 999), /invalid_amount/);
  assert.throws(() => convertToDynamic(STATIC_QRIS, 1_000_001), /invalid_amount/);
});
