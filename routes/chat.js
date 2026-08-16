/**
 * AgentKontor — Chat API v3
 *
 * Features:
 * ✅ Streaming SSE (POST /api/chat/stream/:agentId)
 * ✅ Multimodal (Bilder in Nachrichten)
 * ✅ Persistente Memory (Facts über Sessions hinweg)
 * ✅ LLM Cost Tracking
 * ✅ Widget Rate-Limiting
 * ✅ Human Handoff Detection
 * ✅ Outgoing Webhooks
 * ✅ Lead Capture
 */

const router    = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const crypto    = require('crypto');
const { checkMsgQuota, getLimits, rateLimit } = require('../middleware/plan-gate');
const { hashSessionId, minimizeMessages, hashIp } = require('../utils/privacy');
const { runAgenticChat } = require('./actions');
const { v4: uuid } = require('uuid');

function getPool(req) { return req.app.locals.pool; }

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── COST TABLE PER MODEL ──────────────────────────────────
const MODEL_COSTS = {
  'claude-sonnet-4-6':      { in: 3.00,   out: 15.00  },
  'claude-opus-4-6':        { in: 15.00,  out: 75.00  },
  'claude-haiku-4-5':       { in: 0.80,   out: 4.00   },
  'gpt-4o':                 { in: 2.50,   out: 10.00  },
  'gpt-4o-mini':            { in: 0.15,   out: 0.60   },
};

function calcCost(model, inputTokens, outputTokens) {
  const base = model.startsWith('ft:') ? MODEL_COSTS['gpt-4o-mini'] : (MODEL_COSTS[model] || MODEL_COSTS['claude-sonnet-4-6']);
  return ((inputTokens * base.in) + (outputTokens * base.out)) / 1_000_000;
}

// ── WIDGET CONFIG (public) ────────────────────────────────
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
  } catch(e) { res.status(500).json({ error: 'Fehler' }); }
});

// ── BUILD SYSTEM PROMPT ───────────────────────────────────
async function buildSystemPrompt(pool, agent, memory) {
  let sys = agent.system_prompt || 'Du bist ein hilfreicher KI-Assistent.';

  if (agent.cap_calendar && agent.cal_link)
    sys += `\n\nTerminbuchung: ${agent.cal_link}`;
  if (agent.cap_leads && agent.lead_fields?.length)
    sys += `\n\nSammle diese Infos: ${agent.lead_fields.join(', ')}. Bestätige wenn du alle hast.`;
  if (agent.cap_products && agent.products_data?.length)
    sys += `\n\nProdukte:\n${agent.products_data.map(p => `- ${p.name}: ${p.description} (${p.price})`).join('\n')}`;
  if (agent.cap_multilang)
    sys += '\n\nAntworte immer in der Sprache des Nutzers.';

  // Persistent memory injection
  if (memory?.facts?.length) {
    sys += `\n\nBekannte Informationen über diesen Nutzer:\n${memory.facts.map(f => `- ${f}`).join('\n')}`;
  }
  if (memory?.summary) {
    sys += `\n\nZusammenfassung früherer Gespräche: ${memory.summary}`;
  }

  return sys;
}

// ── RAG CONTEXT ───────────────────────────────────────────
async function fetchRagContext(pool, agentId, query) {
  try {
    const emb = await client.embeddings?.create({ model: 'voyage-3', input: query }).catch(() => null);
    if (!emb?.data?.[0]?.embedding) return '';
    const vec    = JSON.stringify(emb.data[0].embedding);
    const chunks = await pool.query(
      `SELECT content FROM document_chunks WHERE agent_id=$1 ORDER BY embedding <=> $2::vector LIMIT 4`,
      [agentId, vec]
    );
    return chunks.rows.length ? '\n\nWissensbasis:\n' + chunks.rows.map(c => c.content).join('\n\n') : '';
  } catch { return ''; }
}

// ── LOAD PERSISTENT MEMORY ───────────────────────────────
async function loadMemory(pool, agentId, sessionIdentifierHash) {
  if (!sessionIdentifierHash) return null;
  try {
    const { decryptFacts } = require('../utils/privacy');
    const r = await pool.query(
      'SELECT facts, summary, message_count, encrypted, iv FROM agent_memory WHERE agent_id=$1 AND session_identifier=$2',
      [agentId, sessionIdentifierHash]
    );
    if (!r.rows[0]) return null;
    const row = r.rows[0];
    // Decrypt if encrypted
    if (row.encrypted && row.iv) {
      const [ivHex, tagHex, ctHex] = (row.iv || '').split(':');
      row.facts = decryptFacts(ctHex, ivHex, tagHex);
    } else if (typeof row.facts === 'string') {
      try { row.facts = JSON.parse(row.facts); } catch { row.facts = []; }
    }
    return row;
  } catch { return null; }
}

