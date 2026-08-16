/**
 * AgentKontor — Extras: Feedback, Versioning, Cron, Changelog, Handoff,
 *               Digest, Audit, Deletion, Retention, Webhook Inspector,
 *               Conversation Intelligence, Lead Scoring, Templates
 */

const router = require('express').Router();
const auth   = require('../middleware/auth');

function getPool(req) { return req.app.locals.pool; }

/* ── MESSAGE FEEDBACK ──────────────────────────────────── */
router.post('/feedback/:agentId/:sessionId', async (req, res) => {
  const pool = getPool(req);
  const { rating, comment, messageId } = req.body;
  if (![1, -1].includes(parseInt(rating))) return res.status(400).json({ error: 'Rating 1 oder -1' });
  try {
    await pool.query('INSERT INTO message_feedback (agent_id, session_id, message_id, rating, comment, source) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
      [req.params.agentId, req.params.sessionId, messageId||null, parseInt(rating), comment||null, req.body.source||'web']);
    res.json({ success: true });
  } catch { res.json({ success: true }); }
});

router.get('/feedback/:agentId/summary', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query('SELECT COUNT(*) FILTER (WHERE rating=1) AS thumbs_up, COUNT(*) FILTER (WHERE rating=-1) AS thumbs_down, COUNT(*) AS total FROM message_feedback mf JOIN agents a ON mf.agent_id=a.id WHERE mf.agent_id=$1 AND a.user_id=$2',
      [req.params.agentId, req.userId]);
    const recent = await pool.query('SELECT mf.rating, mf.comment, mf.created_at, mf.source FROM message_feedback mf JOIN agents a ON mf.agent_id=a.id WHERE mf.agent_id=$1 AND a.user_id=$2 AND mf.comment IS NOT NULL ORDER BY mf.created_at DESC LIMIT 20',
      [req.params.agentId, req.userId]);
    res.json({ summary: r.rows[0], recent: recent.rows });
  } catch { res.json({ summary: { thumbs_up:0, thumbs_down:0, total:0 }, recent: [] }); }
});

/* ── AGENT VERSIONING ──────────────────────────────────── */
router.post('/agents/:id/save-version', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const a = await pool.query('SELECT system_prompt, greeting, tone, quick_chips FROM agents WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
    if (!a.rows.length) return res.status(404).json({ error: 'Agent nicht gefunden' });
    const lastV = await pool.query('SELECT COALESCE(MAX(version_number),0) AS v FROM agent_versions WHERE agent_id=$1', [req.params.id]);
    const nextV = parseInt(lastV.rows[0].v) + 1;
    await pool.query('INSERT INTO agent_versions (agent_id, version_number, system_prompt, greeting, tone, quick_chips) VALUES ($1,$2,$3,$4,$5,$6)',
      [req.params.id, nextV, a.rows[0].system_prompt, a.rows[0].greeting, a.rows[0].tone, JSON.stringify(a.rows[0].quick_chips)]);
    await pool.query('DELETE FROM agent_versions WHERE agent_id=$1 AND version_number < (SELECT MAX(version_number)-9 FROM agent_versions WHERE agent_id=$1)', [req.params.id]);
    res.json({ success: true, version: nextV });
  } catch { res.status(500).json({ error: 'Fehler' }); }
});

router.get('/agents/:id/versions', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query('SELECT av.id, av.version_number, LEFT(av.system_prompt,80) AS prompt_preview, av.created_at FROM agent_versions av JOIN agents a ON av.agent_id=a.id WHERE av.agent_id=$1 AND a.user_id=$2 ORDER BY av.version_number DESC', [req.params.id, req.userId]);
    res.json({ versions: r.rows });
  } catch { res.json({ versions: [] }); }
});

router.post('/agents/:id/rollback/:versionId', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const v = await pool.query('SELECT av.* FROM agent_versions av JOIN agents a ON av.agent_id=a.id WHERE av.id=$1 AND av.agent_id=$2 AND a.user_id=$3', [req.params.versionId, req.params.id, req.userId]);
    if (!v.rows.length) return res.status(404).json({ error: 'Version nicht gefunden' });
    await pool.query('UPDATE agents SET system_prompt=$1, greeting=$2, tone=$3, quick_chips=$4 WHERE id=$5', [v.rows[0].system_prompt, v.rows[0].greeting, v.rows[0].tone, JSON.stringify(v.rows[0].quick_chips), req.params.id]);
    res.json({ success: true, rolledBackTo: v.rows[0].version_number });
  } catch { res.status(500).json({ error: 'Rollback fehlgeschlagen' }); }
});

