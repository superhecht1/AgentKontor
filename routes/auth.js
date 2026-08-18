/**
 * AgentKontor — Auth Routes (security-hardened)
 * POST /api/auth/register
 * POST /api/auth/login
 * GET  /api/auth/me
 *
 * Robustness: queries gracefully handle missing columns (token_version, is_admin)
 * by using COALESCE / fallback — no dependency on specific migration order.
 */

const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

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

const { setAuthCookie, clearAuthCookie, hashIp } = require('../utils/privacy');
const { auditLog } = require('../middleware/plan-gate');
if (!JWT_SECRET) throw new Error('❌ JWT_SECRET env var nicht gesetzt — bitte in Render setzen');

function getPool(req) { return req.app.locals.pool; }

/** Ensure security columns exist — runs once, idempotent */
async function ensureColumns(pool) {
  // Run once per server start would be ideal, but this is safe idempotently
  const cols = [
    // Auth basics
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version    INTEGER  NOT NULL DEFAULT 1`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin         BOOLEAN  NOT NULL DEFAULT false`,
    // 2FA
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled     BOOLEAN  NOT NULL DEFAULT false`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret      TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_backup_codes TEXT`,
    // Lockout
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS login_attempts   INTEGER  NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until     TIMESTAMPTZ`,
    // Soft-delete
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at       TIMESTAMPTZ`,
    // Plan / trial
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_ends_at    TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_period_end  TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_cycle    VARCHAR(10) DEFAULT 'monthly'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id      VARCHAR(64)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id  VARCHAR(64)`,
    // Quota
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS msg_count_month  INTEGER  NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS msg_count_reset  TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS quota_alert_sent BOOLEAN  NOT NULL DEFAULT false`,
    // E-Mail double-opt-in
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_email       VARCHAR(256)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_email_token VARCHAR(128)`,
    // Misc
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS lang              VARCHAR(5)  DEFAULT 'de'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_done   BOOLEAN  NOT NULL DEFAULT false`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS digest_frequency  VARCHAR(10) DEFAULT 'weekly'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS digest_last_sent  TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS workspace_id      INTEGER`,
  ];
  // Run all in parallel, ignore errors (column already exists)
  await Promise.allSettled(cols.map(sql => pool.query(sql)));
}

function maskEmail(e) { return e ? e.replace(/(?<=.{1}).(?=[^@]*@)/g, '*') : ''; }

function signToken(userId, tokenVersion) {
  return jwt.sign({ userId, tv: tokenVersion }, JWT_SECRET, { expiresIn: '30d' });
}

/* ── REGISTER ──────────────────────────────────────────── */
router.post('/register', async (req, res) => {
  const pool = req.app.locals.pool;
  const { email, password, name } = req.body;
  if (!email || !password || !name)
    return res.status(400).json({ error: 'Alle Felder erforderlich' });

  // Passwort-Stärke
  const pwErr = checkPasswordStrength(password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  // E-Mail-Format
  if (!/^[^@]+@[^@]+\.[^@]+$/.test(email))
    return res.status(400).json({ error: 'Ungültige E-Mail-Adresse' });

  try {
    // Bereits registriert?
    const existing = await pool.query('SELECT id, email_confirmed FROM users WHERE email=$1', [email.toLowerCase()]);
    if (existing.rows.length) {
      if (!existing.rows[0].email_confirmed) {
        return res.status(409).json({
          error: 'E-Mail bereits registriert aber noch nicht bestätigt.',
          code: 'UNCONFIRMED',
          userId: existing.rows[0].id
        });
      }
      return res.status(409).json({ error: 'E-Mail bereits registriert.' });
    }

    
    const crypto     = require('crypto');
    const hash       = await bcrypt.hash(password, 12);
    const token      = crypto.randomBytes(32).toString('hex');
    const expires    = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    const r = await pool.query(
      `INSERT INTO users (email, password_hash, name, plan, email_confirmed, confirm_token, confirm_expires)
       VALUES ($1,$2,$3,'free',false,$4,$5) RETURNING id`,
      [email.toLowerCase(), hash, name.trim(), token, expires]
    );
    const userId = r.rows[0].id;

    // Bestätigungs-E-Mail senden
    const baseUrl = process.env.BASE_URL || ('https://'+req.get('host'));
    const confirmUrl = `${baseUrl}/auth/confirm?token=${token}`;
    const { sendMail } = require('../utils/mailer');

    try {
      await sendMail({
        to:      email,
        subject: 'AgentKontor — Bitte bestätige deine E-Mail-Adresse',
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:40px auto;padding:32px;background:#fff;border-radius:12px;border:1px solid #eee">
            <h2 style="color:#7c3aed;margin-top:0">Willkommen bei AgentKontor! 🤖</h2>
            <p>Hallo ${name},</p>
            <p>klicke auf den Button um deine E-Mail-Adresse zu bestätigen und dein Konto zu aktivieren:</p>
            <a href="${confirmUrl}" style="display:inline-block;margin:20px 0;padding:14px 28px;background:#7c3aed;color:#fff;text-decoration:none;border-radius:8px;font-weight:700">
              ✅ E-Mail bestätigen
            </a>
            <p style="color:#888;font-size:.85rem">Dieser Link ist 24 Stunden gültig.<br>Falls du dich nicht registriert hast, ignoriere diese E-Mail.</p>
            <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
            <p style="color:#aaa;font-size:.75rem">AgentKontor · superhecht.ai</p>
          </div>`,
        text: `Hallo ${name},\n\nbitte bestätige deine E-Mail-Adresse:\n${confirmUrl}\n\nDieser Link ist 24 Stunden gültig.`,
      });
      res.status(201).json({ success: true, message: 'Registrierung erfolgreich! Bitte prüfe deine E-Mails.' });
    } catch(mailErr) {
      console.error('REGISTER MAIL ERROR:', mailErr.message);
      // Registrierung trotzdem erfolgreich — User manuell bestätigen lassen
      res.status(201).json({
        success: true,
        warning: 'Konto erstellt aber Bestätigungs-E-Mail konnte nicht gesendet werden: ' + mailErr.message,
        // Für Dev: Token direkt zurückgeben
        ...(process.env.NODE_ENV !== 'production' ? { dev_confirm_url: confirmUrl } : {})
      });
    }
  } catch(e) {
    console.error('REGISTER:', e.message);
    res.status(500).json({ error: 'Registrierung fehlgeschlagen: ' + e.message });
  }
});

