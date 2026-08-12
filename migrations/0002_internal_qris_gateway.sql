-- Internal manual QRIS gateway extension. Forward-only; keeps legacy GatePay rows intact.
ALTER TABLE payment_orders ADD COLUMN customer_id TEXT;
ALTER TABLE payment_orders ADD COLUMN customer_name TEXT;
ALTER TABLE payment_orders ADD COLUMN qris_payload TEXT;
ALTER TABLE payment_orders ADD COLUMN cancelled_at INTEGER;
ALTER TABLE payment_orders ADD COLUMN approved_by TEXT;
ALTER TABLE payment_orders ADD COLUMN cancel_token_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_payment_orders_customer_id ON payment_orders(customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_internal_payment_orders_reference_unique ON payment_orders(reference) WHERE provider = 'internal';
CREATE INDEX IF NOT EXISTS idx_payment_orders_created_at ON payment_orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_orders_expires_at ON payment_orders(expires_at);

CREATE TABLE IF NOT EXISTS payment_pending_amounts (
  unique_amount INTEGER PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payment_pending_amounts_expires ON payment_pending_amounts(expires_at);

CREATE TABLE IF NOT EXISTS payment_audit_logs (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  action TEXT NOT NULL,
  old_status TEXT,
  new_status TEXT,
  admin_id TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payment_audit_logs_order_created ON payment_audit_logs(order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_audit_logs_action_created ON payment_audit_logs(action, created_at DESC);

CREATE TABLE IF NOT EXISTS payment_api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_payment_api_keys_status ON payment_api_keys(status);
CREATE INDEX IF NOT EXISTS idx_payment_api_keys_last_used ON payment_api_keys(last_used_at);
