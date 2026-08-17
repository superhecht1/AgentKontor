-- ═══════════════════════════════════════════════════════════════════════
-- Migration 006 – Phase 2: Planner · Approval-System
-- ═══════════════════════════════════════════════════════════════════════

-- ── PLANS ───────────────────────────────────────────────────────────────
-- Ein Plan ist ein zerlegtes Ziel mit mehreren Schritten
CREATE TABLE IF NOT EXISTS agent_plans (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id)   ON DELETE CASCADE,
  agent_id      INTEGER REFERENCES agents(id)  ON DELETE CASCADE,
  session_id    TEXT,
  goal          TEXT    NOT NULL,               -- ursprüngliches Nutzerziel
  context       TEXT,                           -- zusätzlicher Kontext
  status        TEXT    NOT NULL DEFAULT 'planning',
                -- planning | running | paused | completed | failed | cancelled
  result        TEXT,                           -- finales synthetisiertes Ergebnis
  result_data   JSONB,                          -- strukturierte Ergebnisdaten
  error_msg     TEXT,
  step_count    INTEGER NOT NULL DEFAULT 0,
  steps_done    INTEGER NOT NULL DEFAULT 0,
  model         TEXT    DEFAULT 'claude-sonnet-4-6',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_plans_user   ON agent_plans (user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_plans_agent  ON agent_plans (agent_id, status);

-- ── PLAN STEPS ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plan_steps (
  id             SERIAL PRIMARY KEY,
  plan_id        INTEGER REFERENCES agent_plans(id) ON DELETE CASCADE,
  step_number    INTEGER NOT NULL,
  title          TEXT    NOT NULL,
  description    TEXT,
  reasoning      TEXT,                          -- warum dieser Schritt nötig ist
  tool_name      TEXT,                          -- welches Tool aufgerufen wird (NULL = LLM-only)
  tool_input     JSONB   DEFAULT '{}',
  approval_level TEXT    NOT NULL DEFAULT 'auto',
                 -- auto | notify | approve
  status         TEXT    NOT NULL DEFAULT 'pending',
                 -- pending | waiting_approval | approved | rejected | running | completed | failed | skipped
  result         JSONB,                         -- Tool-Ergebnis oder LLM-Antwort
  result_summary TEXT,                          -- menschenlesbare Zusammenfassung
  error          TEXT,
  depends_on     INTEGER[],                     -- step_numbers die vorher fertig sein müssen
  approved_by    TEXT,
  approved_at    TIMESTAMPTZ,
  started_at     TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_plan_steps_plan ON plan_steps (plan_id, step_number);

-- ── APPROVAL QUEUE ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS approvals (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id)       ON DELETE CASCADE,
  agent_id        INTEGER REFERENCES agents(id)      ON DELETE SET NULL,
  plan_id         INTEGER REFERENCES agent_plans(id) ON DELETE CASCADE,
  step_id         INTEGER REFERENCES plan_steps(id)  ON DELETE CASCADE,
  task_id         INTEGER REFERENCES agent_tasks(id) ON DELETE CASCADE,
  type            TEXT    NOT NULL DEFAULT 'plan_step',
                  -- plan_step | task | direct_action
  title           TEXT    NOT NULL,
  description     TEXT,
  proposed_action JSONB   NOT NULL DEFAULT '{}',  -- {tool, input, url, method, ...}
  level           TEXT    NOT NULL DEFAULT 'approve',  -- notify | approve
  status          TEXT    NOT NULL DEFAULT 'pending',
                  -- pending | approved | rejected | expired | auto_approved
  response_note   TEXT,                          -- User-Kommentar bei Entscheidung
  expires_at      TIMESTAMPTZ DEFAULT (now() + INTERVAL '24 hours'),
  decided_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_approvals_user    ON approvals (user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_approvals_pending ON approvals (status, expires_at) WHERE status='pending';

-- ── APPROVAL RULES ───────────────────────────────────────────────────────
-- Definiert welche Aktionen welche Freigabe brauchen (pro Agent oder global)
CREATE TABLE IF NOT EXISTS approval_rules (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id)  ON DELETE CASCADE,
  agent_id        INTEGER REFERENCES agents(id) ON DELETE CASCADE, -- NULL = alle Agenten
  -- Muster: tool_name, action_type, url_pattern ('*' = alle)
  action_pattern  TEXT    NOT NULL,
  -- Beispiele: 'send_email', 'http_call', 'spend_money', 'delete_*', '*'
  level           TEXT    NOT NULL DEFAULT 'approve',
  -- auto | notify | approve
  description     TEXT,                          -- warum diese Regel
  enabled         BOOLEAN NOT NULL DEFAULT true,
  priority        INTEGER NOT NULL DEFAULT 50,   -- höhere Zahl = höhere Priorität
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_approval_rules_user ON approval_rules (user_id, agent_id);

-- Standard-Regeln (werden per Seed angelegt, nicht hier hardcoded)
-- Beispiel-Daten für Dokumentation:
-- INSERT INTO approval_rules (action_pattern, level, description)
-- VALUES
--   ('send_email',  'notify',  'E-Mails immer notifizieren'),
--   ('http_call',   'auto',    'HTTP-Calls automatisch'),
--   ('spend_money', 'approve', 'Ausgaben immer genehmigen');

SELECT 'Migration 006 (Phase 2: Planner, Approvals) erfolgreich' AS status;
