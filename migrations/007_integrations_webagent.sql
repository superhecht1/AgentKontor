-- ═══════════════════════════════════════════════════════════════════════
-- Migration 007 – Phase 3+4: Integrations · Web-Agent
-- ═══════════════════════════════════════════════════════════════════════

-- ── INTEGRATION CREDENTIALS ─────────────────────────────────────────────
-- Speichert OAuth-Tokens und API-Keys pro User + Integration
CREATE TABLE IF NOT EXISTS integration_credentials (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  integration   TEXT    NOT NULL,  -- calendar | email | crm | webhook | document
  provider      TEXT    NOT NULL,  -- google | microsoft | caldav | imap | airtable | custom
  label         TEXT    DEFAULT 'Standard',
  -- Credentials (in Produktion: verschlüsselt mit AES-256)
  credentials   JSONB   NOT NULL DEFAULT '{}',
  -- {access_token, refresh_token, expires_at, email, imap_host, ...}
  scopes        TEXT[]  DEFAULT '{}',
  is_active     BOOLEAN NOT NULL DEFAULT true,
  last_used     TIMESTAMPTZ,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_creds_user_int_prov
  ON integration_credentials (user_id, integration, provider, label);
CREATE INDEX IF NOT EXISTS idx_creds_user ON integration_credentials (user_id, integration);

-- ── CALENDAR EVENTS CACHE ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS calendar_events_cache (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  cred_id       INTEGER REFERENCES integration_credentials(id) ON DELETE CASCADE,
  event_id      TEXT    NOT NULL,
  title         TEXT,
  start_at      TIMESTAMPTZ,
  end_at        TIMESTAMPTZ,
  location      TEXT,
  description   TEXT,
  attendees     JSONB   DEFAULT '[]',
  raw           JSONB   DEFAULT '{}',
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cal_user_event ON calendar_events_cache (user_id, event_id);

-- ── EMAIL CACHE ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_cache (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  cred_id       INTEGER REFERENCES integration_credentials(id) ON DELETE CASCADE,
  message_id    TEXT    NOT NULL,
  thread_id     TEXT,
  from_addr     TEXT,
  to_addrs      TEXT[],
  subject       TEXT,
  snippet       TEXT,   -- kurze Vorschau
  body_text     TEXT,   -- plain text Body
  is_read       BOOLEAN DEFAULT false,
  importance    TEXT    DEFAULT 'normal', -- high | normal | low
  labels        TEXT[]  DEFAULT '{}',
  received_at   TIMESTAMPTZ,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_user_msg ON email_cache (user_id, message_id);
CREATE INDEX IF NOT EXISTS idx_email_received ON email_cache (user_id, received_at DESC);

-- ── WEB SEARCH CACHE ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS web_search_cache (
  id            SERIAL PRIMARY KEY,
  query_hash    TEXT    NOT NULL UNIQUE,
  query         TEXT    NOT NULL,
  results       JSONB   NOT NULL DEFAULT '[]',
  provider      TEXT    DEFAULT 'brave',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '1 hour')
);
CREATE INDEX IF NOT EXISTS idx_web_cache_hash ON web_search_cache (query_hash, expires_at);

-- ── RESEARCH SESSIONS ────────────────────────────────────────────────────
-- Mehrstufige Recherche-Sitzungen für den Web-Agenten
CREATE TABLE IF NOT EXISTS research_sessions (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  agent_id      INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  goal          TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'running',
  -- running | completed | failed
  steps         JSONB   NOT NULL DEFAULT '[]',
  -- [{type,query,url,content_snippet,analysis,timestamp}]
  result        TEXT,   -- finaler Bericht
  result_table  JSONB,  -- strukturierte Tabelle wenn Vergleich
  sources       JSONB   DEFAULT '[]',  -- [{url,title,snippet}]
  model         TEXT    DEFAULT 'claude-sonnet-4-6',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_research_user ON research_sessions (user_id, created_at DESC);

-- ── PAGE CONTENT CACHE ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS page_content_cache (
  id            SERIAL PRIMARY KEY,
  url_hash      TEXT    NOT NULL UNIQUE,
  url           TEXT    NOT NULL,
  title         TEXT,
  content       TEXT,   -- extrahierter Text
  word_count    INTEGER,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '6 hours')
);

SELECT 'Migration 007 (Phase 3+4: Integrations, Web-Agent) erfolgreich' AS status;
