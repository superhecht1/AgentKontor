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

    // 1b. Auto-delete chat messages past agent retention period
    const chatDel = await pool.query(`
      DELETE FROM chat_messages cm
      USING agents a
      WHERE cm.agent_id = a.id
        AND cm.created_at < NOW() - (a.data_retention_days * INTERVAL '1 day')
    `);
    results.push(`Deleted ${chatDel.rowCount} expired chat messages`);

    // 1c. Auto-delete leads past lead retention period
    const leadDel = await pool.query(`
      DELETE FROM lead_captures lc
      USING agents a
      WHERE lc.agent_id = a.id
        AND lc.created_at < NOW() - (a.lead_retention_days * INTERVAL '1 day')
    `);
    results.push(`Deleted ${leadDel.rowCount} expired leads`);

    // 1c2. Clean stale agent_memory (updated more than 180 days ago = likely abandoned sessions)
    const memClean = await pool.query(`
      DELETE FROM agent_memory WHERE updated_at < NOW() - INTERVAL '180 days'
    `);
    results.push(`Cleaned ${memClean.rowCount} stale memory records`);

    // 1d. Anonymize IP addresses in audit_log older than 30 days
    const ipAnon = await pool.query(`
      UPDATE audit_log
      SET ip_address = NULL
      WHERE created_at < NOW() - INTERVAL '30 days'
        AND ip_address IS NOT NULL
    `);
    results.push(`Anonymized ${ipAnon.rowCount} IP addresses in audit log`);

    // 1e. Process deletion requests
    const delReqs = await pool.query(`
      SELECT * FROM deletion_requests WHERE status='pending'
    `).catch(() => ({ rows: [] }));

    for (const delReq of delReqs.rows) {
      try {
        await pool.query(`DELETE FROM chat_messages WHERE agent_id=$1
          AND session_id IN (
            SELECT session_id FROM chat_messages cm2
            JOIN agent_memory am ON am.agent_id=cm2.agent_id
            WHERE am.session_identifier=$2 AND am.agent_id=$1
            LIMIT 1000
          )`, [delReq.agent_id, delReq.session_identifier_hash]);
        await pool.query(`DELETE FROM agent_memory WHERE agent_id=$1 AND session_identifier=$2`,
          [delReq.agent_id, delReq.session_identifier_hash]);
        await pool.query(`UPDATE deletion_requests SET status='done', completed_at=NOW() WHERE id=$1`, [delReq.id]);
      } catch(e) { console.warn('Deletion request error:', e.message); }
    }
    if (delReqs.rows.length) results.push(`Processed ${delReqs.rows.length} deletion requests`);

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

    // Send lead digests
    const digestCount = await sendLeadDigests(pool);
    results.push(`Digest emails sent: ${digestCount}`);

    // FIX 15: Reset monthly quota alert flag (so users get notified again next month)
    const quotaReset = await pool.query(`
      UPDATE users SET quota_alert_sent=false
      WHERE quota_alert_sent=true
        AND msg_count_reset < DATE_TRUNC('month', NOW())
      RETURNING id
    `).catch(() => ({ rowCount: 0 }));
    if (quotaReset.rowCount > 0)
      results.push(`Reset quota alert for ${quotaReset.rowCount} users`);

    // FIX 4: Downgrade expired trials to free plan
    const trialExpired = await pool.query(`
      UPDATE users SET plan='free'
      WHERE plan='pro'
        AND trial_ends_at IS NOT NULL
        AND trial_ends_at < NOW()
        AND stripe_subscription_id IS NULL
        AND deleted_at IS NULL
      RETURNING id
    `);
    if (trialExpired.rowCount > 0)
      results.push(`Downgraded ${trialExpired.rowCount} expired trials to free`);

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


