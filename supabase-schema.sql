-- ============================================================
-- ForgeBot — Supabase Database Schema
-- Run this entire file in Supabase SQL Editor
-- ============================================================

-- Clients (one row per business that signs up)
CREATE TABLE IF NOT EXISTS clients (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  full_name       TEXT NOT NULL,
  business_name   TEXT NOT NULL,
  business_type   TEXT,
  whatsapp_number TEXT NOT NULL,
  country         TEXT DEFAULT 'Nigeria',

  -- Bot status
  status              TEXT DEFAULT 'pending',   -- pending | active | paused | cancelled
  whatsapp_status     TEXT DEFAULT 'disconnected', -- disconnected | connecting | connected
  setup_paid          BOOLEAN DEFAULT false,
  subscription_active BOOLEAN DEFAULT false,

  -- Paystack
  paystack_customer_id       TEXT,
  paystack_subscription_code TEXT,
  paystack_email_token       TEXT,

  -- Stripe
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,

  -- Fallback bot message
  fallback_message TEXT DEFAULT 'Thank you for reaching out! 🙏 Someone will get back to you shortly.',

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-reply flows (keyword → response rules per client)
CREATE TABLE IF NOT EXISTS flows (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id     UUID REFERENCES clients(id) ON DELETE CASCADE,
  flow_name     TEXT NOT NULL,
  keywords      TEXT NOT NULL,       -- comma-separated trigger words
  response_type TEXT DEFAULT 'text', -- text | image
  response      TEXT NOT NULL,
  media_url     TEXT,
  priority      INT DEFAULT 0,
  active        BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Scheduled WhatsApp Status posts
CREATE TABLE IF NOT EXISTS status_posts (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id    UUID REFERENCES clients(id) ON DELETE CASCADE,
  caption      TEXT,
  media_url    TEXT,
  post_time    TEXT NOT NULL,        -- HH:MM format (e.g. "09:00")
  repeat_daily BOOLEAN DEFAULT true,
  last_posted  DATE,
  active       BOOLEAN DEFAULT true,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Payment records
CREATE TABLE IF NOT EXISTS payments (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id    UUID REFERENCES clients(id),
  payment_type TEXT NOT NULL,        -- setup | subscription
  amount       NUMERIC NOT NULL,
  currency     TEXT NOT NULL,        -- NGN | USD
  provider     TEXT NOT NULL,        -- paystack | stripe
  reference    TEXT UNIQUE,
  status       TEXT DEFAULT 'pending', -- pending | success | failed
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Broadcast message logs
CREATE TABLE IF NOT EXISTS broadcast_logs (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id  UUID REFERENCES clients(id),
  message    TEXT NOT NULL,
  recipients INT DEFAULT 0,
  sent_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Indexes for performance ────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_flows_client        ON flows(client_id);
CREATE INDEX IF NOT EXISTS idx_flows_active        ON flows(client_id, active);
CREATE INDEX IF NOT EXISTS idx_status_posts_client ON status_posts(client_id);
CREATE INDEX IF NOT EXISTS idx_status_posts_time   ON status_posts(post_time, active);
CREATE INDEX IF NOT EXISTS idx_payments_client     ON payments(client_id);
CREATE INDEX IF NOT EXISTS idx_payments_reference  ON payments(reference);

-- ── Auto-update updated_at on clients ─────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER clients_updated_at
  BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
