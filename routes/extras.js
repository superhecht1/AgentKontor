/**
 * AgentKontor — Feedback, Versioning & Cron
 *
 * POST /api/feedback/:agentId/:sessionId  — thumbs up/down
 * GET  /api/feedback/:agentId/summary     — feedback summary
 * POST /api/agents/:id/save-version       — save agent version
 * GET  /api/agents/:id/versions           — list versions
 * POST /api/agents/:id/rollback/:versionId — rollback
 * POST /api/cron/cleanup                  — DB cleanup (call from external cron)
 * GET  /api/changelog                     — what's new
 */

const router  = require('express').Router();
const auth    = require('../middleware/auth');

function getPool(req) { return req.app.locals.pool; }

/* ── MESSAGE FEEDBACK ──────────────────────────────────── */
router.post('/feedback/:agentId/:sessionId', async (req, res) => {
  const pool = getPool(req);
  const { rating, comment, messageId } = req.body;
  if (![1, -1].includes(parseInt(rating)))
    return res.status(400).json({ error: 'Rating muss 1 (👍) oder -1 (👎) sein' });

  try {
    await pool.query(`
      INSERT INTO message_feedback (agent_id, session_id, message_id, rating, comment, source)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT DO NOTHING
    `, [req.params.agentId, req.params.sessionId, messageId || null, parseInt(rating), comment || null, req.body.source || 'web']);
    res.json({ success: true });
  } catch(e) {
    // Table might not exist yet
    res.json({ success: true });
  }
});

/* ── FEEDBACK SUMMARY (auth) ───────────────────────────── */
router.get('/feedback/:agentId/summary', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE rating=1)  AS thumbs_up,
        COUNT(*) FILTER (WHERE rating=-1) AS thumbs_down,
        COUNT(*)                           AS total
      FROM message_feedback mf
      JOIN agents a ON mf.agent_id=a.id
      WHERE mf.agent_id=$1 AND a.user_id=$2
    `, [req.params.agentId, req.userId]);

    const recent = await pool.query(`
      SELECT mf.rating, mf.comment, mf.created_at, mf.source
      FROM message_feedback mf
      JOIN agents a ON mf.agent_id=a.id
      WHERE mf.agent_id=$1 AND a.user_id=$2 AND mf.comment IS NOT NULL
      ORDER BY mf.created_at DESC LIMIT 20
    `, [req.params.agentId, req.userId]);

    res.json({ summary: r.rows[0], recent: recent.rows });
  } catch(e) {
    res.json({ summary: { thumbs_up: 0, thumbs_down: 0, total: 0 }, recent: [] });
  }
});

/* ── SAVE AGENT VERSION ────────────────────────────────── */
router.post('/agents/:id/save-version', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const a = await pool.query(
      'SELECT system_prompt, greeting, tone, quick_chips FROM agents WHERE id=$1 AND user_id=$2',
      [req.params.id, req.userId]
    );
    if (!a.rows.length) return res.status(404).json({ error: 'Agent nicht gefunden' });

    const lastV = await pool.query(
      'SELECT COALESCE(MAX(version_number),0) AS v FROM agent_versions WHERE agent_id=$1',
      [req.params.id]
    );
    const nextV = parseInt(lastV.rows[0].v) + 1;

    await pool.query(`
      INSERT INTO agent_versions (agent_id, version_number, system_prompt, greeting, tone, quick_chips)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [req.params.id, nextV, a.rows[0].system_prompt, a.rows[0].greeting, a.rows[0].tone, JSON.stringify(a.rows[0].quick_chips)]);

    // Keep only last 10 versions
    await pool.query(`
      DELETE FROM agent_versions WHERE agent_id=$1
        AND version_number < (SELECT MAX(version_number)-9 FROM agent_versions WHERE agent_id=$1)
    `, [req.params.id]);

    res.json({ success: true, version: nextV });
  } catch(e) {
    res.status(500).json({ error: 'Fehler beim Speichern' });
  }
});

/* ── LIST VERSIONS ─────────────────────────────────────── */
router.get('/agents/:id/versions', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query(`
      SELECT av.id, av.version_number, LEFT(av.system_prompt, 80) AS prompt_preview, av.created_at
      FROM agent_versions av
      JOIN agents a ON av.agent_id=a.id
      WHERE av.agent_id=$1 AND a.user_id=$2
      ORDER BY av.version_number DESC
    `, [req.params.id, req.userId]);
    res.json({ versions: r.rows });
  } catch(e) {
    res.json({ versions: [] });
  }
});

