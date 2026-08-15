/**
 * AgentKontor — Referral Program
 * 20% MRR commission for referring users
 *
 * GET  /api/referral/me          — my referral code + stats
 * POST /api/referral/track       — track referral on registration
 * GET  /api/referral/leaderboard — top referrers (public)
 */

const router = require('express').Router();
const auth   = require('../middleware/auth');
const crypto = require('crypto');

function getPool(req) { return req.app.locals.pool; }

function generateCode(name) {
  const slug  = (name || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 6);
  const rand  = crypto.randomBytes(2).toString('hex').toUpperCase();
  return (slug || 'AK') + rand;
}

/* ── GET MY REFERRAL INFO ───────────────────────────────── */
router.get('/me', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    // Ensure user has a referral code
    let user = await pool.query('SELECT name, email, referral_code, referral_credits FROM users WHERE id=$1', [req.userId]);
    if (!user.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });

    if (!user.rows[0].referral_code) {
      const code = generateCode(user.rows[0].name);
      await pool.query('UPDATE users SET referral_code=$1 WHERE id=$2', [code, req.userId]);
      user.rows[0].referral_code = code;
    }

    // Stats
    const stats = await pool.query(`
      SELECT
        COUNT(*) AS total_referrals,
        COUNT(*) FILTER (WHERE status='converted') AS converted,
        COUNT(*) FILTER (WHERE status='paid') AS paid
      FROM referrals WHERE referrer_id=$1
    `, [req.userId]);

    const base = process.env.APP_URL || 'https://agentkontor.de';
    res.json({
      code:     user.rows[0].referral_code,
      link:     `${base}/app?ref=${user.rows[0].referral_code}`,
      credits:  parseFloat(user.rows[0].referral_credits || 0),
      stats:    stats.rows[0],
    });
  } catch(e) {
    console.error('Referral me error:', e.message);
    res.status(500).json({ error: 'Fehler' });
  }
});

/* ── TRACK REFERRAL (called on registration) ────────────── */
router.post('/track', async (req, res) => {
  const { code, newUserId } = req.body;
  if (!code || !newUserId) return res.status(400).json({ error: 'code und newUserId erforderlich' });

  const pool = getPool(req);
  try {
    // Find referrer
    const referrer = await pool.query('SELECT id FROM users WHERE referral_code=$1', [code.toUpperCase()]);
    if (!referrer.rows.length) return res.json({ success: false, reason: 'Code nicht gefunden' });
    if (referrer.rows[0].id === parseInt(newUserId)) return res.json({ success: false, reason: 'Selbstreferral' });

    // Record referral
    await pool.query(`
      INSERT INTO referrals (referrer_id, referred_id, code)
      VALUES ($1,$2,$3)
      ON CONFLICT DO NOTHING
    `, [referrer.rows[0].id, newUserId, code.toUpperCase()]);

    // Mark new user as referred
    await pool.query('UPDATE users SET referred_by_code=$1 WHERE id=$2', [code.toUpperCase(), newUserId]);

    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

/* ── CONVERT REFERRAL (called when referred user subscribes) */
async function convertReferral(pool, subscribedUserId, amountEur) {
  try {
    const ref = await pool.query(
      "SELECT * FROM referrals WHERE referred_id=$1 AND status='pending'",
      [subscribedUserId]
    );
    if (!ref.rows.length) return;

    const referral    = ref.rows[0];
    const commission  = (amountEur * referral.commission_pct) / 100;

    // Credit referrer
    await pool.query(
      'UPDATE users SET referral_credits=referral_credits+$1 WHERE id=$2',
      [commission, referral.referrer_id]
    );
    await pool.query(
      "UPDATE referrals SET status='paid', credited_at=NOW() WHERE id=$1",
      [referral.id]
    );

    console.log(`Referral converted: user ${referral.referrer_id} earned €${commission.toFixed(2)}`);
  } catch(e) { console.warn('Referral convert error:', e.message); }
}

/* ── LEADERBOARD (public) ───────────────────────────────── */
router.get('/leaderboard', async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query(`
      SELECT u.name,
             COUNT(ref.id) AS total_referrals,
             COUNT(ref.id) FILTER (WHERE ref.status='paid') AS paid_referrals
      FROM users u
      JOIN referrals ref ON ref.referrer_id=u.id
      WHERE ref.status IN ('converted','paid')
      GROUP BY u.id ORDER BY paid_referrals DESC LIMIT 10
    `);
    res.json({ leaderboard: r.rows });
  } catch(e) { res.json({ leaderboard: [] }); }
});

module.exports = router;
module.exports.convertReferral = convertReferral;
