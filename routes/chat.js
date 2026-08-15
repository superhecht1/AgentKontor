/**
 * AgentKontor — Chat API
 *
 * POST /api/chat/web/:agentId       — Web / Widget chat
 * POST /api/chat/api/:agentId       — REST API chat (API key auth)
 * POST /api/chat/widget-config/:pid — Widget config (public)
 * GET  /api/chat/widget-config/:pid — Widget config (public)
 */

const router   = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const { checkMsgQuota, getLimits } = require('../middleware/plan-gate');
const { v4: uuid } = require('uuid');

function getPool(req) { return req.app.locals.pool; }

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/* ── WIDGET CONFIG (public) ────────────────────────────── */
router.get('/widget-config/:publicId', async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query(
      `SELECT name, emoji, color, greeting, quick_chips, widget_enabled,
              widget_position, widget_delay, widget_theme, widget_size, is_active
       FROM agents WHERE public_id=$1`,
      [req.params.publicId]
    );
    if (!r.rows.length || !r.rows[0].is_active || !r.rows[0].widget_enabled)
      return res.status(404).json({ error: 'Widget nicht verfügbar' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

/* ── SHARED CHAT HANDLER ───────────────────────────────── */
async function handleChat(pool, agent, owner, messages, sessionId, source, res) {
  sessionId = sessionId || uuid();

  // Build system prompt
  let sysPrompt = agent.system_prompt || 'Du bist ein hilfreicher KI-Assistent.';

  // Capabilities context
  if (agent.cap_calendar && agent.cal_link)
    sysPrompt += `\n\nTerminbuchung: ${agent.cal_link}`;
  if (agent.cap_leads && agent.lead_fields?.length)
    sysPrompt += `\n\nSammle diese Informationen vom Nutzer: ${agent.lead_fields.join(', ')}. Sobald du alle hast, bestätige dass du sie notiert hast.`;
  if (agent.cap_products && agent.products_data?.length)
    sysPrompt += `\n\nProdukte:\n${agent.products_data.map(p => `- ${p.name}: ${p.description} (${p.price})`).join('\n')}`;
  if (agent.cap_multilang)
    sysPrompt += `\n\nAntworte immer in der Sprache des Nutzers.`;

  // RAG context
  if (agent.rag_enabled) {
    try {
      const lastMsg = messages[messages.length - 1]?.content || '';
      const emb = await client.embeddings?.create({
        model: 'voyage-3', input: lastMsg,
      }).catch(() => null);

      if (emb?.data?.[0]?.embedding) {
        const vec    = JSON.stringify(emb.data[0].embedding);
        const chunks = await pool.query(
          `SELECT content FROM document_chunks
           WHERE agent_id=$1
           ORDER BY embedding <=> $2::vector LIMIT 4`,
          [agent.id, vec]
        );
        if (chunks.rows.length) {
          sysPrompt += `\n\nRelevante Wissensbasis:\n${chunks.rows.map(c => c.content).join('\n\n')}`;
          if (agent.rag_prompt) sysPrompt += `\n\n${agent.rag_prompt}`;
        }
      }
    } catch { /* RAG optional */ }
  }

  // Save user message
  const userMsg = messages[messages.length - 1];
  await pool.query(
    'INSERT INTO chat_messages (agent_id, session_id, role, content, source) VALUES ($1,$2,$3,$4,$5)',
    [agent.id, sessionId, 'user', userMsg.content, source]
  );

  // Call Anthropic
  const model = agent.model || 'claude-sonnet-4-6';
  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    system: sysPrompt,
    messages: messages.slice(-12), // last 12 for context window
  });

  const reply = response.content[0]?.text || 'Keine Antwort erhalten.';

  // Save assistant message
  await pool.query(
    'INSERT INTO chat_messages (agent_id, session_id, role, content, source) VALUES ($1,$2,$3,$4,$5)',
    [agent.id, sessionId, 'assistant', reply, source]
  );

  // Increment message count
  await pool.query('UPDATE agents SET total_messages=total_messages+1 WHERE id=$1', [agent.id]);

  // Lead capture detection
  const leadCaptured = await tryCaptureLead(pool, agent, owner, messages, reply, sessionId, source);

  // Dispatch outgoing webhooks (non-blocking)
  setImmediate(() => dispatchWebhooks(pool, agent.id, 'message.received', {
    agentId:   agent.id,
    agentName: agent.name,
    sessionId,
    source,
    message:   userMsg.content,
    reply,
    timestamp: new Date().toISOString(),
  }));

  if (leadCaptured) {
    setImmediate(() => dispatchWebhooks(pool, agent.id, 'lead.captured', {
      agentId: agent.id, sessionId, source, lead: leadCaptured,
    }));
    setImmediate(() => sendLeadEmail(agent, owner, leadCaptured));
  }

  return { reply, sessionId };
}

/* ── LEAD CAPTURE ──────────────────────────────────────── */
async function tryCaptureLead(pool, agent, owner, messages, reply, sessionId, source) {
  if (!agent.cap_leads || !agent.lead_fields?.length) return null;

  // Check if reply confirms lead collection
  const confirmKeywords = ['notiert', 'habe ich', 'gespeichert', 'danke', 'recorded', 'noted', 'got it'];
  const hasConfirm = confirmKeywords.some(k => reply.toLowerCase().includes(k));
  if (!hasConfirm) return null;

  // Already captured this session?
  const existing = await pool.query(
    'SELECT id FROM lead_captures WHERE agent_id=$1 AND session_id=$2',
    [agent.id, sessionId]
  );
  if (existing.rows.length) return null;

  // Extract data from conversation
  const fullConv = messages.map(m => m.content).join('\n');
  const data = {};
  const emailRx = /[\w.-]+@[\w.-]+\.\w+/;
  const phoneRx = /(\+?[\d\s\-()]{8,})/;

  const emailMatch = fullConv.match(emailRx);
  if (emailMatch) data['E-Mail'] = emailMatch[0];

  const phoneMatch = fullConv.match(phoneRx);
  if (phoneMatch) data['Telefon'] = phoneMatch[1].trim();

  // Name heuristic — first capitalized word pair
  const nameRx = /(?:heiße|bin|name ist|ich bin|my name is|i am|i'm)\s+([A-ZÄÖÜ][a-zäöüß]+(?: [A-ZÄÖÜ][a-zäöüß]+)?)/i;
  const nameMatch = fullConv.match(nameRx);
  if (nameMatch) data['Name'] = nameMatch[1];

  if (Object.keys(data).length === 0) return null;

  await pool.query(
    'INSERT INTO lead_captures (agent_id, session_id, source, data) VALUES ($1,$2,$3,$4)',
    [agent.id, sessionId, source, JSON.stringify(data)]
  );

  return data;
}

/* ── LEAD EMAIL NOTIFICATION ───────────────────────────── */
async function sendLeadEmail(agent, owner, leadData) {
  // Send to agent-specific email or owner email
  const to = agent.lead_email || owner?.email;
  if (!to || !process.env.SMTP_HOST) return;

  try {
    const nodemailer  = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT || '587'), secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    const rows = Object.entries(leadData)
      .map(([k, v]) => `<tr><td style="padding:6px 12px;color:#7a786e;font-size:.82rem">${k}</td><td style="padding:6px 12px;color:#1a1916;font-weight:600;font-size:.82rem">${v}</td></tr>`)
      .join('');

    await transporter.sendMail({
      from:    `AgentKontor <${process.env.SMTP_FROM || 'noreply@agentkontor.de'}>`,
      to,
      subject: `🎯 Neuer Lead: ${agent.name}`,
      html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f3ef;font-family:sans-serif">
<div style="max-width:520px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden">
  <div style="background:#1a1916;padding:24px 32px;display:flex;align-items:center;gap:12px">
    <div style="font-size:1.8rem">${agent.emoji || '🤖'}</div>
    <div>
      <div style="font-size:1rem;font-weight:700;color:#fff">${agent.name}</div>
      <div style="font-size:.74rem;color:#a29bfe">Neuer Lead eingegangen</div>
    </div>
  </div>
  <div style="padding:28px 32px">
    <table style="width:100%;border-collapse:collapse;border:1px solid #eee;border-radius:8px;overflow:hidden">
      <thead><tr style="background:#f4f3ef"><th style="padding:8px 12px;text-align:left;font-size:.72rem;color:#888;letter-spacing:.08em;text-transform:uppercase">Feld</th><th style="padding:8px 12px;text-align:left;font-size:.72rem;color:#888;letter-spacing:.08em;text-transform:uppercase">Wert</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="margin-top:20px">
      <a href="${process.env.APP_URL || 'https://agentkontor.de'}/app" style="display:inline-block;background:#6c5ce7;color:#fff;padding:10px 22px;border-radius:8px;text-decoration:none;font-weight:600;font-size:.84rem">Im Dashboard ansehen →</a>
    </div>
  </div>
  <div style="background:#f4f3ef;padding:14px 32px;text-align:center;font-size:.7rem;color:#a8a49a">
    AgentKontor · superhecht.ai · <a href="${process.env.APP_URL || 'https://agentkontor.de'}/app" style="color:#a8a49a">Dashboard</a>
  </div>
</div></body></html>`,
    });
  } catch (e) { console.warn('Lead email failed:', e.message); }
}

/* ── OUTGOING WEBHOOKS ─────────────────────────────────── */
async function dispatchWebhooks(pool, agentId, eventType, payload) {
  try {
    const { dispatchWebhooks: dispatch } = require('./webhooks-out');
    if (dispatch) await dispatch(pool, agentId, eventType, payload);
  } catch { /* webhooks optional */ }
}

/* ── WEB / WIDGET CHAT ─────────────────────────────────── */
router.post('/web/:agentId', async (req, res) => {
  const pool = getPool(req);
  try {
    const { messages, sessionId, source = 'web' } = req.body;
    if (!messages?.length) return res.status(400).json({ error: 'messages erforderlich' });

    // FIX 2: Limit message size to prevent abuse + cost explosion
    const MAX_MSG_LEN  = 4000;  // chars per message
    const MAX_HISTORY  = 12;    // max messages in history
    const sanitized = messages
      .slice(-MAX_HISTORY)
      .map(m => ({ role: m.role, content: String(m.content || '').slice(0, MAX_MSG_LEN) }));
    if (!sanitized.length) return res.status(400).json({ error: 'Ungültige Nachrichten' });
    const validMessages = sanitized; // use this instead of messages below

    const ar = await pool.query(
      `SELECT a.*, u.email AS owner_email, u.plan AS owner_plan
       FROM agents a JOIN users u ON a.user_id=u.id
       WHERE a.id=$1 AND a.is_active=true`,
      [req.params.agentId]
    );
    if (!ar.rows.length) return res.status(404).json({ error: 'Agent nicht gefunden' });
    const agent = ar.rows[0];
    const owner = { email: agent.owner_email };

    // Check quota
    const quota = await checkMsgQuota(pool, agent.user_id);
    if (!quota.allowed)
      return res.status(429).json({ error: 'Nachrichtenlimit erreicht.', upgrade: true });

    const result = await handleChat(pool, agent, owner, validMessages, sessionId, source, res);
    res.json(result);
  } catch (e) {
    console.error('WEB CHAT ERROR:', e.message);
    res.status(500).json({ error: 'Chat-Fehler' });
  }
});

/* ── API KEY CHAT ──────────────────────────────────────── */
router.post('/api/:agentId', async (req, res) => {
  const pool = getPool(req);
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'x-api-key Header erforderlich' });

    // Verify API key
    const prefix = apiKey.slice(0, 16);
    const kr = await pool.query(
      `SELECT k.*, a.*, u.email AS owner_email, u.plan AS owner_plan
       FROM api_keys k
       JOIN agents a ON (k.agent_id=a.id OR k.agent_id IS NULL)
       JOIN users u ON k.user_id=u.id
       WHERE k.key_prefix=$1 AND a.id=$2 AND a.is_active=true AND k.is_active=true`,
      [prefix, req.params.agentId]
    );
    if (!kr.rows.length) return res.status(401).json({ error: 'Ungültiger API-Key' });

    const row   = kr.rows[0];
    const agent = row;
    const owner = { email: row.owner_email };

    // Plan check
    const limits = getLimits(row.owner_plan);
    if (!limits.api) return res.status(403).json({ error: 'API-Zugang erfordert Pro-Plan', upgrade: true });

    // Quota
    const quota = await checkMsgQuota(pool, agent.user_id);
    if (!quota.allowed) return res.status(429).json({ error: 'Nachrichtenlimit erreicht.' });

    // Update last_used
    await pool.query('UPDATE api_keys SET last_used=NOW() WHERE id=$1', [row.id]);

    const { messages, sessionId } = req.body;
    if (!messages?.length) return res.status(400).json({ error: 'messages erforderlich' });

    const result = await handleChat(pool, agent, owner, messages, sessionId, 'api', res);
    res.json(result);
  } catch (e) {
    console.error('API CHAT ERROR:', e.message);
    res.status(500).json({ error: 'Chat-Fehler' });
  }
});

module.exports = router;
