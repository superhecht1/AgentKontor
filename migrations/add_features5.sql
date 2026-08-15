-- AgentKontor — Features 5: 2FA, Trial, Referral, Audit, Invoices, Slack, GDPR
-- Idempotent

-- 2FA / MFA
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret      VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled     BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_backup_codes JSONB  NOT NULL DEFAULT '[]';

-- 14-Day Pro Trial
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_ends_at    TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_used        BOOLEAN NOT NULL DEFAULT false;

-- Referral Program
CREATE TABLE IF NOT EXISTS referrals (
  id              SERIAL PRIMARY KEY,
  referrer_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  code            VARCHAR(16) NOT NULL UNIQUE,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | converted | paid
  commission_pct  NUMERIC(4,2) NOT NULL DEFAULT 20.00,
  credited_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code     VARCHAR(16) UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by_code  VARCHAR(16);
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_credits  NUMERIC(10,2) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_ref_code    ON referrals(code);
CREATE INDEX IF NOT EXISTS idx_ref_referrer ON referrals(referrer_id);

-- Audit Log
CREATE TABLE IF NOT EXISTS audit_log (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action     VARCHAR(64)  NOT NULL,
  entity     VARCHAR(64),
  entity_id  INTEGER,
  metadata   JSONB NOT NULL DEFAULT '{}',
  ip_address VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);

-- Invoice tracking (Stripe invoices mit §19 UStG)
CREATE TABLE IF NOT EXISTS invoices (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_invoice_id VARCHAR(128) UNIQUE,
  invoice_number  VARCHAR(32) NOT NULL,
  amount_eur      NUMERIC(10,2) NOT NULL,
  description     TEXT NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'paid',
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pdf_url         TEXT
);

CREATE SEQUENCE IF NOT EXISTS invoice_seq START 1000;

-- Slack integration per agent
ALTER TABLE agents ADD COLUMN IF NOT EXISTS slack_enabled    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS slack_bot_token  TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS slack_channel_id VARCHAR(32);

-- GDPR consent for lead capture
ALTER TABLE lead_captures ADD COLUMN IF NOT EXISTS consent_given BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE lead_captures ADD COLUMN IF NOT EXISTS consent_text  TEXT;

-- Lead digest preferences
ALTER TABLE users ADD COLUMN IF NOT EXISTS digest_frequency VARCHAR(10) NOT NULL DEFAULT 'daily'; -- daily | weekly | never
ALTER TABLE users ADD COLUMN IF NOT EXISTS digest_last_sent  TIMESTAMPTZ;

-- Coupon / Promo codes (Stripe)
CREATE TABLE IF NOT EXISTS promo_codes (
  id          SERIAL PRIMARY KEY,
  code        VARCHAR(32) NOT NULL UNIQUE,
  stripe_id   VARCHAR(128),
  discount_pct INTEGER NOT NULL DEFAULT 20,
  max_uses    INTEGER,
  uses        INTEGER NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enterprise plan marker
ALTER TABLE users ADD COLUMN IF NOT EXISTS enterprise_seats INTEGER NOT NULL DEFAULT 0;
