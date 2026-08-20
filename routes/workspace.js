/**
 * AgentKontor — White-Label / Workspace / Reseller
 *
 * GET  /api/workspace/me               — eigene Workspace-Infos
 * POST /api/workspace                  — Workspace erstellen (Reseller)
 * PUT  /api/workspace/:id              — Workspace updaten
 * GET  /api/workspace/:id/members      — Sub-User verwalten
 * POST /api/workspace/:id/invite       — Sub-User einladen
 * DELETE /api/workspace/:id/members/:uid — Sub-User entfernen
 * GET  /api/workspace/:id/usage        — Nutzung & Kosten aller Sub-User
 * GET  /api/workspace/config/:slug     — öffentliche Branding-Konfig (kein Auth)
 */

const router = require('express').Router();
const auth   = require('../middleware/auth');

function getPool(req) { return req.app.locals.pool; }

/* ── PUBLIC BRANDING CONFIG (für Login-Seite etc.) ─────── */
router.get('/config/:slug', async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query(
      `SELECT name, slug, logo_url, favicon_url, primary_color, bg_color, brand_name, support_email
       FROM workspaces WHERE slug=$1`,
      [req.params.slug]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Workspace nicht gefunden' });
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: 'Fehler' }); }
});

/* ── GET OWN WORKSPACE ──────────────────────────────────── */
router.get('/me', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query(
      `SELECT w.*, u.name AS owner_name, u.email AS owner_email
       FROM workspaces w
       JOIN users u ON w.owner_user_id=u.id
       WHERE w.owner_user_id=$1 OR EXISTS (
         SELECT 1 FROM users u2 WHERE u2.id=$1 AND u2.workspace_id=w.id
       )`,
      [req.userId]
    );
    res.json({ workspace: r.rows[0] || null });
  } catch(e) { res.status(500).json({ error: 'Fehler' }); }
});

