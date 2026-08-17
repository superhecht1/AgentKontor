'use strict';
const express = require('express');
const router  = express.Router();
const auth = require('../middleware/auth');
const { getPool } = require('../utils/db');
const { superAgent } = require('../utils/super-agent');

// ── POST /api/super  — Neue Session starten ──────────────────────────────────
router.post('/', auth, async (req, res) => {
  const pool = getPool(req);
  const { goal, context, teamId, model = 'claude-sonnet-4-6' } = req.body;
  if (!goal?.trim()) return res.status(400).json({ error: 'goal erforderlich' });

  try {
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
      }
    });
  } catch (e) {
    console.error('CREATE SUPER SESSION:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/super  — Session-Liste ─────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  const pool = getPool(req);
  const { limit = 20, status } = req.query;
  try {
    const conditions = ['user_id=$1'];
    const params = [req.userId];
    if (status) { conditions.push('status=$2'); params.push(status); }
    params.push(parseInt(limit));

    const r = await pool.query(
      `SELECT id, goal, status, created_at, updated_at, completed_at, total_duration_ms,
         jsonb_object_keys(COALESCE(agent_results,'{}')) as agents_count,
         LEFT(final_result, 200) as result_preview
       FROM super_agent_sessions
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
    res.json({ sessions: r.rows });
  } catch (e) {
    // Fallback ohne jsonb_object_keys
    try {
      const r2 = await pool.query(
        `SELECT id, goal, status, created_at, updated_at, completed_at, total_duration_ms
         FROM super_agent_sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`,
        [req.userId, parseInt(limit)]
      );
      res.json({ sessions: r2.rows });
    } catch (e2) {
      res.status(500).json({ error: 'Fehler' });
    }
  }
});

// ── GET /api/super/:id/poll  — Live-Status ───────────────────────────────────
router.get('/:id/poll', auth, async (req, res) => {
  const pool = getPool(req);
  try {
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
    res.status(500).json({ error: 'Fehler' });
  }
});

// ── GET /api/super/:id  — Session-Detail ─────────────────────────────────────
router.get('/:id', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query(
      'SELECT * FROM super_agent_sessions WHERE id=$1 AND user_id=$2',
      [req.params.id, req.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });

    const msgs = await pool.query(
      'SELECT * FROM agent_messages WHERE session_id=$1 ORDER BY created_at ASC',
      [req.params.id]
    );
    res.json({ session: r.rows[0], messages: msgs.rows });
  } catch (e) {
    res.status(500).json({ error: 'Fehler' });
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
    const profiles = await superAgent.loadProfiles(pool);

    // Kollaborations-Stats hinzufügen
    const collabs = await pool.query(
      'SELECT agent_a, agent_b, count FROM agent_collaborations ORDER BY count DESC LIMIT 20'
    ).catch(() => ({ rows: [] }));

    res.json({ profiles, collaborations: collabs.rows });
  } catch (e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// ── GET /api/super/stats/overview  — Analytics ───────────────────────────────
router.get('/stats/overview', auth, async (req, res) => {
  const pool = getPool(req);
  try {
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
    res.status(500).json({ error: 'Fehler' });
  }
});

// ── GET /api/super/teams  — Teams ────────────────────────────────────────────
router.get('/teams/all', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query(
      'SELECT * FROM agent_teams WHERE user_id=$1 ORDER BY is_default DESC, created_at',
      [req.userId]
    );
    res.json({ teams: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// ── POST /api/super/teams  — Team erstellen ───────────────────────────────────
router.post('/teams', auth, async (req, res) => {
  const pool = getPool(req);
  const { name, description, members } = req.body;
  if (!name) return res.status(400).json({ error: 'name erforderlich' });
  try {
    const r = await pool.query(
      'INSERT INTO agent_teams (user_id,name,description,members) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.userId, name, description||'', JSON.stringify(members||[])]
    );
    res.json({ team: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

module.exports = router;
