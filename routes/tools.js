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
const { BUILTIN_DEFINITIONS } = require('../utils/tool-executor');

// ── GET /api/tools  — alle Tools des Users ──────────────────────────────────
router.get('/', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    if (!await tableExists(pool, 'tools')) return res.json({ tools: [] });
    const r = await pool.query(
      `SELECT t.*,
         COALESCE(
           json_agg(at2.agent_id) FILTER (WHERE at2.agent_id IS NOT NULL), '[]'
         ) AS assigned_agents
       FROM tools t
       LEFT JOIN agent_tools at2 ON at2.tool_id = t.id
       WHERE t.user_id=$1 OR t.user_id IS NULL
       GROUP BY t.id
       ORDER BY t.type, t.name`,
      [req.userId]
    );
    res.json({ tools: r.rows });
  } catch (e) {
    console.error('LIST TOOLS:', e.message);
    res.status(500).json({ error: 'Fehler beim Laden' });
  }
});

// ── GET /api/tools/builtins  — verfügbare Builtin-Definitionen ───────────────
router.get('/builtins', auth, (_req, res) => {
  res.json({ builtins: BUILTIN_DEFINITIONS });
});

// ── POST /api/tools  — neues Tool erstellen ──────────────────────────────────
router.post('/', auth, async (req, res) => {
  const pool = getPool(req);
  const { name, description, type = 'http', parameters, config, permissions, rate_limit, timeout_s } = req.body;

  if (!name || !description) return res.status(400).json({ error: 'name und description erforderlich' });
  if (!['http','builtin','mcp'].includes(type)) return res.status(400).json({ error: 'Ungültiger type' });

  try {
    const r = await pool.query(
      `INSERT INTO tools (user_id,name,description,type,parameters,config,permissions,rate_limit,timeout_s)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.userId, name, description, type,
       JSON.stringify(parameters || { type:'object', properties:{} }),
       JSON.stringify(config || {}),
       permissions || ['user'],
       rate_limit || 60,
       timeout_s || 10]
    );
    res.status(201).json({ tool: r.rows[0] });
  } catch (e) {
    console.error('CREATE TOOL:', e.message);
    res.status(500).json({ error: 'Fehler beim Erstellen' });
  }
});

// ── PUT /api/tools/:id  — Tool bearbeiten ────────────────────────────────────
router.put('/:id', auth, async (req, res) => {
  const pool = getPool(req);
  const { name, description, parameters, config, permissions, enabled, rate_limit, timeout_s } = req.body;
  try {
    const r = await pool.query(
      `UPDATE tools SET
         name=$1, description=$2, parameters=$3, config=$4,
         permissions=$5, enabled=$6, rate_limit=$7, timeout_s=$8,
         updated_at=now()
       WHERE id=$9 AND user_id=$10 RETURNING *`,
      [name, description,
       JSON.stringify(parameters),
       JSON.stringify(config),
       permissions, enabled !== false,
       rate_limit || 60, timeout_s || 10,
       req.params.id, req.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json({ tool: r.rows[0] });
  } catch (e) {
    console.error('UPDATE TOOL:', e.message);
    res.status(500).json({ error: 'Fehler beim Speichern' });
  }
});

// ── DELETE /api/tools/:id ────────────────────────────────────────────────────
router.delete('/:id', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    await pool.query('DELETE FROM tools WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Fehler beim Löschen' });
  }
});

// ── POST /api/tools/assign  — Tool einem Agenten zuweisen ────────────────────
router.post('/assign', auth, async (req, res) => {
  const pool = getPool(req);
  const { agentId, toolId, enabled = true } = req.body;
  if (!agentId || !toolId) return res.status(400).json({ error: 'agentId und toolId erforderlich' });

  try {
    // Sicherstellen dass Agent dem User gehört
    const check = await pool.query(
      'SELECT id FROM agents WHERE id=$1 AND user_id=$2', [agentId, req.userId]
    );
    if (!check.rows.length) return res.status(403).json({ error: 'Nicht berechtigt' });

    await pool.query(
      `INSERT INTO agent_tools (agent_id,tool_id,enabled)
       VALUES ($1,$2,$3)
       ON CONFLICT (agent_id,tool_id) DO UPDATE SET enabled=$3`,
      [agentId, toolId, enabled]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('ASSIGN TOOL:', e.message);
    res.status(500).json({ error: 'Fehler beim Zuweisen' });
  }
});

// ── DELETE /api/tools/assign  — Tool-Zuweisung entfernen ────────────────────
router.delete('/assign', auth, async (req, res) => {
  const pool = getPool(req);
  const { agentId, toolId } = req.body;
  try {
    await pool.query(
      'DELETE FROM agent_tools WHERE agent_id=$1 AND tool_id=$2', [agentId, toolId]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// ── POST /api/tools/:id/test  — Tool manuell testen ─────────────────────────
router.post('/:id/test', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query(
      'SELECT * FROM tools WHERE id=$1 AND (user_id=$2 OR user_id IS NULL)',
      [req.params.id, req.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Tool nicht gefunden' });

    const tool = r.rows[0];
    const { executeTool } = require('../utils/tool-executor');
    const result = await executeTool(tool, req.body.input || {}, {
      pool, userId: req.userId,
    });
    res.json({ success: true, result });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// ── GET /api/tools/calls  — Tool-Aufruf-History ──────────────────────────────
router.get('/calls', auth, async (req, res) => {
  const pool = getPool(req);
  const { agentId, limit = 50 } = req.query;
  try {
    const conditions = ['(t.user_id=$1 OR t.user_id IS NULL)'];
    const params = [req.userId];
    if (agentId) { conditions.push(`tc.agent_id=$${params.length+1}`); params.push(agentId); }
    params.push(parseInt(limit));

    const r = await pool.query(
      `SELECT tc.*, t.name as tool_name
       FROM tool_calls tc
       LEFT JOIN tools t ON t.id = tc.tool_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY tc.created_at DESC
       LIMIT $${params.length}`,
      params
    );
    res.json({ calls: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// ── POST /api/tools/seed-builtins  — Builtin-Tools anlegen ──────────────────
router.post('/seed-builtins', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    let created = 0;
    for (const def of BUILTIN_DEFINITIONS) {
      const exists = await pool.query(
        'SELECT id FROM tools WHERE name=$1 AND type=$2 AND user_id IS NULL',
        [def.name, 'builtin']
      );
      if (!exists.rows.length) {
        await pool.query(
          `INSERT INTO tools (name,description,type,parameters,config,permissions)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [def.name, def.description, 'builtin',
           JSON.stringify(def.parameters), '{}', ['user']]
        );
        created++;
      }
    }
    res.json({ success: true, created });
  } catch (e) {
    safeErr(res, e, 500);
  }
});

module.exports = router;
