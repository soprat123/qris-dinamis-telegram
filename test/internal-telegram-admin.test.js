import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPendingAdminMessage,
  pendingOrderKeyboard,
} from "../worker/internal-telegram-admin.js";

const order = {
  id: "QR-1234567890ABCDEF12345678",
  reference: "deposit:123456:789",
  source: "telegram",
  customer_id: "123456",
  customer_name: "Nama User",
  username: "user_test",
  base_amount: 10_000,
  unique_amount: 10_137,
  expires_at: 1_800_000_000,
};

test("formats pending Telegram order notification", () => {
  const message = buildPendingAdminMessage(order);
  assert.match(message, /TOP UP BARU/);
  assert.match(message, /Telegram Bikin Foto/);
  assert.match(message, /@user_test/);
  assert.match(message, /Rp10\.000/);
  assert.match(message, /Rp10\.137/);
  assert.match(message, /Jangan tandai PAID/);
});

test("pending order keyboard uses compact callback data without secrets", () => {
  const keyboard = pendingOrderKeyboard(order.id);
  const buttons = keyboard.inline_keyboard.flat();
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].callback_data, `qris_check:${order.id}`);
  assert.equal(buttons[1].callback_data, `qris_cancel_check:${order.id}`);
  for (const button of buttons) {
    assert.ok(button.callback_data.length <= 64);
    assert.doesNotMatch(button.callback_data, /secret|token/i);
  }
});
