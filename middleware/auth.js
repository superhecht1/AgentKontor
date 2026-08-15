/**
 * AgentKontor — JWT Auth Middleware
 * Verifies token + checks token_version to allow invalidation on pw-change
 */

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('❌ JWT_SECRET env var nicht gesetzt — Start abgebrochen');

module.exports = async function auth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer '))
    return res.status(401).json({ error: 'Nicht autorisiert' });

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;

    // Check token_version — invalidates old tokens after password change
    const pool = req.app.locals.pool;
    if (pool && payload.tv !== undefined) {
      const r = await pool.query('SELECT token_version FROM users WHERE id=$1', [payload.userId]);
      if (!r.rows.length || r.rows[0].token_version !== payload.tv) {
        return res.status(401).json({ error: 'Sitzung abgelaufen. Bitte erneut anmelden.' });
      }
    }

    next();
  } catch (e) {
    return res.status(401).json({ error: 'Ungültiger oder abgelaufener Token' });
  }
};
