'use strict';
const express  = require('express');
const router   = express.Router();
const auth     = require('../middleware/auth');
const { getPool } = require('../utils/db');
const { callLLM } = require('../utils/llm');

async function tableExists(pool, t) {
  try { await pool.query(`SELECT 1 FROM ${t} LIMIT 1`); return true; } catch { return false; }
}

// Chunk-Größe: 800 Zeichen mit 100 Überlapp
function chunkText(text, size=800, overlap=100) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i+size));
    i += size - overlap;
  }
  return chunks;
}

// Einfache TF-ähnliche Suche (kein Embedding-Server nötig)
function scoredSearch(query, chunks, topK=5) {
  const qWords = new Set(query.toLowerCase().split(/\W+/).filter(w => w.length > 2));
  return chunks
    .map((c, i) => {
      const words = c.content.toLowerCase().split(/\W+/);
      const score = words.filter(w => qWords.has(w)).length;
      return { ...c, score };
    })
    .filter(c => c.score > 0)
    .sort((a,b) => b.score - a.score)
    .slice(0, topK);
}

// ── GET /rag/documents ──────────────────────────────────────────────────────
router.get('/documents', auth, async (req, res) => {
  const pool = getPool(req);
  const { agentId } = req.query;
  try {
    if (!await tableExists(pool, 'agent_documents')) return res.json({ documents: [] });
    const r = await pool.query(
      'SELECT id, filename, file_size, chunk_count, created_at FROM agent_documents WHERE agent_id=$1 ORDER BY created_at DESC',
      [agentId]
    );
    res.json({ documents: r.rows });
  } catch { res.json({ documents: [] }); }
});

// ── POST /rag/upload ────────────────────────────────────────────────────────
router.post('/upload', auth, async (req, res) => {
  const pool = getPool(req);
  const { agentId, filename, content, fileSize } = req.body;
  if (!agentId || !filename || !content)
    return res.status(400).json({ error: 'agentId, filename und content erforderlich' });

  // Gehört der Agent dem User?
  const ag = await pool.query('SELECT id FROM agents WHERE id=$1 AND user_id=$2', [agentId, req.userId]);
  if (!ag.rows.length) return res.status(403).json({ error: 'Agent nicht gefunden' });

  try {
    if (!await tableExists(pool, 'agent_documents')) return res.status(503).json({ error: 'RAG noch nicht bereit' });

    // Alte Chunks löschen wenn Datei schon existiert
    const existing = await pool.query(
      'SELECT id FROM agent_documents WHERE agent_id=$1 AND filename=$2', [agentId, filename]
    );
    if (existing.rows.length) {
      await pool.query('DELETE FROM agent_document_chunks WHERE document_id=$1', [existing.rows[0].id]);
      await pool.query('DELETE FROM agent_documents WHERE id=$1', [existing.rows[0].id]);
    }

    // Dokument anlegen
    const chunks = chunkText(content.slice(0, 500000)); // max 500k Zeichen
    const docR = await pool.query(
      'INSERT INTO agent_documents (agent_id, filename, file_size, chunk_count) VALUES ($1,$2,$3,$4) RETURNING id',
      [agentId, filename.slice(0,255), fileSize || content.length, chunks.length]
    );
    const docId = docR.rows[0].id;

    // Chunks speichern
    for (let i = 0; i < chunks.length; i++) {
      await pool.query(
        'INSERT INTO agent_document_chunks (document_id, agent_id, chunk_index, content) VALUES ($1,$2,$3,$4)',
        [docId, agentId, i, chunks[i]]
      ).catch(() => {});
    }

    res.json({ success: true, docId, chunkCount: chunks.length });
  } catch (e) {
    console.error('RAG UPLOAD:', e.message);
    res.status(500).json({ error: 'Upload fehlgeschlagen' });
  }
});

// ── POST /rag/search ────────────────────────────────────────────────────────
router.post('/search', auth, async (req, res) => {
  const pool = getPool(req);
  const { agentId, query, topK = 5 } = req.body;
  if (!agentId || !query) return res.status(400).json({ error: 'agentId und query erforderlich' });
  try {
    if (!await tableExists(pool, 'agent_document_chunks')) return res.json({ results: [] });
    const r = await pool.query(
      `SELECT c.content, c.chunk_index, d.filename
       FROM agent_document_chunks c
       JOIN agent_documents d ON d.id=c.document_id
       WHERE c.agent_id=$1
       ORDER BY c.id`,
      [agentId]
    );
    const results = scoredSearch(query, r.rows.map(row => ({
      content: row.content, filename: row.filename, index: row.chunk_index
    })), parseInt(topK));
    res.json({ results, query });
  } catch (e) { res.json({ results: [] }); }
});

// ── DELETE /rag/documents/:id ───────────────────────────────────────────────
router.delete('/documents/:id', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    await pool.query('DELETE FROM agent_document_chunks WHERE document_id=$1', [req.params.id]);
    await pool.query('DELETE FROM agent_documents WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Fehler' }); }
});

module.exports = router;
