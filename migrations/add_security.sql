-- AgentKontor — Security hardening
-- Adds token_version for JWT invalidation on password change

ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 1;
