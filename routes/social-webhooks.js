'use strict';
/**
 * routes/social-webhooks.js
 * WhatsApp Business API + Telegram Bot Webhook-Empfang
 */
const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/auth');
const { getPool } = require('../utils/db');
const { callLLM }  = require('../utils/llm');

async function tableExists(pool, t) {
  try { await pool.query(`SELECT 1 FROM ${t} LIMIT 1`); return true; } catch { return false; }
}

// Antwort generieren und senden
async function generateAndReply(pool, agent, userMessage, platform, externalId) {
  try {
    const reply = await callLLM(
      agent.model || 'claude-haiku-4-5-20251001',
      agent.system_prompt || 'Du bist ein hilfreicher Assistent.',
      [{ role: 'user', content: userMessage.slice(0, 2000) }]
    );

    // Lead ggf. speichern
    if (agent.cap_leads) {
      await pool.query(
        `INSERT INTO leads (agent_id, user_id, platform, external_id, message)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [agent.id, agent.user_id, platform, externalId, userMessage.slice(0,500)]
      ).catch(() => {});
    }

    return reply;
  } catch (e) {
    console.error('[social-webhook] LLM-Fehler:', e.message);
    return 'Es tut mir leid, ich kann gerade nicht antworten.';
  }
}

// ── WHATSAPP VERIFY ──────────────────────────────────────────────────────────
router.get('/whatsapp/:agentId', async (req, res) => {
  const mode  = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const chal  = req.query['hub.challenge'];
  const pool  = getPool(req);

  const ag = await pool.query('SELECT wa_verify_token FROM agents WHERE id=$1', [req.params.agentId])
    .catch(() => ({ rows: [] }));

  if (mode === 'subscribe' && ag.rows[0]?.wa_verify_token === token) {
    return res.send(chal);
  }
  res.status(403).send('Forbidden');
});

// ── WHATSAPP NACHRICHTEN ─────────────────────────────────────────────────────
router.post('/whatsapp/:agentId', async (req, res) => {
  const pool = getPool(req);
  res.sendStatus(200); // WhatsApp braucht sofort 200

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const msg = change?.value?.messages?.[0];
    if (!msg || msg.type !== 'text') return;

    const userText = msg.text?.body || '';
    const phoneNumber = msg.from;

    const ag = await pool.query('SELECT * FROM agents WHERE id=$1 AND is_active=true', [req.params.agentId]);
    if (!ag.rows.length) return;
    const agent = ag.rows[0];

    const reply = await generateAndReply(pool, agent, userText, 'whatsapp', phoneNumber);

    // WhatsApp antworten (benötigt WHATSAPP_TOKEN ENV)
    const waToken = process.env.WHATSAPP_TOKEN;
    const phoneId = change?.value?.metadata?.phone_number_id;
    if (waToken && phoneId) {
      await fetch(`https://graph.facebook.com/v17.0/${phoneId}/messages`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${waToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: phoneNumber,
          type: 'text',
          text: { body: reply.slice(0, 4096) },
        }),
      }).catch(e => console.error('[WhatsApp Send]', e.message));
    }
  } catch (e) {
    console.error('[WA Webhook]', e.message);
  }
});

// ── TELEGRAM NACHRICHTEN ─────────────────────────────────────────────────────
router.post('/telegram/:agentId', async (req, res) => {
  const pool = getPool(req);
  res.sendStatus(200);

  try {
    const msg = req.body?.message;
    if (!msg) return;

    const chatId   = msg.chat?.id;
    const userText = msg.text || '';
    if (!userText) return;

    const ag = await pool.query('SELECT * FROM agents WHERE id=$1 AND is_active=true', [req.params.agentId]);
    if (!ag.rows.length) return;
    const agent = ag.rows[0];

    const reply = await generateAndReply(pool, agent, userText, 'telegram', String(chatId));

    // Telegram antworten
    const tgToken = agent.telegram_token || process.env.TELEGRAM_BOT_TOKEN;
    if (tgToken) {
      await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: reply.slice(0, 4096), parse_mode: 'Markdown' }),
      }).catch(e => console.error('[Telegram Send]', e.message));
    }
  } catch (e) {
    console.error('[TG Webhook]', e.message);
  }
});

// ── TELEGRAM WEBHOOK REGISTRIEREN ────────────────────────────────────────────
router.post('/telegram/:agentId/register', auth, async (req, res) => {
  const { botToken } = req.body;
  if (!botToken) return res.status(400).json({ error: 'botToken erforderlich' });

  const baseUrl = process.env.BASE_URL || `https://${req.get('host')}`;
  const webhookUrl = `${baseUrl}/api/social/telegram/${req.params.agentId}`;

  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl }),
    });
    const data = await r.json();
    if (!data.ok) return res.status(400).json({ error: data.description });

    // Token am Agent speichern
    await pool.query('UPDATE agents SET telegram_token=$1 WHERE id=$2 AND user_id=$3',
      [botToken, req.params.agentId, req.userId]).catch(() => {});

    res.json({ success: true, webhookUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
