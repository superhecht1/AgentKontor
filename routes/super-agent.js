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

async function tableExists(pool, table) {
  try { await pool.query(`SELECT 1 FROM ${table} LIMIT 1`); return true; }
  catch { return false; }
}

const { getPool } = require('../utils/db');
const { superAgent } = require('../utils/super-agent');

// ── POST /api/super  — Neue Session starten ──────────────────────────────────
router.post('/', auth, async (req, res) => {
  const pool = getPool(req);
  const { goal, context, teamId, model = 'claude-sonnet-4-6' } = req.body;
  if (!goal?.trim()) return res.status(400).json({ error: 'goal erforderlich' });

  try {
    if (!await tableExists(pool, 'super_agent_sessions')) return res.json({ sessions: [] });
    // Session anlegen
    const r = await pool.query(
      `INSERT INTO super_agent_sessions (user_id,team_id,goal,context,model,status)
       VALUES ($1,$2,$3,$4,$5,'routing') RETURNING id`,
      [req.userId, teamId||null, goal.trim(), context||'', model]
    );
    const sessionId = r.rows[0].id;

    // Erste Nachricht
    await pool.query(
      `INSERT INTO agent_messages (session_id,from_agent,to_agent,message_type,content)
       VALUES ($1,'user','super','task',$2)`,
      [sessionId, goal.trim()]
    );

    // Sofort antworten — Orchestrierung läuft asynchron
    res.status(202).json({ sessionId, status: 'routing' });

    // Asynchron orchestrieren
    setImmediate(async () => {
      try {
        await superAgent.orchestrate(pool, sessionId);
      } catch (e) {
        console.error(`[super-agent] Session ${sessionId} Fehler:`, e.message);
        // Session als fehlgeschlagen markieren
        pool.query(
          "UPDATE super_agent_sessions SET status='failed', error_msg=$1, updated_at=now() WHERE id=$2",
          [e.message, sessionId]
        ).catch(() => {});
      }
    });
  } catch (e) {
    console.error('CREATE SUPER SESSION:', e.message);
    safeErr(res, e, 500);
  }
});

// ── GET /api/super  — Session-Liste ─────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  const pool = getPool(req);
  const { limit = 20, status } = req.query;
  try {
    if (!await tableExists(pool, 'super_agent_sessions')) return res.json({ sessions: [] });

    const conditions = ['user_id=$1'];
    const params = [req.userId];
    if (status) { conditions.push(`status=$${params.length+1}`); params.push(status); }
    params.push(Math.min(parseInt(limit)||20, 50));

    const r = await pool.query(
      `SELECT id, goal, status, created_at, updated_at
       FROM super_agent_sessions
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
    res.json({ sessions: r.rows });
  } catch (e) {
    console.error('LIST SUPER:', e.message);
    res.json({ sessions: [] });
  }
});

// ── GET /api/super/:id/poll  — Live-Status ───────────────────────────────────
router.get('/:id/poll', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    if (!await tableExists(pool, 'super_agent_sessions')) return res.json({ sessions: [] });
    const r = await pool.query(
      `SELECT s.id, s.status, s.routing_result, s.plan, s.agent_results,
              s.final_result, s.error_msg, s.total_duration_ms, s.updated_at,
         (SELECT json_agg(m ORDER BY m.created_at) FROM agent_messages m WHERE m.session_id=s.id) as messages
       FROM super_agent_sessions s
       WHERE s.id=$1 AND s.user_id=$2`,
      [req.params.id, req.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json(r.rows[0]);
  } catch (e) {
    res.json({ error: 'Fehler', items: [] });
  }
});

// ── GET /api/super/:id  — Session-Detail ─────────────────────────────────────
router.get('/:id', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    if (!await tableExists(pool, 'super_agent_sessions')) return res.json({ sessions: [] });
    const r = await pool.query(
      'SELECT * FROM super_agent_sessions WHERE id=$1 AND user_id=$2',
      [req.params.id, req.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });

    const msgs = await pool.query(
      'SELECT * FROM agent_messages WHERE session_id=$1 ORDER BY created_at ASC',
      [parseInt(req.params.id)]
    );
    res.json({ session: r.rows[0], messages: msgs.rows });
  } catch (e) {
    res.json({ error: 'Fehler', items: [] });
  }
});

// ── DELETE /api/super/:id  — Session löschen ─────────────────────────────────
router.delete('/:id', auth, async (req, res) => {
  const pool = getPool(req);
  await pool.query(
    'DELETE FROM super_agent_sessions WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]
  );
  res.json({ success: true });
});

// ── GET /api/super/profiles  — Spezialisten-Profile ──────────────────────────
router.get('/profiles/all', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    if (!await tableExists(pool, 'super_agent_sessions')) return res.json({ sessions: [] });
    const profiles = await superAgent.loadProfiles(pool);

    // Kollaborations-Stats hinzufügen
    const collabs = await pool.query(
      'SELECT agent_a, agent_b, count FROM agent_collaborations ORDER BY count DESC LIMIT 20'
    ).catch(() => ({ rows: [] }));

    res.json({ profiles, collaborations: collabs.rows });
  } catch (e) {
    res.json({ error: 'Fehler', items: [] });
  }
});

// ── GET /api/super/stats/overview  — Analytics ───────────────────────────────
router.get('/stats/overview', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    if (!await tableExists(pool, 'super_agent_sessions')) return res.json({ sessions: [] });
    const r = await pool.query(
      `SELECT
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE status='completed') as completed,
         COUNT(*) FILTER (WHERE status='failed') as failed,
         COUNT(*) FILTER (WHERE status IN ('routing','planning','running','synthesizing')) as running,
         AVG(total_duration_ms) FILTER (WHERE status='completed') as avg_duration_ms
       FROM super_agent_sessions WHERE user_id=$1`,
      [req.userId]
    );
    res.json({ stats: r.rows[0] });
  } catch (e) {
    res.json({ error: 'Fehler', items: [] });
  }
});

// ── GET /api/super/teams  — Teams ────────────────────────────────────────────
router.get('/teams/all', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    if (!await tableExists(pool, 'super_agent_sessions')) return res.json({ sessions: [] });
    const r = await pool.query(
      'SELECT * FROM agent_teams WHERE user_id=$1 ORDER BY is_default DESC, created_at',
      [req.userId]
    );
    res.json({ teams: r.rows });
  } catch (e) {
    res.json({ error: 'Fehler', items: [] });
  }
});

// ── POST /api/super/teams  — Team erstellen ───────────────────────────────────
router.post('/teams', auth, async (req, res) => {
  const pool = getPool(req);
  const { name, description, members } = req.body;
  if (!name) return res.status(400).json({ error: 'name erforderlich' });
  try {
    if (!await tableExists(pool, 'super_agent_sessions')) return res.json({ sessions: [] });
    const r = await pool.query(
      'INSERT INTO agent_teams (user_id,name,description,members) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.userId, name, description||'', JSON.stringify(members||[])]
    );
    res.json({ team: r.rows[0] });
  } catch (e) {
    res.json({ error: 'Fehler', items: [] });
  }
});

module.exports = router;
