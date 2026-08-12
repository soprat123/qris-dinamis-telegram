import assert from "node:assert/strict";
import test from "node:test";
import { createInternalOrder } from "../worker/internal-gateway-core.js";
import { markOrderPaid } from "../worker/internal-gateway-admin.js";

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

class Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.args = [];
  }
  bind(...args) {
    this.args = args;
    return this;
  }
  async first() {
    return clone(this.db.exec(this.sql, this.args, "first"));
  }
  async all() {
    return clone({ results: this.db.exec(this.sql, this.args, "all") || [] });
  }
  async run() {
    const result = this.db.exec(this.sql, this.args, "run") || {
      success: true,
      meta: { changes: 1 },
    };
    this.db.lastChanges = Number(result?.meta?.changes ?? 0);
    return clone(result);
  }
}

class FakeD1 {
  constructor() {
    this.orders = [];
    this.pending = [];
    this.audit = [];
    this.lastChanges = 0;
    this.failAudit = false;
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  async batch(statements) {
    const snapshot = clone({
      orders: this.orders,
      pending: this.pending,
      audit: this.audit,
      lastChanges: this.lastChanges,
    });
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    } catch (error) {
      this.orders = snapshot.orders;
      this.pending = snapshot.pending;
      this.audit = snapshot.audit;
      this.lastChanges = snapshot.lastChanges;
      throw error;
    }
  }

  exec(sql, args, mode) {
    const compact = sql.replace(/\s+/g, " ").trim();

    if (compact.startsWith("SELECT id FROM payment_orders WHERE reference")) {
      return this.orders.find((order) => order.reference === String(args[0])) || null;
    }
    if (compact.startsWith("SELECT id FROM payment_orders WHERE unique_amount")) {
      return this.orders.find(
        (order) => order.unique_amount === Number(args[0]) && order.status === "pending",
      ) || null;
    }
    if (compact.startsWith("SELECT id FROM payment_api_keys")) return null;
    if (compact.startsWith("DELETE FROM payment_pending_amounts WHERE expires_at")) {
      this.pending = this.pending.filter((row) => row.expires_at > Number(args[0]));
      return { success: true, meta: { changes: 1 } };
    }
    if (compact.startsWith("INSERT INTO payment_pending_amounts")) {
      if (this.pending.some((row) => row.unique_amount === Number(args[0]))) {
        throw new Error("UNIQUE");
      }
      this.pending.push({
        unique_amount: Number(args[0]),
        order_id: String(args[1]),
        expires_at: Number(args[2]),
        created_at: Number(args[3]),
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (compact.startsWith("DELETE FROM payment_pending_amounts WHERE order_id")) {
      const before = this.pending.length;
      this.pending = this.pending.filter((row) => row.order_id !== String(args[0]));
      return { success: true, meta: { changes: before - this.pending.length } };
    }
    if (compact.startsWith("INSERT INTO payment_orders")) {
      this.orders.push({
        id: String(args[0]),
        reference: String(args[1]),
        provider: "internal",
        source: String(args[2]),
        customer_id: args[3],
        customer_name: args[4],
        user_id: args[5],
        username: args[6],
        email: args[7],
        base_amount: Number(args[8]),
        unique_amount: Number(args[9]),
        currency: "IDR",
        status: "pending",
        qris_payload: String(args[10]),
        checkout_url: String(args[11]),
        expires_at: Number(args[12]),
        paid_at: null,
        cancelled_at: null,
        approved_by: null,
        settlement_status: "pending",
        created_at: Number(args[13]),
        updated_at: Number(args[14]),
        cancel_token_hash: String(args[15]),
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (compact.startsWith("INSERT INTO payment_audit_logs")) {
      if (this.failAudit) throw new Error("audit_fail");
      if (compact.includes("WHERE changes() = 1") && this.lastChanges !== 1) {
        return { success: true, meta: { changes: 0 } };
      }
      this.audit.push({
        action: compact.includes("'order.created'") ? "order.created" : String(args[2]),
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (compact.startsWith("SELECT id, reference, provider, source")) {
      let rows = [...this.orders];
      if (compact.includes("WHERE id = ?")) {
        rows = rows.filter((order) => order.id === String(args[0]));
      }
      return mode === "all" ? rows : rows[0] || null;
    }
    if (compact.startsWith("UPDATE payment_orders SET status = 'paid'")) {
      const order = this.orders.find(
        (row) => row.id === String(args[3]) && row.status === "pending",
      );
      if (!order) return { success: true, meta: { changes: 0 } };
      order.status = "paid";
      order.paid_at = Number(args[0]);
      order.approved_by = String(args[1]);
      order.settlement_status = "received";
      order.updated_at = Number(args[2]);
      return { success: true, meta: { changes: 1 } };
    }
    if (compact.startsWith("UPDATE payment_orders SET settlement_status")) {
      const order = this.orders.find(
        (row) => row.id === String(args[2]) && row.status === "paid",
      );
      if (order) order.settlement_status = String(args[0]);
      return { success: true, meta: { changes: order ? 1 : 0 } };
    }

    throw new Error(`unhandled ${compact}`);
  }
}

function env() {
  return {
    DB: new FakeD1(),
    QRIS_STATIC_PAYLOAD: "STATIC",
    QRIS_INTERNAL_SECRET: "secret",
    AICHATAPI_URL: "https://a.example",
    BIKIN_FOTO_URL: "https://b.example",
  };
}

async function create(environment, amount, reference) {
  const response = await createInternalOrder(
    new Request("https://gateway.example/api/orders", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": "secret",
      },
      body: JSON.stringify({ base_amount: amount, reference, source: "api" }),
    }),
    environment,
    (_payload, uniqueAmount) => `qris:${uniqueAmount}`,
  );
  return [response, await response.json()];
}

test("Rp1.000.000 base amount does not fail randomly", async () => {
  const environment = env();
  const [response, body] = await create(environment, 1_000_000, "max");
  assert.equal(response.status, 201);
  assert.equal(body.order.unique_amount, 1_000_000);
});

test("paid transition rolls back if audit insert fails", async () => {
  const environment = env();
  const [, body] = await create(environment, 10_000, "atomic");
  const auditBefore = environment.DB.audit.length;
  environment.DB.failAudit = true;

  const response = await markOrderPaid(environment, body.order.id, "admin-token");

  assert.equal(response.status, 502);
  assert.equal(environment.DB.orders[0].status, "pending");
  assert.equal(environment.DB.pending.length, 1);
  assert.equal(environment.DB.audit.length, auditBefore);
});
