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
    `).catch(() => ({ rows: [] }));

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
    await pool.query('DELETE FROM users WHERE id=$1', [parseInt(req.params.id)]);
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
    `).catch(() => ({ rows: [] }));
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
        FROM llm_usage`).catch(() => ({ rows: [] })),
      pool.query(`SELECT model, COUNT(*) AS calls, SUM(cost_usd) AS cost, SUM(input_tokens) AS input, SUM(output_tokens) AS output
        FROM llm_usage GROUP BY model ORDER BY cost DESC LIMIT 10`).catch(() => ({ rows: [{ total:0, month:0, week:0, total_tokens:0, total_calls:0 }] })),
      pool.query(`SELECT a.name, a.emoji, u.email, SUM(lu.cost_usd) AS cost, COUNT(*) AS calls
        FROM llm_usage lu JOIN agents a ON lu.agent_id=a.id JOIN users u ON a.user_id=u.id
        WHERE lu.created_at>=NOW()-INTERVAL'30 days'
        GROUP BY a.id,u.email ORDER BY cost DESC LIMIT 10`).catch(() => ({ rows: [{ total:0, month:0, week:0, total_tokens:0, total_calls:0 }] })),
      pool.query(`SELECT DATE(created_at) AS day, SUM(cost_usd) AS cost, COUNT(*) AS calls
        FROM llm_usage WHERE created_at>=NOW()-INTERVAL'30 days'
        GROUP BY day ORDER BY day ASC`).catch(() => ({ rows: [{ total:0, month:0, week:0, total_tokens:0, total_calls:0 }] })),
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
      pool.query(`SELECT table_schema AS schemaname, table_name AS tablename, 0 AS rows
        FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name LIMIT 10`).catch(() => ({ rows: [] })),
      pool.query(`SELECT pg_size_pretty(pg_database_size(current_database())) AS size`),
      pool.query(`SELECT COUNT(*) AS count FROM pg_stat_activity WHERE state='active' AND wait_event_type='Lock'`).catch(() => ({ rows: [{ count: 0 }] })),
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
  } catch(e) { res.status(500).json({ error: process.env.NODE_ENV==='production'?'Interner Fehler':e.message }); }
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
  } catch(e) { res.status(500).json({ error: process.env.NODE_ENV==='production'?'Interner Fehler':e.message }); }
});

/* ── SEND EMAIL TO USER ─────────────────────────────────────── */
router.post('/users/:id/email', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  const { subject, body } = req.body;
  if (!subject || !body) return res.status(400).json({ error: 'Subject und Body erforderlich' });
  try {
    const r = await pool.query('SELECT email, name FROM users WHERE id=$1', [parseInt(req.params.id)]);
    if (!r.rows.length) return res.status(404).json({ error: 'Nutzer nicht gefunden' });
    if (!process.env.SMTP_HOST) return res.status(503).json({ error: 'SMTP nicht konfiguriert. Bitte SMTP_HOST in den Umgebungsvariablen setzen.' });

    await sendMail({
      from: `AgentKontor <${process.env.SMTP_FROM||'info@think-cloud.org'}>`,
      to: r.rows[0].email,
      subject,
      html: '<div style="font-family:sans-serif;max-width:560px;margin:32px auto;padding:28px;background:#fff;border-radius:12px"><p>Hallo ' + r.rows[0].name + ',</p>' + body.replace(/\n/g,'<br>') + '<p style="color:#888;font-size:.8rem;margin-top:24px">\u2014 Das AgentKontor Team</p></div>',
    });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: process.env.NODE_ENV==='production'?'Interner Fehler':e.message }); }
});

/* ── IMPERSONATE USER (generate login token) ────────────────── */
router.post('/users/:id/impersonate', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query('SELECT id, token_version, plan FROM users WHERE id=$1 AND deleted_at IS NULL', [parseInt(req.params.id)]);
    if (!r.rows.length) return res.status(404).json({ error: 'Nutzer nicht gefunden' });

    const jwt = require('jsonwebtoken');
    const token = jwt.sign(
      { userId: r.rows[0].id, tv: r.rows[0].token_version, admin_impersonate: req.userId },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    res.json({ token, message: 'Token gültig für 1 Stunde' });
  } catch(e) { res.status(500).json({ error: process.env.NODE_ENV==='production'?'Interner Fehler':e.message }); }
});

/* ── HARD DELETE USER ──────────────────────────────────────── */
router.delete('/users/:id/hard', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  if (parseInt(req.params.id) === req.userId)
    return res.status(400).json({ error: 'Eigenes Konto nicht löschbar' });
  try {
    await pool.query('DELETE FROM users WHERE id=$1', [parseInt(req.params.id)]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: process.env.NODE_ENV==='production'?'Interner Fehler':e.message }); }
});

/* ── PLATFORM-WIDE LLM COSTS ───────────────────────────────── */
router.get('/llm-costs', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  try {
    // Tabelle existiert? Falls nicht → leere Antwort
    const exists = await pool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_name='llm_usage' LIMIT 1"
    );
    if (!exists.rows.length) {
      return res.json({
        totals: { total:0, month:0, week:0, total_tokens:0, total_calls:0 },
        byModel: [], byUser: [], daily: []
      });
    }
    const [totals, byModel, byUser, daily] = await Promise.all([
      pool.query(`SELECT
        COALESCE(SUM(cost_usd),0) AS total,
        COALESCE(SUM(cost_usd) FILTER (WHERE created_at>=NOW()-INTERVAL'30 days'),0) AS month,
        COALESCE(SUM(cost_usd) FILTER (WHERE created_at>=NOW()-INTERVAL'7 days'),0) AS week,
        COALESCE(SUM(input_tokens+output_tokens),0) AS total_tokens,
        COUNT(*) AS total_calls
        FROM llm_usage`).catch(() => ({ rows: [{ total:0, month:0, week:0, total_tokens:0, total_calls:0 }] })),
      pool.query(`SELECT model, COUNT(*) AS calls, ROUND(SUM(cost_usd)::numeric,4) AS cost,
        SUM(input_tokens) AS in_tok, SUM(output_tokens) AS out_tok
        FROM llm_usage GROUP BY model ORDER BY cost DESC LIMIT 12`).catch(() => ({ rows: [{ total:0, month:0, week:0, total_tokens:0, total_calls:0 }] })),
      pool.query(`SELECT u.email, u.name, u.plan, ROUND(SUM(lu.cost_usd)::numeric,4) AS cost, COUNT(*) AS calls
        FROM llm_usage lu JOIN agents a ON lu.agent_id=a.id JOIN users u ON a.user_id=u.id
        WHERE lu.created_at>=NOW()-INTERVAL'30 days'
        GROUP BY u.id ORDER BY cost DESC LIMIT 15`).catch(() => ({ rows: [{ total:0, month:0, week:0, total_tokens:0, total_calls:0 }] })),
      pool.query(`SELECT DATE(created_at) AS day, ROUND(SUM(cost_usd)::numeric,4) AS cost, COUNT(*) AS calls
        FROM llm_usage WHERE created_at>=NOW()-INTERVAL'30 days'
        GROUP BY day ORDER BY day ASC`).catch(() => ({ rows: [{ total:0, month:0, week:0, total_tokens:0, total_calls:0 }] })),
    ]);
    res.json({ totals: totals.rows[0], byModel: byModel.rows, byUser: byUser.rows, daily: daily.rows });
  } catch(e) {
    console.error('LLM-COSTS:', e.message);
    res.json({
      totals: { total:0, month:0, week:0, total_tokens:0, total_calls:0 },
      byModel: [], byUser: [], daily: [], _error: e.message
    });
  }
});


// ── DEBUG: E-Mail-Test ──────────────────────────────────────────────────────
router.post('/test-email', auth, adminOnly, async (req, res) => {
  const { to } = req.body;
  const debug = {
    BREVO_API_KEY:    !!process.env.BREVO_API_KEY,
    RESEND_API_KEY:   !!process.env.RESEND_API_KEY,
    SENDGRID_API_KEY: !!process.env.SENDGRID_API_KEY,
    SMTP_HOST:        process.env.SMTP_HOST   || null,
    MAIL_FROM:        process.env.MAIL_FROM   || null,
    BREVO_SENDER:     process.env.BREVO_SENDER || null,
    NODE_ENV:         process.env.NODE_ENV,
    from_used:        process.env.MAIL_FROM || process.env.BREVO_SENDER || 'info@think-cloud.org',
  };
  console.log('[EMAIL-DEBUG]', JSON.stringify(debug));
  try {
    const { sendMail } = require('../utils/mailer');
    await sendMail({
      to: to || req.user?.email || 'test@example.com',
      subject: 'AgentKontor Test-E-Mail',
      html: '<p>Wenn du das siehst, funktioniert der E-Mail-Versand ✅</p>',
      text: 'Test-E-Mail von AgentKontor',
    });
    res.json({ success: true, debug, message: 'E-Mail gesendet!' });
  } catch(e) {
    console.error('[EMAIL-TEST ERROR]', e.message);
    res.json({ success: false, error: e.message, debug });
  }
});

/* ── BROADCAST EMAIL ──────────────────────────────────────── */
router.post('/broadcast', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  const { subject, body, plan } = req.body;  // plan statt plan_filter
  if (!subject || !body) return res.status(400).json({ error: 'Subject und Body erforderlich' });

  // Kein SMTP_HOST Check — mailer.js unterstützt auch Brevo/Resend
  const hasProvider = process.env.BREVO_API_KEY || process.env.RESEND_API_KEY ||
                      process.env.SENDGRID_API_KEY || process.env.SMTP_HOST;
  if (!hasProvider && process.env.NODE_ENV === 'production') {
    return res.status(503).json({ error: 'Kein E-Mail-Provider konfiguriert (BREVO_API_KEY, RESEND_API_KEY oder SMTP_HOST)' });
  }

  try {
    // deleted_at optional (könnte nicht existieren)
    const where = (plan && plan !== 'all') ? 'AND plan=$1' : '';
    const args  = (plan && plan !== 'all') ? [plan] : [];
    const users = await pool.query(
      `SELECT email, name FROM users WHERE is_active IS NOT FALSE ${where} ORDER BY id LIMIT 500`,
      args
    ).catch(() => pool.query(
      `SELECT email, name FROM users ${plan && plan !== 'all' ? 'WHERE plan=$1' : ''} ORDER BY id LIMIT 500`,
      args
    ));

    if (!users.rows.length) return res.json({ success: true, sent: 0, total: 0, message: 'Keine Empfänger gefunden' });

    const htmlTemplate = (name) =>
      '<div style="font-family:sans-serif;max-width:560px;margin:32px auto;padding:24px;background:#fff;border-radius:12px">' +
      '<p>Hallo ' + (name||'Kunde') + ',</p>' +
      body.replace(/\n/g,'<br>') +
      '<p style="color:#888;font-size:.8rem;margin-top:24px">— Das AgentKontor Team</p></div>';

    const { sendMailBatch } = require('../utils/mailer');
    const result = await sendMailBatch(users.rows, {
      subject,
      htmlFn: (u) => htmlTemplate(u.name),
      textFn: (u) => 'Hallo ' + (u.name||'Kunde') + ',\n\n' + body + '\n\n— Das AgentKontor Team',
      from: process.env.MAIL_FROM || 'AgentKontor <info@think-cloud.org>',
    });

    res.json({ success: true, sent: result.sent, total: users.rows.length, failed: result.failed });
  } catch(e) {
    console.error('BROADCAST:', e.message);
    res.status(500).json({ error: process.env.NODE_ENV==='production'?'Interner Fehler':e.message });
  }
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
  } catch(e) { res.status(500).json({ error: process.env.NODE_ENV==='production'?'Interner Fehler':e.message }); }
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
  } catch(e) { res.status(500).json({ error: process.env.NODE_ENV==='production'?'Interner Fehler':e.message }); }
});



/* ── NUTZER DETAIL ──────────────────────────────────────────────────────── */
router.get('/users/:id', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  try {
    const [user, agents, activity, stats] = await Promise.all([
      pool.query(`
        SELECT u.*, COUNT(a.id) AS agent_count
        FROM users u LEFT JOIN agents a ON a.user_id=u.id
        WHERE u.id=$1 GROUP BY u.id`, [parseInt(req.params.id)]),
      pool.query(`
        SELECT id, name, emoji, is_active, total_messages, created_at, model
        FROM agents WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`, [parseInt(req.params.id)]),
      pool.query(`
        SELECT type, detail, created_at FROM user_activity
        WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50
      `, [parseInt(req.params.id)]).catch(() => ({ rows: [] })),
      pool.query(`
        SELECT
          COALESCE(SUM(CASE WHEN DATE_TRUNC('month',created_at)=DATE_TRUNC('month',NOW()) THEN 1 ELSE 0 END),0) AS msgs_this_month,
          COALESCE(SUM(1),0) AS msgs_total,
          MAX(created_at) AS last_message
        FROM conversations WHERE user_id=$1
      `, [parseInt(req.params.id)]).catch(() => ({ rows: [{}] })),
    ]);
    if (!user.rows.length) return res.status(404).json({ error: 'Nutzer nicht gefunden' });
    res.json({
      user:     user.rows[0],
      agents:   agents.rows,
      activity: activity.rows,
      stats:    stats.rows[0] || {},
    });
  } catch(e) {
    console.error('USER DETAIL:', e.message);
    res.status(500).json({ error: 'Fehler' });
  }
});

/* ── NUTZER NOTIZEN ─────────────────────────────────────────────────────── */
router.get('/users/:id/notes', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  const notes = await pool.query(
    `SELECT id, note, admin_id, created_at FROM user_notes
     WHERE user_id=$1 ORDER BY created_at DESC`, [parseInt(req.params.id)]
  ).catch(() => ({ rows: [] }));
  res.json({ notes: notes.rows });
});

router.post('/users/:id/notes', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  const { note } = req.body;
  if (!note?.trim()) return res.status(400).json({ error: 'Notiz erforderlich' });
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS user_notes (
        id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        note TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now()
      )`
    );
    const r = await pool.query(
      'INSERT INTO user_notes (user_id, admin_id, note) VALUES ($1,$2,$3) RETURNING *',
      [req.params.id, req.userId, note.trim().slice(0, 1000)]
    );
    res.json({ note: r.rows[0] });
  } catch(e) { res.status(500).json({ error: 'Fehler' }); }
});

