-- ═══════════════════════════════════════════════════════════════════════
-- Migration 005 – Agent Phase 1: Tool-System · Memory · Task-Engine
-- Idempotent (IF NOT EXISTS überall)
-- ═══════════════════════════════════════════════════════════════════════

-- ── TOOL REGISTRY ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tools (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  agent_id      INTEGER REFERENCES agents(id) ON DELETE CASCADE, -- NULL = global für alle Agenten des Users
  name          TEXT    NOT NULL,
  description   TEXT    NOT NULL,
  type          TEXT    NOT NULL DEFAULT 'http', -- http | sql | javascript | mcp | builtin
  -- JSON Schema der Parameter die das Tool erwartet
  parameters    JSONB   NOT NULL DEFAULT '{"type":"object","properties":{},"required":[]}',
  -- Konfiguration je nach type: {url, method, headers, body_template} / {query} / {code}
  config        JSONB   NOT NULL DEFAULT '{}',
  -- Berechtigungen: welche Rollen dürfen dieses Tool aufrufen
  permissions   TEXT[]  NOT NULL DEFAULT ARRAY['user'],
  enabled       BOOLEAN NOT NULL DEFAULT true,
  -- Sicherheit: Rate-Limit pro Minute
  rate_limit    INTEGER DEFAULT 60,
  -- Timeout in Sekunden
  timeout_s     INTEGER DEFAULT 10,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Welche Tools sind für welchen Agenten aktiv
CREATE TABLE IF NOT EXISTS agent_tools (
  agent_id      INTEGER REFERENCES agents(id)  ON DELETE CASCADE,
  tool_id       INTEGER REFERENCES tools(id)   ON DELETE CASCADE,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (agent_id, tool_id)
);

-- Audit-Log aller Tool-Aufrufe
CREATE TABLE IF NOT EXISTS tool_calls (
  id            SERIAL PRIMARY KEY,
  tool_id       INTEGER REFERENCES tools(id)   ON DELETE SET NULL,
  agent_id      INTEGER REFERENCES agents(id)  ON DELETE SET NULL,
  session_id    TEXT,
  input         JSONB,
  output        JSONB,
  status        TEXT    NOT NULL DEFAULT 'ok', -- ok | error | timeout
  duration_ms   INTEGER,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── AGENT MEMORY ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_memory (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id)   ON DELETE CASCADE,
  agent_id      INTEGER REFERENCES agents(id)  ON DELETE CASCADE,
  session_id    TEXT,   -- NULL = kein Session-Scope
  scope         TEXT    NOT NULL DEFAULT 'session',
                        -- session    = nur diese Sitzung
                        -- longterm   = dauerhaft für diesen Agenten
                        -- contact    = einem Kontakt zugeordnet (contact_id)
                        -- business   = global für den User (alle Agenten)
  contact_id    TEXT,   -- externe Kontakt-ID (E-Mail, Phone, CRM-ID)
  key           TEXT    NOT NULL,
  value         TEXT    NOT NULL,
  confidence    NUMERIC DEFAULT 1.0, -- 0.0–1.0 (wie sicher ist die Aussage)
  source        TEXT    DEFAULT 'user', -- user | agent | system | extracted
  metadata      JSONB   DEFAULT '{}',
  expires_at    TIMESTAMPTZ,          -- NULL = nie
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_scope_key
  ON agent_memory (agent_id, scope, COALESCE(session_id,''), COALESCE(contact_id,''), key);

CREATE INDEX IF NOT EXISTS idx_memory_agent_scope   ON agent_memory (agent_id, scope);
CREATE INDEX IF NOT EXISTS idx_memory_contact        ON agent_memory (agent_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_memory_session        ON agent_memory (session_id);

-- ── TASK ENGINE ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_tasks (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id)   ON DELETE CASCADE,
  agent_id      INTEGER REFERENCES agents(id)  ON DELETE CASCADE,
  session_id    TEXT,
  title         TEXT    NOT NULL,
  description   TEXT,
  type          TEXT    NOT NULL DEFAULT 'generic',
                        -- generic | http_call | email | data_export | rag_index | scheduled
  status        TEXT    NOT NULL DEFAULT 'pending',
                        -- pending | running | waiting | completed | failed | cancelled
  priority      INTEGER NOT NULL DEFAULT 5,  -- 1=highest, 10=lowest
  payload       JSONB   NOT NULL DEFAULT '{}',
  result        JSONB,
  error_msg     TEXT,
  retry_count   INTEGER NOT NULL DEFAULT 0,
  max_retries   INTEGER NOT NULL DEFAULT 3,
  retry_delay_s INTEGER NOT NULL DEFAULT 60,
  -- Scheduling
  scheduled_at  TIMESTAMPTZ DEFAULT now(),
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  -- Abhängigkeiten: erst starten wenn depends_on erledigt
  depends_on    INTEGER REFERENCES agent_tasks(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tasks_status         ON agent_tasks (status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_tasks_agent          ON agent_tasks (agent_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_user           ON agent_tasks (user_id, status);

-- Step-by-step Log jeder Task-Ausführung
CREATE TABLE IF NOT EXISTS task_logs (
  id            SERIAL PRIMARY KEY,
  task_id       INTEGER REFERENCES agent_tasks(id) ON DELETE CASCADE,
  level         TEXT    NOT NULL DEFAULT 'info',  -- debug | info | warn | error
  message       TEXT    NOT NULL,
  data          JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs (task_id, created_at DESC);

-- ── CONTACTS (für contact-Memory) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS contacts (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  external_id   TEXT,   -- E-Mail / Phone / CRM-ID
  name          TEXT,
  email         TEXT,
  phone         TEXT,
  channel       TEXT,   -- widget | whatsapp | telegram | api
  metadata      JSONB   DEFAULT '{}',
  first_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen     TIMESTAMPTZ NOT NULL DEFAULT now(),
  msg_count     INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_user_ext
  ON contacts (user_id, external_id) WHERE external_id IS NOT NULL;

SELECT 'Migration 005 (Phase 1: Tools, Memory, Tasks) erfolgreich' AS status;