// ── UPDATE PERSISTENT MEMORY (async) ─────────────────────
async function updateMemory(pool, agentId, sessionIdentifierHash, messages, reply) {
  if (!sessionIdentifier) return;
  try {
    // Quick LLM call to extract facts
    const extraction = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: 'Extrahiere max. 5 kurze Fakten über den Nutzer aus diesem Gespräch. Nur konkrete Infos (Name, Beruf, Interessen, Ort, etc.). Format: JSON-Array von Strings. Nur Array, keine anderen Zeichen.',
      messages: [{ role: 'user', content: messages.slice(-6).map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : '[Bild]'}`).join('\n') + `\nassistant: ${reply}` }],
    });
    const text = extraction.content[0]?.text?.trim() || '[]';
    let newFacts = [];
    try { newFacts = JSON.parse(text.match(/\[.*\]/s)?.[0] || '[]'); } catch {}

    // Merge with existing
    const existing = await pool.query(
      'SELECT facts, message_count, encrypted, iv FROM agent_memory WHERE agent_id=$1 AND session_identifier=$2',
      [agentId, sessionIdentifierHash]
    );
    const existingFacts = existing.rows[0]?.facts || [];
    const allFacts = [...new Set([...existingFacts, ...newFacts])].slice(0, 15);
    const msgCount = (existing.rows[0]?.message_count || 0) + messages.length;

    await pool.query(`
      INSERT INTO agent_memory (agent_id, session_identifier, facts, message_count, updated_at)
      VALUES ($1,$2,$3,$4,NOW())
      ON CONFLICT (agent_id, session_identifier)
      DO UPDATE SET facts=$3, message_count=$4, updated_at=NOW()
    `, [agentId, sessionIdentifier, JSON.stringify(allFacts), msgCount]);
  } catch(e) { console.warn('Memory update error:', e.message); }
}

// ── TRACK LLM COST ────────────────────────────────────────
async function trackCost(pool, agentId, sessionId, model, usage, source) {
  try {
    const cost = calcCost(model, usage.input_tokens || 0, usage.output_tokens || 0);
    await pool.query(
      `INSERT INTO llm_usage (agent_id, session_id, model, source, input_tokens, output_tokens, cost_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [agentId, sessionId, model, source, usage.input_tokens||0, usage.output_tokens||0, cost]
    );
    // Update daily summary
    await pool.query(`
      INSERT INTO agent_cost_daily (agent_id, date, total_cost, total_tokens)
      VALUES ($1, CURRENT_DATE, $2, $3)
      ON CONFLICT (agent_id, date)
      DO UPDATE SET total_cost=agent_cost_daily.total_cost+$2, total_tokens=agent_cost_daily.total_tokens+$3
    `, [agentId, cost, (usage.input_tokens||0)+(usage.output_tokens||0)]);
  } catch(e) { console.warn('Cost tracking error:', e.message); }
}

// ── LEAD CAPTURE ──────────────────────────────────────────
async function tryCaptureLead(pool, agent, messages, reply, sessionId, source) {
  if (!agent.cap_leads || !agent.lead_fields?.length) return null;
  const keywords = ['notiert','habe ich','gespeichert','danke','recorded','noted','got it','erfasst'];
  if (!keywords.some(k => reply.toLowerCase().includes(k))) return null;
  const existing = await pool.query('SELECT id FROM lead_captures WHERE agent_id=$1 AND session_id=$2', [agent.id, sessionId]);
  if (existing.rows.length) return null;
  const fullConv = messages.map(m => typeof m.content === 'string' ? m.content : '[Bild]').join('\n');
  const data = {};
  const emailM = fullConv.match(/[\w.-]+@[\w.-]+\.\w+/); if (emailM) data['E-Mail'] = emailM[0];
  const phoneM = fullConv.match(/(\+?[\d\s\-()]{8,})/);  if (phoneM) data['Telefon'] = phoneM[1].trim();
  const nameM  = fullConv.match(/(?:heiße|bin|name ist|my name is)\s+([A-ZÄÖÜ][a-zäöüß]+(?: [A-ZÄÖÜ][a-zäöüß]+)?)/i);
  if (nameM) data['Name'] = nameM[1];
  if (!Object.keys(data).length) return null;
  await pool.query('INSERT INTO lead_captures (agent_id, session_id, source, data) VALUES ($1,$2,$3,$4)', [agent.id, sessionId, source, JSON.stringify(data)]);
  return data;
}

// ── SEND LEAD EMAIL ───────────────────────────────────────
async function sendLeadEmail(agent, ownerEmail, lead) {
  const to = agent.lead_email || ownerEmail;
  if (!to || !process.env.SMTP_HOST) return;
  try {
    const nodemailer = require('nodemailer');
    const t = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT||'587'), secure:false, auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS} });
    const rows = Object.entries(lead).map(([k,v]) => `<tr><td style="padding:6px 12px;color:#888">${k}</td><td style="padding:6px 12px;font-weight:600">${v}</td></tr>`).join('');
    await t.sendMail({ from:`AgentKontor <${process.env.SMTP_FROM||'noreply@agentkontor.de'}>`, to, subject:`🎯 Neuer Lead: ${agent.emoji} ${agent.name}`, html:`<div style="font-family:sans-serif;max-width:500px;margin:32px auto;padding:28px;background:#fff;border-radius:12px;border:1px solid #eee"><h2>${agent.emoji} ${agent.name} — Neuer Lead</h2><table style="width:100%;margin-top:14px;border:1px solid #eee;border-radius:8px;overflow:hidden">${rows}</table><a href="${process.env.APP_URL||'https://agentkontor.de'}/app" style="display:inline-block;margin-top:18px;background:#6c5ce7;color:#fff;padding:10px 22px;border-radius:8px;text-decoration:none">Im Dashboard →</a></div>` });
  } catch(e) { console.warn('Lead email error:', e.message); }
}