// ── GET /auth/confirm  — E-Mail bestätigen ──────────────────────────────────
router.get('/confirm', async (req, res) => {
  const pool = req.app.locals.pool;
  const { token } = req.query;
  if (!token) return res.redirect('/app.html?confirmed=error&msg=Kein+Token');

  try {
    const r = await pool.query(
      `UPDATE users SET email_confirmed=true, confirm_token=NULL, confirm_expires=NULL, is_active=true
       WHERE confirm_token=$1 AND confirm_expires > NOW() AND email_confirmed=false
       RETURNING id, email, name`,
      [token]
    );

    if (!r.rows.length) {
      // Token abgelaufen oder ungültig?
      const expired = await pool.query(
        'SELECT id FROM users WHERE confirm_token=$1', [token]
      );
      if (expired.rows.length) {
        return res.redirect('/app.html?confirmed=expired');
      }
      return res.redirect('/app.html?confirmed=invalid');
    }

    console.log('✅ E-Mail bestätigt:', r.rows[0].email);
    res.redirect('/app.html?confirmed=success&name=' + encodeURIComponent(r.rows[0].name));
  } catch(e) {
    console.error('CONFIRM:', e.message);
    res.redirect('/app.html?confirmed=error&msg=' + encodeURIComponent(e.message));
  }
});