router.delete('/users/:id/notes/:noteId', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  await pool.query('DELETE FROM user_notes WHERE id=$1', [req.params.noteId]).catch(() => {});
  res.json({ success: true });
});

/* ── NUTZER REAKTIVIEREN ────────────────────────────────────────────────── */
router.post('/users/:id/restore', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  await pool.query(
    'UPDATE users SET deleted_at=NULL, is_active=true WHERE id=$1', [parseInt(req.params.id)]
  );
  res.json({ success: true });
});

/* ── ADMIN PASSWORT-RESET ───────────────────────────────────────────────── */
router.post('/users/:id/reset-password', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 8)
    return res.status(400).json({ error: 'Passwort mind. 8 Zeichen' });
  try {
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query(
      'UPDATE users SET password_hash=$1, token_version=COALESCE(token_version,1)+1 WHERE id=$2',
      [hash, req.params.id]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Fehler' }); }
});

/* ── NUTZER SEGMENTE/TAGS ───────────────────────────────────────────────── */
router.post('/users/:id/tags', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  const { tags } = req.body; // Array von Strings
  try {
    await pool.query(
      'UPDATE users SET tags=$1 WHERE id=$2',
      [JSON.stringify(tags || []), req.params.id]
    ).catch(() => {});
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Fehler' }); }
});

