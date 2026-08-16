-- AgentKontor — Security 2: Brute-Force, IV fix, Consent server-side
-- Idempotent

-- Fix: iv column too small for AES-GCM (iv:tag:ciphertext combined)
ALTER TABLE agent_memory ALTER COLUMN iv TYPE TEXT;

-- Brute-force account lockout
ALTER TABLE users ADD COLUMN IF NOT EXISTS login_attempts  INTEGER      NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until    TIMESTAMPTZ;

-- Server-side widget consent verification
ALTER TABLE widget_consents ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

-- RAG document encryption flag
ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS encrypted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS encrypted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS content_iv TEXT;

-- VVT tracking (internal)
CREATE TABLE IF NOT EXISTS vvt_entries (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(256) NOT NULL,
  purpose     TEXT,
  legal_basis VARCHAR(128),
  recipients  TEXT,
  retention   VARCHAR(128),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Quota alert tracking
ALTER TABLE users ADD COLUMN IF NOT EXISTS quota_alert_sent BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_email VARCHAR(256);
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_email_token VARCHAR(128);

-- Deactivate old API keys without hash (they can't authenticate anymore)
-- Users must regenerate their keys
UPDATE api_keys SET is_active=false WHERE key_hash IS NULL AND is_active=true;
