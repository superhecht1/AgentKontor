const router = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const https = require('https');

const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
function getPool(req) { return req.app.locals.pool; }

async function getAgentByNumber(pool, number) {
  const r = await pool.query(
    'SELECT * FROM agents WHERE whatsapp_number=$1 AND whatsapp_enabled=true AND is_active=true',
    [number]
  );
  return r.rows[0] || null;
}

async function getAgentByToken(pool, token) {
  const r = await pool.query(
    'SELECT * FROM agents WHERE telegram_token=$1 AND telegram_enabled=true AND is_active=true',
    [token]
  );
  return r.rows[0] || null;
}

async function getAIReply(agent, userMsg, sessionId, pool) {
  // Load last 10 messages for context
  const history = await pool.query(
    'SELECT role, content FROM chat_messages WHERE agent_id=$1 AND session_id=$2 ORDER BY created_at DESC LIMIT 10',
    [agent.id, sessionId]
  );
  const msgs = history.rows.reverse().concat([{ role: 'user', content: userMsg }]);

  const response = await ai.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 512,
    system: agent.system_prompt,
    messages: msgs.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }))
  });
  return response.content[0]?.text || '...';
}

/* ── WHATSAPP (Meta Cloud API) ──────────────────────── */
// GET /webhook/whatsapp — verification
router.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// POST /webhook/whatsapp
router.post('/whatsapp', async (req, res) => {
  res.sendStatus(200); // Always respond immediately
  const pool = getPool(req);

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];
    if (!message || message.type !== 'text') return;

    const fromNumber = message.from;
    const toNumber = value.metadata?.display_phone_number;
    const text = message.text.body;
    const sessionId = `wa_${fromNumber}`;

    // Find matching agent
    const agent = await getAgentByNumber(pool, toNumber);
    if (!agent) return;

    // Save user message
    await pool.query(
      'INSERT INTO chat_messages (agent_id, session_id, role, content, source) VALUES ($1,$2,$3,$4,$5)',
      [agent.id, sessionId, 'user', text, 'whatsapp']
    );

    const reply = await getAIReply(agent, text, sessionId, pool);

    // Save reply
    await pool.query(
      'INSERT INTO chat_messages (agent_id, session_id, role, content, source) VALUES ($1,$2,$3,$4,$5)',
      [agent.id, sessionId, 'assistant', reply, 'whatsapp']
    );

    // Send WhatsApp reply via Meta API
    await sendWhatsApp(fromNumber, reply);
    await pool.query('UPDATE agents SET total_messages = total_messages + 1 WHERE id=$1', [agent.id]);
  } catch (e) {
    console.error('WhatsApp webhook error:', e.message);
  }
});

async function sendWhatsApp(to, text) {
  const body = JSON.stringify({
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text }
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'graph.facebook.com',
      path: `/v19.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => { res.on('data', () => {}); res.on('end', resolve); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/* ── TELEGRAM ───────────────────────────────────────── */
// POST /webhook/telegram/:token
router.post('/telegram/:token', async (req, res) => {
  res.sendStatus(200);
  const pool = getPool(req);

  try {
    const agent = await getAgentByToken(pool, req.params.token);
    if (!agent) return;

    const message = req.body?.message;
    if (!message?.text) return;

    const chatId = message.chat.id;
    const text = message.text;
    const sessionId = `tg_${chatId}`;

    await pool.query(
      'INSERT INTO chat_messages (agent_id, session_id, role, content, source) VALUES ($1,$2,$3,$4,$5)',
      [agent.id, sessionId, 'user', text, 'telegram']
    );

    const reply = await getAIReply(agent, text, sessionId, pool);

    await pool.query(
      'INSERT INTO chat_messages (agent_id, session_id, role, content, source) VALUES ($1,$2,$3,$4,$5)',
      [agent.id, sessionId, 'assistant', reply, 'telegram']
    );

    // Send Telegram reply
    await sendTelegram(agent.telegram_token.split(':')[0], agent.telegram_token, chatId, reply);
    await pool.query('UPDATE agents SET total_messages = total_messages + 1 WHERE id=$1', [agent.id]);
  } catch (e) {
    console.error('Telegram webhook error:', e.message);
  }
});

async function sendTelegram(botId, token, chatId, text) {
  const body = JSON.stringify({ chat_id: chatId, text });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { res.on('data', () => {}); res.on('end', resolve); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = router;
