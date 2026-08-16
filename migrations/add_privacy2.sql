-- AgentKontor — Privacy 2: TTL, Encryption, Retention
-- Idempotent

-- Data retention per agent (configurable by agent owner)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS data_retention_days  INTEGER NOT NULL DEFAULT 90;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS lead_retention_days  INTEGER NOT NULL DEFAULT 180;

-- Mark chat messages for deletion (soft-flag before hard delete)
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS scheduled_delete TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_cm_delete ON chat_messages(scheduled_delete) WHERE scheduled_delete IS NOT NULL;

-- Widget consent tracking (per session)
CREATE TABLE IF NOT EXISTS widget_consents (
  id                SERIAL PRIMARY KEY,
  agent_id          INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_identifier_hash VARCHAR(64) NOT NULL, -- SHA-256 of session identifier
  consent_given     BOOLEAN NOT NULL DEFAULT false,
  consent_text      TEXT,
  ip_hash           VARCHAR(64), -- anonymized: SHA-256 of truncated IP
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(agent_id, session_identifier_hash)
);

-- End-user deletion requests
CREATE TABLE IF NOT EXISTS deletion_requests (
  id                SERIAL PRIMARY KEY,
  agent_id          INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_identifier_hash VARCHAR(64) NOT NULL,
  email             VARCHAR(256),
  status            VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | done
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ
);

-- Encryption: mark which memory records are encrypted
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS encrypted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS iv        VARCHAR(32);

-- IP anonymization: store only truncated IPs
-- audit_log: replace ip_address with ip_hash
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS ip_hash VARCHAR(64);

-- Rate limits: already use key (IP embedded) — no PII fix needed there
-- but add cleanup faster: window reduced

-- GDPR lead consent
ALTER TABLE lead_captures ADD COLUMN IF NOT EXISTS ip_hash VARCHAR(64);
