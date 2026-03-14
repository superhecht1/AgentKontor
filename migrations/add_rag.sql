-- RAG System Migration
-- Run: psql $DATABASE_URL -f migrations/add_rag.sql

-- Enable pgvector if available (falls back to JSONB)
CREATE EXTENSION IF NOT EXISTS vector;

-- Documents uploaded per agent
CREATE TABLE IF NOT EXISTS rag_documents (
  id          SERIAL PRIMARY KEY,
  agent_id    INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename    VARCHAR(255) NOT NULL,
  filetype    VARCHAR(50)  NOT NULL,  -- pdf, txt, md, docx
  filesize    INTEGER      NOT NULL DEFAULT 0,
  content     TEXT         NOT NULL,  -- raw extracted text
  chunk_count INTEGER      NOT NULL DEFAULT 0,
  status      VARCHAR(20)  NOT NULL DEFAULT 'processing',  -- processing, ready, error
  error_msg   TEXT         DEFAULT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Text chunks with embeddings
CREATE TABLE IF NOT EXISTS rag_chunks (
  id          SERIAL PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
  agent_id    INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content     TEXT    NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 0,
  -- pgvector column (1536 dims for text-embedding-3-small)
  -- Falls back to JSONB if pgvector not available
  embedding   vector(1536) DEFAULT NULL,
  embedding_json JSONB    DEFAULT NULL,  -- fallback
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_rag_docs_agent     ON rag_documents(agent_id);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_agent   ON rag_chunks(agent_id);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_doc     ON rag_chunks(document_id);

-- Vector similarity index (only if pgvector available)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_rag_chunks_embedding ON rag_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector index not created: %', SQLERRM;
END $$;

-- Add RAG flag to agents
ALTER TABLE agents ADD COLUMN IF NOT EXISTS rag_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS rag_prompt  TEXT DEFAULT 'Nutze die bereitgestellten Dokumente um präzise Antworten zu geben. Beziehe dich auf die Quellen wenn möglich.';
