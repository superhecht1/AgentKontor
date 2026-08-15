/**
 * AgentKontor — Outgoing Webhooks (Pro feature)
 * Sends events to external URLs (Zapier, Make, n8n, custom)
 *
 * GET    /api/webhooks-out/:agentId          — list webhooks for agent
 * POST   /api/webhooks-out/:agentId          — create webhook
 * PUT    /api/webhooks-out/:agentId/:id      — update webhook
 * DELETE /api/webhooks-out/:agentId/:id      — delete webhook
 * POST   /api/webhooks-out/:agentId/:id/test — send test event
 * GET    /api/webhooks-out/:agentId/:id/log  — delivery log
 */

const router  = require('express').Router();
const auth    = require('../middleware/auth');
const crypto  = require('crypto');
const https   = require('https');
const http    = require('http');
const { requirePlan } = require('../middleware/plan-gate');

function getPool(req) { return req.app.locals.pool; }

const VALID_EVENTS = [
  'message.received',   // User sends message to agent
  'message.sent',       // Agent replies
  'lead.captured',      // Lead data collected
  'session.started',    // New conversation started
];

/* ── VERIFY AGENT OWNERSHIP ──────────────────────────────── */
async function verifyAgent(pool, agentId, userId) {
  const r = await pool.query(
    'SELECT id FROM agents WHERE id=$1 AND user_id=$2', [agentId, userId]
  );
  return r.rows.length > 0;
}

/* ── LIST ────────────────────────────────────────────────── */
router.get('/:agentId', auth, requirePlan('webhooksOut'), async (req, res) => {
  const pool = getPool(req);
  if (!(await verifyAgent(pool, req.params.agentId, req.userId)))
    return res.status(403).json({ error: 'Nicht berechtigt' });

  try {
    const r = await pool.query(
      'SELECT id,url,events,is_active,created_at FROM outgoing_webhooks WHERE agent_id=$1 ORDER BY created_at DESC',
      [req.params.agentId]
    );
    res.json({ webhooks: r.rows });
  } catch(e) { res.status(500).json({ error: 'Fehler' }); }
});

/* ── CREATE ──────────────────────────────────────────────── */
router.post('/:agentId', auth, requirePlan('webhooksOut'), async (req, res) => {
  const pool = getPool(req);
  if (!(await verifyAgent(pool, req.params.agentId, req.userId)))
    return res.status(403).json({ error: 'Nicht berechtigt' });

  const { url, events = ['message.received'], secret } = req.body;
  if (!url || !url.startsWith('http')) return res.status(400).json({ error: 'Gültige URL erforderlich (http/https)' });

  const validEvts = events.filter(e => VALID_EVENTS.includes(e));
  if (!validEvts.length) return res.status(400).json({ error: 'Mindestens ein gültiges Event erforderlich' });

  // Generate secret if not provided
  const sigSecret = secret || crypto.randomBytes(24).toString('hex');

  try {
    // Max 5 webhooks per agent
    const count = await pool.query('SELECT COUNT(*) FROM outgoing_webhooks WHERE agent_id=$1', [req.params.agentId]);
    if (parseInt(count.rows[0].count) >= 5)
      return res.status(400).json({ error: 'Max. 5 Webhooks pro Agent' });

    const r = await pool.query(
      'INSERT INTO outgoing_webhooks (user_id,agent_id,url,events,secret) VALUES ($1,$2,$3,$4,$5) RETURNING id,url,events,is_active,created_at',
      [req.userId, req.params.agentId, url, JSON.stringify(validEvts), sigSecret]
    );
    res.json({ webhook: r.rows[0], secret: sigSecret });
  } catch(e) { res.status(500).json({ error: 'Fehler beim Erstellen' }); }
});

