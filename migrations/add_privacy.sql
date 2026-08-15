-- AgentKontor — Security: Soft-Delete + API Key Hashing
-- Idempotent

-- Soft-delete for users (DSGVO: 30-day grace period)
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- API key hash (store hash instead of plaintext)
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_hash VARCHAR(64);

-- Index for fast hash lookup
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash) WHERE key_hash IS NOT NULL;

-- Mark deleted users (filter in queries)
-- Usage: WHERE deleted_at IS NULL