/* ── BULK AKTIONEN ──────────────────────────────────────────────────────── */
router.post('/users/bulk', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  const { ids, action, value } = req.body;
  if (!ids?.length || !action) return res.status(400).json({ error: 'IDs und Aktion erforderlich' });
  if (ids.length > 200) return res.status(400).json({ error: 'Max. 200 Nutzer auf einmal' });

  try {
    let affected = 0;
    if (action === 'change_plan') {
      const r = await pool.query(
        `UPDATE users SET plan=$1 WHERE id=ANY($2::int[]) RETURNING id`,
        [value, ids]
      );
      affected = r.rowCount;
    } else if (action === 'delete') {
      const r = await pool.query(
        `UPDATE users SET deleted_at=now(), is_active=false WHERE id=ANY($1::int[]) AND is_admin=false RETURNING id`,
        [ids]
      );
      affected = r.rowCount;
    } else if (action === 'restore') {
      const r = await pool.query(
        `UPDATE users SET deleted_at=NULL, is_active=true WHERE id=ANY($1::int[]) RETURNING id`, [ids]
      );
      affected = r.rowCount;
    } else if (action === 'email') {
      const users = await pool.query('SELECT email, name FROM users WHERE id=ANY($1::int[])', [ids]);
      const { sendMailBatch } = require('../utils/mailer');
      const result = await sendMailBatch(users.rows, {
        subject: value.subject,
        htmlFn: (u) => '<p>Hallo ' + (u.name||'Kunde') + ',</p>' + (value.body||'').replace(/\n/g,'<br>'),
        textFn: (u) => 'Hallo ' + (u.name||'Kunde') + ',\n\n' + (value.body||''),
        from: process.env.MAIL_FROM || 'AgentKontor <noreply@agentkontor.de>',
      });
      return res.json({ success: true, sent: result.sent, failed: result.failed });
    } else {
      return res.status(400).json({ error: 'Unbekannte Aktion' });
    }
    res.json({ success: true, affected });
  } catch(e) {
    console.error('BULK:', e.message);
    res.status(500).json({ error: 'Fehler' });
  }
});

