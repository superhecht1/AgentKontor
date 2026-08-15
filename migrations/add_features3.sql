-- AgentKontor — Features 3: Streaming, Multimodal, Memory, Costs, Instagram/Facebook
-- Idempotent

-- LLM cost tracking
CREATE TABLE IF NOT EXISTS llm_usage (
  id            SERIAL PRIMARY KEY,
  agent_id      INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_id    VARCHAR(128),
  model         VARCHAR(128) NOT NULL,
  source        VARCHAR(32)  NOT NULL DEFAULT 'web',
  input_tokens  INTEGER      NOT NULL DEFAULT 0,
  output_tokens INTEGER      NOT NULL DEFAULT 0,
  cost_usd      NUMERIC(10,6) NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_llm_agent     ON llm_usage(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_created   ON llm_usage(created_at DESC);

-- Persistent memory per agent+user
CREATE TABLE IF NOT EXISTS agent_memory (
  id                SERIAL PRIMARY KEY,
  agent_id          INTEGER      NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_identifier VARCHAR(256) NOT NULL, -- hashed: WA number, TG user_id, cookie id
  facts             JSONB        NOT NULL DEFAULT '[]',
  summary           TEXT,
  message_count     INTEGER      NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE(agent_id, session_identifier)
);

CREATE INDEX IF NOT EXISTS idx_mem_agent ON agent_memory(agent_id, session_identifier);

-- Instagram + Facebook fields on agents
ALTER TABLE agents ADD COLUMN IF NOT EXISTS instagram_enabled    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS instagram_token      TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS instagram_business_id VARCHAR(64);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS facebook_enabled     BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS facebook_token       TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS facebook_page_id     VARCHAR(64);

-- Multimodal: track if image was in message
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS has_image BOOLEAN NOT NULL DEFAULT false;

-- Cost summary per agent per day (materialized for performance)
CREATE TABLE IF NOT EXISTS agent_cost_daily (
  id         SERIAL PRIMARY KEY,
  agent_id   INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  date       DATE    NOT NULL,
  total_cost NUMERIC(10,6) NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  UNIQUE(agent_id, date)
);
