const router = require('express').Router();
const auth = require('../middleware/auth');
const Anthropic = require('@anthropic-ai/sdk');
const multer = require('multer');
const path = require('path');

const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.txt', '.md', '.pdf', '.csv', '.json', '.html'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Dateityp nicht unterstützt. Erlaubt: txt, md, pdf, csv, json, html'));
  }
});

function getPool(req) { return req.app.locals.pool; }

/* ── TEXT EXTRACTION ─────────────────────────────── */
function extractText(buffer, mimetype, filename) {
  const ext = path.extname(filename).toLowerCase();
  const text = buffer.toString('utf-8');

  if (ext === '.json') {
    try { return JSON.stringify(JSON.parse(text), null, 2); }
    catch { return text; }
  }
  if (ext === '.csv') {
    // Simple CSV → readable text
    return text.split('\n').filter(Boolean).map((row, i) => {
      return i === 0 ? '### Spalten: ' + row : row;
    }).join('\n');
  }
  if (ext === '.html') {
    return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  // txt, md — return as-is
  return text;
}

/* ── CHUNKING ─────────────────────────────────────── */
function chunkText(text, maxTokens = 400, overlap = 50) {
  // Approx: 1 token ≈ 4 chars
  const chunkSize = maxTokens * 4;
  const overlapSize = overlap * 4;
  const chunks = [];

  // Split by paragraphs first
  const paragraphs = text.split(/\n\n+/);
  let current = '';

  for (const para of paragraphs) {
    if ((current + para).length > chunkSize && current.length > 0) {
      chunks.push(current.trim());
      // Keep overlap
      const words = current.split(' ');
      current = words.slice(-Math.floor(overlapSize / 5)).join(' ') + '\n\n' + para;
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  // Split oversized chunks
  const result = [];
  for (const chunk of chunks) {
    if (chunk.length > chunkSize * 1.5) {
      for (let i = 0; i < chunk.length; i += chunkSize - overlapSize) {
        result.push(chunk.slice(i, i + chunkSize).trim());
      }
    } else {
      result.push(chunk);
    }
  }
  return result.filter(c => c.length > 20);
}

/* ── EMBEDDING (via Anthropic) ────────────────────── */
// Anthropic doesn't have embeddings — use simple TF-IDF style
// or store as text for keyword search fallback
// If OpenAI key provided, use text-embedding-3-small
async function getEmbedding(text) {
  if (process.env.OPENAI_API_KEY) {
    const { default: OpenAI } = await import('openai').catch(() => ({ default: null }));
    if (OpenAI) {
      try {
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const resp = await openai.embeddings.create({
          model: 'text-embedding-3-small',
          input: text.slice(0, 8000),
        });
        return resp.data[0].embedding;
      } catch (e) { console.warn('OpenAI embedding failed:', e.message); }
    }
  }
  return null; // Fallback to keyword search
}

/* ── KEYWORD SEARCH FALLBACK ─────────────────────── */
function keywordSearch(query, chunks, topK = 5) {
  const queryWords = query.toLowerCase().split(/\W+/).filter(w => w.length > 2);
  const scored = chunks.map(chunk => {
    const text = chunk.content.toLowerCase();
    let score = 0;
    for (const word of queryWords) {
      const matches = (text.match(new RegExp(word, 'g')) || []).length;
      score += matches;
    }
    return { ...chunk, score };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}

/* ── COSINE SIMILARITY ───────────────────────────── */
function cosineSim(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/* ── ROUTES ──────────────────────────────────────── */

// POST /api/rag/:agentId/upload
router.post('/:agentId/upload', auth, upload.single('file'), async (req, res) => {
  const pool = getPool(req);
  const { agentId } = req.params;

  // Verify ownership
  const agentCheck = await pool.query(
    'SELECT id FROM agents WHERE id=$1 AND user_id=$2', [agentId, req.userId]
  );
  if (!agentCheck.rows.length) return res.status(403).json({ error: 'Agent nicht gefunden' });
  if (!req.file) return res.status(400).json({ error: 'Keine Datei hochgeladen' });

  try {
    const rawText = extractText(req.file.buffer, req.file.mimetype, req.file.originalname);
    if (!rawText.trim()) return res.status(400).json({ error: 'Keine Textinhalte gefunden' });

    // Create document record
    const docResult = await pool.query(
      `INSERT INTO rag_documents (agent_id, user_id, filename, filetype, filesize, content, status)
       VALUES ($1,$2,$3,$4,$5,$6,'processing') RETURNING id`,
      [agentId, req.userId, req.file.originalname,
       path.extname(req.file.originalname).slice(1),
       req.file.size, rawText]
    );
    const docId = docResult.rows[0].id;

    // Respond immediately, process async
    res.json({ success: true, docId, message: 'Wird verarbeitet...' });

    // Async: chunk + embed
    setImmediate(async () => {
      try {
        const chunks = chunkText(rawText);

        for (let i = 0; i < chunks.length; i++) {
          const embedding = await getEmbedding(chunks[i]);

          if (embedding) {
            // pgvector
            try {
              await pool.query(
                `INSERT INTO rag_chunks (document_id, agent_id, chunk_index, content, token_count, embedding)
                 VALUES ($1,$2,$3,$4,$5,$6::vector)`,
                [docId, agentId, i, chunks[i], Math.ceil(chunks[i].length / 4), JSON.stringify(embedding)]
              );
            } catch {
              // pgvector not available, use JSONB
              await pool.query(
                `INSERT INTO rag_chunks (document_id, agent_id, chunk_index, content, token_count, embedding_json)
                 VALUES ($1,$2,$3,$4,$5,$6)`,
                [docId, agentId, i, chunks[i], Math.ceil(chunks[i].length / 4), JSON.stringify(embedding)]
              );
            }
          } else {
            // No embedding — store text only
            await pool.query(
              `INSERT INTO rag_chunks (document_id, agent_id, chunk_index, content, token_count)
               VALUES ($1,$2,$3,$4,$5)`,
              [docId, agentId, i, chunks[i], Math.ceil(chunks[i].length / 4)]
            );
          }
        }

        await pool.query(
          'UPDATE rag_documents SET status=$1, chunk_count=$2 WHERE id=$3',
          ['ready', chunks.length, docId]
        );
      } catch (e) {
        console.error('RAG processing error:', e);
        await pool.query(
          'UPDATE rag_documents SET status=$1, error_msg=$2 WHERE id=$3',
          ['error', e.message, docId]
        );
      }
    });

  } catch (e) {
    console.error('Upload error:', e);
    res.status(500).json({ error: 'Upload fehlgeschlagen: ' + e.message });
  }
});

// GET /api/rag/:agentId/documents
router.get('/:agentId/documents', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const result = await pool.query(
      `SELECT id, filename, filetype, filesize, chunk_count, status, error_msg, created_at
       FROM rag_documents WHERE agent_id=$1 AND user_id=$2 ORDER BY created_at DESC`,
      [req.params.agentId, req.userId]
    );
    res.json({ documents: result.rows });
  } catch (e) {
    res.status(500).json({ error: 'Fehler beim Laden' });
  }
});

// DELETE /api/rag/:agentId/documents/:docId
router.delete('/:agentId/documents/:docId', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    await pool.query(
      'DELETE FROM rag_documents WHERE id=$1 AND user_id=$2',
      [req.params.docId, req.userId]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Löschen fehlgeschlagen' });
  }
});

// POST /api/rag/:agentId/search — internal, used by chat
router.post('/:agentId/search', async (req, res) => {
  const pool = getPool(req);
  const { query, topK = 5 } = req.body;
  if (!query) return res.status(400).json({ error: 'query fehlt' });

  try {
    const context = await retrieveContext(pool, req.params.agentId, query, topK);
    res.json({ context });
  } catch (e) {
    res.status(500).json({ error: 'Suche fehlgeschlagen' });
  }
});

/* ── RETRIEVE CONTEXT (used by chat.js) ─────────── */
async function retrieveContext(pool, agentId, query, topK = 5) {
  try {
    // Try vector search first
    const queryEmbedding = await getEmbedding(query);

    if (queryEmbedding) {
      // Try pgvector
      try {
        const result = await pool.query(
          `SELECT content, 1 - (embedding <=> $1::vector) as similarity
           FROM rag_chunks WHERE agent_id=$2 AND embedding IS NOT NULL
           ORDER BY embedding <=> $1::vector LIMIT $3`,
          [JSON.stringify(queryEmbedding), agentId, topK]
        );
        if (result.rows.length > 0) {
          return result.rows.filter(r => r.similarity > 0.3).map(r => r.content);
        }
      } catch {
        // pgvector not available — try JSONB cosine
        const all = await pool.query(
          'SELECT content, embedding_json FROM rag_chunks WHERE agent_id=$1 AND embedding_json IS NOT NULL',
          [agentId]
        );
        if (all.rows.length > 0) {
          const scored = all.rows.map(row => ({
            content: row.content,
            score: cosineSim(queryEmbedding, row.embedding_json)
          }));
          return scored.sort((a,b) => b.score - a.score).slice(0, topK)
            .filter(r => r.score > 0.3).map(r => r.content);
        }
      }
    }

    // Fallback: keyword search
    const all = await pool.query(
      'SELECT content FROM rag_chunks WHERE agent_id=$1',
      [agentId]
    );
    if (!all.rows.length) return [];
    return keywordSearch(query, all.rows, topK).filter(r => r.score > 0).map(r => r.content);

  } catch (e) {
    console.error('RAG retrieval error:', e);
    return [];
  }
}

module.exports = router;
module.exports.retrieveContext = retrieveContext;
