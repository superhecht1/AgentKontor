/**
 * AgentKontor — Admin Panel API
 * Secured via is_admin flag or ADMIN_EMAIL env var
 *
 * GET  /api/admin/stats          — platform overview
 * GET  /api/admin/users          — all users
 * PUT  /api/admin/users/:id/plan — change user plan
 * GET  /api/admin/agents         — all agents
 * GET  /api/admin/activity       — recent activity log
 */

const router = require('express').Router();
const auth   = require('../middleware/auth');

function getPool(req) { return req.app.locals.pool; }

/* ── ADMIN AUTH MIDDLEWARE ─────────────────────────────────── */
async function adminOnly(req, res, next) {
  const pool = getPool(req);
  try {
    const r = await pool.query('SELECT email, is_admin FROM users WHERE id=$1', [req.userId]);
    if (!r.rows.length) return res.status(401).json({ error: 'Nicht autorisiert' });

    const adminEmails = (process.env.ADMIN_EMAIL || '').toLowerCase().split(',').map(s => s.trim());
    const isAdmin = r.rows[0].is_admin || adminEmails.includes(r.rows[0].email.toLowerCase());
    if (!isAdmin) return res.status(403).json({ error: 'Kein Admin-Zugriff' });

    next();
  } catch(e) {
    res.status(500).json({ error: 'Fehler' });
  }
}

/* ── PLATFORM STATS ────────────────────────────────────────── */
router.get('/stats', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  try {
    const [users, agents, msgs, leads, revenue] = await Promise.all([
      pool.query('SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE plan=\'pro\') AS pro, COUNT(*) FILTER (WHERE created_at >= NOW()-INTERVAL\'7 days\') AS new_week FROM users'),
      pool.query('SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE is_active=true) AS active FROM agents'),
      pool.query('SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE created_at >= NOW()-INTERVAL\'30 days\') AS month FROM chat_messages WHERE role=\'user\''),
      pool.query('SELECT COUNT(*) AS total FROM lead_captures WHERE created_at >= NOW()-INTERVAL\'30 days\''),
      pool.query('SELECT COUNT(*) AS subscribers FROM users WHERE plan=\'pro\''),
    ]);

    const msgsByDay = await pool.query(`
      SELECT DATE_TRUNC('day', created_at) AS day, COUNT(*) AS count
      FROM chat_messages WHERE role='user' AND created_at >= NOW()-INTERVAL'30 days'
      GROUP BY day ORDER BY day ASC
    `);

    const topAgents = await pool.query(`
      SELECT a.id, a.name, a.emoji, u.email AS owner, a.total_messages, a.is_active
      FROM agents a JOIN users u ON a.user_id=u.id
      ORDER BY a.total_messages DESC LIMIT 10
    `);

    res.json({
      users:     users.rows[0],
      agents:    agents.rows[0],
      messages:  msgs.rows[0],
      leads:     leads.rows[0],
      revenue:   { subscribers: parseInt(revenue.rows[0].subscribers), mrr: parseInt(revenue.rows[0].subscribers) * 19 },
      msgsByDay: msgsByDay.rows,
      topAgents: topAgents.rows,
    });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: 'Fehler' });
  }
});

/* ── ALL USERS ─────────────────────────────────────────────── */
router.get('/users', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query(`
      SELECT u.id, u.email, u.name, u.plan, u.is_admin, u.created_at,
             u.msg_count_month, u.stripe_customer_id,
             COUNT(a.id) AS agent_count
      FROM users u
      LEFT JOIN agents a ON a.user_id=u.id
      GROUP BY u.id ORDER BY u.created_at DESC
    `);
    res.json({ users: r.rows });
  } catch(e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

/* ── CHANGE USER PLAN ──────────────────────────────────────── */
router.put('/users/:id/plan', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  const { plan } = req.body;
  if (!['free','pro','enterprise'].includes(plan))
    return res.status(400).json({ error: 'Ungültiger Plan' });
  try {
    await pool.query('UPDATE users SET plan=$1 WHERE id=$2', [plan, req.params.id]);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

/* ── TOGGLE ADMIN ──────────────────────────────────────────── */
router.put('/users/:id/admin', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  const { is_admin } = req.body;
  try {
    await pool.query('UPDATE users SET is_admin=$1 WHERE id=$2', [!!is_admin, req.params.id]);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

/* ── DELETE USER ───────────────────────────────────────────── */
router.delete('/users/:id', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  if (parseInt(req.params.id) === req.userId)
    return res.status(400).json({ error: 'Eigenes Konto nicht löschbar' });
  try {
    await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

/* ── ALL AGENTS ────────────────────────────────────────────── */
router.get('/agents', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query(`
      SELECT a.id, a.name, a.emoji, a.color, a.is_active, a.total_messages,
             a.rag_enabled, a.whatsapp_enabled, a.telegram_enabled,
             u.email AS owner_email, u.name AS owner_name, u.plan AS owner_plan,
             a.created_at
      FROM agents a JOIN users u ON a.user_id=u.id
      ORDER BY a.total_messages DESC
    `);
    res.json({ agents: r.rows });
  } catch(e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

/* ── RECENT ACTIVITY ───────────────────────────────────────── */
router.get('/activity', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  try {
    const msgs = await pool.query(`
      SELECT cm.id, cm.role, LEFT(cm.content,80) AS preview, cm.source, cm.created_at,
             a.name AS agent_name, u.email AS owner_email
      FROM chat_messages cm
      JOIN agents a ON cm.agent_id=a.id
      JOIN users u ON a.user_id=u.id
      WHERE cm.role='user'
      ORDER BY cm.created_at DESC LIMIT 50
    `);
    res.json({ activity: msgs.rows });
  } catch(e) {
    res.status(500).json({ error: 'Fehler' });
  }
});


/* ── ADMIN: LLM COSTS OVERVIEW ──────────────────────────── */
router.get('/costs', adminOnly, async (req, res) => {
  const pool = getPool(req);
  try {
    const [totals, byModel, topAgents, daily] = await Promise.all([
      pool.query(`SELECT
        COALESCE(SUM(cost_usd),0) AS total_cost,
        COALESCE(SUM(cost_usd) FILTER (WHERE created_at>=NOW()-INTERVAL'30 days'),0) AS month_cost,
        COALESCE(SUM(input_tokens+output_tokens),0) AS total_tokens,
        COUNT(DISTINCT agent_id) AS agents_used
        FROM llm_usage`),
      pool.query(`SELECT model, COUNT(*) AS calls, SUM(cost_usd) AS cost, SUM(input_tokens) AS input, SUM(output_tokens) AS output
        FROM llm_usage GROUP BY model ORDER BY cost DESC LIMIT 10`),
      pool.query(`SELECT a.name, a.emoji, u.email, SUM(lu.cost_usd) AS cost, COUNT(*) AS calls
        FROM llm_usage lu JOIN agents a ON lu.agent_id=a.id JOIN users u ON a.user_id=u.id
        WHERE lu.created_at>=NOW()-INTERVAL'30 days'
        GROUP BY a.id,u.email ORDER BY cost DESC LIMIT 10`),
      pool.query(`SELECT DATE(created_at) AS day, SUM(cost_usd) AS cost, COUNT(*) AS calls
        FROM llm_usage WHERE created_at>=NOW()-INTERVAL'30 days'
        GROUP BY day ORDER BY day ASC`),
    ]);
    res.json({ totals: totals.rows[0], byModel: byModel.rows, topAgents: topAgents.rows, daily: daily.rows });
  } catch(e) { res.status(500).json({ error: 'Fehler' }); }
});

module.exports = router;
