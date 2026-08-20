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
const { planner } = require('../utils/planner');

// ── POST /api/planner  — Plan erstellen + ausführen ──────────────────────────
router.post('/', auth, async (req, res) => {
  const pool = getPool(req);
  const { agentId, goal, context, model } = req.body;
  if (!goal?.trim()) return res.status(400).json({ error: 'goal erforderlich' });

  try {
    if (!await tableExists(pool, 'agent_plans')) return res.json({ plans: [] });
    // Agent-Ownership prüfen
    if (agentId) {
      const check = await pool.query(
        'SELECT id, model FROM agents WHERE id=$1 AND user_id=$2', [agentId, req.userId]
      );
      if (!check.rows.length) return res.status(403).json({ error: 'Nicht berechtigt' });
    }

    const { plan, decomposed } = await planner.createAndRun(pool, {
      userId:    req.userId,
      agentId:   agentId || null,
      goal:      goal.trim(),
      context:   context || '',
      model:     model || 'claude-sonnet-4-6',
      sessionId: req.body.sessionId,
    });

    res.status(201).json({ plan, decomposed });
  } catch (e) {
    console.error('CREATE PLAN:', e.message);
    res.json({ plans: [], error: e.message });
  }
});

// ── GET /api/planner  — Plan-Liste ───────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  const pool = getPool(req);
  const { agentId, status, limit = 20, offset = 0 } = req.query;
  try {
    if (!await tableExists(pool, 'agent_plans')) return res.json({ plans: [] });
    const conditions = ['p.user_id=$1'];
    const params = [req.userId];
    let i = 2;
    if (agentId) { conditions.push(`p.agent_id=$${i++}`); params.push(agentId); }
    if (status)  { conditions.push(`p.status=$${i++}`);   params.push(status); }
    params.push(parseInt(limit), parseInt(offset));

    const r = await pool.query(
      `SELECT p.*, a.name as agent_name, a.emoji as agent_emoji
       FROM agent_plans p
       LEFT JOIN agents a ON a.id = p.agent_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY p.created_at DESC
       LIMIT $${i} OFFSET $${i+1}`,
      params
    );

    const counts = await pool.query(
      `SELECT status, COUNT(*) as c FROM agent_plans WHERE user_id=$1 GROUP BY status`,
      [req.userId]
    );
    const byStatus = {};
    counts.rows.forEach(r => { byStatus[r.status] = parseInt(r.c); });

    res.json({ plans: r.rows, byStatus });
  } catch (e) {
    console.error('LIST PLANS:', e.message);
    res.json({ plans: [] });
  }
});

// ── GET /api/planner/:id  — Plan-Detail + Steps ──────────────────────────────
router.get('/:id', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    if (!await tableExists(pool, 'agent_plans')) return res.json({ plans: [] });
    const r = await pool.query(
      `SELECT p.*, a.name as agent_name, a.emoji as agent_emoji
       FROM agent_plans p
       LEFT JOIN agents a ON a.id = p.agent_id
       WHERE p.id=$1 AND p.user_id=$2`,
      [req.params.id, req.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });

    const steps = await pool.query(
      'SELECT * FROM plan_steps WHERE plan_id=$1 ORDER BY step_number',
      [parseInt(req.params.id)]
    );

    // Pending Approvals für diesen Plan
    const pendingApprovals = await pool.query(
      "SELECT * FROM approvals WHERE plan_id=$1 AND status='pending' ORDER BY created_at",
      [parseInt(req.params.id)]
    );

    res.json({ plan: r.rows[0], steps: steps.rows, pendingApprovals: pendingApprovals.rows });
  } catch (e) {
    res.json({ plans: [] });
  }
});

