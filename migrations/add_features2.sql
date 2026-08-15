-- AgentKontor — Features 2: Feedback, Yearly Plan, Human Handoff
-- Idempotent

-- Message feedback (thumbs up/down)
CREATE TABLE IF NOT EXISTS message_feedback (
  id         SERIAL PRIMARY KEY,
  agent_id   INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_id VARCHAR(128) NOT NULL,
  message_id INTEGER REFERENCES chat_messages(id) ON DELETE SET NULL,
  rating     SMALLINT NOT NULL CHECK (rating IN (1, -1)), -- 1=up, -1=down
  comment    TEXT,
  source     VARCHAR(32) DEFAULT 'web',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mf_agent ON message_feedback(agent_id);
CREATE INDEX IF NOT EXISTS idx_mf_session ON message_feedback(session_id);

-- Yearly plan support
ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_cycle VARCHAR(10) NOT NULL DEFAULT 'monthly'; -- monthly | yearly
ALTER TABLE users ADD COLUMN IF NOT EXISTS churn_email_sent BOOLEAN NOT NULL DEFAULT false;

-- Human handoff requests
CREATE TABLE IF NOT EXISTS handoff_requests (
  id         SERIAL PRIMARY KEY,
  agent_id   INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_id VARCHAR(128) NOT NULL,
  source     VARCHAR(32) DEFAULT 'web',
  reason     TEXT,
  status     VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | resolved
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Agent version history (for rollback)
CREATE TABLE IF NOT EXISTS agent_versions (
  id             SERIAL PRIMARY KEY,
  agent_id       INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL DEFAULT 1,
  system_prompt  TEXT,
  greeting       TEXT,
  tone           VARCHAR(32),
  quick_chips    JSONB DEFAULT '[]',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_av_agent ON agent_versions(agent_id, version_number DESC);

-- Changelog entries (what's new)
CREATE TABLE IF NOT EXISTS changelog (
  id         SERIAL PRIMARY KEY,
  version    VARCHAR(20) NOT NULL,
  title      VARCHAR(200) NOT NULL,
  body       TEXT NOT NULL,
  published  BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cron tracking
CREATE TABLE IF NOT EXISTS cron_log (
  id         SERIAL PRIMARY KEY,
  job        VARCHAR(64) NOT NULL,
  ran_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  result     TEXT
);

-- Session rate limiting for widget (unauthenticated)
-- Uses existing rate_limits table: key = 'widget:{ip}'