// ── POST /auth/resend-confirm  — Bestätigungs-E-Mail erneut senden ──────────
router.post('/resend-confirm', async (req, res) => {
  const pool = req.app.locals.pool;
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'E-Mail erforderlich' });

  try {
    const crypto = require('crypto');
    const token  = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const r = await pool.query(
      `UPDATE users SET confirm_token=$1, confirm_expires=$2
       WHERE email=$3 AND email_confirmed=false RETURNING name`,
      [token, expires, email.toLowerCase()]
    );
    if (!r.rows.length)
      return res.status(404).json({ error: 'E-Mail nicht gefunden oder bereits bestätigt.' });

    const baseUrl = process.env.BASE_URL || ('https://'+req.get('host'));
    const confirmUrl = `${baseUrl}/auth/confirm?token=${token}`;
    const { sendMail } = require('../utils/mailer');

    await sendMail({
      to:      email,
      subject: 'AgentKontor — Neuer Bestätigungslink',
      html: `<div style="font-family:sans-serif;max-width:520px;margin:40px auto;padding:32px;background:#fff;border-radius:12px">
        <h2 style="color:#7c3aed">Neuer Bestätigungslink</h2>
        <p>Hallo ${r.rows[0].name},</p>
        <a href="${confirmUrl}" style="display:inline-block;margin:20px 0;padding:14px 28px;background:#7c3aed;color:#fff;text-decoration:none;border-radius:8px;font-weight:700">
          ✅ E-Mail bestätigen
        </a>
        <p style="color:#888;font-size:.85rem">Dieser Link ist 24 Stunden gültig.</p>
      </div>`,
      text: `Neuer Bestätigungslink:\n${confirmUrl}`,
    });

    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


/* ── LOGIN ─────────────────────────────────────────────── */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'E-Mail und Passwort erforderlich' });

  const pool = getPool(req);
  try {
    // ensureColumns runs once per process start, cached after first run
    if (!global._ak_columns_ready) {
      await ensureColumns(pool);
      global._ak_columns_ready = true;
    }

    // Fallback query if new columns don't exist yet
    const result = await pool.query(
      `SELECT id, email, name, password_hash, lang, plan, onboarding_done,
              COALESCE(is_admin, false)             AS is_admin,
              COALESCE(token_version, 1)            AS token_version,
              COALESCE(totp_enabled, false)         AS totp_enabled,
              totp_secret, totp_backup_codes,
              COALESCE(login_attempts, 0)           AS login_attempts,
              locked_until, deleted_at
       FROM users WHERE email=$1 AND deleted_at IS NULL`,
      [email.toLowerCase()]
    );
    // Identical error for wrong email AND wrong password — prevents user enumeration
    if (!result.rows.length) return res.status(401).json({ error: 'Ungültige Zugangsdaten' });

    const user  = result.rows[0];

    // Check lockout BEFORE bcrypt (bcrypt is slow - don't waste time on locked accounts)
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const mins = Math.ceil((new Date(user.locked_until) - Date.now()) / 60000);
      return res.status(423).json({ error: `Konto gesperrt. Bitte in ${mins} Minute(n) erneut versuchen.` });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      // Increment failed attempts, lock after 5
      const pool2 = getPool(req);

    // E-Mail bestätigt?
    if (user.email_confirmed === false) {
      return res.status(403).json({
        error: 'Bitte bestätige zuerst deine E-Mail-Adresse.',
        code: 'EMAIL_NOT_CONFIRMED',
        email: user.email,
      });
    }
      const attempts = (user.login_attempts || 0) + 1;
      const lockUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;
      await pool2.query('UPDATE users SET login_attempts=$1, locked_until=$2 WHERE id=$3', [attempts, lockUntil, user.id]);
      if (lockUntil) return res.status(423).json({ error: 'Zu viele Fehlversuche. Konto für 15 Minuten gesperrt.' });
      return res.status(401).json({ error: 'Ungültige Zugangsdaten' });
    }
    // Reset on success
    await pool.query('UPDATE users SET login_attempts=0, locked_until=NULL WHERE id=$1', [user.id]);

    const token = signToken(user.id, user.token_version);
    const { password_hash, token_version, ...safeUser } = user;

    // FIX 1: 2FA check — if enabled, require code before issuing token
    if (user.totp_enabled) {
      const totpCode = req.body.totpCode || req.body.totp_code;
      if (!totpCode) {
        // Return partial response — frontend must ask for TOTP
        return res.json({ requires2FA: true, userId: user.id });
      }
      try {
        const speakeasy = require('speakeasy');
        const valid2FA = speakeasy.totp.verify({
          secret: user.totp_secret, encoding: 'base32',
          token: totpCode.replace(/\s/g, ''), window: 1,
        });
        if (!valid2FA) {
          // Check backup codes
          const backups = user.totp_backup_codes || [];
          const idx = backups.indexOf(totpCode.toUpperCase().replace(/\s/g, ''));
          if (idx === -1) return res.status(401).json({ error: 'Ungültiger 2FA-Code.' });
          backups.splice(idx, 1);
          await pool.query('UPDATE users SET totp_backup_codes=$1 WHERE id=$2', [JSON.stringify(backups), user.id]);
        }
      } catch(e) {
        if (e.code === 'MODULE_NOT_FOUND')
          return res.status(503).json({ error: '2FA nicht verfügbar (speakeasy fehlt).' });
        throw e;
      }
    }

    setImmediate(() => auditLog(pool, user.id, 'user_login', 'user', user.id, { ip_hash: hashIp(req.ip) }));
    setAuthCookie(res, token);
    res.json({ token, user: safeUser });
  } catch (e) {
    console.error('LOGIN ERROR:', e.message);
    res.status(500).json({ error: 'Login fehlgeschlagen' });
  }
});