// ── GET /api/planner/:id/poll  — Live-Status pollen (leichtgewichtig) ─────────
router.get('/:id/poll', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    if (!await tableExists(pool, 'agent_plans')) return res.json({ plans: [] });
    const r = await pool.query(
      `SELECT p.status, p.steps_done, p.step_count, p.result, p.error_msg, p.updated_at,
         json_agg(json_build_object(
           'id', s.id, 'step_number', s.step_number, 'title', s.title,
           'status', s.status, 'result_summary', s.result_summary, 'error', s.error,
           'approval_level', s.approval_level, 'started_at', s.started_at, 'completed_at', s.completed_at
         ) ORDER BY s.step_number) as steps
       FROM agent_plans p
       LEFT JOIN plan_steps s ON s.plan_id = p.id
       WHERE p.id=$1 AND p.user_id=$2
       GROUP BY p.id`,
      [req.params.id, req.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json(r.rows[0]);
  } catch (e) {
    res.json({ plans: [] });
  }
});

// ── POST /api/planner/:id/cancel  — Plan abbrechen ───────────────────────────
router.post('/:id/cancel', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    if (!await tableExists(pool, 'agent_plans')) return res.json({ plans: [] });
    const r = await pool.query(
      `UPDATE agent_plans SET status='cancelled', updated_at=now()
       WHERE id=$1 AND user_id=$2 AND status IN ('planning','running','paused')
       RETURNING id`,
      [req.params.id, req.userId]
    );
    if (!r.rows.length) return res.status(400).json({ error: 'Plan nicht abbrechbar' });
    // Offene Approvals ebenfalls schließen
    await pool.query(
      "UPDATE approvals SET status='expired' WHERE plan_id=$1 AND status='pending'",
      [parseInt(req.params.id)]
    );
    res.json({ success: true });
  } catch (e) {
    res.json({ plans: [] });
  }
});

// ── POST /api/planner/:id/retry  — Fehlgeschlagenen Plan neu starten ──────────
router.post('/:id/retry', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    if (!await tableExists(pool, 'agent_plans')) return res.json({ plans: [] });
    const r = await pool.query(
      `UPDATE agent_plans SET status='running', error_msg=NULL, updated_at=now()
       WHERE id=$1 AND user_id=$2 AND status IN ('failed','paused')
       RETURNING *`,
      [req.params.id, req.userId]
    );
    if (!r.rows.length) return res.status(400).json({ error: 'Plan kann nicht neu gestartet werden' });

    // Fehlgeschlagene Steps zurücksetzen
    await pool.query(
      "UPDATE plan_steps SET status='pending', error=NULL WHERE plan_id=$1 AND status IN ('failed')",
      [parseInt(req.params.id)]
    );

    setImmediate(() => {
      const pool2 = req.app.locals.pool;
      planner.runPlan(pool2, parseInt(req.params.id)).catch(e =>
        console.error(`[planner] Retry Plan ${req.params.id}:`, e.message)
      );
    });

    res.json({ plan: r.rows[0] });
  } catch (e) {
    res.json({ plans: [] });
  }
});

// ── DELETE /api/planner/:id  — Plan löschen ──────────────────────────────────
router.delete('/:id', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    await pool.query(
      'DELETE FROM agent_plans WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]
    );
    res.json({ success: true });
  } catch (e) {
    res.json({ plans: [] });
  }
});

// ── POST /api/planner/decompose-preview  — Nur zerlegen, nicht ausführen ─────
router.post('/decompose-preview', auth, async (req, res) => {
  const pool = getPool(req);
  const { agentId, goal, context, model } = req.body;
  if (!goal?.trim()) return res.status(400).json({ error: 'goal erforderlich' });
  try {
    if (!await tableExists(pool, 'agent_plans')) return res.json({ plans: [] });
    const decomposed = await planner.decompose(pool, {
      goal, context,
      agentId: agentId || null,
      userId: req.userId,
      model: model || 'claude-sonnet-4-6',
    });
    res.json({ decomposed });
  } catch (e) {
    res.json({ plans: [], error: e.message });
  }
});

module.exports = router;