/* ── CRON CLEANUP ──────────────────────────────────────── */
router.post('/cron/cleanup', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['x-cron-secret'] !== secret) return res.status(401).json({ error: 'Unauthorized' });
  const pool = getPool(req);
  const results = [];
  try {
    // Hard-delete soft-deleted users
    const deleted = await pool.query("DELETE FROM users WHERE deleted_at < NOW() - INTERVAL '30 days' RETURNING id");
    results.push('Hard-deleted ' + deleted.rowCount + ' users');
    // Auto-delete chats past retention
    const chatDel = await pool.query("DELETE FROM chat_messages cm USING agents a WHERE cm.agent_id=a.id AND cm.created_at < NOW() - (a.data_retention_days * INTERVAL '1 day')");
    results.push('Deleted ' + chatDel.rowCount + ' expired chat messages');
    // Auto-delete leads
    const leadDel = await pool.query("DELETE FROM lead_captures lc USING agents a WHERE lc.agent_id=a.id AND lc.created_at < NOW() - (a.lead_retention_days * INTERVAL '1 day')");
    results.push('Deleted ' + leadDel.rowCount + ' expired leads');
    // Anonymize IPs
    const ipAnon = await pool.query("UPDATE audit_log SET ip_address=NULL WHERE created_at < NOW()-INTERVAL '30 days' AND ip_address IS NOT NULL");
    results.push('Anonymized ' + ipAnon.rowCount + ' IPs');
    // Stale memory
    const memClean = await pool.query("DELETE FROM agent_memory WHERE updated_at < NOW()-INTERVAL '180 days'");
    results.push('Cleaned ' + memClean.rowCount + ' stale memory records');
    // Clean expired tokens
    const tokens = await pool.query("DELETE FROM password_reset_tokens WHERE expires_at < NOW()-INTERVAL '1 day'");
    results.push('Deleted ' + tokens.rowCount + ' expired tokens');
    // Clean rate limits
    const rl = await pool.query("DELETE FROM rate_limits WHERE window_end < NOW()-INTERVAL '2 hours'");
    results.push('Deleted ' + rl.rowCount + ' rate limit entries');
    // Reset monthly quota alert
    const qa = await pool.query("UPDATE users SET quota_alert_sent=false WHERE quota_alert_sent=true AND msg_count_reset < DATE_TRUNC('month',NOW())").catch(() => ({rowCount:0}));
    if (qa.rowCount > 0) results.push('Reset quota alert for ' + qa.rowCount + ' users');
    // Downgrade expired trials
    const trialExp = await pool.query("UPDATE users SET plan='free' WHERE plan='pro' AND trial_ends_at IS NOT NULL AND trial_ends_at < NOW() AND stripe_subscription_id IS NULL AND deleted_at IS NULL RETURNING id");
    if (trialExp.rowCount > 0) results.push('Downgraded ' + trialExp.rowCount + ' expired trials');
    // Process deletion requests
    const delReqs = await pool.query("SELECT * FROM deletion_requests WHERE status='pending'").catch(() => ({rows:[]}));
    for (const delReq of delReqs.rows) {
      try {
        await pool.query('DELETE FROM agent_memory WHERE agent_id=$1 AND session_identifier=$2', [delReq.agent_id, delReq.session_identifier_hash]);
        await pool.query("UPDATE deletion_requests SET status='done', completed_at=NOW() WHERE id=$1", [delReq.id]);
      } catch(e) { console.warn('Deletion request error:', e.message); }
    }
    if (delReqs.rows.length) results.push('Processed ' + delReqs.rows.length + ' deletion requests');
    // Lead digests
    const digestCount = await sendLeadDigests(pool);
    results.push('Digest emails: ' + digestCount);
    // Log
    await pool.query('INSERT INTO cron_log (job, result) VALUES ($1,$2)', ['cleanup', results.join(', ')]);
    console.log('Cron:', results.join(' | '));
    res.json({ success: true, results });
  } catch(e) { console.error('Cron error:', e.message); res.status(500).json({ error: 'Cleanup fehlgeschlagen' }); }
});

/* ── CHANGELOG ─────────────────────────────────────────── */
router.get('/changelog', async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query("SELECT version, title, body, created_at FROM changelog WHERE published=true ORDER BY created_at DESC LIMIT 10");
    res.json({ entries: r.rows });
  } catch {
    res.json({ entries: [{ version:'3.0', title:'🚀 AgentKontor 3.0', body:'Multi-LLM Support, Voice, Agentic Actions, White-Label und mehr.', created_at: new Date().toISOString() }] });
  }
});

