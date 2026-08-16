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
const { setAuthCookie, clearAuthCookie, hashIp } = require('../utils/privacy');
const { auditLog } = require('../middleware/plan-gate');
if (!JWT_SECRET) throw new Error('❌ JWT_SECRET env var nicht gesetzt — bitte in Render setzen');

function getPool(req) { return req.app.locals.pool; }

/** Ensure security columns exist — runs once, idempotent */
async function ensureColumns(pool) {
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 1`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false`);
}

function maskEmail(e) { return e ? e.replace(/(?<=.{1}).(?=[^@]*@)/g, '*') : ''; }

function signToken(userId, tokenVersion) {
  return jwt.sign({ userId, tv: tokenVersion }, JWT_SECRET, { expiresIn: '30d' });
}

/* ── REGISTER ──────────────────────────────────────────── */
router.post('/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name)
    return res.status(400).json({ error: 'Alle Felder erforderlich' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Passwort mindestens 8 Zeichen' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Ungültige E-Mail-Adresse' });

  const pool = getPool(req);
  try {
    await ensureColumns(pool);

    const exists = await pool.query('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
    if (exists.rows.length) return res.status(409).json({ error: 'E-Mail bereits registriert' });

    const hash   = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1,$2,$3)
       RETURNING id, email, name, lang, plan, onboarding_done,
                 COALESCE(token_version, 1) AS token_version`,
      [email.toLowerCase(), hash, name]
    );
    const user  = result.rows[0];
    const token = signToken(user.id, user.token_version);

    setImmediate(() => sendWelcomeEmail(user.email, user.name));

    const { token_version, ...safeUser } = user;
    setAuthCookie(res, token);
    res.json({ token, user: safeUser });
  } catch (e) {
    console.error('REGISTER ERROR:', e.message);
    res.status(500).json({ error: 'Registrierung fehlgeschlagen' });
  }
});

/* ── LOGIN ─────────────────────────────────────────────── */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'E-Mail und Passwort erforderlich' });

  const pool = getPool(req);
  try {
    await ensureColumns(pool);

    const result = await pool.query(
      `SELECT id, email, name, password_hash, lang, plan, onboarding_done,
              COALESCE(is_admin, false)        AS is_admin,
              COALESCE(token_version, 1)       AS token_version
       FROM users WHERE email=$1`,
      [email.toLowerCase()]
    );
    // Identical error for wrong email AND wrong password — prevents user enumeration
    if (!result.rows.length) return res.status(401).json({ error: 'Ungültige Zugangsdaten' });

    const user  = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Ungültige Zugangsdaten' });

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
    console.log('✅ Welcome email sent to', to);
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

module.exports = router;