// ── DISPATCH WEBHOOKS ─────────────────────────────────────
async function dispatchWebhooks(pool, agentId, eventType, payload) {
  try { const {dispatchWebhooks:d}=require('./webhooks-out'); if(d) await d(pool,agentId,eventType,payload); } catch {}
}

// ── SANITIZE MESSAGES (size + format) ────────────────────
function sanitizeMessages(messages, maxLen = 4000, maxCount = 12) {
  return messages.slice(-maxCount).map(m => {
    if (typeof m.content === 'string') {
      return { role: m.role, content: m.content.slice(0, maxLen) };
    }
    // Multimodal content array
    if (Array.isArray(m.content)) {
      return {
        role: m.role,
        content: m.content.map(block => {
          if (block.type === 'text') return { ...block, text: block.text.slice(0, maxLen) };
          if (block.type === 'image') return block; // pass through images
          return block;
        })
      };
    }
    return { role: m.role, content: String(m.content || '').slice(0, maxLen) };
  });
}

// ── STREAMING SSE ENDPOINT ────────────────────────────────
router.post('/stream/:agentId', async (req, res) => {
  const pool = getPool(req);

  // Widget rate limit
  const ip  = req.ip || 'unknown';
  const wrl = await rateLimit(pool, `widget:${ip}`, 60).catch(() => ({ allowed: false })); // fail-closed
  if (!wrl.allowed) return res.status(429).json({ error: 'Zu viele Anfragen.' });

  try {
    const { messages, sessionId: rawSid, source = 'web', sessionIdentifier } = req.body;
    if (!messages?.length) return res.status(400).json({ error: 'messages erforderlich' });

    const ar = await pool.query(
      `SELECT a.*, u.email AS owner_email, u.plan AS owner_plan
       FROM agents a JOIN users u ON a.user_id=u.id
       WHERE a.id=$1 AND a.is_active=true`,
      [req.params.agentId]
    );
    if (!ar.rows.length) return res.status(404).json({ error: 'Agent nicht gefunden' });
    const agent = ar.rows[0];

    const quota = await checkMsgQuota(pool, agent.user_id);
    if (!quota.allowed) return res.status(429).json({ error: 'Nachrichtenlimit erreicht.', upgrade: true });

    const sessionId = rawSid || uuid();
    const msgs      = sanitizeMessages(messages);
    const userMsg   = msgs[msgs.length - 1];
    const model     = agent.model || 'claude-sonnet-4-6';

    // Load memory + RAG
    const sessionIdHash = sessionIdentifier ? hashSessionId(sessionIdentifier) : null;
    const memory = await loadMemory(pool, agent.id, sessionIdHash);
    const sysPrompt = await buildSystemPrompt(pool, agent, memory);
    const ragCtx = agent.rag_enabled ? await fetchRagContext(pool, agent.id, typeof userMsg.content === 'string' ? userMsg.content : 'image') : '';

    // Save user message
    const hasImage = Array.isArray(userMsg.content) && userMsg.content.some(b => b.type === 'image');
    await pool.query(
      'INSERT INTO chat_messages (agent_id, session_id, role, content, source, has_image) VALUES ($1,$2,$3,$4,$5,$6)',
      [agent.id, sessionId, 'user', typeof userMsg.content === 'string' ? userMsg.content : '[Bild + Text]', source, hasImage]
    );

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
    res.flushHeaders();

    // Send sessionId immediately
    res.write(`data: ${JSON.stringify({ type: 'session', sessionId })}\n\n`);

    let fullReply = '';
    let usage     = {};

    // Load agent tools for agentic actions
    let agentTools = [];
    try {
      const toolsR = await pool.query('SELECT * FROM agent_tools WHERE agent_id=$1 AND is_enabled=true', [agent.id]);
      agentTools = toolsR.rows;
    } catch {}

    // If tools present — use agentic mode (no streaming for tool-use loops)
    if (agentTools.length > 0) {
      const agResult = await runAgenticChat(client, model, sysPrompt + ragCtx, msgs, agentTools, pool, agent.id, sessionId);
      fullReply = agResult.reply;
      usage = agResult.usage || {};
      res.write(`data: ${JSON.stringify({ type: 'text', text: fullReply })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();

      setImmediate(async () => {
        try {
          await pool.query('INSERT INTO chat_messages (agent_id, session_id, role, content, source) VALUES ($1,$2,$3,$4,$5)', [agent.id, sessionId, 'assistant', fullReply, source]);
          await pool.query('UPDATE agents SET total_messages=total_messages+1 WHERE id=$1', [agent.id]);
          await trackCost(pool, agent.id, sessionId, model, usage, source);
          if (sessionIdHash) await updateMemory(pool, agent.id, sessionIdHash, msgs, fullReply);
          const lead = await tryCaptureLead(pool, agent, msgs, fullReply, sessionId, source);
          if (lead) { await sendLeadEmail(agent, agent.owner_email, lead); }
        } catch(e) { console.error('Post-agentic error:', e.message); }
      });
    } else {

    // Stream from Anthropic
    // PII minimization before external API call
    const safeMessages = minimizeMessages(msgs);
    const stream = client.messages.stream({
      model,
      max_tokens: 1024,
      system: sysPrompt + ragCtx,
      messages: safeMessages,
    });

    stream.on('text', (text) => {
      fullReply += text;
      res.write(`data: ${JSON.stringify({ type: 'text', text })}\n\n`);
    });

    stream.on('message', (msg) => {
      usage = msg.usage || {};
    });

    await stream.finalMessage();

    // Done signal
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();

    // Post-processing (non-blocking)
    setImmediate(async () => {
      try {
        // Save assistant message
        await pool.query(
          'INSERT INTO chat_messages (agent_id, session_id, role, content, source) VALUES ($1,$2,$3,$4,$5)',
          [agent.id, sessionId, 'assistant', fullReply, source]
        );
        await pool.query('UPDATE agents SET total_messages=total_messages+1 WHERE id=$1', [agent.id]);

        // Cost tracking
        await trackCost(pool, agent.id, sessionId, model, usage, source);

        // Memory update
        if (sessionIdHash) await updateMemory(pool, agent.id, sessionIdHash, msgs, fullReply);

        // Lead capture
        const lead = await tryCaptureLead(pool, agent, msgs, fullReply, sessionId, source);
        if (lead) {
          await sendLeadEmail(agent, agent.owner_email, lead);
          await dispatchWebhooks(pool, agent.id, 'lead.captured', { agentId:agent.id, sessionId, source, lead });
        }

        // Webhooks
        await dispatchWebhooks(pool, agent.id, 'message.received', {
          agentId: agent.id, agentName: agent.name, sessionId, source,
          message: typeof userMsg.content === 'string' ? userMsg.content : '[Bild]',
          reply: fullReply, timestamp: new Date().toISOString(),
        });
      } catch(e) { console.error('Post-stream error:', e.message); }
    });

    } // end else (no agentic tools)

  } catch(e) {
    console.error('STREAM ERROR:', e.message);
    if (!res.headersSent) return res.status(500).json({ error: 'Stream-Fehler' });
    res.write(`data: ${JSON.stringify({ type: 'error', error: 'Stream-Fehler' })}\n\n`);
    res.end();
  }
});

// ── STANDARD (non-streaming) WEB CHAT ────────────────────
router.post('/web/:agentId', async (req, res) => {
  const pool = getPool(req);
  const ip   = req.ip || 'unknown';
  const wrl  = await rateLimit(pool, `widget:${ip}`, 60).catch(() => ({ allowed: false })); // fail-closed
  if (!wrl.allowed) return res.status(429).json({ error: 'Zu viele Anfragen.' });

  try {
    const { messages, sessionId: rawSid, source = 'web', sessionIdentifier } = req.body;
    if (!messages?.length) return res.status(400).json({ error: 'messages erforderlich' });

    const ar = await pool.query(
      `SELECT a.*, u.email AS owner_email, u.plan AS owner_plan
       FROM agents a JOIN users u ON a.user_id=u.id WHERE a.id=$1 AND a.is_active=true`,
      [req.params.agentId]
    );
    if (!ar.rows.length) return res.status(404).json({ error: 'Agent nicht gefunden' });
    const agent = ar.rows[0];

    const quota = await checkMsgQuota(pool, agent.user_id);
    if (!quota.allowed) return res.status(429).json({ error: 'Nachrichtenlimit erreicht.', upgrade: true });

    const sessionId = rawSid || uuid();
    const msgs      = sanitizeMessages(messages);
    const userMsg   = msgs[msgs.length - 1];
    const model     = agent.model || 'claude-sonnet-4-6';

    const sessionIdHash = sessionIdentifier ? hashSessionId(sessionIdentifier) : null;
    const memory    = await loadMemory(pool, agent.id, sessionIdHash);
    const sysPrompt = await buildSystemPrompt(pool, agent, memory);
    const ragCtx    = agent.rag_enabled ? await fetchRagContext(pool, agent.id, typeof userMsg.content === 'string' ? userMsg.content : '') : '';

    const hasImage = Array.isArray(userMsg.content) && userMsg.content.some(b => b.type === 'image');
    await pool.query(
      'INSERT INTO chat_messages (agent_id, session_id, role, content, source, has_image) VALUES ($1,$2,$3,$4,$5,$6)',
      [agent.id, sessionId, 'user', typeof userMsg.content === 'string' ? userMsg.content : '[Bild + Text]', source, hasImage]
    );

    // Load agent tools
    let agentTools = [];
    try {
      const toolsR = await pool.query('SELECT * FROM agent_tools WHERE agent_id=$1 AND is_enabled=true', [agent.id]);
      agentTools = toolsR.rows;
    } catch {}

    const safeMsgs = minimizeMessages(msgs);
    let reply, responseUsage;
    if (agentTools.length > 0) {
      const result = await runAgenticChat(client, model, sysPrompt + ragCtx, safeMsgs, agentTools, pool, agent.id, sessionId);
      reply = result.reply; responseUsage = result.usage;
    } else {
      const response = await client.messages.create({ model, max_tokens: 1024, system: sysPrompt + ragCtx, messages: safeMsgs });
      reply = response.content[0]?.text || 'Keine Antwort.'; responseUsage = response.usage;
    };
    await pool.query('INSERT INTO chat_messages (agent_id, session_id, role, content, source) VALUES ($1,$2,$3,$4,$5)', [agent.id, sessionId, 'assistant', reply, source]);
    await pool.query('UPDATE agents SET total_messages=total_messages+1 WHERE id=$1', [agent.id]);

    setImmediate(async () => {
      await trackCost(pool, agent.id, sessionId, model, responseUsage || {}, source);
      if (sessionIdHash) await updateMemory(pool, agent.id, sessionIdHash, msgs, reply);
      const lead = await tryCaptureLead(pool, agent, msgs, reply, sessionId, source);
      if (lead) { await sendLeadEmail(agent, agent.owner_email, lead); await dispatchWebhooks(pool, agent.id, 'lead.captured', {agentId:agent.id,sessionId,source,lead}); }
      await dispatchWebhooks(pool, agent.id, 'message.received', {agentId:agent.id,agentName:agent.name,sessionId,source,message:typeof userMsg.content==='string'?userMsg.content:'[Bild]',reply,timestamp:new Date().toISOString()});
    });

    // Human handoff detection
    const handoffWords = ['mensch','mitarbeiter','human','real person','speak to someone'];
    const wantsHandoff = typeof userMsg.content === 'string' && handoffWords.some(w => userMsg.content.toLowerCase().includes(w));

    res.json({ reply, sessionId, wantsHandoff, feedback: { endpoint: `/api/feedback/${agent.id}/${sessionId}` } });
  } catch(e) {
    console.error('WEB CHAT ERROR:', e.message);
    res.status(500).json({ error: 'Chat-Fehler' });
  }
});

// ── API KEY CHAT ──────────────────────────────────────────
router.post('/api/:agentId', async (req, res) => {
  const pool   = getPool(req);
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'x-api-key Header erforderlich' });

  try {
    const crypto  = require('crypto');
    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    const kr = await pool.query(
      `SELECT k.user_id, u.plan, u.msg_count_month, a.id AS agent_id,
              a.system_prompt, a.greeting, a.tone, a.language, a.quick_chips,
              a.is_active, a.api_enabled, a.rag_enabled, a.rag_prompt,
              a.cap_calendar, a.cal_link, a.cap_leads, a.lead_fields, a.lead_email,
              a.cap_products, a.products_data, a.cap_multilang,
              a.model, a.color, a.emoji, a.name,
              u.email AS owner_email
       FROM api_keys k JOIN users u ON k.user_id=u.id
       JOIN agents a ON a.id=$2 AND a.user_id=k.user_id
       WHERE k.key_hash=$1 AND k.is_active=true AND a.is_active=true AND u.deleted_at IS NULL`,
      [keyHash, req.params.agentId]
    );
    if (!kr.rows.length) return res.status(401).json({ error: 'Ungültiger API-Key oder Agent nicht gefunden' });

    const row   = kr.rows[0];
    const limits = getLimits(row.plan);
    if (!limits.api) return res.status(403).json({ error: 'API-Zugang erfordert Pro-Plan', upgrade: true });

    const quota = await checkMsgQuota(pool, row.user_id);
    if (!quota.allowed) return res.status(429).json({ error: 'Nachrichtenlimit erreicht.' });

    const { messages, sessionId: rawSid, sessionIdentifier } = req.body;
    if (!messages?.length) return res.status(400).json({ error: 'messages erforderlich' });

    const sessionId = rawSid || uuid();
    const msgs      = sanitizeMessages(messages);
    const userMsg   = msgs[msgs.length - 1];
    const model     = row.model || 'claude-sonnet-4-6';

    const agent = { ...row, id: row.agent_id };
    const memory = await loadMemory(pool, agent.id, sessionIdentifier);
    const sysPrompt = await buildSystemPrompt(pool, agent, memory);

    const response = await client.messages.create({ model, max_tokens: 1024, system: sysPrompt, messages: msgs });
    const reply    = response.content[0]?.text || '';

    await pool.query('INSERT INTO chat_messages (agent_id, session_id, role, content, source) VALUES ($1,$2,$3,$4,$5)', [agent.id, sessionId, 'user', typeof userMsg.content==='string'?userMsg.content:'[Bild]', 'api']);
    await pool.query('INSERT INTO chat_messages (agent_id, session_id, role, content, source) VALUES ($1,$2,$3,$4,$5)', [agent.id, sessionId, 'assistant', reply, 'api']);
    await pool.query('UPDATE api_keys SET last_used=NOW() WHERE key_hash=$1', [keyHash]);
    await pool.query('UPDATE agents SET total_messages=total_messages+1 WHERE id=$1', [agent.id]);

    setImmediate(async () => {
      await trackCost(pool, agent.id, sessionId, model, response.usage||{}, 'api');
      if (sessionIdentifier) await updateMemory(pool, agent.id, sessionIdentifier, msgs, reply);
    });

    res.json({ reply, sessionId });
  } catch(e) {
    console.error('API CHAT ERROR:', e.message);
    res.status(500).json({ error: 'Chat-Fehler' });
  }
});

module.exports = router;
