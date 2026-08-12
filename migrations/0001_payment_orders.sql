CREATE TABLE IF NOT EXISTS payment_orders (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'gatepay',
  source TEXT NOT NULL DEFAULT 'unknown',
  user_id TEXT,
  username TEXT,
  email TEXT,
  base_amount INTEGER NOT NULL CHECK (base_amount >= 0),
  unique_amount INTEGER NOT NULL CHECK (unique_amount >= 0),
  currency TEXT NOT NULL DEFAULT 'IDR',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'expired', 'cancelled', 'failed')),
  checkout_url TEXT,
  expires_at INTEGER,
  paid_at INTEGER,
  settlement_status TEXT NOT NULL DEFAULT 'pending' CHECK (settlement_status IN ('pending', 'received', 'delivered', 'retry_needed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_reference
  ON payment_orders(reference);

CREATE INDEX IF NOT EXISTS idx_payment_orders_status_expires
  ON payment_orders(status, expires_at);

CREATE INDEX IF NOT EXISTS idx_payment_orders_unique_amount_status
  ON payment_orders(unique_amount, status);

CREATE INDEX IF NOT EXISTS idx_payment_orders_user_created
  ON payment_orders(user_id, created_at DESC);