/* ── ME ────────────────────────────────────────────────── */
router.get('/me', require('../middleware/auth'), async (req, res) => {
  const pool = getPool(req);
  try {
    const result = await pool.query(
      `SELECT id, email, name, lang, plan, onboarding_done,
              COALESCE(is_admin, false) AS is_admin, created_at
       FROM users WHERE id=$1`,
      [req.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Nutzer nicht gefunden' });
    res.json({ user: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

/* ── WELCOME EMAIL ─────────────────────────────────────── */
async function sendWelcomeEmail(to, name) {
  if (!process.env.SMTP_HOST) return;
  try {
    const nodemailer  = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT || '587'), secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    const base = process.env.APP_URL || 'https://agentkontor.de';
    await transporter.sendMail({
      from: `AgentKontor <${process.env.SMTP_FROM || 'noreply@agentkontor.de'}>`, to,
      subject: `Willkommen bei AgentKontor, ${name}!`,
      html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f3ef;font-family:sans-serif">
<div style="max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden">
  <div style="background:#1a1916;padding:32px 40px;text-align:center">
    <div style="font-size:1.5rem;font-weight:800;color:#fff">Agent<span style="color:#a29bfe">Kontor</span></div>
  </div>
  <div style="padding:40px">
    <h1 style="font-size:1.4rem;color:#1a1916;margin:0 0 12px">Hallo ${name}! 👋</h1>
    <p style="color:#7a786e;line-height:1.7;margin:0 0 24px">Willkommen bei AgentKontor — deiner Plattform für eigene KI-Agenten.</p>
    <a href="${base}/app" style="display:block;background:#1a1916;color:#fff;text-align:center;padding:14px 32px;border-radius:9px;text-decoration:none;font-weight:600;font-size:.9rem;margin-bottom:20px">Dashboard öffnen →</a>
    <p style="color:#a8a49a;font-size:.78rem">Fragen? <a href="mailto:info@think-cloud.org" style="color:#5b4fcf">info@think-cloud.org</a></p>
  </div>
  <div style="background:#f4f3ef;padding:20px 40px;text-align:center;font-size:.72rem;color:#a8a49a">
    © 2025 AgentKontor · superhecht.ai · Köln
  </div>
</div></body></html>`,
    });
    console.log('✅ Welcome email sent to', to.replace(/(?<=.{1}).(?=[^@]*@)/g, '*'));
  } catch (e) { console.warn('Welcome email failed:', e.message); }
}

/* ── TOKEN REFRESH ──────────────────────────────────────── */
// Issues a new short-lived access token using the existing valid cookie/header
router.post('/refresh', require('../middleware/auth'), async (req, res) => {
  const pool = req.app.locals.pool;
  try {
    const r = await pool.query(
      'SELECT token_version, plan, name, email FROM users WHERE id=$1 AND deleted_at IS NULL',
      [req.userId]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'Nutzer nicht gefunden' });
    const user  = r.rows[0];
    const token = signToken(req.userId, user.token_version);
    setAuthCookie(res, token);
    res.json({ token, expiresIn: '30d' });
  } catch(e) {
    res.status(500).json({ error: 'Refresh fehlgeschlagen' });
  }
});

/* ── LOGOUT ─────────────────────────────────────────────── */
router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ success: true });
});

async function ensureColumnsOnce(pool) {
  if (!global._ak_columns_ready) {
    await ensureColumns(pool);
    global._ak_columns_ready = true;
  }
}

module.exports = router;
module.exports.ensureColumnsOnce = ensureColumnsOnce;
