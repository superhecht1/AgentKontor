'use strict';
const express = require('express');
const router  = express.Router();

// Sicheres Error-Logging: Stack intern, generische Meldung zum Client
function safeErr(res, e, status = 500, context = '') {
  const isProd = process.env.NODE_ENV === 'production';
  if (context) console.error(`[${context}]`, e.message);
  else console.error(e.message);
  const msg = isProd
    ? (status < 500 ? e.message : 'Interner Serverfehler')  // 4xx ok, 5xx generisch
    : e.message;
  return res.status(status).json({ error: msg });
}

const auth = require('../middleware/auth');

// ── Tabellen-Guard: gibt leere Antwort wenn Migration noch nicht gelaufen ──
async function tableExists(pool, table) {
  try {
    await pool.query(`SELECT 1 FROM ${table} LIMIT 1`);
    return true;
  } catch { return false; }
}

const { getPool } = require('../utils/db');
const { memoryManager } = require('../utils/memory-manager');

// ── GET /api/memory  — alle Memory-Einträge eines Agenten ──────────────────
router.get('/', auth, async (req, res) => {
  const pool = getPool(req);
  const { agentId, scope, contactId, sessionId, limit = 100 } = req.query;
  if (!agentId) return res.status(400).json({ error: 'agentId erforderlich' });

  try {
    if (!await tableExists(pool, 'agent_memory')) return res.json({ memories: [] });
    // Sicherstellen dass Agent dem User gehört
    const check = await pool.query(
      'SELECT id FROM agents WHERE id=$1 AND user_id=$2', [agentId, req.userId]
    );
    if (!check.rows.length) return res.status(403).json({ error: 'Nicht berechtigt' });

    const entries = await memoryManager.getAll(pool, {
      agentId: parseInt(agentId),
      userId: req.userId,
      scope, contactId, sessionId,
      limit: Math.min(parseInt(limit)||100, 500),
    });
    res.json({ entries });
  } catch (e) {
    console.error('LIST MEMORY:', e.message);
    res.status(500).json({ error: 'Fehler beim Laden' });
  }
});

// ── POST /api/memory  — Eintrag setzen ──────────────────────────────────────
router.post('/', auth, async (req, res) => {
  const pool = getPool(req);
  const { agentId, scope = 'longterm', contactId, sessionId, key, value, ttlSeconds, metadata } = req.body;
  if (!agentId || !key || value === undefined) {
    return res.status(400).json({ error: 'agentId, key und value erforderlich' });
  }

  try {
    if (!await tableExists(pool, 'agent_memory')) return res.json({ memories: [] });
    const check = await pool.query(
      'SELECT id FROM agents WHERE id=$1 AND user_id=$2', [agentId, req.userId]
    );
    if (!check.rows.length) return res.status(403).json({ error: 'Nicht berechtigt' });

    await memoryManager.set(pool, {
      agentId, userId: req.userId,
      scope, contactId, sessionId,
      key, value: String(value),
      source: 'user', confidence: 1.0,
      metadata: metadata || {},
      ttlSeconds: ttlSeconds ? parseInt(ttlSeconds) : undefined,
    });
    res.json({ success: true });
  } catch (e) {
    console.error('SET MEMORY:', e.message);
    res.status(500).json({ error: 'Fehler beim Speichern' });
  }
});