/* ── NUTZER ANLEGEN (Admin) ─────────────────────────────────────────────── */
router.post('/users/create', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  const { name, email, password, plan = 'free' } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'Name, E-Mail und Passwort erforderlich' });
  try {
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash(password, 12);
    const r = await pool.query(
      `INSERT INTO users (name, email, password_hash, plan, email_confirmed, is_active)
       VALUES ($1,$2,$3,$4,true,true) RETURNING id, email, name, plan, created_at`,
      [name.trim(), email.toLowerCase().trim(), hash, plan]
    );
    res.status(201).json({ user: r.rows[0] });
  } catch(e) {
    if (e.message?.includes('unique')) return res.status(409).json({ error: 'E-Mail bereits registriert' });
    res.status(500).json({ error: 'Fehler' });
  }
});

/* ── GEFILTERTE NUTZER-LISTE ────────────────────────────────────────────── */
router.get('/users/filter', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  const { plan, status, sort = 'created_at', order = 'desc', limit = 50, offset = 0, q } = req.query;

  const conditions = [];
  const params = [];
  let i = 1;

  if (plan && plan !== 'all') { conditions.push(`u.plan=$${i++}`); params.push(plan); }
  if (status === 'active')  { conditions.push('u.deleted_at IS NULL AND u.is_active=true'); }
  if (status === 'deleted') { conditions.push('u.deleted_at IS NOT NULL'); }
  if (status === 'unconfirmed') { conditions.push('u.email_confirmed=false'); }
  if (q) {
    conditions.push(`(u.email ILIKE $${i} OR u.name ILIKE $${i})`);
    params.push(`%${q}%`);
    i++;
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const safeSort = ['created_at','last_login','msg_count_month','agent_count'].includes(sort) ? sort : 'created_at';
  const safeOrder = order === 'asc' ? 'ASC' : 'DESC';

  params.push(Math.min(parseInt(limit)||50, 200), parseInt(offset)||0);

  try {
    const [rows, total] = await Promise.all([
      pool.query(`
        SELECT u.id, u.email, u.name, u.plan, u.is_admin, u.created_at,
               u.email_confirmed, u.is_active, u.deleted_at, u.last_login,
               u.trial_ends_at, u.msg_count_month, u.stripe_customer_id,
               COALESCE(u.company,'') AS company,
               COUNT(a.id) AS agent_count
        FROM users u
        LEFT JOIN agents a ON a.user_id=u.id
        ${where}
        GROUP BY u.id
        ORDER BY ${safeSort} ${safeOrder}
        LIMIT $${i} OFFSET $${i+1}
      `, params),
      pool.query(`SELECT COUNT(*) FROM users u ${where}`, params.slice(0,-2))
    ]);
    res.json({ users: rows.rows, total: parseInt(total.rows[0].count), limit: parseInt(limit), offset: parseInt(offset) });
  } catch(e) {
    console.error('FILTER:', e.message);
    res.status(500).json({ error: 'Fehler' });
  }
});