/* ── LEAD DIGEST EMAIL ──────────────────────────────────── */
// Also called by cron cleanup — sends daily/weekly lead summaries
async function sendLeadDigests(pool) {
  try {
    // Find users who want digest and haven't received one recently
    const users = await pool.query(`
      SELECT u.id, u.email, u.name, u.digest_frequency, u.digest_last_sent
      FROM users u WHERE u.deleted_at IS NULL
        AND u.digest_frequency != 'never'
        AND (
          (u.digest_frequency='daily'  AND (u.digest_last_sent IS NULL OR u.digest_last_sent < NOW()-INTERVAL'23 hours'))
          OR
          (u.digest_frequency='weekly' AND (u.digest_last_sent IS NULL OR u.digest_last_sent < NOW()-INTERVAL'6 days 23 hours'))
        )
    `);

    for (const user of users.rows) {
      try {
        // Get leads since last digest
        const since = user.digest_last_sent || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const leads = await pool.query(`
          SELECT lc.data, lc.source, lc.created_at, a.name AS agent_name, a.emoji
          FROM lead_captures lc
          JOIN agents a ON lc.agent_id=a.id
          WHERE a.user_id=$1 AND lc.created_at > $2
          ORDER BY lc.created_at DESC LIMIT 50
        `, [user.id, since]);

        if (!leads.rows.length) continue; // No new leads

        if (!process.env.SMTP_HOST) continue;

        const nodemailer = require('nodemailer');
        const t = nodemailer.createTransport({ host:process.env.SMTP_HOST, port:parseInt(process.env.SMTP_PORT||'587'), secure:false, auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS} });

        const rows = leads.rows.map(l =>
          `<tr><td style="padding:7px 11px">${l.emoji} ${l.agent_name}</td><td style="padding:7px 11px">${JSON.stringify(l.data).slice(0,60)}</td><td style="padding:7px 11px;color:#888;font-size:.85em">${l.source}</td><td style="padding:7px 11px;color:#888;font-size:.85em">${new Date(l.created_at).toLocaleDateString('de-DE')}</td></tr>`
        ).join('');

        await t.sendMail({
          from: `AgentKontor <${process.env.SMTP_FROM||'noreply@agentkontor.de'}>`,
          to: user.email,
          subject: `📊 ${leads.rows.length} neue Leads — AgentKontor`,
          html: `<div style="font-family:sans-serif;max-width:600px;margin:32px auto;padding:28px;background:#fff;border-radius:12px;border:1px solid #eee">
            <h2 style="margin-bottom:4px">Hallo ${user.name}!</h2>
            <p style="color:#888;margin-bottom:20px">${leads.rows.length} neue Lead(s) seit deinem letzten Digest.</p>
            <table style="width:100%;border-collapse:collapse;border:1px solid #eee;border-radius:8px;overflow:hidden">
              <thead><tr style="background:#f8f8f8"><th style="padding:8px 11px;text-align:left;font-size:.8em;color:#888">Agent</th><th style="padding:8px 11px;text-align:left;font-size:.8em;color:#888">Daten</th><th style="padding:8px 11px;text-align:left;font-size:.8em;color:#888">Kanal</th><th style="padding:8px 11px;text-align:left;font-size:.8em;color:#888">Datum</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
            <a href="${process.env.APP_URL||'https://agentkontor.de'}/app" style="display:inline-block;margin-top:20px;background:#6c5ce7;color:#fff;padding:10px 22px;border-radius:8px;text-decoration:none;font-weight:600">Im Dashboard ansehen →</a>
            <p style="color:#aaa;font-size:.78em;margin-top:16px">Digest-Frequenz ändern: Einstellungen → Benachrichtigungen</p>
          </div>`
        });

        // Update last sent
        await pool.query('UPDATE users SET digest_last_sent=NOW() WHERE id=$1', [user.id]);
      } catch(e) { console.warn(`Digest error for user ${user.id}:`, e.message); }
    }

    return users.rows.length;
  } catch(e) { console.error('Digest error:', e.message); return 0; }
}

/* ── AUDIT LOG ENDPOINT ─────────────────────────────────── */
router.get('/audit', require('../middleware/auth'), async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query(
      `SELECT action, entity, entity_id, metadata, ip_address, created_at
       FROM audit_log WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [req.userId]
    );
    res.json({ log: r.rows });
  } catch(e) { res.json({ log: [] }); }
});

/* ── DIGEST PREFERENCES ─────────────────────────────────── */
router.put('/digest-preferences', require('../middleware/auth'), async (req, res) => {
  const pool = getPool(req);
  const { frequency } = req.body;
  if (!['daily','weekly','never'].includes(frequency))
    return res.status(400).json({ error: 'Ungültige Frequenz' });
  try {
    await pool.query('UPDATE users SET digest_frequency=$1 WHERE id=$2', [frequency, req.userId]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Fehler' }); }
});


/* ── END-USER DELETION (DSGVO Recht auf Vergessen) ──────── */
// Widget users can delete their own data by providing session identifier
router.post('/widget/forget', async (req, res) => {
  const pool = getPool(req);
  const { sessionIdentifier, agentId, email } = req.body;
  if (!sessionIdentifier && !email) return res.status(400).json({ error: 'sessionIdentifier oder E-Mail erforderlich' });
  if (!agentId) return res.status(400).json({ error: 'agentId erforderlich' });

  try {
    const { hashSessionId } = require('../utils/privacy');
    const hash = sessionIdentifier ? hashSessionId(sessionIdentifier) : null;

    // Queue deletion request
    await pool.query(`
      INSERT INTO deletion_requests (agent_id, session_identifier_hash, email)
      VALUES ($1,$2,$3)
      ON CONFLICT DO NOTHING
    `, [agentId, hash || 'email:' + email, email || null]).catch(() => {});

    // Also immediate delete if hash known
    if (hash) {
      await pool.query('DELETE FROM agent_memory WHERE agent_id=$1 AND session_identifier=$2', [agentId, hash]);
    }

    res.json({ success: true, message: 'Deine Daten werden innerhalb von 24 Stunden gelöscht.' });
  } catch(e) {
    res.status(500).json({ error: 'Fehler beim Verarbeiten der Anfrage' });
  }
});

/* ── DATA RETENTION SETTINGS ────────────────────────────── */
router.put('/agents/:id/retention', require('../middleware/auth'), async (req, res) => {
  const pool = getPool(req);
  const { data_retention_days, lead_retention_days } = req.body;
  const chat = Math.min(Math.max(parseInt(data_retention_days) || 90, 7), 730);
  const lead = Math.min(Math.max(parseInt(lead_retention_days) || 180, 7), 730);
  try {
    const r = await pool.query('SELECT id FROM agents WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
    if (!r.rows.length) return res.status(403).json({ error: 'Nicht berechtigt' });
    await pool.query(
      'UPDATE agents SET data_retention_days=$1, lead_retention_days=$2 WHERE id=$3',
      [chat, lead, req.params.id]
    );
    res.json({ success: true, data_retention_days: chat, lead_retention_days: lead });
  } catch(e) { res.status(500).json({ error: 'Fehler' }); }
});

module.exports = router;
module.exports.sendLeadDigests = sendLeadDigests;
