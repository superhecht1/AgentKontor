-- Model & Fine-Tuning Extension
ALTER TABLE agents ADD COLUMN IF NOT EXISTS model       VARCHAR(120) NOT NULL DEFAULT 'claude-sonnet-4-20250514';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS openai_key  TEXT DEFAULT NULL;  -- per-agent OpenAI key (optional)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS ollama_url  TEXT DEFAULT NULL;  -- per-agent Ollama URL

CREATE TABLE IF NOT EXISTS fine_tuning_jobs (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id          INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  openai_job_id     VARCHAR(100) NOT NULL UNIQUE,
  file_id           VARCHAR(100) NOT NULL,
  name              VARCHAR(100) NOT NULL DEFAULT 'Fine-Tuned Model',
  base_model        VARCHAR(80)  NOT NULL DEFAULT 'gpt-4o-mini-2024-07-18',
  fine_tuned_model  VARCHAR(150) DEFAULT NULL,  -- filled when job succeeds
  status            VARCHAR(30)  NOT NULL DEFAULT 'pending',
  training_pairs    INTEGER      NOT NULL DEFAULT 0,
  error_msg         TEXT         DEFAULT NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ft_jobs_user  ON fine_tuning_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_ft_jobs_agent ON fine_tuning_jobs(agent_id);