/* ── HANDOFF ───────────────────────────────────────────── */
router.post('/handoff/:agentId', async (req, res) => {
  const pool = getPool(req);
  const { sessionId, reason, source='web' } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId erforderlich' });
  try {
    await pool.query('INSERT INTO handoff_requests (agent_id, session_id, source, reason) VALUES ($1,$2,$3,$4)', [req.params.agentId, sessionId, source, reason||null]);
    setImmediate(async () => {
      try {
        const r = await pool.query('SELECT a.name, a.emoji, u.email, a.lead_email FROM agents a JOIN users u ON a.user_id=u.id WHERE a.id=$1', [req.params.agentId]);
        if (!r.rows.length || !process.env.SMTP_HOST) return;
        const { name, emoji, email, lead_email } = r.rows[0];
        const nodemailer = require('nodemailer');
        const t = nodemailer.createTransport({ host:process.env.SMTP_HOST, port:parseInt(process.env.SMTP_PORT||'587'), secure:false, auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS} });
        await t.sendMail({ from:`AgentKontor <${process.env.SMTP_FROM||'noreply@agentkontor.de'}>`, to: lead_email||email, subject:`🙋 Handoff: ${emoji} ${name}`, html:`<p>Ein Nutzer bittet um menschliche Unterstützung.</p><p><b>Grund:</b> ${reason||'Nicht angegeben'}</p><p><b>Session:</b> ${sessionId}</p>` });
      } catch(e) { console.warn('Handoff email:', e.message); }
    });
    res.json({ success: true, message: 'Ein Mitarbeiter wird sich melden.' });
  } catch { res.status(500).json({ error: 'Fehler' }); }
});

/* ── LEAD DIGEST ───────────────────────────────────────── */
async function sendLeadDigests(pool) {
  try {
    const users = await pool.query("SELECT u.id, u.email, u.name, u.digest_frequency, u.digest_last_sent FROM users u WHERE u.deleted_at IS NULL AND u.digest_frequency != 'never' AND ((u.digest_frequency='daily' AND (u.digest_last_sent IS NULL OR u.digest_last_sent < NOW()-INTERVAL'23 hours')) OR (u.digest_frequency='weekly' AND (u.digest_last_sent IS NULL OR u.digest_last_sent < NOW()-INTERVAL'6 days 23 hours')))");
    for (const user of users.rows) {
      try {
        const since = user.digest_last_sent || new Date(Date.now() - 7*24*60*60*1000);
        const leads = await pool.query('SELECT lc.data, lc.source, lc.created_at, a.name AS agent_name, a.emoji FROM lead_captures lc JOIN agents a ON lc.agent_id=a.id WHERE a.user_id=$1 AND lc.created_at > $2 ORDER BY lc.created_at DESC LIMIT 50', [user.id, since]);
        if (!leads.rows.length || !process.env.SMTP_HOST) continue;
        const nodemailer = require('nodemailer');
        const t = nodemailer.createTransport({ host:process.env.SMTP_HOST, port:parseInt(process.env.SMTP_PORT||'587'), secure:false, auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS} });
        const rows = leads.rows.map(l => '<tr><td>' + l.emoji + ' ' + l.agent_name + '</td><td>' + JSON.stringify(l.data).slice(0,60) + '</td><td>' + l.source + '</td></tr>').join('');
        await t.sendMail({ from:`AgentKontor <${process.env.SMTP_FROM||'noreply@agentkontor.de'}>`, to:user.email, subject:'📊 ' + leads.rows.length + ' neue Leads — AgentKontor', html:'<div style="font-family:sans-serif;max-width:600px;margin:32px auto"><h2>Hallo ' + user.name + '!</h2><table>' + rows + '</table><a href="' + (process.env.APP_URL||'https://agentkontor.de') + '/app">Dashboard →</a></div>' });
        await pool.query('UPDATE users SET digest_last_sent=NOW() WHERE id=$1', [user.id]);
      } catch(e) { console.warn('Digest error user ' + user.id + ':', e.message); }
    }
    return users.rows.length;
  } catch { return 0; }
}

/* ── AUDIT LOG ─────────────────────────────────────────── */
router.get('/audit', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query('SELECT action, entity, entity_id, metadata, ip_address, created_at FROM audit_log WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [req.userId]);
    res.json({ log: r.rows });
  } catch { res.json({ log: [] }); }
});

