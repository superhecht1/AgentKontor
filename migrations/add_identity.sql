-- Agent Identity & Credentials
CREATE TABLE IF NOT EXISTS agent_identities (
  id              SERIAL PRIMARY KEY,
  agent_id        INTEGER NOT NULL UNIQUE REFERENCES agents(id) ON DELETE CASCADE,
  -- Identity
  display_name    VARCHAR(100) NOT NULL DEFAULT '',
  email_address   VARCHAR(255) DEFAULT NULL,  -- agent's own email
  avatar_url      TEXT         DEFAULT NULL,
  -- Google OAuth
  google_access_token  TEXT DEFAULT NULL,
  google_refresh_token TEXT DEFAULT NULL,
  google_token_expiry  TIMESTAMPTZ DEFAULT NULL,
  google_scopes        TEXT DEFAULT NULL,  -- comma-separated scopes
  google_calendar_id   VARCHAR(255) DEFAULT NULL,
  -- Calendly
  calendly_token  TEXT DEFAULT NULL,
  calendly_user   JSONB DEFAULT NULL,
  -- Stored credentials (encrypted in production)
  credentials     JSONB NOT NULL DEFAULT '{}',
  -- Status
  is_configured   BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Action log — every action the agent takes
CREATE TABLE IF NOT EXISTS agent_actions (
  id          SERIAL PRIMARY KEY,
  agent_id    INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_id  VARCHAR(64) NOT NULL,
  action_type VARCHAR(50) NOT NULL,  -- calendar_create, email_send, calendly_book, form_fill
  action_data JSONB NOT NULL DEFAULT '{}',
  result      JSONB DEFAULT NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending, success, error
  error_msg   TEXT DEFAULT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_identity_agent ON agent_identities(agent_id);
CREATE INDEX IF NOT EXISTS idx_actions_agent  ON agent_actions(agent_id, session_id);

-- Add identity flag to agents
ALTER TABLE agents ADD COLUMN IF NOT EXISTS has_identity BOOLEAN NOT NULL DEFAULT false;
