-- ═══════════════════════════════════════════════════════════════════════
-- Migration 008 – Phase 5: Multi-Agent System
-- ═══════════════════════════════════════════════════════════════════════

-- ── SPECIALIST AGENT PROFILES ───────────────────────────────────────────
-- Vordefinierte Rollen für den Super Agent (system-level, kein user_id)
CREATE TABLE IF NOT EXISTS specialist_profiles (
  id            SERIAL PRIMARY KEY,
  slug          TEXT    NOT NULL UNIQUE,  -- research | sales | support | data | marketing | finance
  name          TEXT    NOT NULL,
  emoji         TEXT    NOT NULL,
  description   TEXT    NOT NULL,
  system_prompt TEXT    NOT NULL,
  tools         TEXT[]  NOT NULL DEFAULT '{}',  -- Tool-Namen die dieser Agent nutzen darf
  capabilities  TEXT[]  NOT NULL DEFAULT '{}',
  color         TEXT    DEFAULT '#7c3aed',
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_specialist_slug ON specialist_profiles (slug);

-- ── AGENT TEAMS ──────────────────────────────────────────────────────────
-- User kann Teams aus Agenten zusammenstellen
CREATE TABLE IF NOT EXISTS agent_teams (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  description   TEXT,
  members       JSONB   NOT NULL DEFAULT '[]',
  -- [{specialist_slug, agent_id (optional custom), enabled, config}]
  is_default    BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_teams_user ON agent_teams (user_id);

-- ── SUPER AGENT SESSIONS ─────────────────────────────────────────────────
-- Eine Session = User stellt Aufgabe → Super Agent orchestriert
CREATE TABLE IF NOT EXISTS super_agent_sessions (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
  team_id         INTEGER REFERENCES agent_teams(id) ON DELETE SET NULL,
  goal            TEXT    NOT NULL,
  context         TEXT,
  status          TEXT    NOT NULL DEFAULT 'routing',
  -- routing | planning | running | synthesizing | completed | failed
  routing_result  JSONB,    -- welche Agenten wurden ausgewählt und warum
  plan            JSONB,    -- [{agent, task, tools, depends_on, status}]
  agent_results   JSONB   NOT NULL DEFAULT '{}',  -- {slug: result}
  final_result    TEXT,     -- synthesierte Antwort
  final_data      JSONB,    -- strukturierte Daten (Tabellen etc.)
  model           TEXT    DEFAULT 'claude-sonnet-4-6',
  total_duration_ms INTEGER,
  error_msg       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_super_sessions_user ON super_agent_sessions (user_id, created_at DESC);

-- ── AGENT MESSAGES ────────────────────────────────────────────────────────
-- Nachrichten zwischen Agenten innerhalb einer Session
CREATE TABLE IF NOT EXISTS agent_messages (
  id            SERIAL PRIMARY KEY,
  session_id    INTEGER REFERENCES super_agent_sessions(id) ON DELETE CASCADE,
  from_agent    TEXT    NOT NULL,  -- 'user' | 'super' | 'research' | 'sales' | ...
  to_agent      TEXT    NOT NULL,
  message_type  TEXT    NOT NULL DEFAULT 'task',
  -- task | result | error | status_update | tool_call | tool_result
  content       TEXT    NOT NULL,
  data          JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_msgs_session ON agent_messages (session_id, created_at ASC);

-- ── AGENT COLLABORATIONS ─────────────────────────────────────────────────
-- Welche Agenten haben wie oft zusammengearbeitet (Analytics)
CREATE TABLE IF NOT EXISTS agent_collaborations (
  agent_a       TEXT    NOT NULL,
  agent_b       TEXT    NOT NULL,
  count         INTEGER NOT NULL DEFAULT 1,
  last_session  TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (agent_a, agent_b)
);

-- ── STANDARD-SPECIALIST-PROFILE ANLEGEN ─────────────────────────────────
INSERT INTO specialist_profiles (slug, name, emoji, color, description, system_prompt, tools, capabilities)
VALUES
(
  'research',
  'Research Agent',
  '🔬',
  '#38bdf8',
  'Recherchiert Informationen im Web und in Dokumenten',
  'Du bist ein erfahrener Research-Spezialist. Deine Aufgabe ist es, präzise und umfassende Informationen zu sammeln, zu validieren und strukturiert zu präsentieren. Du nutzt mehrere Quellen, überprüfst Fakten und gibst immer Quellenangaben an. Sei gründlich, aber effizient.',
  ARRAY['web_search','web_scrape','web_research','analyze_document','read_from_memory'],
  ARRAY['web_search','document_analysis','fact_checking','source_validation']
),
(
  'sales',
  'Sales Agent',
  '💼',
  '#f59e0b',
  'Qualifiziert Leads, erstellt Outreach und plant Termine',
  'Du bist ein erfahrener B2B-Sales-Spezialist. Du qualifizierst Leads nach BANT, erkennst Kaufsignale, formulierst überzeugende Outreach-Nachrichten und planst effiziente Follow-ups. Du fokussierst dich auf Mehrwert, nicht auf Druck.',
  ARRAY['qualify_leads','calendar_find_slots','save_to_memory','create_task','web_search'],
  ARRAY['lead_qualification','outreach_generation','appointment_scheduling','pipeline_management']
),
(
  'support',
  'Support Agent',
  '🎧',
  '#10b981',
  'Beantwortet Kundenanfragen und löst Probleme',
  'Du bist ein empathischer Kunden-Support-Spezialist. Du verstehst Kundenprobleme schnell, findest Lösungen in der Wissensdatenbank, eskalierst wenn nötig und dokumentierst alles sorgfältig. Dein Ziel ist maximale Kundenzufriedenheit.',
  ARRAY['read_from_memory','save_to_memory','email_get_messages','web_search','create_task'],
  ARRAY['ticket_handling','faq_answering','escalation','knowledge_base']
),
(
  'data',
  'Data Agent',
  '📊',
  '#6366f1',
  'Analysiert Daten und erstellt Berichte und Visualisierungen',
  'Du bist ein präziser Daten-Analyst. Du analysierst Datensätze, erkennst Muster und Anomalien, erstellst aussagekräftige Berichte und übersetzt komplexe Zahlen in verständliche Erkenntnisse. Du arbeitest mit Fakten und kennzeichnest Annahmen.',
  ARRAY['calculate','analyze_document','web_search','read_from_memory','web_research'],
  ARRAY['data_analysis','report_generation','pattern_recognition','visualization']
),
(
  'marketing',
  'Marketing Agent',
  '📢',
  '#ec4899',
  'Erstellt Inhalte, plant Kampagnen und analysiert den Markt',
  'Du bist ein kreativer Marketing-Spezialist mit analytischem Mindset. Du erstellst überzeugende Inhalte, entwickelst Kampagnenstrategien, analysierst Wettbewerber und misst Erfolg. Du kennst Zielgruppen genau und sprichst sie präzise an.',
  ARRAY['web_search','web_research','save_to_memory','create_task','web_scrape'],
  ARRAY['content_creation','campaign_planning','competitor_analysis','market_research']
),
(
  'finance',
  'Finance Agent',
  '💰',
  '#f43f5e',
  'Analysiert Finanzdaten, Rechnungen und Budgets',
  'Du bist ein gewissenhafter Finanz-Analyst. Du prüfst Zahlen sorgfältig, erkennst finanzielle Risiken, analysierst Budgets und Cashflows, und erstellst präzise Finanzberichte. Du arbeitest compliance-konform und transparent.',
  ARRAY['calculate','analyze_document','read_from_memory','web_search','create_task'],
  ARRAY['invoice_analysis','budget_planning','financial_reporting','risk_assessment']
)
ON CONFLICT (slug) DO UPDATE SET
  name=EXCLUDED.name, description=EXCLUDED.description,
  system_prompt=EXCLUDED.system_prompt, tools=EXCLUDED.tools;

SELECT 'Migration 008 (Phase 5: Multi-Agent) erfolgreich' AS status;
