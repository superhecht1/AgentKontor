/**
 * AgentKontor — Slack Integration
 *
 * GET  /webhook/slack/events     — Slack event verification + messages
 * POST /webhook/slack/events     — incoming Slack events
 *
 * Setup: Slack App → Event Subscriptions → URL: /webhook/slack/events
 * Scopes needed: chat:write, channels:history, im:history, im:read, im:write
 */

const router  = require('express').Router();
const crypto  = require('crypto');
const { v4: uuid } = require('uuid');

function getPool(req) { return req.app.locals.pool; }

function verifySlackSignature(req, signingSecret) {
  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];
  if (!timestamp || !signature) return false;

  // Prevent replay attacks — reject requests older than 5 minutes
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) return false;

  const rawBody = req.rawBody || JSON.stringify(req.body);
  const sigBase = `v0:${timestamp}:${rawBody}`;
  const expected = 'v0=' + crypto.createHmac('sha256', signingSecret).update(sigBase).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

/* ── SLACK EVENTS ───────────────────────────────────────── */
router.post('/slack/events', async (req, res) => {
  const pool = getPool(req);

  // URL verification challenge
  if (req.body.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge });
  }

  // Acknowledge immediately (Slack requires <3s response)
  res.sendStatus(200);

  try {
    const event = req.body.event;
    if (!event) return;

    // Only handle direct messages and mentions
    if (!['message', 'app_mention'].includes(event.type)) return;
    if (event.subtype === 'bot_message' || event.bot_id) return; // Ignore own messages
    if (!event.text) return;

    const channelId = event.channel;
    const userId    = event.user;
    const text      = event.text.replace(/<@[A-Z0-9]+>/g, '').trim(); // Remove @mentions

    // Find agent by slack_channel_id
    const agentR = await pool.query(
      'SELECT a.*, u.email AS owner_email FROM agents a JOIN users u ON a.user_id=u.id WHERE a.slack_channel_id=$1 AND a.slack_enabled=true AND a.is_active=true LIMIT 1',
      [channelId]
    );
    if (!agentR.rows.length) return;
    const agent = agentR.rows[0];

    // Get reply from Claude
    const Anthropic = require('@anthropic-ai/sdk');
    const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    let sys = agent.system_prompt || 'Du bist ein hilfreicher KI-Assistent.';
    if (agent.cap_multilang) sys += '\n\nAntworte immer in der Sprache des Nutzers.';

    const response = await client.messages.create({
      model: agent.model || 'claude-sonnet-4-6',
      max_tokens: 800,
      system: sys,
      messages: [{ role: 'user', content: text }],
    });

    const reply      = response.content[0]?.text || '';
    const sessionId  = `slack_${userId}_${channelId}`;

    // Save to DB
    await pool.query('INSERT INTO chat_messages (agent_id, session_id, role, content, source) VALUES ($1,$2,$3,$4,$5)', [agent.id, sessionId, 'user', text, 'slack']);
    await pool.query('INSERT INTO chat_messages (agent_id, session_id, role, content, source) VALUES ($1,$2,$3,$4,$5)', [agent.id, sessionId, 'assistant', reply, 'slack']);
    await pool.query('UPDATE agents SET total_messages=total_messages+1 WHERE id=$1', [agent.id]);

    // Send reply to Slack
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${agent.slack_bot_token}`,
      },
      body: JSON.stringify({
        channel: channelId,
        text:    reply,
        // Optionally thread the reply
        ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}),
      }),
    });

  } catch(e) { console.error('Slack event error:', e.message); }
});

module.exports = router;