module.exports = router;


/* ── CRON: LOGS + MANUELL AUSLÖSEN ──────────────────────── */
router.get('/cron/logs', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query(
      `SELECT job, result, created_at FROM cron_log ORDER BY created_at DESC LIMIT 50`
    ).catch(() => ({ rows: [] }));
    res.json({ logs: r.rows });
  } catch(e) { res.status(500).json({ error: process.env.NODE_ENV==='production'?'Interner Fehler':e.message }); }
});

router.post('/cron/run', auth, adminOnly, async (req, res) => {
  try {
    const base = process.env.APP_URL || 'http://localhost:3000';
    const secret = process.env.CRON_SECRET || '';
    const r = await fetch(`${base}/api/extras/cron/cleanup`, {
      method: 'POST',
      headers: { 'x-cron-secret': secret, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
    const d = await r.json();
    res.json(d);
  } catch(e) { res.status(500).json({ error: process.env.NODE_ENV==='production'?'Interner Fehler':e.message }); }
});

/* ── CONVERSION FUNNEL ──────────────────────────────────── */
router.get('/funnel', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  try {
    const [signups, trials, converted, churned, active30d] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL`).catch(() => ({ rows: [{ n:0, count:0, total:0 }] })),
      pool.query(`SELECT COUNT(*) AS n FROM users WHERE trial_ends_at IS NOT NULL AND deleted_at IS NULL`),
      pool.query(`SELECT COUNT(*) AS n FROM users WHERE plan='pro' AND stripe_subscription_id IS NOT NULL AND deleted_at IS NULL`),
      pool.query(`SELECT COUNT(*) AS n FROM users WHERE plan='free' AND trial_ends_at < NOW() AND trial_ends_at IS NOT NULL AND deleted_at IS NULL`),
      pool.query(`SELECT COUNT(DISTINCT a.user_id) AS n FROM agents a JOIN chat_messages cm ON cm.agent_id=a.id WHERE cm.created_at > NOW()-INTERVAL'30 days'`),
    ]);
    const daily = await pool.query(`
      SELECT DATE(created_at) AS day, COUNT(*) AS signups,
             COUNT(*) FILTER (WHERE plan='pro') AS pro_same_day
      FROM users WHERE created_at > NOW()-INTERVAL'30 days' AND deleted_at IS NULL
      GROUP BY day ORDER BY day ASC
    `);
    res.json({
      total:      parseInt(signups.rows[0].n),
      trialed:    parseInt(trials.rows[0].n),
      converted:  parseInt(converted.rows[0].n),
      churned:    parseInt(churned.rows[0].n),
      active30d:  parseInt(active30d.rows[0].n),
      daily:      daily.rows,
    });
  } catch(e) { res.status(500).json({ error: process.env.NODE_ENV==='production'?'Interner Fehler':e.message }); }
});

/* ── TEMPLATES VERWALTEN ────────────────────────────────── */
router.get('/templates', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query(`SELECT * FROM agent_templates ORDER BY use_count DESC`).catch(() => ({ rows: [] }));
    res.json({ templates: r.rows });
  } catch(e) { res.status(500).json({ error: process.env.NODE_ENV==='production'?'Interner Fehler':e.message }); }
});

router.post('/templates', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  const { name, emoji, description, category, system_prompt, greeting, tone, tags } = req.body;
  if (!name || !system_prompt) return res.status(400).json({ error: 'name und system_prompt erforderlich' });
  try {
    const r = await pool.query(
      `INSERT INTO agent_templates (name,emoji,description,category,system_prompt,greeting,tone,tags,is_public,author) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9) RETURNING id`,
      [name, emoji||'🤖', description||'', category||'Allgemein', system_prompt, greeting||'Hallo! Wie kann ich helfen?', tone||'professionell', tags||[], 'AgentKontor']
    );
    res.json({ success: true, id: r.rows[0].id });
  } catch(e) { res.status(500).json({ error: process.env.NODE_ENV==='production'?'Interner Fehler':e.message }); }
});

router.put('/templates/:id', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  const { name, emoji, description, category, system_prompt, greeting, tone, is_public } = req.body;
  try {
    await pool.query(
      `UPDATE agent_templates SET name=$1,emoji=$2,description=$3,category=$4,system_prompt=$5,greeting=$6,tone=$7,is_public=$8 WHERE id=$9`,
      [name, emoji||'🤖', description||'', category||'Allgemein', system_prompt, greeting, tone||'professionell', is_public!==false, req.params.id]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: process.env.NODE_ENV==='production'?'Interner Fehler':e.message }); }
});

router.delete('/templates/:id', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  try {
    await pool.query(`DELETE FROM agent_templates WHERE id=$1`, [parseInt(req.params.id)]).catch(() => ({ rows: [] }));
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: process.env.NODE_ENV==='production'?'Interner Fehler':e.message }); }
});

/* ── FEEDBACK / BEWERTUNGEN ─────────────────────────────── */
router.get('/feedback', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  try {
    const [summary, recent] = await Promise.all([
      pool.query(`SELECT
        COUNT(*) FILTER (WHERE rating=1) AS thumbs_up,
        COUNT(*) FILTER (WHERE rating=-1) AS thumbs_down,
        COUNT(*) AS total,
        ROUND(AVG(rating::numeric),2) AS avg_rating
        FROM message_feedback`).catch(() => ({ rows: [{}] })),
      pool.query(`SELECT mf.rating, mf.comment, mf.source, mf.created_at,
        a.name AS agent_name, a.emoji AS agent_emoji, u.email AS owner_email
        FROM message_feedback mf
        JOIN agents a ON mf.agent_id=a.id
        JOIN users u ON a.user_id=u.id
        WHERE mf.comment IS NOT NULL
        ORDER BY mf.created_at DESC LIMIT 50`).catch(() => ({ rows: [] })),
    ]);
    res.json({ summary: summary.rows[0], recent: recent.rows });
  } catch(e) { res.status(500).json({ error: process.env.NODE_ENV==='production'?'Interner Fehler':e.message }); }
});

/* ── ANNOUNCEMENT BANNER ────────────────────────────────── */
// In-memory for simplicity (survives until restart)
let _announcement = null;
router.get('/announcement', (req, res) => res.json({ announcement: _announcement }));
router.post('/announcement', auth, adminOnly, (req, res) => {
  const { text, type, url } = req.body;
  _announcement = text ? { text, type: type||'info', url: url||null, set_at: new Date().toISOString() } : null;
  res.json({ success: true, announcement: _announcement });
});

/* ── CHANGELOG VERWALTEN ────────────────────────────────── */
router.get('/changelog', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query(`SELECT * FROM changelog ORDER BY created_at DESC LIMIT 30`)
      .catch(() => ({ rows: [] }));
    res.json({ entries: r.rows });
  } catch(e) { res.status(500).json({ error: process.env.NODE_ENV==='production'?'Interner Fehler':e.message }); }
});

router.post('/changelog', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  const { version, title, body } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'title und body erforderlich' });
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS changelog (id SERIAL PRIMARY KEY, version VARCHAR(32), title TEXT, body TEXT, published BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW())`);
    const r = await pool.query(
      `INSERT INTO changelog (version, title, body, published) VALUES ($1,$2,$3,true) RETURNING id`,
      [version||'', title, body]
    );
    res.json({ success: true, id: r.rows[0].id });
  } catch(e) { res.status(500).json({ error: process.env.NODE_ENV==='production'?'Interner Fehler':e.message }); }
});