/* ── ROLLBACK ──────────────────────────────────────────── */
router.post('/agents/:id/rollback/:versionId', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const v = await pool.query(`
      SELECT av.* FROM agent_versions av
      JOIN agents a ON av.agent_id=a.id
      WHERE av.id=$1 AND av.agent_id=$2 AND a.user_id=$3
    `, [req.params.versionId, req.params.id, req.userId]);
    if (!v.rows.length) return res.status(404).json({ error: 'Version nicht gefunden' });

    const ver = v.rows[0];
    await pool.query(`
      UPDATE agents SET system_prompt=$1, greeting=$2, tone=$3, quick_chips=$4 WHERE id=$5
    `, [ver.system_prompt, ver.greeting, ver.tone, JSON.stringify(ver.quick_chips), req.params.id]);

    res.json({ success: true, rolledBackTo: ver.version_number });
  } catch(e) {
    res.status(500).json({ error: 'Rollback fehlgeschlagen' });
  }
});

/* ── CRON CLEANUP ──────────────────────────────────────── */
// Call this from an external cron (e.g. cron-job.org) every day
// Protect with CRON_SECRET env var
router.post('/cron/cleanup', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['x-cron-secret'] !== secret)
    return res.status(401).json({ error: 'Unauthorized' });

  const pool = getPool(req);
  const results = [];

  try {
    // 1. Hard-delete soft-deleted users older than 30 days
    const deleted = await pool.query(`
      DELETE FROM users WHERE deleted_at < NOW() - INTERVAL '30 days' RETURNING id
    `);
    results.push(`Hard-deleted ${deleted.rowCount} users`);

    // 2. Clean expired reset tokens
    const tokens = await pool.query(`
      DELETE FROM password_reset_tokens WHERE expires_at < NOW() - INTERVAL '1 day'
    `);
    results.push(`Deleted ${tokens.rowCount} expired reset tokens`);

    // 3. Clean old rate limit entries
    const ratelimits = await pool.query(`
      DELETE FROM rate_limits WHERE window_end < NOW() - INTERVAL '2 hours'
    `);
    results.push(`Deleted ${ratelimits.rowCount} rate limit entries`);

    // 4. Clean old cron logs (keep 30 days)
    await pool.query(`DELETE FROM cron_log WHERE ran_at < NOW() - INTERVAL '30 days'`);

    // Log run
    await pool.query(`INSERT INTO cron_log (job, result) VALUES ('cleanup', $1)`,
      [results.join(', ')]);

    console.log('Cron cleanup:', results.join(' | '));
    res.json({ success: true, results });
  } catch(e) {
    console.error('Cron cleanup error:', e.message);
    res.status(500).json({ error: 'Cleanup fehlgeschlagen' });
  }
});

/* ── CHANGELOG ─────────────────────────────────────────── */
router.get('/changelog', async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query(
      `SELECT version, title, body, created_at FROM changelog
       WHERE published=true ORDER BY created_at DESC LIMIT 10`
    );
    res.json({ entries: r.rows });
  } catch(e) {
    // Seed initial changelog if table doesn't exist yet
    res.json({ entries: [
      {
        version: '2.0',
        title: '🚀 AgentKontor 2.0 — Launch',
        body: 'Widget-Customizer, Agent-Templates, Gesprächsverlauf, WhatsApp-Wizard, Fine-Tuning, Admin-Panel, vollständige i18n und mehr.',
        created_at: new Date().toISOString(),
      }
    ]});
  }
});

/* ── HUMAN HANDOFF REQUEST ─────────────────────────────── */
router.post('/handoff/:agentId', async (req, res) => {
  const pool = getPool(req);
  const { sessionId, reason, source = 'web' } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId erforderlich' });

  try {
    await pool.query(`
      INSERT INTO handoff_requests (agent_id, session_id, source, reason)
      VALUES ($1,$2,$3,$4)
    `, [req.params.agentId, sessionId, source, reason || null]);

    // Notify agent owner via email
    setImmediate(async () => {
      try {
        const r = await pool.query(`
          SELECT a.name AS agent_name, a.emoji, u.email AS owner_email, a.lead_email
          FROM agents a JOIN users u ON a.user_id=u.id WHERE a.id=$1
        `, [req.params.agentId]);
        if (!r.rows.length || !process.env.SMTP_HOST) return;
        const { agent_name, emoji, owner_email, lead_email } = r.rows[0];
        const to = lead_email || owner_email;
        const nodemailer = require('nodemailer');
        const t = nodemailer.createTransport({
          host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT||'587'), secure: false,
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        });
        await t.sendMail({
          from: `AgentKontor <${process.env.SMTP_FROM||'noreply@agentkontor.de'}>`,
          to,
          subject: `🙋 Handoff-Anfrage: ${emoji} ${agent_name}`,
          html: `<p>Ein Nutzer bittet um menschliche Unterstützung.</p><p><strong>Agent:</strong> ${emoji} ${agent_name}</p><p><strong>Grund:</strong> ${reason||'Nicht angegeben'}</p><p><strong>Session:</strong> ${sessionId}</p><p><a href="${process.env.APP_URL||'https://agentkontor.de'}/app">Im Dashboard ansehen →</a></p>`,
        });
      } catch(e) { console.warn('Handoff email error:', e.message); }
    });

    res.json({ success: true, message: 'Ein Mitarbeiter wird sich melden.' });
  } catch(e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

module.exports = router;
