/**
 * AgentKontor — Two-Factor Authentication (TOTP)
 * Compatible with Google Authenticator, Authy, 1Password
 *
 * POST /api/auth/2fa/setup    — generate secret + QR code
 * POST /api/auth/2fa/verify   — confirm setup with code
 * POST /api/auth/2fa/disable  — disable 2FA
 * POST /api/auth/2fa/check    — verify code on login
 */

const router = require('express').Router();
const auth   = require('../middleware/auth');
const crypto = require('crypto');

function getPool(req) { return req.app.locals.pool; }

function getTOTP() {
  try { return require('speakeasy'); } catch { return null; }
}

function getQR() {
  try { return require('qrcode'); } catch { return null; }
}

/* ── SETUP: Generate secret + QR ───────────────────────── */
router.post('/2fa/setup', auth, async (req, res) => {
  const speakeasy = getTOTP();
  if (!speakeasy) return res.status(503).json({
    error: 'speakeasy nicht installiert. npm install speakeasy qrcode',
    install: 'npm install speakeasy qrcode'
  });

  const pool = getPool(req);
  try {
    const user = await pool.query('SELECT email, name FROM users WHERE id=$1', [req.userId]);
    if (!user.rows.length) return res.status(404).json({ error: 'Nutzer nicht gefunden' });

    const secret = speakeasy.generateSecret({
      name:   `AgentKontor (${user.rows[0].email})`,
      issuer: 'AgentKontor',
      length: 20,
    });

    // Temporarily store secret (not yet enabled)
    await pool.query(
      'UPDATE users SET totp_secret=$1, totp_enabled=false WHERE id=$2',
      [secret.base32, req.userId]
    );

    // Generate QR code as data URL
    const qrCodeUrl = secret.otpauth_url;
    let qrDataUrl = null;
    const QRCode = getQR();
    if (QRCode) {
      qrDataUrl = await QRCode.toDataURL(qrCodeUrl);
    }

    res.json({
      secret: secret.base32,
      qrCode: qrDataUrl,
      manualEntry: {
        account: user.rows[0].email,
        secret:  secret.base32,
        issuer:  'AgentKontor',
      },
    });
  } catch(e) {
    console.error('2FA setup error:', e.message);
    res.status(500).json({ error: 'Fehler beim Einrichten' });
  }
});

/* ── VERIFY: Confirm setup ──────────────────────────────── */
router.post('/2fa/verify', auth, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code erforderlich' });

  const speakeasy = getTOTP();
  if (!speakeasy) return res.status(503).json({ error: 'speakeasy nicht installiert' });

  const pool = getPool(req);
  try {
    const user = await pool.query('SELECT totp_secret FROM users WHERE id=$1', [req.userId]);
    if (!user.rows.length || !user.rows[0].totp_secret)
      return res.status(400).json({ error: 'Erst Setup durchführen' });

    const valid = speakeasy.totp.verify({
      secret:   user.rows[0].totp_secret,
      encoding: 'base32',
      token:    code.replace(/\s/g, ''),
      window:   1,
    });

    if (!valid) return res.status(400).json({ error: 'Ungültiger Code. Bitte erneut versuchen.' });

    // Generate backup codes
    const backupCodes = Array.from({ length: 8 }, () =>
      crypto.randomBytes(4).toString('hex').toUpperCase()
    );

    await pool.query(
      'UPDATE users SET totp_enabled=true, totp_backup_codes=$1 WHERE id=$2',
      [JSON.stringify(backupCodes), req.userId]
    );

    res.json({ success: true, backupCodes });
  } catch(e) {
    res.status(500).json({ error: 'Fehler beim Verifizieren' });
  }
});

/* ── DISABLE 2FA ────────────────────────────────────────── */
router.post('/2fa/disable', auth, async (req, res) => {
  const { code, password } = req.body;
  const pool = getPool(req);

  try {
    const user = await pool.query('SELECT password_hash, totp_secret, totp_enabled FROM users WHERE id=$1', [req.userId]);
    if (!user.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });

    // Verify password
    const bcrypt = require('bcryptjs');
    const validPw = await bcrypt.compare(password || '', user.rows[0].password_hash);
    if (!validPw) return res.status(401).json({ error: 'Passwort falsch' });

    // Optionally verify TOTP code
    if (user.rows[0].totp_enabled && code) {
      const speakeasy = getTOTP();
      if (speakeasy) {
        const validCode = speakeasy.totp.verify({
          secret: user.rows[0].totp_secret, encoding: 'base32',
          token: code.replace(/\s/g, ''), window: 1,
        });
        if (!validCode) return res.status(400).json({ error: 'Ungültiger 2FA-Code' });
      }
    }

    await pool.query(
      'UPDATE users SET totp_enabled=false, totp_secret=NULL, totp_backup_codes=\'[]\' WHERE id=$1',
      [req.userId]
    );
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

/* ── CHECK on login (called from auth.js) ───────────────── */
router.post('/2fa/check', async (req, res) => {
  const { userId, code } = req.body;
  if (!userId || !code) return res.status(400).json({ error: 'userId und code erforderlich' });

  const speakeasy = getTOTP();
  if (!speakeasy) return res.status(503).json({ error: 'TOTP nicht verfügbar' });

  const pool = getPool(req);
  try {
    const user = await pool.query(
      'SELECT totp_secret, totp_enabled, totp_backup_codes FROM users WHERE id=$1 AND deleted_at IS NULL',
      [userId]
    );
    if (!user.rows.length || !user.rows[0].totp_enabled)
      return res.json({ required: false });

    const cleanCode = code.replace(/\s/g, '');

    // Check backup codes first
    const backupCodes = user.rows[0].totp_backup_codes || [];
    const backupIdx   = backupCodes.indexOf(cleanCode.toUpperCase());
    if (backupIdx !== -1) {
      // Invalidate used backup code
      const newCodes = [...backupCodes];
      newCodes.splice(backupIdx, 1);
      await pool.query('UPDATE users SET totp_backup_codes=$1 WHERE id=$2', [JSON.stringify(newCodes), userId]);
      return res.json({ valid: true, backupUsed: true });
    }

    // Check TOTP
    const valid = speakeasy.totp.verify({
      secret: user.rows[0].totp_secret, encoding: 'base32',
      token: cleanCode, window: 1,
    });

    res.json({ valid, required: true });
  } catch(e) {
    res.status(500).json({ error: 'Fehler beim Prüfen' });
  }
});

/* ── STATUS ─────────────────────────────────────────────── */
router.get('/2fa/status', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query('SELECT totp_enabled FROM users WHERE id=$1', [req.userId]);
    res.json({ enabled: r.rows[0]?.totp_enabled || false });
  } catch(e) { res.status(500).json({ error: 'Fehler' }); }
});

module.exports = router;
