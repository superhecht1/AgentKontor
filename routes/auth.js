const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'agentkontor_secret_change_me';

const db = () => require('../server').locals?.pool || require('pg').Pool;

function getPool(req) { return req.app.locals.pool; }

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { email, password, name, lang = 'de' } = req.body;
  if (!email || !password || !name)
    return res.status(400).json({ error: 'Alle Felder erforderlich' });

  const pool = getPool(req);
  try {
    const exists = await pool.query('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
    if (exists.rows.length) return res.status(409).json({ error: 'E-Mail bereits registriert' });

    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      'INSERT INTO users (email, password_hash, name, lang) VALUES ($1,$2,$3,$4) RETURNING id, email, name, lang, plan',
      [email.toLowerCase(), hash, name, lang]
    );
    const user = result.rows[0];
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user });
  } catch (e) {
    console.error('REGISTER ERROR:', e.message, e.code, e.detail);
    res.status(500).json({ error: 'Registrierung fehlgeschlagen: ' + e.message + (e.detail ? ' | ' + e.detail : '') });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'E-Mail und Passwort erforderlich' });

  const pool = getPool(req);
  try {
    const result = await pool.query(
      'SELECT id, email, name, password_hash, lang, plan FROM users WHERE email=$1',
      [email.toLowerCase()]
    );
    if (!result.rows.length) return res.status(401).json({ error: 'Ungültige Zugangsdaten' });

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Ungültige Zugangsdaten' });

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    const { password_hash, ...safeUser } = user;
    res.json({ token, user: safeUser });
  } catch (e) {
    res.status(500).json({ error: 'Login fehlgeschlagen' });
  }
});

// GET /api/auth/me
router.get('/me', require('../middleware/auth'), async (req, res) => {
  const pool = getPool(req);
  try {
    const result = await pool.query(
      'SELECT id, email, name, lang, plan, created_at FROM users WHERE id=$1',
      [req.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Nutzer nicht gefunden' });
    res.json({ user: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

module.exports = router;
