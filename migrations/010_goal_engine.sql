-- ═══════════════════════════════════════════════════════════════════════
-- Migration 010 – Super Agent Mode: Goal Engine
-- ═══════════════════════════════════════════════════════════════════════

-- ── GOALS ────────────────────────────────────────────────────────────────
-- Das übergeordnete Geschäftsziel des Nutzers
CREATE TABLE IF NOT EXISTS goals (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
  -- Nutzereingabe
  raw_goal        TEXT    NOT NULL,      -- "Ich möchte 50 neue Kunden gewinnen"
  -- LLM-Analyse
  goal_type       TEXT,                  -- customer_acquisition | revenue | awareness | retention | research
  goal_title      TEXT,                  -- Kurztitel
  goal_metric     TEXT,                  -- "50 neue Kunden"
  goal_timeframe  TEXT,                  -- "3 Monate"
  target_value    NUMERIC,               -- 50
  target_unit     TEXT,                  -- Kunden / € / % / Stück
  industry        TEXT,                  -- aus Business-Memory
  context         TEXT,                  -- zusätzlicher Kontext
  -- Ausführung
  status          TEXT    NOT NULL DEFAULT 'analyzing',
  -- analyzing | planning | running | paused | completed | failed | cancelled
  progress        INTEGER NOT NULL DEFAULT 0,  -- 0-100%
  -- Ergebnis
  achieved_value  NUMERIC DEFAULT 0,
  result_summary  TEXT,
  -- Timestamps
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_goals_user ON goals (user_id, status, created_at DESC);

-- ── GOAL CAMPAIGNS ───────────────────────────────────────────────────────
-- Eine Kampagne ist ein konkreter Ausführungsplan für ein Ziel
CREATE TABLE IF NOT EXISTS goal_campaigns (
  id              SERIAL PRIMARY KEY,
  goal_id         INTEGER REFERENCES goals(id) ON DELETE CASCADE,
  user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT    NOT NULL,
  description     TEXT,
  strategy        TEXT,   -- LLM-generierte Strategie-Erklärung
  status          TEXT    NOT NULL DEFAULT 'draft',
  -- draft | active | paused | completed | failed
  step_count      INTEGER NOT NULL DEFAULT 0,
  steps_done      INTEGER NOT NULL DEFAULT 0,
  current_step    INTEGER DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── GOAL STEPS ───────────────────────────────────────────────────────────
-- Einzelne Schritte eines Kampagnen-Plans
CREATE TABLE IF NOT EXISTS goal_steps (
  id              SERIAL PRIMARY KEY,
  campaign_id     INTEGER REFERENCES goal_campaigns(id) ON DELETE CASCADE,
  goal_id         INTEGER REFERENCES goals(id) ON DELETE CASCADE,
  step_number     INTEGER NOT NULL,
  -- Schritt-Definition
  title           TEXT    NOT NULL,
  description     TEXT,
  step_type       TEXT    NOT NULL DEFAULT 'action',
  -- analyze | research | collect | score | update_crm | prepare_email
  -- request_approval | send | schedule | measure | report
  icon            TEXT    DEFAULT '⚡',
  color           TEXT    DEFAULT '#7c3aed',
  -- Ausführung
  status          TEXT    NOT NULL DEFAULT 'waiting',
  -- waiting | ready | running | waiting_approval | approved | completed | failed | skipped
  approval_required BOOLEAN NOT NULL DEFAULT false,
  approval_level  TEXT    DEFAULT 'notify',  -- notify | approve
  -- Ergebnis
  result          JSONB,
  result_summary  TEXT,
  error_msg       TEXT,
  -- Abhängigkeiten
  depends_on      INTEGER[],
  -- Metriken die dieser Schritt liefert
  metric_key      TEXT,
  metric_value    NUMERIC,
  -- Zeitplan
  scheduled_at    TIMESTAMPTZ,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_goal_steps_campaign ON goal_steps (campaign_id, step_number);

-- ── GOAL METRICS ─────────────────────────────────────────────────────────
-- KPI-Tracking für ein Ziel
CREATE TABLE IF NOT EXISTS goal_metrics (
  id              SERIAL PRIMARY KEY,
  goal_id         INTEGER REFERENCES goals(id) ON DELETE CASCADE,
  metric_name     TEXT    NOT NULL,
  metric_key      TEXT    NOT NULL,
  target          NUMERIC,
  current_value   NUMERIC NOT NULL DEFAULT 0,
  unit            TEXT    DEFAULT 'Stück',
  color           TEXT    DEFAULT '#10b981',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_goal_metrics_key ON goal_metrics (goal_id, metric_key);

-- ── GOAL ACTIVITY LOG ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS goal_activity (
  id              SERIAL PRIMARY KEY,
  goal_id         INTEGER REFERENCES goals(id) ON DELETE CASCADE,
  step_id         INTEGER REFERENCES goal_steps(id) ON DELETE SET NULL,
  type            TEXT    NOT NULL,   -- step_started | step_done | approval_needed | metric_updated | message
  title           TEXT    NOT NULL,
  detail          TEXT,
  data            JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_goal_activity ON goal_activity (goal_id, created_at DESC);

SELECT 'Migration 010 (Goal Engine) erfolgreich' AS status;