router.delete('/changelog/:id', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  try {
    await pool.query(`DELETE FROM changelog WHERE id=$1`, [parseInt(req.params.id)]).catch(() => ({ rows: [] }));
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: process.env.NODE_ENV==='production'?'Interner Fehler':e.message }); }
});

/* ── CSV EXPORTS ────────────────────────────────────────── */
router.get('/users/export', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query(`
      SELECT u.id, u.email, u.name, u.plan, u.created_at,
             u.msg_count_month, u.stripe_customer_id, u.trial_ends_at,
             u.deleted_at, COUNT(a.id) AS agent_count
      FROM users u LEFT JOIN agents a ON a.user_id=u.id
      GROUP BY u.id ORDER BY u.created_at DESC
    `);
    const header = 'ID,E-Mail,Name,Plan,Agenten,Nachrichten/Mo,Erstellt,Trial bis,Gelöscht\n';
    const rows = r.rows.map(u =>
      [u.id, u.email, (u.name||'').replace(/,/g,''), u.plan,
       u.agent_count, u.msg_count_month,
       new Date(u.created_at).toLocaleDateString('de-DE'),
       u.trial_ends_at ? new Date(u.trial_ends_at).toLocaleDateString('de-DE') : '',
       u.deleted_at ? 'ja' : ''].join(',')
    ).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="users-${new Date().toISOString().split('T')[0]}.csv"`);
    res.send('\ufeff' + header + rows);
  } catch(e) { res.status(500).json({ error: process.env.NODE_ENV==='production'?'Interner Fehler':e.message }); }
});

router.get('/agents/export', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query(`
      SELECT a.id, a.name, a.emoji, a.is_active, a.total_messages,
             a.model, a.rag_enabled, a.whatsapp_enabled, a.telegram_enabled, a.voice_enabled,
             u.email AS owner_email, u.plan AS owner_plan, a.created_at
      FROM agents a JOIN users u ON a.user_id=u.id ORDER BY a.total_messages DESC
    `);
    const header = 'ID,Name,Aktiv,Nachrichten,Modell,RAG,WA,TG,Voice,Besitzer,Plan,Erstellt\n';
    const rows = r.rows.map(a =>
      [a.id, (a.name||'').replace(/,/g,''), a.is_active?'ja':'nein',
       a.total_messages, a.model, a.rag_enabled?'ja':'nein',
       a.whatsapp_enabled?'ja':'nein', a.telegram_enabled?'ja':'nein',
       a.voice_enabled?'ja':'nein', a.owner_email, a.owner_plan,
       new Date(a.created_at).toLocaleDateString('de-DE')].join(',')
    ).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="agents-${new Date().toISOString().split('T')[0]}.csv"`);
    res.send('\ufeff' + header + rows);
  } catch(e) { res.status(500).json({ error: process.env.NODE_ENV==='production'?'Interner Fehler':e.message }); }
});

