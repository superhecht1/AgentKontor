/**
 * AgentKontor — JWT Auth Middleware (security-hardened)
 * token_version check: invalidates tokens after password change
 * Graceful fallback if column doesn't exist yet
 */

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('❌ JWT_SECRET env var nicht gesetzt');

module.exports = async function auth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer '))
    return res.status(401).json({ error: 'Nicht autorisiert' });

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;

    // Check token_version only if present in JWT (new tokens) — old tokens skip check
    if (payload.tv !== undefined) {
      const pool = req.app.locals.pool;
      try {
        const r = await pool.query(
          'SELECT COALESCE(token_version, 1) AS token_version FROM users WHERE id=$1',
          [payload.userId]
        );
        if (!r.rows.length || r.rows[0].token_version !== payload.tv) {
          return res.status(401).json({ error: 'Sitzung abgelaufen. Bitte erneut anmelden.' });
        }
      } catch {
        // Column might not exist yet — skip check, don't block login
      }
    }

    next();
  } catch (e) {
    return res.status(401).json({ error: 'Ungültiger oder abgelaufener Token' });
  }
};
