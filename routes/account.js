/**
 * AgentKontor — Account Management
 * PATCH /api/account/password  — change password
 * PATCH /api/account/email     — change email
 * DELETE /api/account          — delete account
 * GET   /api/account/export    — DSGVO data export
 * GET   /api/account/plan      — current plan + usage
 */

const router = require('express').Router();
const auth   = require('../middleware/auth');
const bcrypt = require('bcryptjs');

function getPool(req) { return req.app.locals.pool; }

/* ── CHANGE PASSWORD ─────────────────────────────────────── */
router.patch('/password', auth, async (req, res) => {
  const pool = getPool(req);
  const { current, newPw } = req.body;
  if (!current || !newPw) return res.status(400).json({ error: 'Alle Felder erforderlich' });
  if (newPw.length < 8) return res.status(400).json({ error: 'Passwort mindestens 8 Zeichen' });
  if (newPw === current) return res.status(400).json({ error: 'Neues Passwort muss sich unterscheiden' });

  try {
    const r = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.userId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Nutzer nicht gefunden' });
    const valid = await bcrypt.compare(current, r.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Aktuelles Passwort falsch' });
    const hash = await bcrypt.hash(newPw, 12);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.userId]);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: 'Fehler beim Ändern des Passworts' });
  }
});

/* ── CHANGE EMAIL ────────────────────────────────────────── */
router.patch('/email', auth, async (req, res) => {
  const pool = getPool(req);
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Alle Felder erforderlich' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Ungültige E-Mail' });

  try {
    const r = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.userId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Nutzer nicht gefunden' });
    const valid = await bcrypt.compare(password, r.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Passwort falsch' });

    // Check if email already taken
    const exists = await pool.query('SELECT id FROM users WHERE email=$1 AND id!=$2', [email.toLowerCase(), req.userId]);
    if (exists.rows.length) return res.status(409).json({ error: 'E-Mail bereits vergeben' });

    await pool.query('UPDATE users SET email=$1 WHERE id=$2', [email.toLowerCase(), req.userId]);
    res.json({ success: true, email: email.toLowerCase() });
  } catch(e) {
    res.status(500).json({ error: 'Fehler beim Ändern der E-Mail' });
  }
});

/* ── CHANGE NAME ─────────────────────────────────────────── */
router.patch('/name', auth, async (req, res) => {
  const pool = getPool(req);
  const { name } = req.body;
  if (!name || name.trim().length < 2) return res.status(400).json({ error: 'Name zu kurz' });
  try {
    await pool.query('UPDATE users SET name=$1 WHERE id=$2', [name.trim(), req.userId]);
    res.json({ success: true, name: name.trim() });
  } catch(e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

/* ── DELETE ACCOUNT ──────────────────────────────────────── */
router.delete('/', auth, async (req, res) => {
  const pool = getPool(req);
  const { password, confirm } = req.body;
  if (!password) return res.status(400).json({ error: 'Passwort erforderlich' });
  if (confirm !== 'LÖSCHEN') return res.status(400).json({ error: 'Bitte "LÖSCHEN" eingeben' });

  try {
    const r = await pool.query('SELECT password_hash, stripe_subscription_id FROM users WHERE id=$1', [req.userId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Nutzer nicht gefunden' });
    const valid = await bcrypt.compare(password, r.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Passwort falsch' });

    // Cancel Stripe subscription if exists
    if (r.rows[0].stripe_subscription_id && process.env.STRIPE_SECRET_KEY) {
      try {
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        await stripe.subscriptions.cancel(r.rows[0].stripe_subscription_id);
      } catch(stripeErr) { console.warn('Stripe cancel error:', stripeErr.message); }
    }

    // CASCADE deletes agents, api_keys, chat_messages, etc.
    await pool.query('DELETE FROM users WHERE id=$1', [req.userId]);
    res.json({ success: true });
  } catch(e) {
    console.error('Delete account error:', e);
    res.status(500).json({ error: 'Fehler beim Löschen des Kontos' });
  }
});

/* ── PLAN & USAGE ────────────────────────────────────────── */
router.get('/plan', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query(
      `SELECT plan, msg_count_month, msg_count_reset, plan_period_end,
              stripe_subscription_id, stripe_customer_id
       FROM users WHERE id=$1`,
      [req.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });
    const u = r.rows[0];

    // Agent count
    const agentCount = await pool.query('SELECT COUNT(*) FROM agents WHERE user_id=$1', [req.userId]);
    // RAG docs
    const ragCount = await pool.query(`
      SELECT COUNT(*) FROM rag_documents rd
      JOIN agents a ON rd.agent_id=a.id WHERE a.user_id=$1
    `, [req.userId]);

    const { getLimits } = require('../middleware/plan-gate');
    const limits = getLimits(u.plan);

    res.json({
      plan: u.plan,
      periodEnd: u.plan_period_end,
      hasSubscription: !!u.stripe_subscription_id,
      usage: {
        agents:    { current: parseInt(agentCount.rows[0].count), limit: limits.agents },
        messages:  { current: u.msg_count_month, limit: limits.msgPerMonth, reset: u.msg_count_reset },
        ragDocs:   { current: parseInt(ragCount.rows[0].count), limit: limits.ragDocsPerAgent === Infinity ? '∞' : limits.ragDocsPerAgent },
      },
      features: {
        api: limits.api,
        whatsapp: limits.whatsapp,
        telegram: limits.telegram,
        webhooksOut: limits.webhooksOut,
        finetune: limits.finetune,
      },
    });
  } catch(e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

/* ── DSGVO DATA EXPORT ───────────────────────────────────── */
router.get('/export', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const user = await pool.query(
      'SELECT id,email,name,lang,plan,created_at FROM users WHERE id=$1', [req.userId]
    );
    const agents = await pool.query(
      'SELECT id,public_id,name,emoji,description,system_prompt,greeting,tone,language,is_active,created_at FROM agents WHERE user_id=$1',
      [req.userId]
    );
    const messages = await pool.query(`
      SELECT cm.session_id,cm.role,cm.content,cm.source,cm.created_at,a.name AS agent_name
      FROM chat_messages cm JOIN agents a ON cm.agent_id=a.id
      WHERE a.user_id=$1 ORDER BY cm.created_at DESC LIMIT 5000
    `, [req.userId]);
    const leads = await pool.query(`
      SELECT lc.data,lc.source,lc.created_at,a.name AS agent_name
      FROM lead_captures lc JOIN agents a ON lc.agent_id=a.id WHERE a.user_id=$1
    `, [req.userId]);

    const exportData = {
      exportedAt: new Date().toISOString(),
      user: user.rows[0],
      agents: agents.rows,
      messages: messages.rows,
      leads: leads.rows,
    };

    res.setHeader('Content-Disposition', 'attachment; filename="agentkontor-daten.json"');
    res.setHeader('Content-Type', 'application/json');
    res.json(exportData);
  } catch(e) {
    res.status(500).json({ error: 'Export fehlgeschlagen' });
  }
});

/* ── ONBOARDING DONE ─────────────────────────────────────── */
router.post('/onboarding-done', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    await pool.query('UPDATE users SET onboarding_done=true WHERE id=$1', [req.userId]);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

module.exports = router;
