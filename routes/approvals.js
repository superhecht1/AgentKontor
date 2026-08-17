'use strict';
const express = require('express');
const router  = express.Router();
const { auth } = require('../middleware/auth');
const { getPool } = require('../utils/db');

// ── GET /api/approvals  — Approval-Queue ────────────────────────────────────
router.get('/', auth, async (req, res) => {
  const pool = getPool(req);
  const { status = 'pending', limit = 50 } = req.query;
  try {
    const r = await pool.query(
      `SELECT ap.*,
         a.name  as agent_name,  a.emoji as agent_emoji,
         pl.goal as plan_goal,
         ps.title as step_title, ps.description as step_desc
       FROM approvals ap
       LEFT JOIN agents     a  ON a.id  = ap.agent_id
       LEFT JOIN agent_plans pl ON pl.id = ap.plan_id
       LEFT JOIN plan_steps  ps ON ps.id = ap.step_id
       WHERE ap.user_id=$1 AND ap.status=$2
       ORDER BY ap.created_at DESC
       LIMIT $3`,
      [req.userId, status, parseInt(limit)]
    );

    // Zähler je Status
    const counts = await pool.query(
      `SELECT status, COUNT(*) as c FROM approvals WHERE user_id=$1 GROUP BY status`,
      [req.userId]
    );
    const byStatus = {};
    counts.rows.forEach(r => { byStatus[r.status] = parseInt(r.c); });

    res.json({ approvals: r.rows, byStatus });
  } catch (e) {
    console.error('LIST APPROVALS:', e.message);
    res.status(500).json({ error: 'Fehler' });
  }
});

// ── POST /api/approvals/:id/approve  — Freigeben ────────────────────────────
router.post('/:id/approve', auth, async (req, res) => {
  const pool = getPool(req);
  const { note = '' } = req.body;
  try {
    const r = await pool.query(
      `UPDATE approvals
         SET status='approved', response_note=$1, decided_at=now()
       WHERE id=$2 AND user_id=$3 AND status='pending'
       RETURNING *`,
      [note, req.params.id, req.userId]
    );
    if (!r.rows.length) return res.status(400).json({ error: 'Approval nicht gefunden oder bereits entschieden' });

    const ap = r.rows[0];

    // Step-Status aktualisieren
    if (ap.step_id) {
      await pool.query(
        "UPDATE plan_steps SET status='approved' WHERE id=$1", [ap.step_id]
      );
    }
    // Plan wieder auf running setzen
    if (ap.plan_id) {
      await pool.query(
        "UPDATE agent_plans SET status='running', updated_at=now() WHERE id=$1 AND status='paused'",
        [ap.plan_id]
      );
    }

    res.json({ success: true, approval: r.rows[0] });
  } catch (e) {
    console.error('APPROVE:', e.message);
    res.status(500).json({ error: 'Fehler' });
  }
});

