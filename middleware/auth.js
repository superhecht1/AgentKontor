/**
 * AgentKontor — Auth Middleware
 * Reads JWT from:
 *   1. httpOnly Cookie (ak_token) — preferred, XSS-safe
 *   2. Authorization: Bearer header — fallback for API clients
 */

const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;

module.exports = async function auth(req, res, next) {
  // 1. Try httpOnly cookie first
  let token = req.cookies?.ak_token;

  // 2. Fallback to Authorization header (API clients, mobile)
  if (!token) {
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ')) token = header.slice(7);
  }

  if (!token) return res.status(401).json({ error: 'Nicht autorisiert' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;

    // Token version check (invalidates old tokens after password change)
    if (payload.tokenVersion !== undefined && req.app?.locals?.pool) {
      const pool = req.app.locals.pool;
      const r = await pool.query(
        'SELECT token_version FROM users WHERE id=$1 AND deleted_at IS NULL',
        [payload.userId]
      );
      if (!r.rows.length || r.rows[0].token_version !== payload.tokenVersion) {
        return res.status(401).json({ error: 'Sitzung abgelaufen. Bitte erneut anmelden.' });
      }
    }

    next();
  } catch(e) {
    if (e.name === 'TokenExpiredError')
      return res.status(401).json({ error: 'Sitzung abgelaufen.' });
    return res.status(401).json({ error: 'Ungültiges Token.' });
  }
};
