-- AgentKontor — Widget Customizer + Admin
-- psql $DATABASE_URL -f migrations/add_extras.sql

-- Widget customizer fields
ALTER TABLE agents ADD COLUMN IF NOT EXISTS widget_position VARCHAR(10) NOT NULL DEFAULT 'right';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS widget_delay    INTEGER      NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS widget_theme    VARCHAR(10)  NOT NULL DEFAULT 'dark';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS widget_size     INTEGER      NOT NULL DEFAULT 56;

-- Admin flag
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;
