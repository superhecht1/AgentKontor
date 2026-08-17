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


/* ── SYSTEM HEALTH ─────────────────────────────────────────── */
router.get('/health', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  try {
    const start = Date.now();
    await pool.query('SELECT 1');
    const dbMs = Date.now() - start;

    const [tables, dbSize, slowQueries] = await Promise.all([
      pool.query(`SELECT schemaname, tablename, n_live_tup AS rows
        FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 10`),
      pool.query(`SELECT pg_size_pretty(pg_database_size(current_database())) AS size`),
      pool.query(`SELECT COUNT(*) AS count FROM pg_stat_activity WHERE state='active' AND wait_event_type='Lock'`),
    ]);

    res.json({
      db_latency_ms: dbMs,
      db_size: dbSize.rows[0]?.size,
      active_locks: slowQueries.rows[0]?.count,
      top_tables: tables.rows,
      node_version: process.version,
      uptime_s: Math.floor(process.uptime()),
      memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ── REVENUE / MRR ─────────────────────────────────────────── */
router.get('/revenue', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  try {
    const [mrr, churn, newSubs, growth] = await Promise.all([
      pool.query(`SELECT
        COUNT(*) FILTER (WHERE plan='pro' AND stripe_subscription_id IS NOT NULL) AS paying,
        COUNT(*) FILTER (WHERE plan='pro' AND trial_ends_at IS NOT NULL AND stripe_subscription_id IS NULL) AS trialing,
        COUNT(*) FILTER (WHERE plan='pro' AND created_at >= NOW()-INTERVAL'30 days') AS new_30d,
        COUNT(*) FILTER (WHERE plan='free') AS free_users
        FROM users WHERE deleted_at IS NULL`),
      pool.query(`SELECT DATE_TRUNC('month', created_at) AS month, COUNT(*) AS signups
        FROM users WHERE deleted_at IS NULL AND created_at >= NOW()-INTERVAL'6 months'
        GROUP BY month ORDER BY month ASC`),
      pool.query(`SELECT DATE_TRUNC('week', created_at) AS week, COUNT(*) AS count
        FROM users WHERE created_at >= NOW()-INTERVAL'8 weeks' AND deleted_at IS NULL
        GROUP BY week ORDER BY week ASC`),
      pool.query(`SELECT COUNT(*) AS count FROM users WHERE plan='pro' AND created_at >= NOW()-INTERVAL'7 days'`),
    ]);
    const paying = parseInt(mrr.rows[0].paying) || 0;
    res.json({
      mrr_eur: paying * 19,
      arr_eur: paying * 19 * 12,
      paying_users: paying,
      trialing_users: parseInt(mrr.rows[0].trialing) || 0,
      free_users: parseInt(mrr.rows[0].free_users) || 0,
      new_30d: parseInt(mrr.rows[0].new_30d) || 0,
      new_7d_pro: parseInt(growth.rows[0]?.count) || 0,
      monthly_signups: churn.rows,
      weekly_signups: newSubs.rows,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ── SEND EMAIL TO USER ─────────────────────────────────────── */
router.post('/users/:id/email', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  const { subject, body } = req.body;
  if (!subject || !body) return res.status(400).json({ error: 'Subject und Body erforderlich' });
  try {
    const r = await pool.query('SELECT email, name FROM users WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Nutzer nicht gefunden' });
    if (!process.env.SMTP_HOST) return res.status(500).json({ error: 'SMTP nicht konfiguriert' });

    const nodemailer = require('nodemailer');
    const t = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT||'587'),
      secure: false, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await t.sendMail({
      from: `AgentKontor <${process.env.SMTP_FROM||'noreply@agentkontor.de'}>`,
      to: r.rows[0].email,
      subject,
      html: '<div style="font-family:sans-serif;max-width:560px;margin:32px auto;padding:28px;background:#fff;border-radius:12px"><p>Hallo ' + r.rows[0].name + ',</p>' + body.replace(/\n/g,'<br>') + '<p style="color:#888;font-size:.8rem;margin-top:24px">\u2014 Das AgentKontor Team</p></div>',
    });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ── IMPERSONATE USER (generate login token) ────────────────── */
router.post('/users/:id/impersonate', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query('SELECT id, token_version, plan FROM users WHERE id=$1 AND deleted_at IS NULL', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Nutzer nicht gefunden' });

    const jwt = require('jsonwebtoken');
    const token = jwt.sign(
      { userId: r.rows[0].id, tv: r.rows[0].token_version, admin_impersonate: req.userId },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    res.json({ token, message: 'Token gültig für 1 Stunde' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ── HARD DELETE USER ──────────────────────────────────────── */
router.delete('/users/:id/hard', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  if (parseInt(req.params.id) === req.userId)
    return res.status(400).json({ error: 'Eigenes Konto nicht löschbar' });
  try {
    await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ── PLATFORM-WIDE LLM COSTS ───────────────────────────────── */
router.get('/llm-costs', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  try {
    const [totals, byModel, byUser, daily] = await Promise.all([
      pool.query(`SELECT
        COALESCE(SUM(cost_usd),0) AS total,
        COALESCE(SUM(cost_usd) FILTER (WHERE created_at>=NOW()-INTERVAL'30 days'),0) AS month,
        COALESCE(SUM(cost_usd) FILTER (WHERE created_at>=NOW()-INTERVAL'7 days'),0) AS week,
        COALESCE(SUM(input_tokens+output_tokens),0) AS total_tokens,
        COUNT(*) AS total_calls
        FROM llm_usage`),
      pool.query(`SELECT model, COUNT(*) AS calls, ROUND(SUM(cost_usd)::numeric,4) AS cost,
        SUM(input_tokens) AS in_tok, SUM(output_tokens) AS out_tok
        FROM llm_usage GROUP BY model ORDER BY cost DESC LIMIT 12`),
      pool.query(`SELECT u.email, u.name, u.plan, ROUND(SUM(lu.cost_usd)::numeric,4) AS cost, COUNT(*) AS calls
        FROM llm_usage lu JOIN agents a ON lu.agent_id=a.id JOIN users u ON a.user_id=u.id
        WHERE lu.created_at>=NOW()-INTERVAL'30 days'
        GROUP BY u.id ORDER BY cost DESC LIMIT 15`),
      pool.query(`SELECT DATE(created_at) AS day, ROUND(SUM(cost_usd)::numeric,4) AS cost, COUNT(*) AS calls
        FROM llm_usage WHERE created_at>=NOW()-INTERVAL'30 days'
        GROUP BY day ORDER BY day ASC`),
    ]);
    res.json({ totals: totals.rows[0], byModel: byModel.rows, byUser: byUser.rows, daily: daily.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ── BROADCAST EMAIL ──────────────────────────────────────── */
router.post('/broadcast', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  const { subject, body, plan_filter } = req.body;
  if (!subject || !body) return res.status(400).json({ error: 'Subject und Body erforderlich' });
  if (!process.env.SMTP_HOST) return res.status(500).json({ error: 'SMTP nicht konfiguriert' });
  try {
    const where = plan_filter && plan_filter !== 'all' ? `AND plan=$1` : '';
    const args  = plan_filter && plan_filter !== 'all' ? [plan_filter] : [];
    const users = await pool.query(
      `SELECT email, name FROM users WHERE deleted_at IS NULL ${where} ORDER BY id`,
      args
    );
    const nodemailer = require('nodemailer');
    const t = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT||'587'), secure: false, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
    let sent = 0;
    for (const u of users.rows) {
      try {
        await t.sendMail({
          from: `AgentKontor <${process.env.SMTP_FROM||'noreply@agentkontor.de'}>`,
          to: u.email,
          subject,
          html: '<div style="font-family:sans-serif;max-width:560px;margin:32px auto;padding:24px;background:#fff;border-radius:12px"><p>Hallo ' + u.name + ',</p>' + body.replace(/\n/g,'<br>') + '<p style="color:#888;font-size:.8rem;margin-top:24px">\u2014 Das AgentKontor Team</p></div>',
        });
        sent++;
      } catch {}
    }
    res.json({ success: true, sent, total: users.rows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ── PROMO CODE ────────────────────────────────────────────── */
router.post('/promo', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  const { code, plan, days } = req.body;
  if (!code || !plan || !days) return res.status(400).json({ error: 'code, plan, days erforderlich' });
  try {
    await pool.query(
      'INSERT INTO promo_codes (code, plan, days, is_active) VALUES ($1,$2,$3,true) ON CONFLICT (code) DO UPDATE SET plan=$2, days=$3, is_active=true',
      [code.toUpperCase(), plan, parseInt(days)]
    ).catch(async () => {
      await pool.query('CREATE TABLE IF NOT EXISTS promo_codes (code VARCHAR(32) PRIMARY KEY, plan VARCHAR(16), days INTEGER, used_count INTEGER DEFAULT 0, is_active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW())');
      await pool.query('INSERT INTO promo_codes (code, plan, days) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [code.toUpperCase(), plan, parseInt(days)]);
    });
    res.json({ success: true, code: code.toUpperCase() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ── SEARCH USERS ──────────────────────────────────────────── */
router.get('/users/search', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ users: [] });
  try {
    const r = await pool.query(`
      SELECT u.id, u.email, u.name, u.plan, u.created_at, u.msg_count_month,
             u.deleted_at, u.trial_ends_at, COUNT(a.id) AS agent_count
      FROM users u LEFT JOIN agents a ON a.user_id=u.id
      WHERE u.email ILIKE $1 OR u.name ILIKE $1
      GROUP BY u.id ORDER BY u.created_at DESC LIMIT 20`,
      ['%'+q+'%']
    );
    res.json({ users: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