/* ── DIGEST PREFERENCES ────────────────────────────────── */
router.put('/digest-preferences', auth, async (req, res) => {
  const pool = getPool(req);
  const { frequency } = req.body;
  if (!['daily','weekly','never'].includes(frequency)) return res.status(400).json({ error: 'Ungueltige Frequenz' });
  try {
    await pool.query('UPDATE users SET digest_frequency=$1 WHERE id=$2', [frequency, req.userId]);
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Fehler' }); }
});

/* ── END-USER DELETION ─────────────────────────────────── */
router.post('/widget/forget', async (req, res) => {
  const pool = getPool(req);
  const { sessionIdentifier, agentId } = req.body;
  if (!sessionIdentifier && !agentId) return res.status(400).json({ error: 'sessionIdentifier und agentId erforderlich' });
  try {
    const { hashSessionId } = require('../utils/privacy');
    const hash = sessionIdentifier ? hashSessionId(sessionIdentifier) : null;
    if (hash) await pool.query('DELETE FROM agent_memory WHERE agent_id=$1 AND session_identifier=$2', [agentId, hash]);
    await pool.query('INSERT INTO deletion_requests (agent_id, session_identifier_hash) VALUES ($1,$2) ON CONFLICT DO NOTHING', [agentId, hash||'unknown']).catch(()=>{});
    res.json({ success: true, message: 'Deine Daten werden innerhalb von 24 Stunden geloescht.' });
  } catch { res.status(500).json({ error: 'Fehler' }); }
});

/* ── DATA RETENTION SETTINGS ───────────────────────────── */
router.put('/agents/:id/retention', auth, async (req, res) => {
  const pool = getPool(req);
  const chat = Math.min(Math.max(parseInt(req.body.data_retention_days)||90,7),730);
  const lead = Math.min(Math.max(parseInt(req.body.lead_retention_days)||180,7),730);
  try {
    const r = await pool.query('SELECT id FROM agents WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
    if (!r.rows.length) return res.status(403).json({ error: 'Nicht berechtigt' });
    await pool.query('UPDATE agents SET data_retention_days=$1, lead_retention_days=$2 WHERE id=$3', [chat, lead, req.params.id]);
    res.json({ success: true, data_retention_days: chat, lead_retention_days: lead });
  } catch { res.status(500).json({ error: 'Fehler' }); }
});

/* ── WEBHOOK INSPECTOR ──────────────────────────────────── */
router.get('/webhook-logs/:agentId', auth, async (req, res) => {
  const pool = getPool(req);
  const r = await pool.query('SELECT id FROM agents WHERE id=$1 AND user_id=$2', [req.params.agentId, req.userId]);
  if (!r.rows.length) return res.status(403).json({ error: 'Nicht berechtigt' });
  const logs = await pool.query(
    'SELECT wd.id, wd.event_type, wd.url, wd.status_code, wd.success, wd.duration_ms, wd.delivered_at, LEFT(wd.response,200) AS response_preview, wo.name AS webhook_name FROM webhook_deliveries wd LEFT JOIN webhooks_out wo ON wd.webhook_id=wo.id WHERE wd.agent_id=$1 ORDER BY wd.delivered_at DESC LIMIT 100',
    [req.params.agentId]
  ).catch(() => ({ rows: [] }));
  res.json({ logs: logs.rows });
});

/* ── CONVERSATION INTELLIGENCE ───────────────────────────── */
router.post('/intelligence/:agentId', auth, async (req, res) => {
  const pool = getPool(req);
  const own = await pool.query('SELECT id FROM agents WHERE id=$1 AND user_id=$2', [req.params.agentId, req.userId]);
  if (!own.rows.length) return res.status(403).json({ error: 'Nicht berechtigt' });
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const msgs = await pool.query(
      'SELECT role, content FROM chat_messages WHERE agent_id=$1 AND created_at > $2 AND has_image=false ORDER BY created_at DESC LIMIT 200',
      [req.params.agentId, since]
    );
    if (msgs.rows.length < 5) return res.json({ error: 'Zu wenig Daten (min. 5 Nachrichten)' });

    const { callLLM } = require('../utils/llm');
    const conv = msgs.rows.map(m => m.role + ': ' + (m.content || '').slice(0, 200)).join('\n');
    const schema = '{"top_topics":[{"topic":"t","count":1}],"unanswered":["?"],"suggestions":["!"],"sentiment":"neutral","summary":"s"}';
    const result = await callLLM('claude-haiku-4-5', 'Nur JSON antworten.',
      [{ role: 'user', content: 'Konversationen:\n' + conv + '\nGib zurueck: ' + schema }], 600);

    let insights = {};
    try { insights = JSON.parse((result.reply || '').match(/\{[\s\S]*\}/)?.[0] || '{}'); } catch {}

    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    await pool.query(
      'INSERT INTO agent_insights (agent_id, week_start, msg_count, top_topics, unanswered, suggestions, sentiment) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (agent_id, week_start) DO UPDATE SET msg_count=$3, top_topics=$4, unanswered=$5, suggestions=$6, sentiment=$7',
      [req.params.agentId, weekStart.toISOString().split('T')[0], msgs.rows.length,
       JSON.stringify(insights.top_topics || []), JSON.stringify(insights.unanswered || []),
       JSON.stringify(insights.suggestions || []), insights.sentiment || 'neutral']
    ).catch(() => {});
    res.json({ insights: { ...insights, msg_count: msgs.rows.length } });
  } catch(e) { res.status(500).json({ error: 'Analyse fehlgeschlagen: ' + e.message }); }
});

/* ── LEAD SCORING ───────────────────────────────────────── */
router.post('/score-lead/:leadId', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const lead = await pool.query(
      'SELECT lc.*, a.user_id FROM lead_captures lc JOIN agents a ON lc.agent_id=a.id WHERE lc.id=$1 AND a.user_id=$2',
      [req.params.leadId, req.userId]
    );
    if (!lead.rows.length) return res.status(403).json({ error: 'Nicht berechtigt' });
    const l = lead.rows[0];
    const msgs = await pool.query(
      'SELECT role, content FROM chat_messages WHERE agent_id=$1 AND session_id=$2 ORDER BY created_at ASC LIMIT 30',
      [l.agent_id, l.session_id]
    );
    const { callLLM } = require('../utils/llm');
    const conv = msgs.rows.map(m => m.role + ': ' + (m.content || '').slice(0, 150)).join('\n');
    const r = await callLLM('claude-haiku-4-5', 'Bewerte Kaufabsicht 1-10. Nur JSON: {"score":7,"reason":"kurz"}',
      [{ role: 'user', content: 'Lead: ' + JSON.stringify(l.data) + '\n' + conv }], 150);
    let parsed = { score: 5, reason: '' };
    try { parsed = JSON.parse((r.reply || '').match(/\{[\s\S]*?\}/)?.[0] || '{}'); } catch {}
    const score = Math.min(10, Math.max(1, parseInt(parsed.score) || 5));
    await pool.query('UPDATE lead_captures SET score=$1, score_reason=$2 WHERE id=$3', [score, parsed.reason || '', req.params.leadId]);
    res.json({ score, reason: parsed.reason });
  } catch { res.status(500).json({ error: 'Scoring fehlgeschlagen' }); }
});

