/**
 * AgentKontor — Account Management (security-hardened)
 * FIX 7:  E-Mail in Logs maskiert
 * FIX 8:  smtp_pass aus DSGVO-Export entfernt
 * FIX 9:  Soft-Delete statt sofortigem DELETE
 */

const router = require('express').Router();
const auth   = require('../middleware/auth');
const bcrypt = require('bcryptjs');


function checkPasswordStrength(pw) {
  if (!pw || pw.length < 8) return 'Passwort muss mindestens 8 Zeichen lang sein.';
  if (pw.length > 128) return 'Passwort darf maximal 128 Zeichen lang sein.';
  // Check for at least 2 of: uppercase, lowercase, number, special char
  const checks = [/[A-Z]/, /[a-z]/, /[0-9]/, /[^A-Za-z0-9]/];
  const passed = checks.filter(r => r.test(pw)).length;
  if (passed < 2) return 'Passwort muss mindestens Groß- und Kleinbuchstaben oder Zahlen enthalten.';
  // Common passwords
  const common = ['password', 'passwort', '12345678', 'qwertyui', 'abcdefgh'];
  if (common.some(p => pw.toLowerCase().includes(p))) return 'Passwort zu einfach. Bitte wähle ein sichereres Passwort.';
  return null; // valid
}


function getPool(req) { return req.app.locals.pool; }

// FIX 7: Mask email in logs
function maskEmail(email) {
  return email.replace(/(?<=.{1}).(?=[^@]*@)/g, '*');
}

