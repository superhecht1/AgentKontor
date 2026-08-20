require('dotenv').config();
const cookieParser = require('cookie-parser');
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { Pool } = require('pg');

const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET', 'ANTHROPIC_API_KEY'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) throw new Error(`❌ Env var fehlt: ${key}`);
}

const app  = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max:                    parseInt(process.env.DB_POOL_MAX)    || 20,  // FIX 11: bigger pool
  idleTimeoutMillis:      parseInt(process.env.DB_IDLE_MS)    || 30000,
  connectionTimeoutMillis:parseInt(process.env.DB_CONNECT_MS) || 5000, // FIX 4: fail fast
  statement_timeout:      parseInt(process.env.DB_STMT_MS)    || 30000,
});

async function initDb() {
  const fs = require('fs');

  // FIX 11: Migration versioning — track which migrations have run
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    VARCHAR(128) PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});


  // ── Kritische Spalten inline anlegen (vor SQL-Migrations) ──────────────────
  // Verhindert 500er wenn DB noch altes Schema hat
  const criticalAlters = [
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS model TEXT DEFAULT 'claude-sonnet-4-6'",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS api_enabled BOOLEAN DEFAULT false",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS whatsapp_enabled BOOLEAN DEFAULT false",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS whatsapp_number TEXT DEFAULT ''",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS telegram_enabled BOOLEAN DEFAULT false",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS telegram_token TEXT DEFAULT ''",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS rag_enabled BOOLEAN DEFAULT false",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS rag_prompt TEXT DEFAULT ''",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS cap_calendar BOOLEAN DEFAULT false",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS cal_link TEXT DEFAULT ''",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS cap_leads BOOLEAN DEFAULT false",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS lead_fields JSONB DEFAULT '[]'",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS lead_email TEXT DEFAULT ''",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS cap_products BOOLEAN DEFAULT false",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS products_data JSONB DEFAULT '[]'",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS cap_multilang BOOLEAN DEFAULT false",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS cap_email BOOLEAN DEFAULT false",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS smtp_host TEXT DEFAULT ''",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS smtp_port INTEGER DEFAULT 587",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS smtp_user TEXT DEFAULT ''",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS smtp_from TEXT DEFAULT ''",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS widget_position TEXT DEFAULT 'right'",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS widget_delay INTEGER DEFAULT 0",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS widget_theme TEXT DEFAULT 'dark'",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS widget_size INTEGER DEFAULT 56",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS instagram_enabled BOOLEAN DEFAULT false",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS instagram_business_id TEXT DEFAULT ''",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS facebook_enabled BOOLEAN DEFAULT false",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS facebook_page_id TEXT DEFAULT ''",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS slack_enabled BOOLEAN DEFAULT false",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS slack_channel_id TEXT DEFAULT ''",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS voice_enabled BOOLEAN DEFAULT false",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS voice_provider TEXT DEFAULT 'elevenlabs'",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS voice_id TEXT DEFAULT ''",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS voice_stability NUMERIC DEFAULT 0.5",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS stt_provider TEXT DEFAULT 'whisper'",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS data_retention_days INTEGER DEFAULT 90",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS lead_retention_days INTEGER DEFAULT 180",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS total_messages INTEGER DEFAULT 0",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS proactive_enabled BOOLEAN DEFAULT false",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS proactive_trigger TEXT DEFAULT 'time'",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS proactive_delay INTEGER DEFAULT 30",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS proactive_message TEXT DEFAULT ''",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS proactive_scroll INTEGER DEFAULT 50",
  ];
  for (const sql of criticalAlters) {
    await pool.query(sql).catch(() => {});
  }

  // ── E-Mail-Bestätigung Spalten ─────────────────────────────────────────
  const emailConfirmAlters = [
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS email_confirmed BOOLEAN DEFAULT false",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS confirm_token TEXT",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS confirm_expires TIMESTAMPTZ",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token TEXT",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_expires TIMESTAMPTZ",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS company TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS website TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT ''",
  ];
  for (const sql of emailConfirmAlters) {
    await pool.query(sql).catch(() => {});
  }

  console.log('✅ Kritische Spalten geprüft');

  // ── Phase 1-5 Tabellen direkt anlegen (nicht warten auf Migration-Tracking) ──
  const criticalTables = [
    // Phase 1: Tool-System
    `CREATE TABLE IF NOT EXISTS tools (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, description TEXT, type TEXT DEFAULT 'http',
      parameters JSONB DEFAULT '{}', config JSONB DEFAULT '{}',
      is_active BOOLEAN DEFAULT true, user_id_null BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS agent_tools (
      agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE,
      tool_id  INTEGER REFERENCES tools(id)  ON DELETE CASCADE,
      PRIMARY KEY (agent_id, tool_id)
    )`,
    `CREATE TABLE IF NOT EXISTS tool_calls (
      id SERIAL PRIMARY KEY, tool_id INTEGER REFERENCES tools(id) ON DELETE SET NULL,
      agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      input JSONB, output JSONB, status TEXT DEFAULT 'ok',
      duration_ms INTEGER, created_at TIMESTAMPTZ DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS agent_memory (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE,
      scope TEXT DEFAULT 'session', key TEXT NOT NULL, value TEXT NOT NULL,
      source TEXT DEFAULT 'system', created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS agent_tasks (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      title TEXT NOT NULL, description TEXT, type TEXT DEFAULT 'llm',
      payload JSONB DEFAULT '{}', status TEXT DEFAULT 'pending',
      priority INTEGER DEFAULT 5, retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 3, error_msg TEXT, result JSONB,
      depends_on INTEGER REFERENCES agent_tasks(id) ON DELETE SET NULL,
      session_id INTEGER,
      scheduled_at TIMESTAMPTZ DEFAULT now(),
      started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS task_logs (
      id SERIAL PRIMARY KEY, task_id INTEGER REFERENCES agent_tasks(id) ON DELETE CASCADE,
      level TEXT DEFAULT 'info', message TEXT NOT NULL,
      data JSONB, created_at TIMESTAMPTZ DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      email TEXT, name TEXT, phone TEXT, company TEXT,
      data JSONB DEFAULT '{}', tags TEXT[] DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
    )`,
    // Phase 2: Planner + Approvals
    `CREATE TABLE IF NOT EXISTS agent_plans (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      goal TEXT NOT NULL, status TEXT DEFAULT 'planning',
      result TEXT, error_msg TEXT, model TEXT DEFAULT 'claude-sonnet-4-6',
      step_count INTEGER DEFAULT 0, steps_done INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS plan_steps (
      id SERIAL PRIMARY KEY, plan_id INTEGER REFERENCES agent_plans(id) ON DELETE CASCADE,
      step_number INTEGER NOT NULL, title TEXT, description TEXT,
      tool_name TEXT, tool_input JSONB, approval_level TEXT DEFAULT 'auto',
      status TEXT DEFAULT 'pending', result_summary TEXT, error TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS approvals (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      plan_id INTEGER REFERENCES agent_plans(id) ON DELETE SET NULL,
      step_id INTEGER REFERENCES plan_steps(id) ON DELETE SET NULL,
      goal_id INTEGER,
      type TEXT DEFAULT 'plan_step', title TEXT, description TEXT,
      proposed_action JSONB, level TEXT DEFAULT 'approve',
      status TEXT DEFAULT 'pending', response_note TEXT,
      decided_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS approval_rules (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      action_pattern TEXT NOT NULL, level TEXT DEFAULT 'approve',
      description TEXT, priority INTEGER DEFAULT 50,
      enabled BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT now()
    )`,
    // Phase 3+4: Integrations
    `CREATE TABLE IF NOT EXISTS integration_credentials (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      integration TEXT NOT NULL, provider TEXT NOT NULL,
      label TEXT DEFAULT 'Standard', credentials JSONB DEFAULT '{}',
      is_active BOOLEAN DEFAULT true, last_used TIMESTAMPTZ, last_error TEXT,
      created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS research_sessions (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      goal TEXT NOT NULL, status TEXT DEFAULT 'running',
      steps JSONB DEFAULT '[]', result TEXT, result_table JSONB,
      sources JSONB DEFAULT '[]', model TEXT DEFAULT 'claude-sonnet-4-6',
      created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS web_search_cache (
      id SERIAL PRIMARY KEY, query_hash TEXT NOT NULL UNIQUE,
      query TEXT NOT NULL, results JSONB DEFAULT '[]',
      provider TEXT DEFAULT 'brave', created_at TIMESTAMPTZ DEFAULT now(),
      expires_at TIMESTAMPTZ DEFAULT (now() + INTERVAL '1 hour')
    )`,
    `CREATE TABLE IF NOT EXISTS page_content_cache (
      id SERIAL PRIMARY KEY, url_hash TEXT NOT NULL UNIQUE,
      url TEXT NOT NULL, title TEXT, content TEXT, word_count INTEGER,
      fetched_at TIMESTAMPTZ DEFAULT now(),
      expires_at TIMESTAMPTZ DEFAULT (now() + INTERVAL '6 hours')
    )`,
    // Phase 5: Multi-Agent
    `CREATE TABLE IF NOT EXISTS specialist_profiles (
      id SERIAL PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      emoji TEXT NOT NULL, description TEXT, system_prompt TEXT NOT NULL,
      tools TEXT[] DEFAULT '{}', capabilities TEXT[] DEFAULT '{}',
      color TEXT DEFAULT '#7c3aed', enabled BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS super_agent_sessions (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      goal TEXT NOT NULL, context TEXT, status TEXT DEFAULT 'routing',
      routing_result JSONB, plan JSONB, agent_results JSONB DEFAULT '{}',
      final_result TEXT, model TEXT DEFAULT 'claude-sonnet-4-6',
      total_duration_ms INTEGER, error_msg TEXT,
      created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS agent_messages (
      id SERIAL PRIMARY KEY, session_id INTEGER REFERENCES super_agent_sessions(id) ON DELETE CASCADE,
      from_agent TEXT NOT NULL, to_agent TEXT NOT NULL,
      message_type TEXT DEFAULT 'task', content TEXT NOT NULL,
      data JSONB, created_at TIMESTAMPTZ DEFAULT now()
    )`,
    // Goal Engine
    `CREATE TABLE IF NOT EXISTS goals (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      raw_goal TEXT NOT NULL, goal_type TEXT, goal_title TEXT,
      goal_metric TEXT, goal_timeframe TEXT,
      target_value NUMERIC DEFAULT 0, target_unit TEXT,
      industry TEXT, context TEXT, status TEXT DEFAULT 'analyzing',
      progress INTEGER DEFAULT 0, achieved_value NUMERIC DEFAULT 0,
      result_summary TEXT, started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS goal_campaigns (
      id SERIAL PRIMARY KEY, goal_id INTEGER REFERENCES goals(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, description TEXT, strategy TEXT,
      status TEXT DEFAULT 'draft', step_count INTEGER DEFAULT 0,
      steps_done INTEGER DEFAULT 0, current_step INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS goal_steps (
      id SERIAL PRIMARY KEY,
      campaign_id INTEGER REFERENCES goal_campaigns(id) ON DELETE CASCADE,
      goal_id INTEGER REFERENCES goals(id) ON DELETE CASCADE,
      step_number INTEGER NOT NULL, title TEXT NOT NULL,
      description TEXT, step_type TEXT DEFAULT 'action',
      icon TEXT DEFAULT '⚡', color TEXT DEFAULT '#7c3aed',
      status TEXT DEFAULT 'waiting', approval_required BOOLEAN DEFAULT false,
      approval_level TEXT DEFAULT 'notify', result JSONB,
      result_summary TEXT, error_msg TEXT, depends_on INTEGER[],
      metric_key TEXT, metric_value NUMERIC,
      started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS goal_metrics (
      id SERIAL PRIMARY KEY, goal_id INTEGER REFERENCES goals(id) ON DELETE CASCADE,
      metric_name TEXT NOT NULL, metric_key TEXT NOT NULL,
      target NUMERIC, current_value NUMERIC DEFAULT 0,
      unit TEXT DEFAULT 'Stück', color TEXT DEFAULT '#10b981',
      updated_at TIMESTAMPTZ DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS goal_activity (
      id SERIAL PRIMARY KEY, goal_id INTEGER REFERENCES goals(id) ON DELETE CASCADE,
      step_id INTEGER, type TEXT NOT NULL, title TEXT NOT NULL,
      detail TEXT, data JSONB, created_at TIMESTAMPTZ DEFAULT now()
    )`,
    // Marketplace
    `CREATE TABLE IF NOT EXISTS marketplace_categories (
      id SERIAL PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      emoji TEXT NOT NULL, description TEXT, color TEXT DEFAULT '#7c3aed',
      sort_order INTEGER DEFAULT 10, is_active BOOLEAN DEFAULT true
    )`,
    `CREATE TABLE IF NOT EXISTS marketplace_agents (
      id SERIAL PRIMARY KEY, category_slug TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, emoji TEXT NOT NULL,
      tagline TEXT NOT NULL, description TEXT NOT NULL,
      color TEXT DEFAULT '#7c3aed', system_prompt TEXT NOT NULL,
      greeting TEXT NOT NULL, tone TEXT DEFAULT 'freundlich',
      language TEXT DEFAULT 'de', quick_chips JSONB DEFAULT '[]',
      suggested_tools TEXT[] DEFAULT '{}', capabilities JSONB DEFAULT '{}',
      preview_messages JSONB DEFAULT '[]', tags TEXT[] DEFAULT '{}',
      install_count INTEGER DEFAULT 0, rating_avg NUMERIC DEFAULT 0,
      rating_count INTEGER DEFAULT 0, is_featured BOOLEAN DEFAULT false,
      is_active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS marketplace_installations (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      marketplace_id INTEGER REFERENCES marketplace_agents(id) ON DELETE CASCADE,
      agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      installed_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (user_id, marketplace_id)
    )`,
    // API Keys
    `CREATE TABLE IF NOT EXISTS api_keys (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      label TEXT DEFAULT 'Standard', key_prefix TEXT, key_hash TEXT,
      is_active BOOLEAN DEFAULT true, last_used TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now()
    )`,
  
    // Migration 011: Agent Listings
    `CREATE TABLE IF NOT EXISTS agent_listings (
      id SERIAL PRIMARY KEY, agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL, tagline TEXT NOT NULL, description TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'sonstiges', tags TEXT[] DEFAULT '{}',
      emoji TEXT NOT NULL DEFAULT '🤖', color TEXT DEFAULT '#7c3aed',
      price_model TEXT NOT NULL DEFAULT 'monthly', price_cents INTEGER NOT NULL DEFAULT 0,
      hide_prompt BOOLEAN NOT NULL DEFAULT true, preview_msgs JSONB DEFAULT '[]',
      quick_chips JSONB DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'draft', reject_reason TEXT,
      install_count INTEGER DEFAULT 0, revenue_cents INTEGER DEFAULT 0,
      rating_avg NUMERIC DEFAULT 0, rating_count INTEGER DEFAULT 0,
      submitted_at TIMESTAMPTZ, approved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS listing_purchases (
      id SERIAL PRIMARY KEY, listing_id INTEGER REFERENCES agent_listings(id) ON DELETE CASCADE,
      buyer_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      seller_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      price_cents INTEGER NOT NULL DEFAULT 0, platform_fee_pct NUMERIC DEFAULT 20,
      stripe_payment_id TEXT, stripe_sub_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      purchased_at TIMESTAMPTZ DEFAULT now(), expires_at TIMESTAMPTZ, cancelled_at TIMESTAMPTZ,
      UNIQUE (listing_id, buyer_id)
    )`,
    `CREATE TABLE IF NOT EXISTS listing_reviews (
      id SERIAL PRIMARY KEY, listing_id INTEGER REFERENCES agent_listings(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5), review_text TEXT,
      created_at TIMESTAMPTZ DEFAULT now(), UNIQUE (listing_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS seller_payouts (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      amount_cents INTEGER NOT NULL, status TEXT DEFAULT 'pending',
      period_start DATE, period_end DATE, stripe_payout_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    )`,
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS listing_id INTEGER REFERENCES agent_listings(id) ON DELETE SET NULL`,
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS is_listed BOOLEAN DEFAULT false`,


    // ── Tabellen nachrüsten ──────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS agent_documents (
      id SERIAL PRIMARY KEY, agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE,
      filename TEXT NOT NULL, file_size INTEGER DEFAULT 0, chunk_count INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS agent_document_chunks (
      id SERIAL PRIMARY KEY, document_id INTEGER REFERENCES agent_documents(id) ON DELETE CASCADE,
      agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL, content TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS marketplace_ratings (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      marketplace_id INTEGER REFERENCES marketplace_agents(id) ON DELETE CASCADE,
      rating INTEGER CHECK (rating BETWEEN 1 AND 5), review TEXT,
      created_at TIMESTAMPTZ DEFAULT now(), UNIQUE(user_id, marketplace_id))`,
    `CREATE TABLE IF NOT EXISTS marketplace_installations (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      marketplace_id INTEGER REFERENCES marketplace_agents(id) ON DELETE CASCADE,
      agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      installed_at TIMESTAMPTZ DEFAULT now(), UNIQUE(user_id, marketplace_id))`,
    `CREATE TABLE IF NOT EXISTS plans (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      title TEXT NOT NULL, status TEXT DEFAULT 'draft',
      created_at TIMESTAMPTZ DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL, type TEXT DEFAULT 'generic', status TEXT DEFAULT 'pending',
      priority INTEGER DEFAULT 5, payload JSONB DEFAULT '{}', result JSONB,
      retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 3,
      created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS research_results (
      id SERIAL PRIMARY KEY, session_id INTEGER REFERENCES research_sessions(id) ON DELETE CASCADE,
      url TEXT, title TEXT, content TEXT, summary TEXT, relevance_score NUMERIC,
      created_at TIMESTAMPTZ DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE,
      channel TEXT DEFAULT 'widget', created_at TIMESTAMPTZ DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY, agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name TEXT, email TEXT, phone TEXT, message TEXT, platform TEXT DEFAULT 'widget',
      created_at TIMESTAMPTZ DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS webhooks (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE,
      name TEXT, url TEXT NOT NULL, events TEXT[] DEFAULT '{}',
      secret TEXT, is_active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS referral_codes (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      code TEXT UNIQUE NOT NULL, conversion_count INTEGER DEFAULT 0, click_count INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS referral_conversions (
      id SERIAL PRIMARY KEY, referral_code_id INTEGER REFERENCES referral_codes(id) ON DELETE CASCADE,
      referrer_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      referred_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      converted_at TIMESTAMPTZ DEFAULT now(), UNIQUE(referred_user_id))`,
    `CREATE TABLE IF NOT EXISTS workspaces (
      id SERIAL PRIMARY KEY, owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, slug TEXT UNIQUE, plan TEXT DEFAULT 'free',
      created_at TIMESTAMPTZ DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS workspace_members (
      id SERIAL PRIMARY KEY, workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      role TEXT DEFAULT 'member', joined_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(workspace_id, user_id))`,
    // Memory Spalten nachrüsten
  ];
  for (const sql of criticalTables) {
    await pool.query(sql).catch(e => {
      if (!e.message.includes('already exists')) {
        console.warn('Table create warning:', e.message.slice(0, 80));
      }
    });
  }
  // Fehlende Spalten in bereits existierenden Tabellen ergänzen
  await pool.query("ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS depends_on INTEGER REFERENCES agent_tasks(id) ON DELETE SET NULL").catch(()=>{});
  await pool.query("ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS session_id INTEGER").catch(()=>{});
  await pool.query("ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()").catch(()=>{});
  await pool.query("ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL").catch(()=>{});
  await pool.query("ALTER TABLE approvals ADD COLUMN IF NOT EXISTS goal_id INTEGER").catch(()=>{});
  console.log('✅ Kritische Tabellen geprüft');

  // ── Marketplace Seeds (läuft jedes Mal, idempotent) ─────────────────────
  const mktSeeds = [
    `INSERT INTO marketplace_categories (slug,name,emoji,description,color,sort_order) VALUES
      ('vertrieb','Vertrieb','💼','KI-Agenten für Vertrieb & Sales','#5b4fcf',1),
      ('gastro','Gastronomie','🍽️','Agenten für Restaurant, Café & Co.','#e67e22',2),
      ('praxis','Arztpraxis','🏥','DSGVO-konforme Praxis-Agenten','#27ae60',3),
      ('immobilien','Immobilien','🏡','Agenten für Makler & Verwaltungen','#2980b9',4)
    ON CONFLICT (slug) DO NOTHING`,
    `INSERT INTO marketplace_agents (category_slug,slug,name,emoji,tagline,description,color,system_prompt,greeting,tone,language,quick_chips,is_featured,install_count)
    VALUES
      ('vertrieb','lead-hunter','Lead Hunter','🎯','Qualifiziert Leads automatisch nach BANT',
       'Spricht Interessenten an, stellt BANT-Fragen (Budget, Authority, Need, Timeline) und bewertet die Lead-Qualität. Leitet vielversprechende Kontakte an dein Vertriebsteam weiter.',
       '#5b4fcf',
       'Du bist ein professioneller Vertriebsassistent. Qualifiziere Interessenten freundlich nach dem BANT-Prinzip. Frage nach Budget, Entscheidungsträger, Bedarf und Zeitplan. Bei qualifizierten Leads biete einen Termin an. Sei professionell und überzeugend, aber nicht aufdringlich.',
       'Hallo! Ich helfe dir dabei, die richtige Lösung für dein Unternehmen zu finden. Darf ich kurz ein paar Fragen stellen?',
       'professionell','de',
       ''[{"label":"Preise anfragen","action":"Ich möchte die Preise erfahren"},{"label":"Demo buchen","action":"Ich möchte eine Demo"},{"label":"Erstgespräch","action":"Ich hätte Interesse an einem Erstgespräch"}]'',
       true, 127)
    ON CONFLICT (slug) DO NOTHING`,
    `INSERT INTO marketplace_agents (category_slug,slug,name,emoji,tagline,description,color,system_prompt,greeting,tone,language,quick_chips,is_featured,install_count)
    VALUES
      ('vertrieb','sales-assistant','Sales Assistant','💼','Beantwortet Produktfragen und erstellt Angebote',
       'Beantwortet Produktfragen, erstellt individuelle Angebote und leitet Interessenten Schritt für Schritt durch den Kaufprozess.',
       '#7c3aed',
       'Du bist ein kompetenter Sales Assistant. Beantworte Produktfragen präzise, erstelle auf Anfrage Angebote und leite Interessenten durch den Kaufprozess. Bleib stets freundlich und hilfreich.',
       'Willkommen! Ich beantworte gerne alle Fragen zu unseren Produkten und Leistungen. Womit kann ich dir helfen?',
       'freundlich','de',
       ''[{"label":"Produktinfo","action":"Was bietet ihr an?"},{"label":"Angebot anfragen","action":"Ich möchte ein Angebot"}]'',
       true, 89)
    ON CONFLICT (slug) DO NOTHING`,
    `INSERT INTO marketplace_agents (category_slug,slug,name,emoji,tagline,description,color,system_prompt,greeting,tone,language,quick_chips,install_count)
    VALUES
      ('vertrieb','followup-agent','Follow-up Agent','📧','Automatische Follow-ups nach jedem Gespräch',
       'Schreibt personalisierte Follow-up-Nachrichten nach Gesprächen und hält Kontakt zu Interessenten bis zur Entscheidung.',
       '#a29bfe',
       'Du bist ein freundlicher Follow-up-Assistent. Erinnere Interessenten sanft an vereinbarte nächste Schritte. Biete Mehrwert statt Druck. Frage nach dem aktuellen Stand und ob Fragen offen sind.',
       'Hallo! Ich melde mich kurz nach unserem letzten Gespräch. Gibt es noch offene Fragen?',
       'freundlich','de','[]',67)
    ON CONFLICT (slug) DO NOTHING`,
    `INSERT INTO marketplace_agents (category_slug,slug,name,emoji,tagline,description,color,system_prompt,greeting,tone,language,quick_chips,is_featured,install_count)
    VALUES
      ('gastro','bestell-agent','Bestell-Agent','🍽️','Nimmt Bestellungen entgegen und erklärt die Karte',
       'Nimmt digitale Bestellungen entgegen, erklärt die Speisekarte detailliert, informiert über Allergene und Sonderwünsche.',
       '#e67e22',
       'Du bist der freundliche Bestell-Assistent des Restaurants. Beantworte Fragen zur Speisekarte, nimm Bestellungen entgegen, weise auf Allergene hin. Frage bei Unklarheiten nach. Sei herzlich und professionell.',
       'Willkommen! Ich helfe dir gerne bei deiner Bestellung. Was darf es heute sein?',
       'herzlich','de',
       ''[{"label":"Speisekarte","action":"Zeig mir die Speisekarte"},{"label":"Tagesangebot","action":"Was ist heute empfehlenswert?"},{"label":"Allergene","action":"Welche Allergene sind enthalten?"}]'',
       true, 203)
    ON CONFLICT (slug) DO NOTHING`,
    `INSERT INTO marketplace_agents (category_slug,slug,name,emoji,tagline,description,color,system_prompt,greeting,tone,language,quick_chips,install_count)
    VALUES
      ('gastro','reservierungs-agent','Reservierungs-Agent','📅','Tische buchen rund um die Uhr',
       'Nimmt Tischreservierungen entgegen, sendet Bestätigungen und fragt Sonderwünsche ab — komplett automatisch.',
       '#f39c12',
       'Du bist der Reservierungsassistent. Nimm Tischreservierungen entgegen. Frage nach: Datum, Uhrzeit, Personenzahl, Name und Telefonnummer. Frage nach Sonderwünschen (Geburtstag, Allergien). Bestätige die Reservierung.',
       'Guten Tag! Gerne nehme ich Ihre Tischreservierung entgegen. Für wann und wie viele Personen planen Sie?',
       'höflich','de','[]',156)
    ON CONFLICT (slug) DO NOTHING`,
    `INSERT INTO marketplace_agents (category_slug,slug,name,emoji,tagline,description,color,system_prompt,greeting,tone,language,quick_chips,install_count)
    VALUES
      ('gastro','bewertungs-agent','Bewertungs-Agent','⭐','Holt Kundenfeedback und leitet es weiter',
       'Bittet nach dem Besuch um Feedback, sammelt Bewertungen und leitet negative Rückmeldungen direkt ans Management.',
       '#e74c3c',
       'Du bist der Feedback-Assistent. Bedanke dich für den Besuch und bitte freundlich um eine Bewertung. Frage nach dem Gesamterlebnis, Essen und Service. Bei negativem Feedback zeige Verständnis und biete an, das Problem weiterzuleiten.',
       'Vielen Dank für Ihren Besuch! Wir würden uns sehr über Ihr Feedback freuen. Wie war Ihr Erlebnis bei uns?',
       'herzlich','de','[]',98)
    ON CONFLICT (slug) DO NOTHING`,
    `INSERT INTO marketplace_agents (category_slug,slug,name,emoji,tagline,description,color,system_prompt,greeting,tone,language,quick_chips,is_featured,install_count)
    VALUES
      ('praxis','termin-agent','Termin-Agent','🏥','Arzttermine buchen und verwalten',
       'Bucht Arzttermine, schickt Erinnerungen, verwaltet Absagen — DSGVO-konform und rund um die Uhr.',
       '#27ae60',
       'Du bist der Terminassistent der Arztpraxis. Nimm Terminanfragen entgegen. Frage nach: Name, Geburtsdatum, Versicherung (GKV/PKV), Anliegen und gewünschtem Termin. Hinweis: Du kannst keine Diagnosen stellen. Bei Notfällen sofort an 112 verweisen.',
       'Guten Tag! Ich helfe Ihnen gerne bei der Terminvereinbarung. Für welches Anliegen möchten Sie einen Termin?',
       'professionell','de',
       ''[{"label":"Ersttermin","action":"Ich bin Neupazient und möchte einen Ersttermin"},{"label":"Kontrolltermin","action":"Ich brauche einen Kontrolltermin"},{"label":"Rezept","action":"Ich benötige ein Rezept"}]'',
       true,178)
    ON CONFLICT (slug) DO NOTHING`,
    `INSERT INTO marketplace_agents (category_slug,slug,name,emoji,tagline,description,color,system_prompt,greeting,tone,language,quick_chips,install_count)
    VALUES
      ('praxis','dokumentations-agent','Dokumentations-Agent','📋','DSGVO-konforme Praxis-Dokumentation',
       'Fasst Gespräche zusammen und erstellt DSGVO-konforme Dokumentationen für die Praxis.',
       '#2ecc71',
       'Du bist ein professioneller Dokumentationsassistent für medizinische Praxen. Hilf bei der strukturierten Erfassung von Patienteninformationen. Beachte streng den Datenschutz. Erstelle keine Diagnosen.',
       'Guten Tag! Ich unterstütze Sie bei der Erfassung Ihrer Anliegen für unsere Unterlagen.',
       'professionell','de','[]',87)
    ON CONFLICT (slug) DO NOTHING`,
    `INSERT INTO marketplace_agents (category_slug,slug,name,emoji,tagline,description,color,system_prompt,greeting,tone,language,quick_chips,install_count)
    VALUES
      ('praxis','patienten-service','Patienten-Service','💬','Erstfragen beantworten und Abläufe erklären',
       'Beantwortet Patientenfragen zu Abläufen, Öffnungszeiten und Leistungen. Leitet bei Notfällen sofort weiter.',
       '#1abc9c',
       'Du bist der Patientenservice-Assistent. Beantworte Fragen zu Praxisabläufen, Öffnungszeiten, Leistungen und Vorbereitung auf Untersuchungen. Bei medizinischen Fragen weise darauf hin, dass diese im persönlichen Gespräch mit dem Arzt besprochen werden. Bei Notfällen: sofort 112 nennen.',
       'Willkommen in unserer Praxis! Wie kann ich Ihnen weiterhelfen?',
       'freundlich','de',
       ''[{"label":"Öffnungszeiten","action":"Wann haben Sie geöffnet?"},{"label":"Leistungen","action":"Welche Leistungen bieten Sie an?"},{"label":"Notfall","action":"Ich habe einen Notfall"}]'',
       134)
    ON CONFLICT (slug) DO NOTHING`,
    `INSERT INTO marketplace_agents (category_slug,slug,name,emoji,tagline,description,color,system_prompt,greeting,tone,language,quick_chips,is_featured,install_count)
    VALUES
      ('immobilien','expose-agent','Exposé-Agent','🏡','Objekte erklären und Fragen beantworten',
       'Erklärt Immobilien-Objekte, beantwortet Fragen zu Lage, Ausstattung und Preis, und qualifiziert Kaufinteressenten.',
       '#2980b9',
       'Du bist ein kompetenter Immobilienberater. Beantworte Fragen zu Objekten präzise und professionell. Frage bei Interesse nach: Budget, gewünschte Lage, Größe, Einzugstermin. Biete bei ernstem Interesse eine Besichtigung an.',
       'Herzlich willkommen! Ich beantworte Ihre Fragen zu unseren Immobilien-Angeboten. Welches Objekt interessiert Sie?',
       'professionell','de',
       ''[{"label":"Lage","action":"Wie ist die Lage des Objekts?"},{"label":"Preis","action":"Was kostet die Immobilie?"},{"label":"Besichtigung","action":"Ich möchte eine Besichtigung"}]'',
       true,112)
    ON CONFLICT (slug) DO NOTHING`,
    `INSERT INTO marketplace_agents (category_slug,slug,name,emoji,tagline,description,color,system_prompt,greeting,tone,language,quick_chips,install_count)
    VALUES
      ('immobilien','lead-qualifizierer','Lead-Qualifizierer','🔍','Kaufinteressenten filtern und Termine buchen',
       'Filtert ernsthafte Kaufinteressenten heraus, qualifiziert Budget und Zeitplan, bucht direkt Besichtigungstermine.',
       '#3498db',
       'Du bist ein erfahrener Immobilien-Qualifier. Frage systematisch nach: Budget, gewünschte Lage und Größe, Zeitplan, Eigenkapital, Vorfinanzierung. Bewerte die Lead-Qualität intern. Bei qualifizierten Interessenten biete sofort eine Besichtigung an.',
       'Guten Tag! Um Sie optimal beraten zu können, stelle ich Ihnen kurz ein paar Fragen zu Ihren Vorstellungen.',
       'professionell','de','[]',78)
    ON CONFLICT (slug) DO NOTHING`,
    `INSERT INTO marketplace_agents (category_slug,slug,name,emoji,tagline,description,color,system_prompt,greeting,tone,language,quick_chips,install_count)
    VALUES
      ('immobilien','besichtigungs-agent','Besichtigungs-Agent','📍','Besichtigungen planen und nachbereiten',
       'Plant Besichtigungstermine, sendet Erinnerungen, erfasst Feedback danach und verwaltet den gesamten Ablauf.',
       '#1a6ea0',
       'Du bist der Besichtigungskoordinator. Stimme Besichtigungstermine mit Interessenten ab. Frage nach verfügbaren Zeitfenstern, erkläre den Ablauf. Nach der Besichtigung: frage nach Feedback und Interesse. Bei positivem Feedback: leite zu nächsten Schritten weiter.',
       'Sehr geehrte/r Interessent/in, ich koordiniere Ihren Besichtigungstermin. Wann haben Sie Zeit?',
       'professionell','de','[]',65)
    ON CONFLICT (slug) DO NOTHING`,
  ];
  for (const seed of mktSeeds) {
    await pool.query(seed.replace(/'{2}/g, "'")).catch(e => {
      if (!e.message.includes('unique')) console.warn('Marketplace seed:', e.message.slice(0,80));
    });
  }
  console.log('✅ Marketplace Seeds geprüft (12 Agenten)');



  const sqls = [
    'migrations/init.sql',
    'migrations/add_rag.sql',
    'migrations/add_capabilities.sql',
    'migrations/add_identity.sql',
    'migrations/add_models.sql',
    'migrations/add_features.sql',
    'migrations/add_extras.sql',
    'migrations/add_security.sql',
    'migrations/add_reset.sql',
    'migrations/add_privacy.sql',
    'migrations/add_features2.sql',
    'migrations/add_features3.sql',
    'migrations/add_features4.sql',
    'migrations/add_features5.sql',
    'migrations/add_privacy2.sql',
    'migrations/add_security2.sql',
    'migrations/add_features6.sql',
    'migrations/add_indexes.sql',
    'migrations/004_add_missing_agent_columns.sql',
    'migrations/005_agent_phase1.sql',
    'migrations/006_planner_approvals.sql',
    'migrations/007_integrations_webagent.sql',
    'migrations/008_multi_agent.sql',
    'migrations/009_marketplace.sql',
    'migrations/010_goal_engine.sql',
  ];
  for (const file of sqls) {
    const fp = path.join(__dirname, file);
    if (!fs.existsSync(fp)) continue;
    try {
      // Check if already applied
      const applied = await pool.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [file]);
      if (applied.rows.length) { continue; }

      const sql   = fs.readFileSync(fp, 'utf8');
      const stmts = sql.split(';').map(s => s.trim()).filter(s => s.length > 3 && !s.startsWith('--'));
      for (const stmt of stmts) {
        try { await pool.query(stmt); }
        catch(e) {
          const m = e.message;
          if (m.includes('already exists') || m.includes('does not exist') ||
              m.includes('duplicate') || m.includes('extension') ||
              m.includes('ivfflat') || m.includes('vector')) continue;
          console.warn(`  ⚠ ${file}: ${m.slice(0,100)}`);
        }
      }
      await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
      console.log('✅ Migration applied:', file);
    } catch(e) { console.error('❌ Migration failed:', file, e.message); }
  }
  console.log('✅ DB ready');
}

app.locals.pool = pool;

// Helmet + CSP
try {
  const helmet = require('helmet');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc:  ["'self'"],
        scriptSrc:   ["'self'", "'unsafe-eval'", "'unsafe-inline'",
                       "unpkg.com", "https://unpkg.com",
                       "cdnjs.cloudflare.com", "https://cdnjs.cloudflare.com"],
        styleSrc:    ["'self'", "'unsafe-inline'",
                       "fonts.googleapis.com", "https://fonts.googleapis.com"],
        fontSrc:     ["'self'", "fonts.gstatic.com", "https://fonts.gstatic.com", "data:"],
        imgSrc:      ["'self'", "data:", "https:", "blob:"],
        connectSrc:  ["'self'",
                       "https://api.anthropic.com",
                       "https://generativelanguage.googleapis.com",
                       "https://fonts.googleapis.com",
                       "https://fonts.gstatic.com"],
        workerSrc:   ["'self'"],  // für Service Worker
        frameSrc:    ["'none'"],
        objectSrc:   ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
} catch { console.warn('⚠ helmet nicht installiert'); }

// Stripe raw body before json
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

const allowedOrigin = process.env.CORS_ORIGIN ||
  (process.env.NODE_ENV === 'production' ? 'https://agentkontor.de' : '*');

// FIX 1: Widget endpoints need open CORS (embedded on any customer domain)
// App/Auth endpoints stay restricted
app.use('/api/chat/stream', cors({ origin: '*', credentials: false }));
app.use('/api/chat/web',    cors({ origin: '*', credentials: false }));
app.use('/api/chat/widget-config', cors({ origin: '*', credentials: false }));
app.use('/api/widget',      cors({ origin: '*', credentials: false }));
app.use('/api/voice/speak', cors({ origin: '*', credentials: false }));

// All other endpoints: restricted CORS
app.use(cors({ origin: allowedOrigin, credentials: true }));
app.use(cookieParser());

// Zusätzliche Security-Headers (ergänzend zu Helmet)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }
  next();
});

app.use(express.json({ limit: '5mb' }));
// FIX 5: Compression middleware (gzip/br)
try {
  const compression = require('compression');
  app.use(compression({ threshold: 1024 })); // only compress >1KB
} catch { console.warn('compression not installed: npm install compression'); }

// index.html wird durch explizite Route mit Clear-Site-Data geliefert
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.setHeader('Clear-Site-Data', '"cache", "storage"');
  // Explizite CSP fuer Landing Page (Alpine.js benoetigt unsafe-eval)
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: https: blob:",
    "connect-src 'self' https://api.anthropic.com https://fonts.googleapis.com",
    "frame-src 'none'",
    "object-src 'none'",
  ].join('; '));
  const html = require('fs').readFileSync(
    require('path').join(__dirname, 'public', 'index.html'), 'utf8'
  );
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.use(express.static(path.join(__dirname, 'public'), {
    index: false,   // WICHTIG: verhindert auto-serve von index.html für /
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      } else if (filePath.match(/\.(js|css|png|svg|ico)$/)) {
        res.setHeader('Cache-Control', 'public, max-age=3600');
      }
    }
  }));

// Health check endpoint
app.get('/og-image.png', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(require('path').join(__dirname, 'public', 'og-image.svg'));
});

app.get('/health', async (req, res) => {
  const start = Date.now();
  try {
    await pool.query('SELECT 1');
    const dbMs = Date.now() - start;
    const memMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    res.json({
      status: dbMs < 2000 ? 'ok' : 'degraded',
      db: 'connected', db_ms: dbMs,
      uptime: Math.round(process.uptime()),
      memory_mb: memMb,
      ts: new Date().toISOString(),
    });
  } catch(e) {
    res.status(503).json({ status: 'error', db: 'disconnected', db_ms: Date.now()-start });
  }
});

// Auth rate limiter — fail CLOSED
const authLimiter = async (req, res, next) => {
  try {
    const { rateLimit } = require('./middleware/plan-gate');
    const ip = req.ip || 'unknown';
    const r  = await rateLimit(pool, `auth:${ip}`, 30);
    if (!r.allowed) return res.status(429).json({ error: 'Zu viele Anfragen. Bitte später versuchen.' });
    next();
  } catch(e) {
    console.error('Rate limiter error:', e.message);
    return res.status(503).json({ error: 'Dienst vorübergehend nicht verfügbar' });
  }
};

// ── ROUTES ──────────────────────────────────────────────
app.use('/api/auth',          authLimiter, require('./routes/auth'));
app.use('/api/auth',          require('./routes/auth-extra'));
app.use('/api/agents',        require('./routes/agents'));
app.use('/api/chat',          require('./routes/chat'));
app.use('/api/keys',          require('./routes/keys'));
app.use('/api/analytics',     require('./routes/analytics'));
app.use('/api/account',       require('./routes/account'));
app.use('/api/stripe',        require('./routes/stripe'));
app.use('/api/webhooks-out',  require('./routes/webhooks-out'));
app.use('/api/conversations', require('./routes/conversations'));
app.use('/api/admin',         require('./routes/admin'));
app.use('/api/finetune',      require('./routes/finetune'));
app.use('/api/identity',      require('./routes/identity'));
app.use('/api/models',        require('./routes/model-api'));
app.use('/webhook',           require('./routes/webhooks'));
app.use('/api',               require('./routes/extras'));
app.use('/api/voice',         require('./routes/voice'));
app.use('/api/actions',       require('./routes/actions'));
app.use('/api/workspace',     require('./routes/workspace'));
app.use('/api/auth',          require('./routes/twofa'));
app.use('/api/referral',      require('./routes/referral'));
app.use('/api/invoices',      require('./routes/invoices'));
app.use('/webhook',           require('./routes/social-webhooks'));
app.use('/webhook',           require('./routes/slack-webhook')); // feedback, cron, changelog, handoff, versions


// ── Rate Limiter für AI-Endpunkte ─────────────────────────────────────────
const aiLimiter = async (req, res, next) => {
  try {
    const { rateLimit } = require('./middleware/plan-gate');
    const key = `ai:${req.ip}`;
    const r   = await rateLimit(pool, key, 60); // 60 Req/Min pro IP
    if (!r.allowed) return res.status(429).json({ error: 'Zu viele Anfragen. Bitte 1 Minute warten.' });
    next();
  } catch { next(); } // fail OPEN für AI (nie blockieren wenn Limiter kaputt)
};

// ── Phase 1: Tool-System, Memory, Task-Engine ──────────────────────────────
app.use('/api/tools',     require('./routes/tools'));
app.use('/api/memory',    require('./routes/memory'));
app.use('/api/tasks',     require('./routes/tasks'));

// ── Phase 2: Planner, Approval-System ──────────────────────────────────────
app.use('/api/planner',        aiLimiter, require('./routes/planner'));
app.use('/api/approvals',      require('./routes/approvals'));

// ── Phase 3+4: Integrations, Web-Agent ─────────────────────────────────────
app.use('/api/integrations',   require('./routes/integrations'));
app.use('/api/web',            aiLimiter, require('./routes/web-agent'));

// ── Phase 5: Super Agent / Multi-Agent ─────────────────────────────────────
app.use('/api/super',          aiLimiter, require('./routes/super-agent'));

// ── Agent Marketplace ───────────────────────────────────────────────────────
app.use('/api/listings',         require('./routes/listings'));
app.use('/api/marketplace',    require('./routes/marketplace'));

// ── Super Agent Mode: Goal Engine ──────────────────────────────────────────
app.use('/api/goals',          aiLimiter, require('./routes/goals'));

try {
  app.use('/api/rag', require('./routes/rag'));
  console.log('✅ RAG routes loaded');
} catch(e) {
  console.warn('⚠️  RAG skipped:', e.message);
  app.use('/api/rag', (req, res) => res.status(503).json({ error: 'RAG not available' }));
}

// ── PAGES ────────────────────────────────────────────────
app.get('/chat/:publicId',          (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));




// ── DEMO CHAT ENDPOINT (Landing Page, kein Auth nötig) ───────────────────────
// Einfacher In-Memory Rate-Limiter für Demo (kein externes Paket nötig)
const _demoRequests = new Map();
const demoLimiter = (req, res, next) => {
  const ip  = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const key = `demo:${ip}`;
  const rec = _demoRequests.get(key) || { count: 0, reset: now + 60000 };
  if (now > rec.reset) { rec.count = 0; rec.reset = now + 60000; }
  rec.count++;
  _demoRequests.set(key, rec);
  if (rec.count > 15) return res.status(429).json({ error: 'Zu viele Anfragen. Bitte warte kurz.' });
  next();
};

app.post('/api/demo/chat', demoLimiter, async (req, res) => {
  const { messages } = req.body;
  if (!messages?.length) return res.status(400).json({ error: 'Keine Nachrichten' });
  if (messages.length > 10) return res.status(400).json({ error: 'Zu viele Nachrichten' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Demo nicht verfügbar' });

  const systemPrompt = `Du bist der Demo-Agent von AgentKontor — einer KI-Agentur-Plattform für deutsche Unternehmen.

Deine Aufgabe: Besucher von AgentKontor begeistern und ihre Fragen beantworten.

WICHTIGE FAKTEN über AgentKontor:
- Kostenloser Plan: 3 Agenten, 500 Nachrichten/Monat
- Pro Plan: €19/Monat, unbegrenzte Agenten, 10.000 Nachrichten
- 14 KI-Modelle: Claude, GPT-4o, Gemini, Mistral (🇪🇺 EU), Groq, DeepSeek
- Super Agent Mode: Gibt ein Ziel an, AgentKontor erstellt automatisch Kampagnen
- Multi-Agent System: 6 Spezialisten (Research, Sales, Support, Data, Marketing, Finance)
- Agent Marketplace: 12 vorgefertigte Branchen-Agenten
- Web-Agent: Recherchiert selbstständig im Internet
- Planner & Approvals: Mehrstufige Pläne mit Freigabe-System
- WhatsApp Business API, Telegram, Website-Widget
- Integrationen: Google Calendar, Gmail, CRM
- DSGVO-konform, Server in Deutschland
- Vergleich: Mehr Features als Chatbase oder Tidio zum gleichen Preis

Antworte auf Deutsch, sei freundlich und enthusiastisch. Halte Antworten kurz (2-4 Sätze).
Wenn jemand Interesse zeigt, lade ihn ein sich kostenlos zu registrieren unter agentkontor.de/app`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: systemPrompt,
        messages: messages.slice(-6).map(m => ({
          role: m.role === 'user' ? 'user' : 'assistant',
          content: m.content.slice(0, 500),
        })),
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(500).json({ error: 'KI-Fehler: ' + (err.error?.message || response.status) });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || 'Entschuldigung, ich konnte keine Antwort generieren.';
    res.json({ message: text });
  } catch(e) {
    console.error('DEMO CHAT:', e.message);
    res.status(500).json({ error: 'Demo vorübergehend nicht verfügbar.' });
  }
});

// Vergleichsseiten
app.get('/vergleich/:competitor', (req, res) => {
  const map = { chatbase:'vergleich-chatbase.html', tidio:'vergleich-tidio.html', userlike:'vergleich-userlike.html' };
  const file = map[req.params.competitor];
  if (!file) return res.status(404).send('Nicht gefunden');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(require('path').join(__dirname, 'public', file));
});

app.get('/app',                     (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));


app.get('/app/*',                   (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));
app.get('/admin',                   (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/docs',                    (req, res) => res.sendFile(path.join(__dirname, 'public', 'docs.html')));
app.get('/docs.html',               (req, res) => res.sendFile(path.join(__dirname, 'public', 'docs.html')));
app.get('/avv.html',                (req, res) => res.sendFile(path.join(__dirname, 'public', 'avv.html')));
app.get('/cookie-richtlinie.html',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'cookie-richtlinie.html')));
app.get('/impressum.html',          (req, res) => res.sendFile(path.join(__dirname, 'public', 'impressum.html')));
app.get('/datenschutz.html',        (req, res) => res.sendFile(path.join(__dirname, 'public', 'datenschutz.html')));
app.get('/agb.html',                (req, res) => res.sendFile(path.join(__dirname, 'public', 'agb.html')));
// (index.html Route ist oben bei express.static)
// FIX 10: API 404 handler — return JSON not HTML
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: `Endpoint nicht gefunden: ${req.method} ${req.originalUrl}` });
});

app.get('*',                        (req, res) => res.redirect('/'));

// FIX 6: Global error handler middleware (must be last)
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Interner Serverfehler' : err.message,
  });
});

initDb().then(async () => {
  // Ensure all required DB columns exist (idempotent, runs once at startup)
  try {
    const { ensureColumnsOnce } = require('./routes/auth');
    await ensureColumnsOnce(pool);
    console.log('✅ DB columns verified');
  } catch(e) { console.warn('ensureColumns:', e.message); }

  const server = app.listen(PORT, () => {
    console.log(`🚀 AgentKontor on port ${PORT}`);
    // Task-Engine Hintergrundprozessor starten (alle 5s nach fälligen Tasks schauen)
    try {
      const { taskRunner } = require('./utils/task-runner');
      taskRunner.startBackgroundRunner(5000);
    } catch(e) { console.warn('[task-runner] Start fehlgeschlagen:', e.message); }
  });

  // FIX 10: Graceful shutdown — close DB pool and server cleanly
  async function shutdown(signal) {
    console.log(`${signal} received — shutting down gracefully`);
    server.close(async () => {
      try { await pool.end(); console.log('DB pool closed'); } catch {}
      process.exit(0);
    });
    // Force exit after 10s
    setTimeout(() => { console.error('Forced shutdown'); process.exit(1); }, 10000);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('uncaughtException', (e) => { console.error('Uncaught:', e.message); });
  process.on('unhandledRejection', (r) => { console.error('Unhandled:', r); });
});