/* ── CREATE WORKSPACE ───────────────────────────────────── */
router.post('/', auth, async (req, res) => {
  const pool = getPool(req);
  const { name, slug, brand_name, primary_color, bg_color, support_email } = req.body;
  if (!name || !slug) return res.status(400).json({ error: 'name und slug erforderlich' });
  if (!/^[a-z0-9-]{3,32}$/.test(slug)) return res.status(400).json({ error: 'slug: nur Kleinbuchstaben, Zahlen, Bindestriche (3-32 Zeichen)' });

  try {
    // Check if user's plan allows workspace creation
    const user = await pool.query('SELECT plan FROM users WHERE id=$1', [req.userId]);
    if (!['pro', 'enterprise'].includes(user.rows[0]?.plan))
      return res.status(403).json({ error: 'Pro-Plan erforderlich für White-Label Workspaces', upgrade: true });

    const r = await pool.query(
      `INSERT INTO workspaces (name, slug, owner_user_id, brand_name, primary_color, bg_color, support_email)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [name, slug, req.userId, brand_name || name, primary_color || '#6c5ce7', bg_color || '#050510', support_email || '']
    );

    // Set owner as workspace admin
    await pool.query('UPDATE users SET workspace_id=$1, is_workspace_admin=true WHERE id=$2', [r.rows[0].id, req.userId]);

    res.status(201).json({ workspace: r.rows[0] });
  } catch(e) {
    if (e.message.includes('unique')) return res.status(409).json({ error: 'Slug bereits vergeben' });
    console.error('CREATE WORKSPACE:', e.message);
    res.status(500).json({ error: 'Fehler beim Erstellen' });
  }
});

/* ── UPDATE WORKSPACE ───────────────────────────────────── */
router.put('/:id', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    // Only owner can update
    const own = await pool.query('SELECT id FROM workspaces WHERE id=$1 AND owner_user_id=$2', [req.params.id, req.userId]);
    if (!own.rows.length) return res.status(403).json({ error: 'Nicht berechtigt' });

    const { name, brand_name, logo_url, favicon_url, primary_color, bg_color, custom_domain, support_email } = req.body;
    const r = await pool.query(
      `UPDATE workspaces SET name=$1, brand_name=$2, logo_url=$3, favicon_url=$4,
       primary_color=$5, bg_color=$6, custom_domain=$7, support_email=$8
       WHERE id=$9 RETURNING *`,
      [name, brand_name, logo_url || null, favicon_url || null, primary_color || '#6c5ce7',
       bg_color || '#050510', custom_domain || null, support_email || null, req.params.id]
    );
    res.json({ workspace: r.rows[0] });
  } catch(e) { res.status(500).json({ error: 'Fehler beim Updaten' }); }
});

/* ── LIST MEMBERS ───────────────────────────────────────── */
router.get('/:id/members', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const own = await pool.query(
      'SELECT id FROM workspaces WHERE id=$1 AND owner_user_id=$2', [req.params.id, req.userId]
    );
    if (!own.rows.length) return res.status(403).json({ error: 'Nicht berechtigt' });

    const r = await pool.query(
      `SELECT u.id, u.email, u.name, u.plan, u.is_workspace_admin, u.created_at,
              COUNT(a.id) AS agent_count
       FROM users u LEFT JOIN agents a ON a.user_id=u.id
       WHERE u.workspace_id=$1
       GROUP BY u.id ORDER BY u.created_at ASC`,
      [parseInt(req.params.id)]
    );
    res.json({ members: r.rows });
  } catch(e) { res.status(500).json({ error: 'Fehler' }); }
});

/* ── INVITE MEMBER ──────────────────────────────────────── */
router.post('/:id/invite', auth, async (req, res) => {
  const pool = getPool(req);
  const { email, plan = 'free' } = req.body;
  if (!email) return res.status(400).json({ error: 'E-Mail erforderlich' });

  try {
    const ws = await pool.query('SELECT * FROM workspaces WHERE id=$1 AND owner_user_id=$2', [req.params.id, req.userId]);
    if (!ws.rows.length) return res.status(403).json({ error: 'Nicht berechtigt' });

    // Check max users limit
    const memberCount = await pool.query('SELECT COUNT(*) FROM users WHERE workspace_id=$1', [parseInt(req.params.id)]);
    if (ws.rows[0].max_sub_users > 0 && parseInt(memberCount.rows[0].count) >= ws.rows[0].max_sub_users)
      return res.status(403).json({ error: 'Maximale Nutzeranzahl erreicht' });

    // Find or create user
    let user = await pool.query('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
    if (!user.rows.length) {
      // Create placeholder user (no password — they set it on first login)
      const crypto = require('crypto');
      const tmpHash = await require('bcryptjs').hash(crypto.randomBytes(32).toString('hex'), 10);
      user = await pool.query(
        'INSERT INTO users (email, name, password_hash, workspace_id, plan, onboarding_done) VALUES ($1,$2,$3,$4,$5,true) RETURNING id',
        [email.toLowerCase(), email.split('@')[0], tmpHash, req.params.id, plan]
      );
    } else {
      await pool.query('UPDATE users SET workspace_id=$1, plan=$2 WHERE id=$3', [req.params.id, plan, user.rows[0].id]);
    }

    // Send invitation email
    setImmediate(async () => {
      try {
        if (!process.env.SMTP_HOST) return;
        const nodemailer = require('nodemailer');
        const t = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT||'587'), secure: false, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
        const base = process.env.APP_URL || 'https://agentkontor.de';
        await t.sendMail({
          from: `${ws.rows[0].brand_name} <${process.env.SMTP_FROM||'noreply@agentkontor.de'}>`,
          to: email,
          subject: `Einladung zu ${ws.rows[0].brand_name}`,
          html: `<div style="font-family:sans-serif;max-width:520px;margin:32px auto;padding:28px;background:#fff;border-radius:12px"><h2>Einladung zu ${ws.rows[0].brand_name}</h2><p>Du wurdest eingeladen. Melde dich an um loszulegen:</p><a href="${base}/app" style="display:inline-block;background:${ws.rows[0].primary_color};color:#fff;padding:11px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:14px">Jetzt anmelden →</a></div>`,
        });
      } catch(e) { console.warn('Invite email error:', e.message); }
    });

    res.json({ success: true, userId: user.rows[0]?.id });
  } catch(e) {
    console.error('INVITE:', e.message);
    res.status(500).json({ error: 'Fehler beim Einladen' });
  }
});

/* ── REMOVE MEMBER ──────────────────────────────────────── */
router.delete('/:id/members/:uid', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const own = await pool.query('SELECT id FROM workspaces WHERE id=$1 AND owner_user_id=$2', [req.params.id, req.userId]);
    if (!own.rows.length) return res.status(403).json({ error: 'Nicht berechtigt' });
    if (parseInt(req.params.uid) === req.userId) return res.status(400).json({ error: 'Eigenes Konto nicht entfernbar' });
    await pool.query('UPDATE users SET workspace_id=NULL WHERE id=$1 AND workspace_id=$2', [req.params.uid, req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Fehler' }); }
});

/* ── USAGE & COSTS per member ───────────────────────────── */
router.get('/:id/usage', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const own = await pool.query('SELECT id FROM workspaces WHERE id=$1 AND owner_user_id=$2', [req.params.id, req.userId]);
    if (!own.rows.length) return res.status(403).json({ error: 'Nicht berechtigt' });

    const r = await pool.query(`
      SELECT u.id, u.email, u.name, u.plan,
             COALESCE(u.msg_count_month, 0) AS messages_month,
             COALESCE(SUM(lu.cost_usd) FILTER (WHERE lu.created_at >= NOW()-INTERVAL'30 days'), 0) AS cost_month,
             COUNT(DISTINCT a.id) AS agents
      FROM users u
      LEFT JOIN agents a ON a.user_id=u.id
      LEFT JOIN llm_usage lu ON lu.agent_id=a.id
      WHERE u.workspace_id=$1
      GROUP BY u.id ORDER BY cost_month DESC
    `, [parseInt(req.params.id)]);

    const totals = await pool.query(`
      SELECT COALESCE(SUM(lu.cost_usd) FILTER (WHERE lu.created_at >= NOW()-INTERVAL'30 days'), 0) AS total_cost_month,
             COALESCE(SUM(u.msg_count_month), 0) AS total_messages
      FROM users u
      LEFT JOIN agents a ON a.user_id=u.id
      LEFT JOIN llm_usage lu ON lu.agent_id=a.id
      WHERE u.workspace_id=$1
    `, [parseInt(req.params.id)]);

    res.json({ members: r.rows, totals: totals.rows[0] });
  } catch(e) { res.status(500).json({ error: 'Fehler' }); }
});

module.exports = router;