// ── DELETE /api/memory/:id  — Eintrag löschen ───────────────────────────────
router.delete('/:id', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    // Eigentümer prüfen (via agent ownership)
    const r = await pool.query(
      `DELETE FROM agent_memory m
       USING agents a
       WHERE m.id=$1 AND m.agent_id=a.id AND a.user_id=$2
       RETURNING m.id`,
      [req.params.id, req.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// ── DELETE /api/memory/agent/:agentId  — alle Einträge eines Agenten ─────────
router.delete('/agent/:agentId', auth, async (req, res) => {
  const pool = getPool(req);
  const { scope } = req.query;
  try {
    const check = await pool.query(
      'SELECT id FROM agents WHERE id=$1 AND user_id=$2', [req.params.agentId, req.userId]
    );
    if (!check.rows.length) return res.status(403).json({ error: 'Nicht berechtigt' });

    const conditions = ['agent_id=$1'];
    const params = [req.params.agentId];
    if (scope) { conditions.push(`scope=$2`); params.push(scope); }

    const r = await pool.query(
      `DELETE FROM agent_memory WHERE ${conditions.join(' AND ')} RETURNING id`,
      params
    );
    res.json({ success: true, deleted: r.rowCount });
  } catch (e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// ── GET /api/memory/contacts  — Kontakte des Users ──────────────────────────
router.get('/contacts', auth, async (req, res) => {
  const pool = getPool(req);
  const { agentId, limit = 50, search } = req.query;
  try {
    if (!await tableExists(pool, 'agent_memory')) return res.json({ memories: [] });
    const conditions = ['c.user_id=$1'];
    const params = [req.userId];
    if (agentId) { conditions.push(`c.id IN (SELECT DISTINCT contact_id::integer FROM agent_memory WHERE agent_id=$${params.length+1})`); params.push(agentId); }
    if (search)  { conditions.push(`(c.name ILIKE $${params.length+1} OR c.email ILIKE $${params.length+1})`); params.push('%'+search+'%'); }
    params.push(parseInt(limit));

    const r = await pool.query(
      `SELECT c.*,
         (SELECT COUNT(*) FROM agent_memory m WHERE m.contact_id=c.external_id) as memory_count
       FROM contacts c
       WHERE ${conditions.join(' AND ')}
       ORDER BY c.last_seen DESC
       LIMIT $${params.length}`,
      params
    );
    res.json({ contacts: r.rows });
  } catch (e) {
    console.error('LIST CONTACTS:', e.message);
    res.status(500).json({ error: 'Fehler' });
  }
});

// ── GET /api/memory/contacts/:id  — Kontakt-Detail + Memory ─────────────────
router.get('/contacts/:id', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    if (!await tableExists(pool, 'contacts')) return res.status(404).json({ error: 'Nicht gefunden' });
    const contact = await pool.query(
      'SELECT * FROM contacts WHERE id=$1 AND user_id=$2',
      [req.params.id, req.userId]
    );
    if (!contact.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });

    const c = contact.rows[0];
    const memories = await pool.query(
      `SELECT m.*, a.name as agent_name, a.emoji as agent_emoji
       FROM agent_memory m
       LEFT JOIN agents a ON a.id = m.agent_id
       WHERE m.contact_id=$1 AND m.scope='contact'
       ORDER BY m.updated_at DESC`,
      [c.external_id]
    );
    res.json({ contact: c, memories: memories.rows });
  } catch (e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// ── POST /api/memory/cleanup  — abgelaufene Einträge bereinigen ──────────────
router.post('/cleanup', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    if (!await tableExists(pool, 'agent_memory')) return res.json({ memories: [] });
    const deleted = await memoryManager.cleanup(pool);
    res.json({ success: true, deleted });
  } catch (e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// ── GET /api/memory/stats  — Memory-Statistiken ─────────────────────────────
router.get('/stats', auth, async (req, res) => {
  const pool = getPool(req);
  const { agentId } = req.query;
  try {
    if (!await tableExists(pool, 'agent_memory')) return res.json({ memories: [] });
    const cond = agentId ? 'AND m.agent_id=$2' : '';
    const params = agentId ? [req.userId, agentId] : [req.userId];
    const r = await pool.query(
      `SELECT
         m.scope,
         COUNT(*) as count,
         MAX(m.updated_at) as last_updated
       FROM agent_memory m
       JOIN agents a ON a.id = m.agent_id
       WHERE a.user_id=$1 ${cond}
       GROUP BY m.scope`,
      params
    );
    res.json({ stats: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

module.exports = router;
