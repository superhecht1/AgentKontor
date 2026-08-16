/**
 * AgentKontor — Instagram DM + Facebook Messenger Webhooks
 *
 * GET  /webhook/instagram  — webhook verification
 * POST /webhook/instagram  — incoming DM
 * GET  /webhook/facebook   — webhook verification
 * POST /webhook/facebook   — incoming message
 */

const router = require('express').Router();
const { v4: uuid } = require('uuid');

function getPool(req) { return req.app.locals.pool; }

// ── SHARED: find agent by channel token ──────────────────
async function findAgent(pool, field, token) {
  try {
    const r = await pool.query(
      `SELECT * FROM agents WHERE ${field}=$1 AND is_active=true LIMIT 1`,
      [token]
    );
    return r.rows[0] || null;
  } catch { return null; }
}

// ── SHARED: send to AgentKontor chat ────────────────────
async function getAgentReply(pool, req, agent, userText, sessionId) {
  try {
    // Reuse the chat.js logic via direct import
    const Anthropic = require('@anthropic-ai/sdk');
    const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Build simple system prompt
    let sys = agent.system_prompt || 'Du bist ein hilfreicher KI-Assistent.';
    if (agent.cap_multilang) sys += '\n\nAntworte immer in der Sprache des Nutzers.';

    const response = await client.messages.create({
      model: agent.model || 'claude-sonnet-4-6',
      max_tokens: 512,
      system: sys,
      messages: [{ role: 'user', content: userText }],
    });
    return response.content[0]?.text || 'Entschuldigung, ich konnte keine Antwort generieren.';
  } catch(e) {
    console.error('Agent reply error:', e.message);
    return null;
  }
}

// ── INSTAGRAM VERIFICATION ───────────────────────────────
router.get('/instagram', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  const igToken = process.env.INSTAGRAM_VERIFY_TOKEN || '';
  const tokenMatch = igToken && token ? crypto.timingSafeEqual(Buffer.from(token), Buffer.from(igToken)) : token === igToken;
  if (mode === 'subscribe' && tokenMatch) {
    console.log('✅ Instagram webhook verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ── INSTAGRAM INCOMING DM ────────────────────────────────
router.post('/instagram', async (req, res) => {
  res.sendStatus(200); // Acknowledge immediately

  const pool = getPool(req);
  try {
    const body = req.body;
    if (body.object !== 'instagram') return;

    for (const entry of body.entry || []) {
      for (const msg of entry.messaging || []) {
        if (!msg.message?.text) continue;
        const senderId = msg.sender?.id;
        const text     = msg.message.text;
        const pageId   = entry.id;

        // Find agent by instagram_business_id
        const agent = await findAgent(pool, 'instagram_business_id', pageId);
        if (!agent || !agent.instagram_enabled || !agent.instagram_token) continue;

        const sessionId = 'ig_' + senderId;
        const reply     = await getAgentReply(pool, req, agent, text, sessionId);
        if (!reply) continue;

        // Save messages
        await pool.query('INSERT INTO chat_messages (agent_id, session_id, role, content, source) VALUES ($1,$2,$3,$4,$5)', [agent.id, sessionId, 'user', text, 'instagram']);
        await pool.query('INSERT INTO chat_messages (agent_id, session_id, role, content, source) VALUES ($1,$2,$3,$4,$5)', [agent.id, sessionId, 'assistant', reply, 'instagram']);
        await pool.query('UPDATE agents SET total_messages=total_messages+1 WHERE id=$1', [agent.id]);

        // Send reply via Instagram Graph API
        await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${agent.instagram_token}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipient: { id: senderId },
            message:   { text: reply },
          }),
        });
      }
    }
  } catch(e) { console.error('Instagram webhook error:', e.message); }
});

// ── FACEBOOK MESSENGER VERIFICATION ─────────────────────
router.get('/facebook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  const fbToken = process.env.FACEBOOK_VERIFY_TOKEN || '';
  const fbMatch = fbToken && token ? crypto.timingSafeEqual(Buffer.from(token), Buffer.from(fbToken)) : token === fbToken;
  if (mode === 'subscribe' && fbMatch) {
    console.log('✅ Facebook webhook verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ── FACEBOOK MESSENGER INCOMING ──────────────────────────
router.post('/facebook', async (req, res) => {
  res.sendStatus(200); // Acknowledge immediately

  const pool = getPool(req);
  try {
    const body = req.body;
    if (body.object !== 'page') return;

    for (const entry of body.entry || []) {
      const pageId = entry.id;
      for (const msg of entry.messaging || []) {
        if (!msg.message?.text || msg.message.is_echo) continue;
        const senderId = msg.sender?.id;
        const text     = msg.message.text;

        // Find agent by facebook_page_id
        const agent = await findAgent(pool, 'facebook_page_id', pageId);
        if (!agent || !agent.facebook_enabled || !agent.facebook_token) continue;

        const sessionId = 'fb_' + senderId;
        const reply     = await getAgentReply(pool, req, agent, text, sessionId);
        if (!reply) continue;

        // Save messages
        await pool.query('INSERT INTO chat_messages (agent_id, session_id, role, content, source) VALUES ($1,$2,$3,$4,$5)', [agent.id, sessionId, 'user', text, 'facebook']);
        await pool.query('INSERT INTO chat_messages (agent_id, session_id, role, content, source) VALUES ($1,$2,$3,$4,$5)', [agent.id, sessionId, 'assistant', reply, 'facebook']);
        await pool.query('UPDATE agents SET total_messages=total_messages+1 WHERE id=$1', [agent.id]);

        // Send reply via Facebook Graph API
        await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${agent.facebook_token}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipient: { id: senderId },
            message:   { text: reply },
            messaging_type: 'RESPONSE',
          }),
        });
      }
    }
  } catch(e) { console.error('Facebook webhook error:', e.message); }
});

module.exports = router;
