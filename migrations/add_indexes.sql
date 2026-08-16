-- AgentKontor — Performance Indexes
-- Idempotent — all use IF NOT EXISTS

-- chat_messages: most queried table
CREATE INDEX IF NOT EXISTS idx_cm_agent_created  ON chat_messages(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cm_session        ON chat_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_cm_source         ON chat_messages(source);
CREATE INDEX IF NOT EXISTS idx_cm_agent_session  ON chat_messages(agent_id, session_id);

-- agents: common lookups
CREATE INDEX IF NOT EXISTS idx_agents_user       ON agents(user_id);
CREATE INDEX IF NOT EXISTS idx_agents_public_id  ON agents(public_id);
CREATE INDEX IF NOT EXISTS idx_agents_active     ON agents(is_active) WHERE is_active = true;

-- users: login and plan lookups
CREATE INDEX IF NOT EXISTS idx_users_email       ON users(email) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_users_stripe      ON users(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_trial       ON users(trial_ends_at) WHERE trial_ends_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_workspace   ON users(workspace_id) WHERE workspace_id IS NOT NULL;

-- lead_captures: reporting
CREATE INDEX IF NOT EXISTS idx_lc_agent_created  ON lead_captures(agent_id, created_at DESC);

-- llm_usage: cost analytics
CREATE INDEX IF NOT EXISTS idx_lu_user_created   ON llm_usage(created_at DESC);

-- agent_memory: fast lookup by hash
CREATE INDEX IF NOT EXISTS idx_am_agent_sid      ON agent_memory(agent_id, session_identifier);

-- referrals: code lookup
CREATE INDEX IF NOT EXISTS idx_ref_code_upper    ON referrals(upper(code));

-- widget_consents
CREATE INDEX IF NOT EXISTS idx_wc_agent_hash     ON widget_consents(agent_id, session_identifier_hash);

-- stripe_events: idempotency
CREATE INDEX IF NOT EXISTS idx_se_id             ON stripe_events(id);
