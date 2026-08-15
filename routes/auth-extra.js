/**
 * AgentKontor — Password Reset & Email Verification
 *
 * POST /api/auth/forgot-password          — send reset email
 * POST /api/auth/reset-password           — apply new password with token
 * GET  /api/auth/verify-email/:token      — verify email address
 * POST /api/auth/resend-verification      — resend verification email
 */

const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

function getPool(req) { return req.app.locals.pool; }

async function ensureResetTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL,
      token VARCHAR(128) NOT NULL UNIQUE, expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL'1 hour',
      used BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_token VARCHAR(128)`);
}

async function sendMail(to, subject, html) {
  if (!process.env.SMTP_HOST) return false;
  try {
    const nodemailer  = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT || '587'), secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transporter.sendMail({
      from: `AgentKontor <${process.env.SMTP_FROM || 'noreply@agentkontor.de'}>`,
      to, subject, html,
    });
    return true;
  } catch (e) {
    console.warn('Mail error:', e.message);
    return false;
  }
}

const base = () => process.env.APP_URL || 'https://agentkontor.de';

function mailWrap(content) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f3ef;font-family:sans-serif">
<div style="max-width:520px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden">
  <div style="background:#1a1916;padding:28px 36px;text-align:center">
    <div style="font-size:1.4rem;font-weight:800;color:#fff">Agent<span style="color:#a29bfe">Kontor</span></div>
  </div>
  <div style="padding:36px">${content}</div>
  <div style="background:#f4f3ef;padding:16px 36px;text-align:center;font-size:.72rem;color:#a8a49a">
    © 2025 AgentKontor · superhecht.ai · Köln
  </div>
</div></body></html>`;
}

/* ── FORGOT PASSWORD ───────────────────────────────────── */
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'E-Mail erforderlich' });

  const pool = getPool(req);
  try {
    await ensureResetTable(pool);
    const r = await pool.query('SELECT id, name FROM users WHERE email=$1', [email.toLowerCase()]);

    // Always return success — no user enumeration
    if (!r.rows.length) return res.json({ success: true });

    const user  = r.rows[0];
    const token = crypto.randomBytes(48).toString('hex');

    // Invalidate old tokens
    await pool.query('UPDATE password_reset_tokens SET used=true WHERE user_id=$1 AND used=false', [user.id]);
    await pool.query(
      'INSERT INTO password_reset_tokens (user_id, token) VALUES ($1,$2)',
      [user.id, token]
    );

    const link = `${base()}/app?reset=${token}`;
    const html = mailWrap(`
      <h2 style="color:#1a1916;margin:0 0 12px;font-size:1.2rem">Passwort zurücksetzen</h2>
      <p style="color:#7a786e;line-height:1.7;margin:0 0 22px">Hallo ${user.name},<br>du hast eine Passwort-Zurücksetzung angefordert. Der Link ist <strong>1 Stunde</strong> gültig.</p>
      <a href="${link}" style="display:block;background:#6c5ce7;color:#fff;text-align:center;padding:13px 28px;border-radius:9px;text-decoration:none;font-weight:600;font-size:.9rem;margin-bottom:18px">Neues Passwort setzen →</a>
      <p style="color:#a8a49a;font-size:.76rem;line-height:1.6">Falls du das nicht angefordert hast, kannst du diese E-Mail ignorieren. Dein Passwort bleibt unverändert.</p>
    `);

    await sendMail(email, 'Passwort zurücksetzen – AgentKontor', html);
    res.json({ success: true });
  } catch (e) {
    console.error('FORGOT PW ERROR:', e.message);
    res.status(500).json({ error: 'Fehler' });
  }
});

/* ── RESET PASSWORD ────────────────────────────────────── */
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token und Passwort erforderlich' });
  if (password.length < 8)  return res.status(400).json({ error: 'Passwort mindestens 8 Zeichen' });

  const pool = getPool(req);
  try {
    const r = await pool.query(
      'SELECT id, user_id FROM password_reset_tokens WHERE token=$1 AND used=false AND expires_at > NOW()',
      [token]
    );
    if (!r.rows.length) return res.status(400).json({ error: 'Link ungültig oder abgelaufen' });

    const { id: tokenId, user_id } = r.rows[0];
    const hash = await bcrypt.hash(password, 12);

    await pool.query(
      'UPDATE users SET password_hash=$1, token_version=COALESCE(token_version,1)+1 WHERE id=$2',
      [hash, user_id]
    );
    await pool.query('UPDATE password_reset_tokens SET used=true WHERE id=$1', [tokenId]);

    res.json({ success: true });
  } catch (e) {
    console.error('RESET PW ERROR:', e.message);
    res.status(500).json({ error: 'Fehler beim Zurücksetzen' });
  }
});

/* ── VERIFY EMAIL ──────────────────────────────────────── */
router.get('/verify-email/:token', async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query(
      'UPDATE users SET email_verified=true, email_verify_token=NULL WHERE email_verify_token=$1 RETURNING id',
      [req.params.token]
    );
    if (!r.rows.length) return res.redirect(`${base()}/app?verified=invalid`);
    res.redirect(`${base()}/app?verified=ok`);
  } catch (e) {
    res.redirect(`${base()}/app?verified=error`);
  }
});

/* ── RESEND VERIFICATION ───────────────────────────────── */
router.post('/resend-verification', require('../middleware/auth'), async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query('SELECT email, name, email_verified FROM users WHERE id=$1', [req.userId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Nutzer nicht gefunden' });
    if (r.rows[0].email_verified) return res.json({ success: true, already: true });

    const token = crypto.randomBytes(32).toString('hex');
    await pool.query('UPDATE users SET email_verify_token=$1 WHERE id=$2', [token, req.userId]);

    const link = `${base()}/api/auth/verify-email/${token}`;
    const html = mailWrap(`
      <h2 style="color:#1a1916;margin:0 0 12px;font-size:1.2rem">E-Mail bestätigen</h2>
      <p style="color:#7a786e;line-height:1.7;margin:0 0 22px">Hallo ${r.rows[0].name},<br>bitte bestätige deine E-Mail-Adresse.</p>
      <a href="${link}" style="display:block;background:#6c5ce7;color:#fff;text-align:center;padding:13px 28px;border-radius:9px;text-decoration:none;font-weight:600;font-size:.9rem;margin-bottom:18px">E-Mail bestätigen →</a>
    `);
    await sendMail(r.rows[0].email, 'E-Mail bestätigen – AgentKontor', html);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

module.exports = router;