// ── POST /api/approvals/:id/reject  — Ablehnen ──────────────────────────────
router.post('/:id/reject', auth, async (req, res) => {
  const pool = getPool(req);
  const { note = '' } = req.body;
  try {
    const r = await pool.query(
      `UPDATE approvals
         SET status='rejected', response_note=$1, decided_at=now()
       WHERE id=$2 AND user_id=$3 AND status='pending'
       RETURNING *`,
      [note, req.params.id, req.userId]
    );
    if (!r.rows.length) return res.status(400).json({ error: 'Approval nicht gefunden' });

    const ap = r.rows[0];

    // Step + Plan als fehlgeschlagen markieren
    if (ap.step_id) {
      await pool.query(
        "UPDATE plan_steps SET status='rejected', error='Vom Nutzer abgelehnt' WHERE id=$1",
        [ap.step_id]
      );
    }
    if (ap.plan_id) {
      await pool.query(
        `UPDATE agent_plans SET status='failed',
           error_msg='Schritt abgelehnt: ' || COALESCE($1,''), updated_at=now()
         WHERE id=$2`,
        [note, ap.plan_id]
      );
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// ── GET /api/approvals/rules  — Approval-Regeln ─────────────────────────────
router.get('/rules', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query(
      `SELECT ar.*, a.name as agent_name, a.emoji as agent_emoji
       FROM approval_rules ar
       LEFT JOIN agents a ON a.id = ar.agent_id
       WHERE ar.user_id=$1
       ORDER BY ar.priority DESC, ar.created_at`,
      [req.userId]
    );
    res.json({ rules: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// ── POST /api/approvals/rules  — Neue Regel ──────────────────────────────────
router.post('/rules', auth, async (req, res) => {
  const pool = getPool(req);
  const { agentId, actionPattern, level, description, priority = 50 } = req.body;
  if (!actionPattern || !level) return res.status(400).json({ error: 'actionPattern und level erforderlich' });
  if (!['auto','notify','approve'].includes(level)) return res.status(400).json({ error: 'Ungültiger level' });

  try {
    if (agentId) {
      const check = await pool.query(
        'SELECT id FROM agents WHERE id=$1 AND user_id=$2', [agentId, req.userId]
      );
      if (!check.rows.length) return res.status(403).json({ error: 'Nicht berechtigt' });
    }

    const r = await pool.query(
      `INSERT INTO approval_rules
         (user_id, agent_id, action_pattern, level, description, priority)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.userId, agentId||null, actionPattern, level, description||'', parseInt(priority)]
    );
    res.status(201).json({ rule: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// ── PUT /api/approvals/rules/:id  — Regel bearbeiten ────────────────────────
router.put('/rules/:id', auth, async (req, res) => {
  const pool = getPool(req);
  const { actionPattern, level, description, priority, enabled } = req.body;
  try {
    const r = await pool.query(
      `UPDATE approval_rules
         SET action_pattern=$1, level=$2, description=$3,
             priority=$4, enabled=$5
       WHERE id=$6 AND user_id=$7 RETURNING *`,
      [actionPattern, level, description||'', priority||50, enabled!==false,
       req.params.id, req.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json({ rule: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// ── DELETE /api/approvals/rules/:id  — Regel löschen ────────────────────────
router.delete('/rules/:id', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    await pool.query(
      'DELETE FROM approval_rules WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// ── POST /api/approvals/rules/seed  — Standard-Regeln anlegen ────────────────
router.post('/rules/seed', auth, async (req, res) => {
  const pool = getPool(req);
  const defaults = [
    { pattern: 'get_current_time', level: 'auto',    desc: 'Uhrzeit abfragen — immer automatisch', priority: 10 },
    { pattern: 'calculate',        level: 'auto',    desc: 'Berechnungen — immer automatisch',      priority: 10 },
    { pattern: 'read_from_memory', level: 'auto',    desc: 'Memory lesen — immer automatisch',      priority: 10 },
    { pattern: 'save_to_memory',   level: 'auto',    desc: 'Memory schreiben — immer automatisch',  priority: 10 },
    { pattern: 'search_web',       level: 'auto',    desc: 'Web-Suche — immer automatisch',         priority: 10 },
    { pattern: 'create_task',      level: 'notify',  desc: 'Task erstellen — immer benachrichtigen',priority: 20 },
    { pattern: 'http_call',        level: 'notify',  desc: 'HTTP-Requests — benachrichtigen',        priority: 30 },
    { pattern: 'send_email',       level: 'approve', desc: 'E-Mails — immer Freigabe erforderlich', priority: 80 },
    { pattern: 'spend_money',      level: 'approve', desc: 'Ausgaben — immer Freigabe erforderlich',priority: 90 },
    { pattern: 'delete_*',         level: 'approve', desc: 'Löschen — immer Freigabe erforderlich', priority: 85 },
  ];

  let created = 0;
  for (const d of defaults) {
    const exists = await pool.query(
      'SELECT id FROM approval_rules WHERE user_id=$1 AND action_pattern=$2',
      [req.userId, d.pattern]
    );
    if (!exists.rows.length) {
      await pool.query(
        `INSERT INTO approval_rules (user_id,action_pattern,level,description,priority)
         VALUES ($1,$2,$3,$4,$5)`,
        [req.userId, d.pattern, d.level, d.desc, d.priority]
      );
      created++;
    }
  }
  res.json({ success: true, created });
});

module.exports = router;