/* ── UPDATE ──────────────────────────────────────────────── */
router.put('/:agentId/:id', auth, requirePlan('webhooksOut'), async (req, res) => {
  const pool = getPool(req);
  if (!(await verifyAgent(pool, req.params.agentId, req.userId)))
    return res.status(403).json({ error: 'Nicht berechtigt' });

  const { url, events, is_active } = req.body;
  try {
    await pool.query(
      'UPDATE outgoing_webhooks SET url=COALESCE($1,url), events=COALESCE($2,events), is_active=COALESCE($3,is_active) WHERE id=$4 AND agent_id=$5',
      [url||null, events ? JSON.stringify(events) : null, is_active, req.params.id, req.params.agentId]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Fehler' }); }
});

/* ── DELETE ──────────────────────────────────────────────── */
router.delete('/:agentId/:id', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    await pool.query(
      'DELETE FROM outgoing_webhooks WHERE id=$1 AND agent_id=$2 AND user_id=$3',
      [req.params.id, req.params.agentId, req.userId]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Fehler' }); }
});

/* ── TEST ────────────────────────────────────────────────── */
router.post('/:agentId/:id/test', auth, requirePlan('webhooksOut'), async (req, res) => {
  const pool = getPool(req);
  const whk = await pool.query(
    'SELECT * FROM outgoing_webhooks WHERE id=$1 AND agent_id=$2 AND user_id=$3',
    [req.params.id, req.params.agentId, req.userId]
  );
  if (!whk.rows.length) return res.status(404).json({ error: 'Webhook nicht gefunden' });

  const testPayload = {
    event:      'test',
    agent_id:   req.params.agentId,
    session_id: 'test_session',
    timestamp:  new Date().toISOString(),
    data:       { message: 'AgentKontor Webhook Test erfolgreich! 🎉' },
  };

  try {
    const result = await deliver(whk.rows[0], 'test', testPayload);
    res.json({ success: result.ok, statusCode: result.statusCode, error: result.error });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── DELIVERY LOG ────────────────────────────────────────── */
router.get('/:agentId/:id/log', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query(
      'SELECT id,event_type,status,response_code,error_msg,delivered_at FROM webhook_deliveries WHERE webhook_id=$1 ORDER BY delivered_at DESC LIMIT 50',
      [req.params.id]
    );
    res.json({ deliveries: r.rows });
  } catch(e) { res.status(500).json({ error: 'Fehler' }); }
});

/* ── DELIVERY FUNCTION (used by chat.js) ─────────────────── */
async function deliver(webhook, eventType, payload) {
  const body = JSON.stringify({ ...payload, event: eventType });
  const sig  = webhook.secret
    ? 'sha256=' + crypto.createHmac('sha256', webhook.secret).update(body).digest('hex')
    : undefined;

  const url = new URL(webhook.url);
  const lib = url.protocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    const req = lib.request({
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-AgentKontor-Event':     eventType,
        'X-AgentKontor-Signature': sig || '',
        'User-Agent':              'AgentKontor-Webhook/1.0',
      },
      timeout: 10000,
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve({ ok: res.statusCode < 400, statusCode: res.statusCode }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, statusCode: null, error: 'Timeout' }); });
    req.on('error', (e) => resolve({ ok: false, statusCode: null, error: e.message }));
    req.write(body);
    req.end();
  });
}

/** Dispatch webhooks for an agent — call from chat.js after each message */
async function dispatchWebhooks(pool, agentId, eventType, payload) {
  try {
    const whks = await pool.query(
      `SELECT * FROM outgoing_webhooks WHERE agent_id=$1 AND is_active=true AND events @> $2::jsonb`,
      [agentId, JSON.stringify([eventType])]
    );
    if (!whks.rows.length) return;

    for (const whk of whks.rows) {
      setImmediate(async () => {
        const result = await deliver(whk, eventType, payload).catch(e => ({ ok: false, error: e.message }));
        await pool.query(
          `INSERT INTO webhook_deliveries (webhook_id,event_type,payload,status,response_code,error_msg)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [whk.id, eventType, JSON.stringify(payload),
           result.ok ? 'success' : 'error',
           result.statusCode || null,
           result.error || null]
        );
      });
    }
  } catch(e) {
    console.warn('dispatchWebhooks error:', e.message);
  }
}

module.exports = router;
module.exports.dispatchWebhooks = dispatchWebhooks;
