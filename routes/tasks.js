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
const { taskRunner } = require('../utils/task-runner');

// ── GET /api/tasks  — Task-Liste ─────────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  const pool = getPool(req);
  const { agentId, status, limit = 50, offset = 0 } = req.query;
  try {
    if (!await tableExists(pool, 'agent_tasks')) return res.json({ tasks: [], total: 0 });
    const tasks = await taskRunner.list(pool, {
      userId: req.userId,
      agentId: agentId ? parseInt(agentId) : undefined,
      status,
      limit:  Math.min(parseInt(limit)||50, 200),
      offset: parseInt(offset)||0,
    });

    // Anzahl je Status
    const counts = await pool.query(
      `SELECT status, COUNT(*) as count
       FROM agent_tasks WHERE user_id=$1
       GROUP BY status`,
      [req.userId]
    );
    const byStatus = {};
    counts.rows.forEach(r => { byStatus[r.status] = parseInt(r.count); });

    res.json({ tasks, byStatus });
  } catch (e) {
    console.error('LIST TASKS:', e.message);
    res.status(500).json({ error: 'Fehler beim Laden' });
  }
});

// ── POST /api/tasks  — Task erstellen ────────────────────────────────────────
router.post('/', auth, async (req, res) => {
  const pool = getPool(req);
  const { agentId, title, description, type = 'generic',
          payload, priority, maxRetries, scheduledAt, dependsOn } = req.body;

  if (!title) return res.status(400).json({ error: 'title erforderlich' });

  try {
    if (!await tableExists(pool, 'agent_tasks')) return res.status(503).json({ error: 'Migrations noch nicht abgeschlossen. Bitte warte kurz und versuche es erneut.' });
    // Agenten-Ownership prüfen falls agentId angegeben
    if (agentId) {
      const check = await pool.query(
        'SELECT id FROM agents WHERE id=$1 AND user_id=$2', [agentId, req.userId]
      );
      if (!check.rows.length) return res.status(403).json({ error: 'Agent nicht berechtigt' });
    }

    const task = await taskRunner.create(pool, {
      userId:     req.userId,
      agentId:    agentId || null,
      title, description, type,
      payload:    payload || {},
      priority:   priority || 5,
      maxRetries: maxRetries || 3,
      scheduledAt,
      dependsOn,
    });
    res.status(201).json({ task });
  } catch (e) {
    console.error('CREATE TASK:', e.message);
    res.status(500).json({ error: 'Fehler beim Erstellen' });
  }
});

// ── GET /api/tasks/:id  — Task-Detail + Logs ─────────────────────────────────
router.get('/:id', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    if (!await tableExists(pool, 'agent_tasks')) return res.json({ tasks: [], total: 0 });
    const r = await pool.query(
      `SELECT t.*, a.name as agent_name, a.emoji as agent_emoji
       FROM agent_tasks t
       LEFT JOIN agents a ON a.id = t.agent_id
       WHERE t.id=$1 AND t.user_id=$2`,
      [req.params.id, req.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });

    const logs = await taskRunner.getLogs(pool, parseInt(req.params.id), 100);
    res.json({ task: r.rows[0], logs });
  } catch (e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// ── POST /api/tasks/:id/run  — Task sofort manuell ausführen ─────────────────
router.post('/:id/run', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    if (!await tableExists(pool, 'agent_tasks')) return res.json({ tasks: [], total: 0 });
    const r = await pool.query(
      'SELECT * FROM agent_tasks WHERE id=$1 AND user_id=$2',
      [req.params.id, req.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });

    const task = r.rows[0];
    if (!['pending','failed'].includes(task.status)) {
      return res.status(400).json({ error: `Task ist im Status "${task.status}" und kann nicht manuell gestartet werden` });
    }

    // Status auf pending setzen und sofort ausführen
    await pool.query(
      'UPDATE agent_tasks SET status=$1, retry_count=0, scheduled_at=now() WHERE id=$2',
      ['pending', task.id]
    );
    const result = await taskRunner.runTask(pool, { ...task, status: 'pending' });
    res.json({ success: result.success, result: result.result, error: result.error });
  } catch (e) {
    safeErr(res, e, 500);
  }
});

// ── POST /api/tasks/:id/cancel  — Task abbrechen ─────────────────────────────
router.post('/:id/cancel', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    if (!await tableExists(pool, 'agent_tasks')) return res.json({ tasks: [], total: 0 });
    await taskRunner.cancel(pool, { taskId: parseInt(req.params.id), userId: req.userId });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── POST /api/tasks/:id/retry  — Fehlgeschlagenen Task zurücksetzen ───────────
router.post('/:id/retry', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    if (!await tableExists(pool, 'agent_tasks')) return res.json({ tasks: [], total: 0 });
    const r = await pool.query(
      `UPDATE agent_tasks SET status='pending', retry_count=0, error_msg=NULL, scheduled_at=now()
       WHERE id=$1 AND user_id=$2 AND status IN ('failed','cancelled')
       RETURNING *`,
      [req.params.id, req.userId]
    );
    if (!r.rows.length) return res.status(400).json({ error: 'Task kann nicht wiederholt werden' });
    await taskRunner.log(pool, parseInt(req.params.id), 'info', 'Manueller Retry ausgelöst');
    res.json({ task: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// ── DELETE /api/tasks/:id  — Task löschen ────────────────────────────────────
router.delete('/:id', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query(
      'DELETE FROM agent_tasks WHERE id=$1 AND user_id=$2 RETURNING id',
      [req.params.id, req.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// ── GET /api/tasks/stats/summary  — Zusammenfassung ─────────────────────────
router.get('/stats/summary', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    if (!await tableExists(pool, 'agent_tasks'))
      return res.json({ pending:0, running:0, completed:0, failed:0, total:0 });
    const r = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status='pending')   AS pending,
         COUNT(*) FILTER (WHERE status='running')   AS running,
         COUNT(*) FILTER (WHERE status='completed') AS completed,
         COUNT(*) FILTER (WHERE status='failed')    AS failed,
         COUNT(*) FILTER (WHERE status='cancelled') AS cancelled,
         COUNT(*)                                    AS total,
         AVG(EXTRACT(EPOCH FROM (completed_at - started_at))) FILTER (WHERE completed_at IS NOT NULL) AS avg_duration_s
       FROM agent_tasks WHERE user_id=$1`,
      [req.userId]
    );
    res.json({ summary: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

module.exports = router;
