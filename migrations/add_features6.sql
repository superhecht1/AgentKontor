-- AgentKontor — Features 6: Intelligence, Lead Scoring, Webhook Inspector, Proactive, Templates
-- Idempotent

-- Webhook delivery log (Inspector)
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id          SERIAL PRIMARY KEY,
  webhook_id  INTEGER REFERENCES webhooks_out(id) ON DELETE CASCADE,
  agent_id    INTEGER REFERENCES agents(id) ON DELETE CASCADE,
  event_type  VARCHAR(64),
  url         TEXT,
  payload     JSONB,
  status_code INTEGER,
  response    TEXT,
  success     BOOLEAN NOT NULL DEFAULT false,
  duration_ms INTEGER,
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wd_agent ON webhook_deliveries(agent_id, delivered_at DESC);
CREATE INDEX IF NOT EXISTS idx_wd_webhook ON webhook_deliveries(webhook_id, delivered_at DESC);

-- Lead scoring
ALTER TABLE lead_captures ADD COLUMN IF NOT EXISTS score        SMALLINT; -- 1-10
ALTER TABLE lead_captures ADD COLUMN IF NOT EXISTS score_reason TEXT;

-- Conversation Intelligence (weekly insights per agent)
CREATE TABLE IF NOT EXISTS agent_insights (
  id           SERIAL PRIMARY KEY,
  agent_id     INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  week_start   DATE    NOT NULL,
  msg_count    INTEGER NOT NULL DEFAULT 0,
  top_topics   JSONB   NOT NULL DEFAULT '[]',
  unanswered   JSONB   NOT NULL DEFAULT '[]',
  suggestions  JSONB   NOT NULL DEFAULT '[]',
  sentiment    VARCHAR(20),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(agent_id, week_start)
);

-- Public agent templates
CREATE TABLE IF NOT EXISTS agent_templates (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(128) NOT NULL,
  emoji        VARCHAR(8)   NOT NULL DEFAULT '🤖',
  description  TEXT,
  category     VARCHAR(64),
  system_prompt TEXT,
  greeting     TEXT,
  quick_chips  JSONB NOT NULL DEFAULT '[]',
  tone         VARCHAR(32) DEFAULT 'professionell',
  tags         TEXT[],
  is_public    BOOLEAN NOT NULL DEFAULT true,
  use_count    INTEGER NOT NULL DEFAULT 0,
  author       VARCHAR(64),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Proactive chat config per agent
ALTER TABLE agents ADD COLUMN IF NOT EXISTS proactive_enabled  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS proactive_trigger  VARCHAR(32) DEFAULT 'time'; -- time|scroll|exit
ALTER TABLE agents ADD COLUMN IF NOT EXISTS proactive_delay    INTEGER NOT NULL DEFAULT 30; -- seconds
ALTER TABLE agents ADD COLUMN IF NOT EXISTS proactive_message  TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS proactive_scroll   INTEGER NOT NULL DEFAULT 50; -- % scroll
