-- Migration 004: fehlende agents-Spalten (idempotent, sicher mehrfach ausführbar)
-- Ausführen in: Neon-Console → SQL-Editor, oder psql $DATABASE_URL < migrations/004_...sql

ALTER TABLE agents ADD COLUMN IF NOT EXISTS model               TEXT    DEFAULT 'claude-sonnet-4-6';

-- Social / Integrationen
ALTER TABLE agents ADD COLUMN IF NOT EXISTS instagram_enabled   BOOLEAN DEFAULT false;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS instagram_token     TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS instagram_business_id TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS facebook_enabled    BOOLEAN DEFAULT false;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS facebook_token      TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS facebook_page_id   TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS slack_enabled       BOOLEAN DEFAULT false;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS slack_bot_token     TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS slack_channel_id   TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS whatsapp_number     TEXT    DEFAULT '';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS telegram_token      TEXT    DEFAULT '';

-- Voice
ALTER TABLE agents ADD COLUMN IF NOT EXISTS voice_provider      TEXT    DEFAULT 'elevenlabs';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS voice_id            TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS voice_stability     NUMERIC DEFAULT 0.5;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS stt_provider        TEXT    DEFAULT 'whisper';

-- Proaktiv erweitert
ALTER TABLE agents ADD COLUMN IF NOT EXISTS proactive_trigger   TEXT    DEFAULT 'time';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS proactive_delay     INTEGER DEFAULT 30;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS proactive_scroll    INTEGER DEFAULT 50;

-- Widget
ALTER TABLE agents ADD COLUMN IF NOT EXISTS widget_position     TEXT    DEFAULT 'right';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS widget_delay        INTEGER DEFAULT 0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS widget_theme        TEXT    DEFAULT 'dark';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS widget_size         INTEGER DEFAULT 56;

-- E-Mail / SMTP
ALTER TABLE agents ADD COLUMN IF NOT EXISTS cap_email           BOOLEAN DEFAULT false;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS smtp_host           TEXT    DEFAULT '';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS smtp_port           INTEGER DEFAULT 587;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS smtp_user           TEXT    DEFAULT '';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS smtp_pass           TEXT    DEFAULT '';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS smtp_from           TEXT    DEFAULT '';

-- Produkte & Aufbewahrung
ALTER TABLE agents ADD COLUMN IF NOT EXISTS products_data       JSONB   DEFAULT '[]';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS lead_retention_days INTEGER DEFAULT 180;

-- Bestätigung
SELECT 'Migration 004 erfolgreich' AS status;
