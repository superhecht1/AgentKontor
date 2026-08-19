-- ═══════════════════════════════════════════════════════════════════
-- Migration 011 — Agent Marketplace: Nutzer-Listings
-- ═══════════════════════════════════════════════════════════════════

-- ── LISTINGS: Nutzer veröffentlichen ihre Agenten ─────────────────
CREATE TABLE IF NOT EXISTS agent_listings (
  id              SERIAL PRIMARY KEY,
  agent_id        INTEGER REFERENCES agents(id) ON DELETE CASCADE,
  user_id         INTEGER REFERENCES users(id)  ON DELETE CASCADE,
  -- Öffentliche Infos
  title           TEXT    NOT NULL,
  tagline         TEXT    NOT NULL,
  description     TEXT    NOT NULL,
  category        TEXT    NOT NULL DEFAULT 'sonstiges',
  tags            TEXT[]  DEFAULT '{}',
  emoji           TEXT    NOT NULL DEFAULT '🤖',
  color           TEXT    DEFAULT '#7c3aed',
  -- Preismodell
  price_model     TEXT    NOT NULL DEFAULT 'monthly', -- 'free'|'onetime'|'monthly'
  price_cents     INTEGER NOT NULL DEFAULT 0,          -- in Cent (0 = kostenlos)
  -- Konfiguration
  hide_prompt     BOOLEAN NOT NULL DEFAULT true,       -- System-Prompt verbergen
  preview_msgs    JSONB   DEFAULT '[]',
  quick_chips     JSONB   DEFAULT '[]',
  -- Status
  status          TEXT    NOT NULL DEFAULT 'draft',    -- 'draft'|'pending'|'active'|'paused'|'rejected'
  reject_reason   TEXT,
  -- Stats
  install_count   INTEGER DEFAULT 0,
  revenue_cents   INTEGER DEFAULT 0,
  rating_avg      NUMERIC DEFAULT 0,
  rating_count    INTEGER DEFAULT 0,
  -- Timestamps
  submitted_at    TIMESTAMPTZ,
  approved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_listings_status   ON agent_listings (status, category);
CREATE INDEX IF NOT EXISTS idx_listings_user     ON agent_listings (user_id);
CREATE INDEX IF NOT EXISTS idx_listings_rating   ON agent_listings (rating_avg DESC, install_count DESC);

-- ── KÄUFE / ABONNEMENTS ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS listing_purchases (
  id              SERIAL PRIMARY KEY,
  listing_id      INTEGER REFERENCES agent_listings(id) ON DELETE CASCADE,
  buyer_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,
  seller_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  -- Resultierender Agent im Konto des Käufers
  agent_id        INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  -- Zahlung
  price_cents     INTEGER NOT NULL DEFAULT 0,
  platform_fee_pct NUMERIC DEFAULT 20,              -- 20% Provision
  stripe_payment_id TEXT,
  stripe_sub_id   TEXT,
  -- Status
  status          TEXT    NOT NULL DEFAULT 'active', -- 'active'|'cancelled'|'expired'
  -- Timestamps
  purchased_at    TIMESTAMPTZ DEFAULT now(),
  expires_at      TIMESTAMPTZ,                      -- NULL = Einmalzahlung oder läuft
  cancelled_at    TIMESTAMPTZ,
  UNIQUE (listing_id, buyer_id)
);
CREATE INDEX IF NOT EXISTS idx_purchases_buyer  ON listing_purchases (buyer_id, status);
CREATE INDEX IF NOT EXISTS idx_purchases_seller ON listing_purchases (seller_id);

-- ── BEWERTUNGEN ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS listing_reviews (
  id          SERIAL PRIMARY KEY,
  listing_id  INTEGER REFERENCES agent_listings(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  review_text TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (listing_id, user_id)
);

-- ── AUSZAHLUNGEN ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS seller_payouts (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
  amount_cents    INTEGER NOT NULL,
  status          TEXT DEFAULT 'pending',  -- 'pending'|'paid'|'failed'
  period_start    DATE,
  period_end      DATE,
  stripe_payout_id TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- Agenten: Listing-Referenz
ALTER TABLE agents ADD COLUMN IF NOT EXISTS listing_id INTEGER REFERENCES agent_listings(id) ON DELETE SET NULL;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS is_listed  BOOLEAN DEFAULT false;
