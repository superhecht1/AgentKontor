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

const auth    = require('../middleware/auth');
const { getPool } = require('../utils/db');
const { goalEngine } = require('../utils/goal-engine');

// ── POST /api/goals  — Neues Ziel starten ────────────────────────────────────
router.post('/', auth, async (req, res) => {
  const pool = getPool(req);
  const { goal, context, model = 'claude-sonnet-4-6' } = req.body;
  if (!goal?.trim()) return res.status(400).json({ error: 'goal erforderlich' });
  if (goal.length > 2000) return res.status(400).json({ error: 'Ziel zu lang (max. 2000 Zeichen)' });
  if (context && context.length > 1000) return res.status(400).json({ error: 'Kontext zu lang (max. 1000 Zeichen)' });
  const ALLOWED_MODELS = ['claude-sonnet-4-6','claude-opus-4-6','claude-haiku-4-5','gpt-4o','gpt-4o-mini'];
  const safeModel = ALLOWED_MODELS.includes(model) ? model : 'claude-sonnet-4-6';

  try {
    if (!await tableExists(pool, 'goals')) return res.status(503).json({ error: 'Service noch nicht bereit — Migration läuft noch' });
    const { goalId, campaignId, analysis } = await goalEngine.startGoal(pool, {
      userId: req.userId,
      rawGoal: goal.trim().slice(0, 2000),
      context: (context || '').slice(0, 1000),
      model: safeModel,
    });

    // Asynchron ausführen
    setImmediate(async () => {
      await goalEngine.runCampaign(pool, { goalId, campaignId, userId: req.userId, model }).catch(e => {
        console.error('[goals] runCampaign Fehler:', e.message);
        pool.query(
          "UPDATE goals SET status='failed',updated_at=now() WHERE id=$1", [goalId]
        ).catch(() => {});
      });
    });

    res.status(201).json({ goalId, campaignId, analysis, status: 'running' });
  } catch (e) {
    console.error('START GOAL:', e.message);
    safeErr(res, e, 500);
  }
});

// ── GET /api/goals  — Ziel-Liste ─────────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  const pool = getPool(req);
  const { status, limit = 20 } = req.query;
  try {
        if (!await tableExists(pool, 'goals')) return res.json({ goals: [] });
const conditions = ['g.user_id=$1'];
    const params = [req.userId];
    if (status) { conditions.push('g.status=$2'); params.push(status); }
    params.push(parseInt(limit));

    const r = await pool.query(
      `SELECT g.*,
         c.id AS campaign_id, c.step_count, c.steps_done, c.name AS campaign_name,
         (SELECT COUNT(*) FROM goal_metrics gm WHERE gm.goal_id=g.id) AS metric_count
       FROM goals g
       LEFT JOIN goal_campaigns c ON c.goal_id=g.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY g.created_at DESC LIMIT $${params.length}`,
      params
    );
    res.json({ goals: r.rows });
  } catch (e) {
    console.error('LIST GOALS:', e.message);
    res.status(500).json({ error: 'Fehler' });
  }
});