/* ── TRIAL VERLÄNGERN ───────────────────────────────────── */
router.post('/users/:id/extend-trial', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  const days = Math.min(90, Math.max(1, parseInt(req.body.days)||14));
  try {
    const r = await pool.query(`SELECT trial_ends_at, plan FROM users WHERE id=$1`, [parseInt(req.params.id)]);
    if (!r.rows.length) return res.status(404).json({ error: 'Nutzer nicht gefunden' });
    const base = new Date(Math.max(Date.now(), new Date(r.rows[0].trial_ends_at||Date.now()).getTime()));
    const newEnd = new Date(base.getTime() + days * 86400000);
    await pool.query(`UPDATE users SET trial_ends_at=$1, plan='pro' WHERE id=$2`, [newEnd, req.params.id]);
    res.json({ success: true, trial_ends_at: newEnd.toISOString() });
  } catch(e) { res.status(500).json({ error: process.env.NODE_ENV==='production'?'Interner Fehler':e.message }); }
});

/* ── AGENT HEALTH CHECK ─────────────────────────────────── */
router.get('/agent-health', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  try {
    const [inactive, noMessages, errorAgents, topActive] = await Promise.all([
      pool.query(`SELECT a.id, a.name, a.emoji, u.email, a.created_at
        FROM agents a JOIN users u ON a.user_id=u.id
        WHERE a.is_active=false ORDER BY a.created_at DESC LIMIT 20`),
      pool.query(`SELECT a.id, a.name, a.emoji, u.email, a.created_at
        FROM agents a JOIN users u ON a.user_id=u.id
        WHERE a.is_active=true AND a.total_messages=0 ORDER BY a.created_at DESC LIMIT 20`),
      pool.query(`SELECT a.id, a.name, a.emoji, u.email, COUNT(*) AS errors
        FROM agents a JOIN users u ON a.user_id=u.id
        JOIN audit_log al ON al.entity='agent' AND al.entity_id=a.id::text
        WHERE al.action LIKE '%error%' AND al.created_at > NOW()-INTERVAL'7 days'
        GROUP BY a.id,u.email ORDER BY errors DESC LIMIT 10`).catch(() => ({ rows: [] })),
      pool.query(`SELECT a.id, a.name, a.emoji, u.email, u.plan, a.total_messages,
        COUNT(cm.id) FILTER (WHERE cm.created_at > NOW()-INTERVAL'24 hours') AS msgs_today
        FROM agents a JOIN users u ON a.user_id=u.id
        LEFT JOIN chat_messages cm ON cm.agent_id=a.id
        WHERE a.is_active=true GROUP BY a.id,u.email,u.plan
        ORDER BY msgs_today DESC NULLS LAST LIMIT 10`),
    ]);
    res.json({
      inactive: inactive.rows,
      no_messages: noMessages.rows,
      errors: errorAgents.rows,
      top_active: topActive.rows,
    });
  } catch(e) { res.status(500).json({ error: process.env.NODE_ENV==='production'?'Interner Fehler':e.message }); }
});

