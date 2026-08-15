-- AgentKontor — Features 4: Voice, Agentic Actions, White-Label
-- Idempotent

-- Voice settings per agent
ALTER TABLE agents ADD COLUMN IF NOT EXISTS voice_enabled   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS voice_provider  VARCHAR(32) NOT NULL DEFAULT 'elevenlabs'; -- elevenlabs | browser
ALTER TABLE agents ADD COLUMN IF NOT EXISTS voice_id        VARCHAR(64); -- ElevenLabs voice ID
ALTER TABLE agents ADD COLUMN IF NOT EXISTS voice_stability NUMERIC(3,2) NOT NULL DEFAULT 0.5;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS stt_provider    VARCHAR(32) NOT NULL DEFAULT 'whisper'; -- whisper | deepgram

-- Agentic Actions per agent
CREATE TABLE IF NOT EXISTS agent_tools (
  id          SERIAL PRIMARY KEY,
  agent_id    INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tool_type   VARCHAR(64) NOT NULL, -- web_search | send_email | book_calendar | add_crm | http_request | create_doc
  tool_name   VARCHAR(128) NOT NULL,
  tool_desc   TEXT,
  config      JSONB NOT NULL DEFAULT '{}',
  is_enabled  BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_at_agent ON agent_tools(agent_id);

-- Tool execution log
CREATE TABLE IF NOT EXISTS tool_executions (
  id          SERIAL PRIMARY KEY,
  agent_id    INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_id  VARCHAR(128),
  tool_type   VARCHAR(64) NOT NULL,
  input       JSONB,
  output      TEXT,
  success     BOOLEAN NOT NULL DEFAULT true,
  duration_ms INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- White-Label Workspaces
CREATE TABLE IF NOT EXISTS workspaces (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(128) NOT NULL,
  slug            VARCHAR(64) UNIQUE NOT NULL, -- subdomain slug
  owner_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  logo_url        TEXT,
  favicon_url     TEXT,
  primary_color   VARCHAR(7) NOT NULL DEFAULT '#6c5ce7',
  bg_color        VARCHAR(7) NOT NULL DEFAULT '#050510',
  brand_name      VARCHAR(64) NOT NULL DEFAULT 'AgentKontor',
  custom_domain   VARCHAR(256),
  support_email   VARCHAR(256),
  is_reseller     BOOLEAN NOT NULL DEFAULT false,
  reseller_plan   VARCHAR(32) NOT NULL DEFAULT 'standard', -- standard | reseller | enterprise
  max_sub_users   INTEGER NOT NULL DEFAULT 0,
  stripe_price_id VARCHAR(128), -- custom pricing for resellers
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Users belong to workspace (optional)
ALTER TABLE users ADD COLUMN IF NOT EXISTS workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_workspace_admin BOOLEAN NOT NULL DEFAULT false;

-- Reseller billing: monthly usage per sub-user
CREATE TABLE IF NOT EXISTS reseller_usage (
  id           SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month        DATE NOT NULL DEFAULT DATE_TRUNC('month', NOW()),
  msg_count    INTEGER NOT NULL DEFAULT 0,
  cost_usd     NUMERIC(10,6) NOT NULL DEFAULT 0,
  UNIQUE(workspace_id, user_id, month)
);