// ── GET /api/goals/:id/poll  — Live-Daten ────────────────────────────────────
router.get('/:id/poll', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    if (!await tableExists(pool, 'goals')) return res.json({ goals: [] });
    const [goal, campaign, steps, metrics, activity] = await Promise.all([
      pool.query('SELECT * FROM goals WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]),
      pool.query('SELECT * FROM goal_campaigns WHERE goal_id=$1 ORDER BY created_at DESC LIMIT 1', [req.params.id]),
      pool.query('SELECT gs.* FROM goal_steps gs JOIN goals g ON g.id=gs.goal_id WHERE gs.goal_id=$1 AND g.user_id=$2 ORDER BY gs.step_number', [req.params.id, req.userId]),
      pool.query('SELECT * FROM goal_metrics WHERE goal_id=$1 ORDER BY metric_key', [req.params.id]),
      pool.query('SELECT * FROM goal_activity WHERE goal_id=$1 ORDER BY created_at DESC LIMIT 20', [req.params.id]),
    ]);

    if (!goal.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });

    // Pending Approvals
    const approvals = await pool.query(
      "SELECT * FROM approvals WHERE goal_id=$1 AND status='pending' ORDER BY created_at",
      [req.params.id]
    ).catch(() => ({ rows: [] }));

    res.json({
      goal: goal.rows[0],
      campaign: campaign.rows[0],
      steps: steps.rows,
      metrics: metrics.rows,
      activity: activity.rows,
      pendingApprovals: approvals.rows,
    });
  } catch (e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// ── POST /api/goals/:id/approve  — Schritt freigeben ─────────────────────────
router.post('/:id/approve', auth, async (req, res) => {
  const pool = getPool(req);
  const { stepId, approvalId } = req.body;

  try {
    if (!await tableExists(pool, 'goals')) return res.json({ goals: [] });
    // Approval-Status setzen
    if (approvalId) {
      await pool.query(
        "UPDATE approvals SET status='approved',decided_at=now() WHERE id=$1 AND user_id=$2",
        [approvalId, req.userId]
      );
    }

    // Schritt-Status auf approved
    if (stepId) {
      await pool.query(
        "UPDATE goal_steps SET status='approved' WHERE id=$1", [stepId]
      );
    } else {
      // Neuesten waiting_approval Schritt freigeben
      const s = await pool.query(
        "SELECT id FROM goal_steps WHERE goal_id=$1 AND status='waiting_approval' ORDER BY step_number LIMIT 1",
        [req.params.id]
      );
      if (s.rows.length) {
        await goalEngine.resumeAfterApproval(pool, {
          goalId: parseInt(req.params.id),
          stepId: s.rows[0].id,
          userId: req.userId,
        });
      }
    }

    res.json({ success: true });
  } catch (e) {
    safeErr(res, e, 500);
  }
});

// ── POST /api/goals/:id/reject  — Schritt ablehnen ───────────────────────────
router.post('/:id/reject', auth, async (req, res) => {
  const pool = getPool(req);
  const { reason, approvalId } = req.body;
  try {
    if (!await tableExists(pool, 'goals')) return res.json({ goals: [] });
    if (approvalId) {
      await pool.query(
        "UPDATE approvals SET status='rejected',response_note=$1,decided_at=now() WHERE id=$2 AND user_id=$3",
        [reason || '', approvalId, req.userId]
      );
    }
    await pool.query(
      "UPDATE goal_steps SET status='rejected' WHERE goal_id=$1 AND status='waiting_approval'",
      [req.params.id]
    );
    await pool.query(
      "UPDATE goals SET status='paused',updated_at=now() WHERE id=$1", [req.params.id]
    );
    await goalEngine.log(pool, { goalId:parseInt(req.params.id), type:'message', title:'❌ Schritt abgelehnt', detail:reason });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// ── POST /api/goals/:id/cancel  — Ziel abbrechen ─────────────────────────────
router.post('/:id/cancel', auth, async (req, res) => {
  const pool = getPool(req);
  if (!await tableExists(pool, 'goals')) return res.json({ success: true });
  await pool.query(
    "UPDATE goals SET status='cancelled',updated_at=now() WHERE id=$1 AND user_id=$2",
    [req.params.id, req.userId]
  );
  res.json({ success: true });
});

// ── DELETE /api/goals/:id ─────────────────────────────────────────────────────
router.delete('/:id', auth, async (req, res) => {
  const pool = getPool(req);
  await pool.query('DELETE FROM goals WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
  res.json({ success: true });
});

// ── GET /api/goals/stats/overview ─────────────────────────────────────────────
router.get('/stats/overview', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    if (!await tableExists(pool, 'goals')) return res.json({ goals: [] });
    const r = await pool.query(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE status='running')   AS running,
         COUNT(*) FILTER (WHERE status='completed') AS completed,
         COUNT(*) FILTER (WHERE status='paused')    AS paused,
         COUNT(*) FILTER (WHERE status='failed')    AS failed,
         AVG(progress) FILTER (WHERE status='running') AS avg_progress
       FROM goals WHERE user_id=$1`,
      [req.userId]
    );
    res.json({ stats: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

module.exports = router;
