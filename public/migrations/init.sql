-- AgentKontor DB Schema
-- psql $DATABASE_URL -f migrations/init.sql

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  name          VARCHAR(100) NOT NULL,
  lang          VARCHAR(5)   NOT NULL DEFAULT 'de',
  plan          VARCHAR(20)  NOT NULL DEFAULT 'free',
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agents (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_id       VARCHAR(32) NOT NULL UNIQUE,  -- shareable slug
  name            VARCHAR(80) NOT NULL,
  emoji           VARCHAR(10) NOT NULL DEFAULT '🤖',
  description     TEXT        DEFAULT '',
  system_prompt   TEXT        NOT NULL,
  greeting        TEXT        NOT NULL DEFAULT 'Hallo! Wie kann ich helfen?',
  tone            VARCHAR(20) NOT NULL DEFAULT 'professionell',
  language        VARCHAR(5)  NOT NULL DEFAULT 'de',
  quick_chips     JSONB       NOT NULL DEFAULT '[]',
  color           VARCHAR(7)  NOT NULL DEFAULT '#6c5ce7',
  is_active       BOOLEAN     NOT NULL DEFAULT true,
  -- Integrations
  widget_enabled      BOOLEAN NOT NULL DEFAULT true,
  chatpage_enabled    BOOLEAN NOT NULL DEFAULT true,
  api_enabled         BOOLEAN NOT NULL DEFAULT false,
  whatsapp_enabled    BOOLEAN NOT NULL DEFAULT false,
  whatsapp_number     VARCHAR(30) DEFAULT NULL,
  telegram_enabled    BOOLEAN NOT NULL DEFAULT false,
  telegram_token      VARCHAR(200) DEFAULT NULL,
  -- Stats
  total_messages  INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id    INTEGER REFERENCES agents(id) ON DELETE CASCADE,
  key_hash    VARCHAR(255) NOT NULL UNIQUE,
  key_prefix  VARCHAR(12)  NOT NULL,  -- ak_live_xxxx (shown in UI)
  label       VARCHAR(80)  NOT NULL DEFAULT 'API Key',
  is_active   BOOLEAN      NOT NULL DEFAULT true,
  last_used   TIMESTAMPTZ  DEFAULT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id          SERIAL PRIMARY KEY,
  agent_id    INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_id  VARCHAR(64)  NOT NULL,
  role        VARCHAR(12)  NOT NULL CHECK (role IN ('user','assistant')),
  content     TEXT         NOT NULL,
  source      VARCHAR(20)  NOT NULL DEFAULT 'web', -- web, widget, api, whatsapp, telegram
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agents_user_id    ON agents(user_id);
CREATE INDEX IF NOT EXISTS idx_agents_public_id  ON agents(public_id);
CREATE INDEX IF NOT EXISTS idx_chat_session      ON chat_messages(agent_id, session_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_user     ON api_keys(user_id);