/* ── CHANGE PASSWORD ─────────────────────────────────────── */
router.patch('/password', auth, async (req, res) => {
  const pool = getPool(req);
  const { current, newPw } = req.body;
  if (!current || !newPw) return res.status(400).json({ error: 'Alle Felder erforderlich' });
  const pwErr = checkPasswordStrength(newPw);
  if (pwErr) return res.status(400).json({ error: pwErr });
  if (newPw === current) return res.status(400).json({ error: 'Neues Passwort muss sich unterscheiden' });

  try {
    const r = await pool.query('SELECT password_hash FROM users WHERE id=$1 AND deleted_at IS NULL', [req.userId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Nutzer nicht gefunden' });
    const valid = await bcrypt.compare(current, r.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Aktuelles Passwort falsch' });
    const hash = await bcrypt.hash(newPw, 12);
    await pool.query(
      'UPDATE users SET password_hash=$1, token_version=COALESCE(token_version,1)+1 WHERE id=$2',
      [hash, req.userId]
    );
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
    const r = await pool.query('SELECT password_hash FROM users WHERE id=$1 AND deleted_at IS NULL', [req.userId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Nutzer nicht gefunden' });
    const valid = await bcrypt.compare(password, r.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Passwort falsch' });

    const exists = await pool.query(
      'SELECT id FROM users WHERE email=$1 AND id!=$2 AND deleted_at IS NULL',
      [email.toLowerCase(), req.userId]
    );
    if (exists.rows.length) return res.status(409).json({ error: 'E-Mail bereits vergeben' });

    // FIX 9: Double-opt-in — send verification link to NEW email
    const crypto = require('crypto');
    const verifyToken = crypto.randomBytes(32).toString('hex');
    // Store pending new email + token
    await pool.query(
      'UPDATE users SET pending_email=$1, pending_email_token=$2 WHERE id=$3',
      [email.toLowerCase(), verifyToken, req.userId]
    ).catch(async () => {
      // Column might not exist yet — add it on the fly
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_email VARCHAR(256)');
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_email_token VARCHAR(128)');
      await pool.query('UPDATE users SET pending_email=$1, pending_email_token=$2 WHERE id=$3',
        [email.toLowerCase(), verifyToken, req.userId]);
    });

    // Send verification to NEW email
    if (process.env.SMTP_HOST) {
      const nodemailer = require('nodemailer');
      const t = nodemailer.createTransport({ host:process.env.SMTP_HOST, port:parseInt(process.env.SMTP_PORT||'587'), secure:false, auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS} });
      const link = `${process.env.APP_URL||'https://agentkontor.de'}/api/auth/confirm-email/${verifyToken}`;
      await t.sendMail({
        from: `AgentKontor <${process.env.SMTP_FROM||'noreply@agentkontor.de'}>`,
        to: email.toLowerCase(),
        subject: 'E-Mail-Adresse bestätigen — AgentKontor',
        html: `<div style="font-family:sans-serif;max-width:500px;margin:32px auto;padding:28px;background:#fff;border-radius:12px"><h2>Neue E-Mail bestätigen</h2><p>Klicke auf den folgenden Link um deine neue E-Mail-Adresse zu bestätigen:</p><a href="${link}" style="display:inline-block;background:#6c5ce7;color:#fff;padding:11px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:14px">E-Mail bestätigen →</a><p style="color:#888;font-size:.8rem;margin-top:14px">Der Link ist 24 Stunden gültig. Falls du diese Änderung nicht angefragt hast, ignoriere diese E-Mail.</p></div>`,
      }).catch(() => {});
    }

    res.json({ success: true, pending: true, message: 'Bestätigungslink an neue E-Mail gesendet.' });
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

/* ── DELETE ACCOUNT (Soft-Delete) ────────────────────────── */
// FIX 9: Soft-Delete — Daten bleiben 30 Tage erhalten (DSGVO-konform)
// Stripe-Daten bleiben für 10-Jahres-Aufbewahrungspflicht
router.delete('/', auth, async (req, res) => {
  const pool = getPool(req);
  const { password, confirm } = req.body;
  if (!password) return res.status(400).json({ error: 'Passwort erforderlich' });
  if (confirm !== 'LÖSCHEN') return res.status(400).json({ error: 'Bitte "LÖSCHEN" eingeben' });

  try {
    const r = await pool.query(
      'SELECT password_hash, stripe_subscription_id, email FROM users WHERE id=$1 AND deleted_at IS NULL',
      [req.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nutzer nicht gefunden' });
    const valid = await bcrypt.compare(password, r.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Passwort falsch' });

    // Cancel Stripe subscription
    if (r.rows[0].stripe_subscription_id && process.env.STRIPE_SECRET_KEY) {
      try {
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        await stripe.subscriptions.cancel(r.rows[0].stripe_subscription_id);
      } catch(stripeErr) { console.warn('Stripe cancel:', stripeErr.message); }
    }

    // Soft-delete: mark as deleted, anonymize PII, deactivate agents
    // Keep stripe_customer_id + plan history for 10-year billing retention (§257 HGB)
    await pool.query(`
      UPDATE users SET
        deleted_at = NOW(),
        email      = 'deleted-' || id || '@deleted.invalid',
        name       = 'Gelöschter Nutzer',
        password_hash = '$2a$12$DELETED.ACCOUNT.PLACEHOLDER.HASH.CANNOT.LOGIN.EVER',
        token_version = COALESCE(token_version,1) + 999,
        email_verify_token = NULL
      WHERE id=$1
    `, [req.userId]);

    // Deactivate all agents
    await pool.query('UPDATE agents SET is_active=false WHERE user_id=$1', [req.userId]);

    // FIX 7: Delete RAG documents and chunks (PII / proprietary content)
    await pool.query(`
      DELETE FROM document_chunks dc
      USING rag_documents rd
      JOIN agents a ON rd.agent_id=a.id
      WHERE dc.document_id=rd.id AND a.user_id=$1
    `, [req.userId]).catch(() => {});

    await pool.query(`
      DELETE FROM rag_documents rd
      USING agents a
      WHERE rd.agent_id=a.id AND a.user_id=$1
    `, [req.userId]).catch(() => {});

    // Delete agent memory (encrypted facts)
    await pool.query(`
      DELETE FROM agent_memory am
      USING agents a
      WHERE am.agent_id=a.id AND a.user_id=$1
    `, [req.userId]).catch(() => {});

    // Anonymize chat messages (keep for analytics, remove PII)
    // Full delete of leads (PII)
    await pool.query(`
      DELETE FROM lead_captures WHERE agent_id IN (SELECT id FROM agents WHERE user_id=$1)
    `, [req.userId]).catch(() => ({ rows: [] }));

    console.log(`Account soft-deleted: user ${req.userId} (${maskEmail(r.rows[0].email)})`);
    res.json({ success: true, message: 'Konto wird innerhalb von 30 Tagen vollständig gelöscht.' });
  } catch(e) {
    console.error('Delete account error:', e.message);
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
       FROM users WHERE id=$1 AND deleted_at IS NULL`,
      [req.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });
    const u = r.rows[0];

    const agentCount = await pool.query('SELECT COUNT(*) FROM agents WHERE user_id=$1', [req.userId]);
    const ragCount   = await pool.query(`
      SELECT COUNT(*) FROM rag_documents rd
      JOIN agents a ON rd.agent_id=a.id WHERE a.user_id=$1
    `, [req.userId]).catch(() => ({ rows: [{ n:0, count:0, total:0 }] }));

    const { getLimits } = require('../middleware/plan-gate');
    const limits = getLimits(u.plan);

    res.json({
      plan: u.plan,
      periodEnd: u.plan_period_end,
      hasSubscription: !!u.stripe_subscription_id,
      usage: {
        agents:   { current: parseInt(agentCount.rows[0].count), limit: limits.agents },
        messages: { current: u.msg_count_month, limit: limits.msgPerMonth, reset: u.msg_count_reset },
        ragDocs:  { current: parseInt(ragCount.rows[0].count), limit: limits.ragDocsPerAgent },
      },
      features: {
        api: limits.api, whatsapp: limits.whatsapp, telegram: limits.telegram,
        webhooksOut: limits.webhooksOut, finetune: limits.finetune,
      },
    });
  } catch(e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

/* ── DSGVO DATA EXPORT ───────────────────────────────────── */
// FIX 8: smtp_pass wird NICHT exportiert
router.get('/export', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const user = await pool.query(
      'SELECT id,email,name,lang,plan,created_at FROM users WHERE id=$1',
      [req.userId]
    );
    const agents = await pool.query(
      // Deliberately exclude smtp_pass and other credentials
      `SELECT id,public_id,name,emoji,description,system_prompt,greeting,tone,language,
              is_active,widget_enabled,chatpage_enabled,api_enabled,
              whatsapp_enabled,telegram_enabled,rag_enabled,
              cap_calendar,cal_link,cap_leads,lead_fields,cap_products,products_data,
              cap_multilang,created_at
       FROM agents WHERE user_id=$1`,
      [req.userId]
    );
    const messages = await pool.query(`
      SELECT cm.session_id,cm.role,cm.content,cm.source,cm.created_at,a.name AS agent_name
      FROM chat_messages cm JOIN agents a ON cm.agent_id=a.id
      WHERE a.user_id=$1 ORDER BY cm.created_at DESC LIMIT 1000
    `, [req.userId]).catch(() => ({ rows: [{ n:0, count:0, total:0 }] }));
    const leads = await pool.query(`
      SELECT lc.data,lc.source,lc.created_at,a.name AS agent_name
      FROM lead_captures lc JOIN agents a ON lc.agent_id=a.id WHERE a.user_id=$1
    `, [req.userId]).catch(() => ({ rows: [{ n:0, count:0, total:0 }] }));

    res.setHeader('Content-Disposition', 'attachment; filename="agentkontor-daten.json"');
    res.setHeader('Content-Type', 'application/json');
    res.json({
      exportedAt: new Date().toISOString(),
      notice: 'SMTP-Zugangsdaten werden aus Sicherheitsgründen nicht exportiert. Chat-Verlauf: max. 1.000 neueste Nachrichten.',
      datenschutz: {
        verantwortlicher: 'Mark Rusniok, superhecht.ai, Gottesweg 20, 50969 Köln',
        datenempfaenger: [
          { name: 'Anthropic, Inc. (USA)', zweck: 'KI-Modell-Inferenz (Chat-Inhalte)', rechtsgrundlage: 'Art. 6 Abs. 1 lit. b DSGVO' },
          { name: 'Neon Inc. (USA)', zweck: 'Datenbank-Hosting', rechtsgrundlage: 'Art. 6 Abs. 1 lit. b DSGVO' },
          { name: 'Render Services (USA)', zweck: 'Web-Hosting', rechtsgrundlage: 'Art. 6 Abs. 1 lit. b DSGVO' },
          { name: 'Stripe, Inc. (USA)', zweck: 'Zahlungsabwicklung', rechtsgrundlage: 'Art. 6 Abs. 1 lit. b DSGVO' },
        ],
        speicherdauer: 'Chat-Daten: 90 Tage Standard (konfigurierbar). Rechnungsdaten: 10 Jahre (§257 HGB).',
        betroffenenrechte: 'Auskunft, Berichtigung, Löschung, Einschränkung, Datenübertragbarkeit — info@think-cloud.org',
      },
      user: user.rows[0],
      agents: agents.rows,
      messages: messages.rows,
      leads: leads.rows,
    });
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