/* ── PLATFORM SEARCH (users + agents) ──────────────────── */
router.get('/search', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  const q = (req.query.q||'').trim();
  if (q.length < 2) return res.json({ users: [], agents: [] });
  try {
    const [users, agents] = await Promise.all([
      pool.query(`SELECT id, email, name, plan, created_at FROM users WHERE (email ILIKE $1 OR name ILIKE $1) AND deleted_at IS NULL LIMIT 8`, [`%${q}%`]),
      pool.query(`SELECT a.id, a.name, a.emoji, a.total_messages, u.email AS owner FROM agents a JOIN users u ON a.user_id=u.id WHERE a.name ILIKE $1 LIMIT 8`, [`%${q}%`]),
    ]);
    res.json({ users: users.rows, agents: agents.rows });
  } catch(e) { res.status(500).json({ error: process.env.NODE_ENV==='production'?'Interner Fehler':e.message }); }
});

/* ── LLM COST ALERTS ────────────────────────────────────── */
router.get('/cost-alerts', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  try {
    // Users spending more than $1 today
    const r = await pool.query(`
      SELECT u.email, u.name, u.plan, ROUND(SUM(lu.cost_usd)::numeric,4) AS cost_today,
             COUNT(*) AS calls
      FROM llm_usage lu JOIN agents a ON lu.agent_id=a.id JOIN users u ON a.user_id=u.id
      WHERE lu.created_at > NOW()-INTERVAL'24 hours'
      GROUP BY u.id HAVING SUM(lu.cost_usd) > 1
      ORDER BY cost_today DESC
    `).catch(() => ({ rows: [] }));
    res.json({ alerts: r.rows });
  } catch(e) { res.status(500).json({ error: process.env.NODE_ENV==='production'?'Interner Fehler':e.message }); }
});

/* ── FEATURE FLAGS ──────────────────────────────────────── */
router.post('/users/:id/feature', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  const { feature, enabled } = req.body;
  try {
    // Store in users.metadata JSON column if exists, otherwise use plan workaround
    await pool.query(
      `UPDATE users SET plan=CASE WHEN $2 AND plan='free' THEN 'pro' ELSE plan END WHERE id=$1`,
      [req.params.id, enabled]
    );
    res.json({ success: true, note: 'Feature-Flags via plan-Upgrade simuliert. Für echte Flags metadata-Spalte ergänzen.' });
  } catch(e) { res.status(500).json({ error: process.env.NODE_ENV==='production'?'Interner Fehler':e.message }); }
});

/* ── RATE LIMIT STATUS ──────────────────────────────────── */
router.get('/rate-limits', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query(`
      SELECT key, count, window_end FROM rate_limits
      WHERE count >= 5 AND window_end > NOW()
      ORDER BY count DESC LIMIT 30
    `).catch(() => ({ rows: [] }));
    res.json({ limits: r.rows });
  } catch(e) { res.status(500).json({ error: process.env.NODE_ENV==='production'?'Interner Fehler':e.message }); }
});

/* ── PLATFORM STATS SNAPSHOT ────────────────────────────── */
router.get('/snapshot', auth, adminOnly, async (req, res) => {
  const pool = getPool(req);
  try {
    const [msgs_hour, new_users_today, leads_today, costs_today, active_agents] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS n FROM chat_messages WHERE created_at > NOW()-INTERVAL'1 hour'`).catch(() => ({ rows: [] })),
      pool.query(`SELECT COUNT(*) AS n FROM users WHERE created_at > NOW()-INTERVAL'24 hours'`),
      pool.query(`SELECT COUNT(*) AS n FROM lead_captures WHERE created_at > NOW()-INTERVAL'24 hours'`).catch(() => ({ rows: [{ n: 0 }] })),
      pool.query(`SELECT ROUND(SUM(cost_usd)::numeric,4) AS n FROM llm_usage WHERE created_at > NOW()-INTERVAL'24 hours'`).catch(() => ({ rows: [{ n: 0 }] })).catch(() => ({ rows: [] })),
      pool.query(`SELECT COUNT(DISTINCT agent_id) AS n FROM chat_messages WHERE created_at > NOW()-INTERVAL'1 hour'`).catch(() => ({ rows: [] })).catch(() => ({ rows: [] })).catch(() => ({ rows: [] })).catch(() => ({ rows: [] })).catch(() => ({ rows: [] })).catch(() => ({ rows: [] })).catch(() => ({ rows: [] })).catch(() => ({ rows: [] })),
    ]);
    res.json({
      msgs_last_hour:   parseInt(msgs_hour.rows[0].n),
      new_users_today:  parseInt(new_users_today.rows[0].n),
      leads_today:      parseInt(leads_today.rows[0].n),
      costs_today_usd:  parseFloat(costs_today.rows[0].n||0),
      active_agents_now: parseInt(active_agents.rows[0].n),
      timestamp:         new Date().toISOString(),
    });
  } catch(e) { res.status(500).json({ error: process.env.NODE_ENV==='production'?'Interner Fehler':e.message }); }
});
