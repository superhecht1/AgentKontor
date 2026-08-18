'use strict';
const express = require('express');
const router  = express.Router();

// Sicheres Error-Logging: Stack intern, generische Meldung zum Client
function safeErr(res, e, status = 500, context = '') {
  const isProd = process.env.NODE_ENV === 'production';
  if (context) console.error(`[${context}]`, e.message);
  else console.error(e.message);
  const msg = isProd
    ? (status < 500 ? e.message : 'Interner Serverfehler')  // 4xx ok, 5xx generisch
    : e.message;
  return res.status(status).json({ error: msg });
}

const auth = require('../middleware/auth');
const { getPool } = require('../utils/db');
const { callLLM } = require('../utils/llm');
const { encrypt, decrypt } = require('../utils/crypto-utils');

// ── GET /api/integrations  — alle Credentials des Users ──────────────────────
router.get('/', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query(
      `SELECT id, integration, provider, label, is_active, last_used, last_error, created_at,
         -- Credentials OHNE secrets zurückgeben
         jsonb_strip_nulls(jsonb_build_object(
           'email', credentials->>'email',
           'calendar_id', credentials->>'calendar_id',
           'imap_host', credentials->>'imap_host',
           'imap_user', credentials->>'imap_user',
           'url', credentials->>'url'
         )) as safe_credentials
       FROM integration_credentials
       WHERE user_id=$1 ORDER BY integration, created_at`,
      [req.userId]
    );
    res.json({ integrations: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// ── POST /api/integrations  — Credential speichern ───────────────────────────
router.post('/', auth, async (req, res) => {
  const pool = getPool(req);
  const { integration, provider, label = 'Standard', credentials } = req.body;
  if (!integration || !provider || !credentials) return res.status(400).json({ error: 'Pflichtfelder fehlen' });

  try {
    const r = await pool.query(
      `INSERT INTO integration_credentials (user_id,integration,provider,label,credentials)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id,integration,provider,label)
       DO UPDATE SET credentials=$5, is_active=true, updated_at=now()
       RETURNING id, integration, provider, label, is_active`,
      [req.userId, integration, provider, label, encrypt(credentials)]
    );
    res.status(201).json({ integration: r.rows[0] });
  } catch (e) {
    console.error('SAVE INTEGRATION:', e.message);
    res.status(500).json({ error: 'Fehler beim Speichern' });
  }
});

// ── DELETE /api/integrations/:id ─────────────────────────────────────────────
router.delete('/:id', auth, async (req, res) => {
  const pool = getPool(req);
  await pool.query('DELETE FROM integration_credentials WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
  res.json({ success: true });
});

// ── POST /api/integrations/:id/test  — Verbindung testen ─────────────────────
router.post('/:id/test', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query(
      'SELECT * FROM integration_credentials WHERE id=$1 AND user_id=$2',
      [req.params.id, req.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });
    const cred = r.rows[0];

    let result = {};
    if (cred.integration === 'calendar') {
      const cal = require('../utils/integrations/calendar');
      const events = await cal.getEvents(cred, pool, {
        from: new Date().toISOString(),
        to:   new Date(Date.now() + 7*86400000).toISOString(),
        maxResults: 3,
      });
      result = { ok: true, events: events.length, sample: events[0]?.title };
    } else if (cred.integration === 'email') {
      const email = require('../utils/integrations/email-tool');
      const emails = await email.getEmails(cred, pool, { maxResults: 3 });
      result = { ok: true, count: emails.length, sample: emails[0]?.subject };
    } else {
      result = { ok: true, message: 'Verbindung gespeichert' };
    }
    await pool.query('UPDATE integration_credentials SET last_used=now(), last_error=NULL WHERE id=$1', [req.params.id]);
    res.json(result);
  } catch (e) {
    await pool.query('UPDATE integration_credentials SET last_error=$1 WHERE id=$2', [e.message, req.params.id]);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── GET /api/integrations/calendar/events ─────────────────────────────────────
router.get('/calendar/events', auth, async (req, res) => {
  const pool = getPool(req);
  const { from, to, credId } = req.query;
  try {
    const cred = await getCred(pool, req.userId, 'calendar', credId);
    const cal = require('../utils/integrations/calendar');
    const events = await cal.getEvents(cred, pool, { from, to, maxResults: 50 });
    res.json({ events });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── GET /api/integrations/calendar/slots ──────────────────────────────────────
router.get('/calendar/slots', auth, async (req, res) => {
  const pool = getPool(req);
  const { from, to, duration = 60, credId } = req.query;
  try {
    const cred = await getCred(pool, req.userId, 'calendar', credId);
    const cal = require('../utils/integrations/calendar');
    const slots = await cal.findFreeSlots(cred, pool, { from, to, durationMinutes: parseInt(duration) });
    res.json({ slots });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── POST /api/integrations/calendar/events  — Termin erstellen ────────────────
router.post('/calendar/events', auth, async (req, res) => {
  const pool = getPool(req);
  const { credId, ...eventData } = req.body;
  try {
    const cred = await getCred(pool, req.userId, 'calendar', credId);
    const cal = require('../utils/integrations/calendar');
    const event = await cal.createEvent(cred, pool, eventData);
    res.json({ event });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── GET /api/integrations/email/messages ──────────────────────────────────────
router.get('/email/messages', auth, async (req, res) => {
  const pool = getPool(req);
  const { query, maxResults = 20, includeBody, credId } = req.query;
  try {
    const cred = await getCred(pool, req.userId, 'email', credId);
    const emailTool = require('../utils/integrations/email-tool');
    const emails = await emailTool.getEmails(cred, pool, {
      query, maxResults: parseInt(maxResults), includeBody: includeBody === 'true'
    });
    res.json({ emails });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── POST /api/integrations/email/prioritize ───────────────────────────────────
router.post('/email/prioritize', auth, async (req, res) => {
  const pool = getPool(req);
  const { credId, maxResults = 20 } = req.body;
  try {
    const cred = await getCred(pool, req.userId, 'email', credId);
    const emailTool = require('../utils/integrations/email-tool');
    const emails = await emailTool.getEmails(cred, pool, { maxResults, includeBody: false });
    const prioritized = await emailTool.prioritizeEmails(emails, callLLM);
    res.json({ emails: prioritized });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── POST /api/integrations/email/send ─────────────────────────────────────────
router.post('/email/send', auth, async (req, res) => {
  const pool = getPool(req);
  const { credId, ...mailData } = req.body;
  try {
    const cred = await getCred(pool, req.userId, 'email', credId);
    const emailTool = require('../utils/integrations/email-tool');
    const result = await emailTool.sendEmail(cred, pool, mailData);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── POST /api/integrations/email/generate-reply ───────────────────────────────
router.post('/email/generate-reply', auth, async (req, res) => {
  const pool = getPool(req);
  const { email, instructions, credId } = req.body;
  try {
    const emailTool = require('../utils/integrations/email-tool');
    const reply = await emailTool.generateReply(email, instructions, callLLM);
    res.json({ reply });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── POST /api/integrations/crm/qualify  — Leads qualifizieren ────────────────
router.post('/crm/qualify', auth, async (req, res) => {
  const pool = getPool(req);
  const { agentId, crmWebhook, crmApiKey } = req.body;
  try {
    const crm = require('../utils/integrations/crm-tool');
    const results = await crm.batchQualify(pool, req.userId, { agentId, callLLM, crmWebhook, crmApiKey });
    res.json({ results, qualified: results.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── POST /api/integrations/crm/outreach  — Outreach-Text generieren ──────────
router.post('/crm/outreach', auth, async (req, res) => {
  const pool = getPool(req);
  const { leadId, agentId, tone, language } = req.body;
  try {
    const crm = require('../utils/integrations/crm-tool');
    const leads = await crm.getLeads(pool, req.userId, { agentId, limit: 1 });
    const lead = leads.find(l => l.id === parseInt(leadId)) || leads[0];
    if (!lead) return res.status(404).json({ error: 'Lead nicht gefunden' });
    const text = await crm.generateOutreach(lead, callLLM, { tone, language });
    res.json({ text, lead });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── POST /api/integrations/document/analyze ───────────────────────────────────
router.post('/document/analyze', auth, async (req, res) => {
  const pool = getPool(req);
  const { docId, agentId, analysisType = 'summary' } = req.body;
  try {
    const docTool = require('../utils/integrations/document-tool');
    const doc = await docTool.getDocumentFromDB(pool, { docId, agentId });
    const result = await docTool.analyzeDocument(doc.text, { analysisType }, callLLM);
    res.json({ result, filename: doc.filename, analysisType });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── POST /api/integrations/document/compare ───────────────────────────────────
router.post('/document/compare', auth, async (req, res) => {
  const pool = getPool(req);
  const { docIds, agentId, aspects } = req.body;
  if (!docIds?.length || docIds.length < 2) return res.status(400).json({ error: 'Mindestens 2 Dokumente erforderlich' });
  try {
    const docTool = require('../utils/integrations/document-tool');
    const docs = await Promise.all(docIds.map(id => docTool.getDocumentFromDB(pool, { docId: id, agentId })));
    const result = await docTool.compareDocuments(docs, { comparisonAspects: aspects || [] }, callLLM);
    res.json({ result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Hilfsfunktion: Credential laden ─────────────────────────────────────────
async function getCred(pool, userId, integration, credId) {
  const conditions = ['user_id=$1', 'integration=$2', 'is_active=true'];
  const params = [userId, integration];
  if (credId) { conditions.push('id=$3'); params.push(credId); }
  const r = await pool.query(
    `SELECT * FROM integration_credentials WHERE ${conditions.join(' AND ')} LIMIT 1`,
    params
  );
  if (!r.rows.length) throw new Error(`Keine ${integration}-Integration gefunden. Bitte zuerst verbinden.`);
  const row = r.rows[0];
  // Credentials entschlüsseln
  try { row.credentials = decrypt(row.credentials); } catch {}
  return row;
}

module.exports = router;