/* ── AGENT TEMPLATES MARKETPLACE ───────────────────────── */
router.get('/templates', async (req, res) => {
  const pool = getPool(req);
  const { category } = req.query;
  try {
    const args = category ? [category] : [];
    const where = category ? 'AND category=$1' : '';
    const r = await pool.query(
      'SELECT id,name,emoji,description,category,greeting,quick_chips,tone,tags,use_count,author FROM agent_templates WHERE is_public=true ' + where + ' ORDER BY use_count DESC LIMIT 50',
      args
    );
    res.json({ templates: r.rows });
  } catch { res.json({ templates: [] }); }
});

router.post('/templates/:id/use', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const t = await pool.query('SELECT * FROM agent_templates WHERE id=$1 AND is_public=true', [req.params.id]);
    if (!t.rows.length) return res.status(404).json({ error: 'Template nicht gefunden' });
    const tmpl = t.rows[0];
    const { v4: uuid } = require('uuid');
    const agent = await pool.query(
      'INSERT INTO agents (user_id, public_id, name, emoji, system_prompt, greeting, tone, quick_chips, is_active, widget_enabled) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,true) RETURNING id, public_id',
      [req.userId, uuid(), tmpl.name, tmpl.emoji, tmpl.system_prompt, tmpl.greeting, tmpl.tone||'professionell', JSON.stringify(tmpl.quick_chips||[])]
    );
    await pool.query('UPDATE agent_templates SET use_count=use_count+1 WHERE id=$1', [req.params.id]);
    res.json({ agent: agent.rows[0] });
  } catch(e) { res.status(500).json({ error: 'Fehler: ' + e.message }); }
});

module.exports = router;
module.exports.sendLeadDigests = sendLeadDigests;
