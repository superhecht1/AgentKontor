-- AgentKontor — Feature Extensions
-- psql $DATABASE_URL -f migrations/add_features.sql

-- ─── STRIPE / PLAN ───────────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id     VARCHAR(60)  DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(60)  DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_period_end        TIMESTAMPTZ  DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_done        BOOLEAN      NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS msg_count_month        INTEGER      NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS msg_count_reset        TIMESTAMPTZ  NOT NULL DEFAULT date_trunc('month', NOW());

-- ─── OUTGOING WEBHOOKS ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outgoing_webhooks (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id    INTEGER REFERENCES agents(id) ON DELETE CASCADE,
  url         TEXT    NOT NULL,
  events      JSONB   NOT NULL DEFAULT '["message.received","lead.captured"]',
  secret      VARCHAR(80) DEFAULT NULL,   -- HMAC-SHA256 signing secret
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webhooks_out_agent ON outgoing_webhooks(agent_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_out_user  ON outgoing_webhooks(user_id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id           SERIAL PRIMARY KEY,
  webhook_id   INTEGER NOT NULL REFERENCES outgoing_webhooks(id) ON DELETE CASCADE,
  event_type   VARCHAR(50) NOT NULL,
  payload      JSONB NOT NULL DEFAULT '{}',
  status       VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending, success, error
  response_code INTEGER DEFAULT NULL,
  error_msg    TEXT DEFAULT NULL,
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries ON webhook_deliveries(webhook_id);

-- ─── RATE LIMITING ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rate_limits (
  key        VARCHAR(120) PRIMARY KEY,
  count      INTEGER NOT NULL DEFAULT 1,
  window_end TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '1 hour'
);
