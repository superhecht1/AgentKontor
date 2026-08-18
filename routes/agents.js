/**
 * AgentKontor — Agents API
 *
 * GET    /api/agents                        — list user's agents
 * POST   /api/agents                        — create agent
 * GET    /api/agents/:id                    — get single agent
 * PUT    /api/agents/:id                    — update agent
 * DELETE /api/agents/:id                    — delete agent
 * POST   /api/agents/:id/clone              — duplicate agent
 * GET    /api/chat/widget-config/:publicId  — public config for widget.js
 */

const router = require('express').Router();
const auth   = require('../middleware/auth');
const { requirePlan, getLimits } = require('../middleware/plan-gate');

function getPool(req) { return req.app.locals.pool; }

async function verifyOwner(pool, agentId, userId) {
  const r = await pool.query('SELECT id FROM agents WHERE id=$1 AND user_id=$2', [agentId, userId]);
  return r.rows.length > 0;
}

// AGENT_FIELDS mit COALESCE für Spalten die durch Migration 004 hinzukommen
// → kein 500 wenn DB noch alte Schema hat
const AGENT_FIELDS = `
  id, public_id, user_id, name, emoji, description, color,
  system_prompt, greeting, tone, language, quick_chips,
  is_active, widget_enabled, chatpage_enabled,
  COALESCE(api_enabled, false)           AS api_enabled,
  COALESCE(whatsapp_enabled, false)      AS whatsapp_enabled,
  COALESCE(whatsapp_number, '')          AS whatsapp_number,
  COALESCE(telegram_enabled, false)      AS telegram_enabled,
  COALESCE(telegram_token, '')           AS telegram_token,
  COALESCE(rag_enabled, false)           AS rag_enabled,
  COALESCE(rag_prompt, '')               AS rag_prompt,
  COALESCE(cap_calendar, false)          AS cap_calendar,
  COALESCE(cal_link, '')                 AS cal_link,
  COALESCE(cap_leads, false)             AS cap_leads,
  COALESCE(lead_fields, '[]')            AS lead_fields,
  COALESCE(lead_email, '')               AS lead_email,
  COALESCE(cap_products, false)          AS cap_products,
  COALESCE(products_data, '[]')          AS products_data,
  COALESCE(cap_multilang, false)         AS cap_multilang,
  COALESCE(cap_email, false)             AS cap_email,
  COALESCE(smtp_host, '')                AS smtp_host,
  COALESCE(smtp_port, 587)               AS smtp_port,
  COALESCE(smtp_user, '')                AS smtp_user,
  COALESCE(smtp_from, '')                AS smtp_from,
  COALESCE(widget_position, 'right')     AS widget_position,
  COALESCE(widget_delay, 0)              AS widget_delay,
  COALESCE(widget_theme, 'dark')         AS widget_theme,
  COALESCE(widget_size, 56)              AS widget_size,
  COALESCE(instagram_enabled, false)     AS instagram_enabled,
  COALESCE(instagram_business_id, '')    AS instagram_business_id,
  COALESCE(facebook_enabled, false)      AS facebook_enabled,
  COALESCE(facebook_page_id, '')         AS facebook_page_id,
  COALESCE(slack_enabled, false)         AS slack_enabled,
  COALESCE(slack_channel_id, '')         AS slack_channel_id,
  COALESCE(voice_enabled, false)         AS voice_enabled,
  COALESCE(voice_provider, 'elevenlabs') AS voice_provider,
  COALESCE(voice_id, '')                 AS voice_id,
  COALESCE(voice_stability, 0.5)         AS voice_stability,
  COALESCE(stt_provider, 'whisper')      AS stt_provider,
  COALESCE(data_retention_days, 90)      AS data_retention_days,
  COALESCE(lead_retention_days, 180)     AS lead_retention_days,
  COALESCE(model, 'claude-sonnet-4-6')   AS model,
  COALESCE(total_messages, 0)            AS total_messages,
  created_at,
  COALESCE(proactive_enabled, false)     AS proactive_enabled,
  COALESCE(proactive_trigger, 'time')    AS proactive_trigger,
  COALESCE(proactive_delay, 30)          AS proactive_delay,
  COALESCE(proactive_message, '')        AS proactive_message,
  COALESCE(proactive_scroll, 50)         AS proactive_scroll
`;

/* ── LIST ──────────────────────────────────────────────── */
router.get('/', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query(
      `SELECT ${AGENT_FIELDS} FROM agents WHERE user_id=$1 ORDER BY created_at DESC`,
      [req.userId]
    );
    res.json({ agents: r.rows });
  } catch (e) {
    console.error('LIST AGENTS:', e.message);
    res.status(500).json({ error: 'Fehler' });
  }
});

/* ── GET ONE ───────────────────────────────────────────── */
router.get('/:id', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query(
      `SELECT ${AGENT_FIELDS} FROM agents WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Agent nicht gefunden' });
    res.json({ agent: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

/* ── CREATE ────────────────────────────────────────────── */
router.post('/', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    // Check plan limit
    const user = await pool.query('SELECT plan FROM users WHERE id=$1', [req.userId]);
    const limits = getLimits(user.rows[0]?.plan || 'free');
    const count  = await pool.query('SELECT COUNT(*) FROM agents WHERE user_id=$1', [req.userId]);
    if (limits.agents !== Infinity && parseInt(count.rows[0].count) >= limits.agents) {
      return res.status(403).json({ error: `Free-Plan: max. ${limits.agents} Agenten. Bitte upgraden.`, upgrade: true });
    }

    const b = req.body;
    const r = await pool.query(`
      INSERT INTO agents (
        user_id, name, emoji, description, color,
        system_prompt, greeting, tone, language, quick_chips,
        is_active, widget_enabled, chatpage_enabled, api_enabled,
        whatsapp_enabled, whatsapp_number, telegram_enabled, telegram_token,
        rag_enabled, rag_prompt,
        cap_calendar, cal_link, cap_leads, lead_fields, lead_email,
        cap_products, products_data, cap_multilang, cap_email,
        smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from,
        widget_position, widget_delay, widget_theme, widget_size,
        model
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
        $31,$32,$33,$34,$35,$36,$37,$38,$39,$40
      ) RETURNING ${AGENT_FIELDS}`,
      [
        req.userId,
        b.name, b.emoji || '🤖', b.description || '', b.color || '#6c5ce7',
        b.system_prompt || '', b.greeting || '', b.tone || 'professionell',
        b.language || 'de', JSON.stringify(b.quick_chips || []),
        b.is_active !== false, b.widget_enabled !== false,
        b.chatpage_enabled !== false, !!b.api_enabled,
        !!b.whatsapp_enabled, b.whatsapp_number || '',
        !!b.telegram_enabled, b.telegram_token || '',
        !!b.rag_enabled, b.rag_prompt || '',
        !!b.cap_calendar, b.cal_link || '',
        !!b.cap_leads, JSON.stringify(b.lead_fields || []), b.lead_email || '',
        !!b.cap_products, JSON.stringify(b.products_data || []),
        !!b.cap_multilang, !!b.cap_email,
        b.smtp_host || '', b.smtp_port || 587, b.smtp_user || '',
        b.smtp_pass || '', b.smtp_from || '',
        b.widget_position || 'right', b.widget_delay || 0,
        b.widget_theme || 'dark', b.widget_size || 56,
        b.model || 'claude-sonnet-4-6',
      ]
    );
    res.status(201).json({ agent: r.rows[0] });
  } catch (e) {
    console.error('CREATE AGENT:', e.message);
    res.status(500).json({ error: 'Fehler beim Erstellen' });
  }
});

/* ── UPDATE ────────────────────────────────────────────── */
router.put('/:id', auth, async (req, res) => {
  const pool = getPool(req);

  // FIX 4: Input length limits on update
  const MAX = { name: 80, system_prompt: 20000, greeting: 1000, description: 500, tone: 50 };
  for (const [field, limit] of Object.entries(MAX)) {
    if (req.body[field] && String(req.body[field]).length > limit)
      return res.status(400).json({ error: `${field} darf maximal ${limit} Zeichen lang sein.` });
  }

  if (!(await verifyOwner(pool, req.params.id, req.userId)))
    return res.status(403).json({ error: 'Nicht berechtigt' });

  const b = req.body;
  try {
    const r = await pool.query(`
      UPDATE agents SET
        name=$1, emoji=$2, description=$3, color=$4,
        system_prompt=$5, greeting=$6, tone=$7, language=$8, quick_chips=$9,
        is_active=$10, widget_enabled=$11, chatpage_enabled=$12, api_enabled=$13,
        whatsapp_enabled=$14, whatsapp_number=$15, telegram_enabled=$16, telegram_token=$17,
        rag_enabled=$18, rag_prompt=$19,
        cap_calendar=$20, cal_link=$21, cap_leads=$22, lead_fields=$23, lead_email=$24,
        cap_products=$25, products_data=$26, cap_multilang=$27, cap_email=$28,
        smtp_host=$29, smtp_port=$30, smtp_user=$31, smtp_pass=$32, smtp_from=$33,
        widget_position=$34, widget_delay=$35, widget_theme=$36, widget_size=$37,
        instagram_enabled=$38, instagram_token=$39, instagram_business_id=$40,
        facebook_enabled=$41, facebook_token=$42, facebook_page_id=$43,
        slack_enabled=$44, slack_bot_token=$45, slack_channel_id=$46,
        voice_enabled=$47, voice_provider=$48, voice_id=$49, voice_stability=$50, stt_provider=$51,
        data_retention_days=$52, lead_retention_days=$53,
        model=$54,
        proactive_enabled=$55, proactive_trigger=$56, proactive_delay=$57,
        proactive_message=$58, proactive_scroll=$59
      WHERE id=$60 AND user_id=$61
      RETURNING ${AGENT_FIELDS}`,
      [
        b.name, b.emoji || '🤖', b.description || '', b.color || '#6c5ce7',
        b.system_prompt || '', b.greeting || '', b.tone || 'professionell',
        b.language || 'de', JSON.stringify(b.quick_chips || []),
        b.is_active !== false, b.widget_enabled !== false,
        b.chatpage_enabled !== false, !!b.api_enabled,
        !!b.whatsapp_enabled, b.whatsapp_number || '',
        !!b.telegram_enabled, b.telegram_token || '',
        !!b.rag_enabled, b.rag_prompt || '',
        !!b.cap_calendar, b.cal_link || '',
        !!b.cap_leads, JSON.stringify(b.lead_fields || []), b.lead_email || '',
        !!b.cap_products, JSON.stringify(b.products_data || []),
        !!b.cap_multilang, !!b.cap_email,
        b.smtp_host || '', b.smtp_port || 587, b.smtp_user || '',
        b.smtp_pass || '', b.smtp_from || '',
        b.widget_position || 'right', b.widget_delay || 0,
        b.widget_theme || 'dark', b.widget_size || 56,
        !!b.instagram_enabled, b.instagram_token || null, b.instagram_business_id || null,
        !!b.facebook_enabled,  b.facebook_token  || null, b.facebook_page_id   || null,
        !!b.slack_enabled,     b.slack_bot_token  || null, b.slack_channel_id   || null,
        !!b.voice_enabled, b.voice_provider || 'elevenlabs', b.voice_id || null,
        parseFloat(b.voice_stability) || 0.5, b.stt_provider || 'whisper',
        Math.min(Math.max(parseInt(b.data_retention_days) || 90, 7), 730),
        Math.min(Math.max(parseInt(b.lead_retention_days) || 180, 7), 730),
        b.model || 'claude-sonnet-4-6',
        !!b.proactive_enabled, b.proactive_trigger || 'time',
        parseInt(b.proactive_delay) || 30, b.proactive_message || null,
        parseInt(b.proactive_scroll) || 50,
        req.params.id, req.userId,
      ]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Agent nicht gefunden' });
    res.json({ agent: r.rows[0] });
  } catch (e) {
    console.error('UPDATE AGENT:', e.message);
    res.status(500).json({ error: 'Fehler beim Speichern' });
  }
});

/* ── DELETE ────────────────────────────────────────────── */
router.delete('/:id', auth, async (req, res) => {
  const pool = getPool(req);
  if (!(await verifyOwner(pool, req.params.id, req.userId)))
    return res.status(403).json({ error: 'Nicht berechtigt' });
  try {
    await pool.query('DELETE FROM agents WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Fehler beim Löschen' });
  }
});

/* ── CLONE ─────────────────────────────────────────────── */
router.post('/:id/clone', auth, async (req, res) => {
  const pool = getPool(req);
  if (!(await verifyOwner(pool, req.params.id, req.userId)))
    return res.status(403).json({ error: 'Nicht berechtigt' });

  try {
    // Check plan limit first
    const user = await pool.query('SELECT plan FROM users WHERE id=$1', [req.userId]);
    const limits = getLimits(user.rows[0]?.plan || 'free');
    const count  = await pool.query('SELECT COUNT(*) FROM agents WHERE user_id=$1', [req.userId]);
    if (limits.agents !== Infinity && parseInt(count.rows[0].count) >= limits.agents) {
      return res.status(403).json({ error: 'Agent-Limit erreicht. Bitte upgraden.', upgrade: true });
    }

    const src = await pool.query(
      `SELECT ${AGENT_FIELDS} FROM agents WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.userId]
    );
    if (!src.rows.length) return res.status(404).json({ error: 'Agent nicht gefunden' });

    const a = src.rows[0];
    const r = await pool.query(`
      INSERT INTO agents (
        user_id, name, emoji, description, color,
        system_prompt, greeting, tone, language, quick_chips,
        is_active, widget_enabled, chatpage_enabled, api_enabled,
        whatsapp_enabled, whatsapp_number, telegram_enabled, telegram_token,
        rag_enabled, rag_prompt,
        cap_calendar, cal_link, cap_leads, lead_fields, lead_email,
        cap_products, products_data, cap_multilang, cap_email,
        smtp_host, smtp_port, smtp_user, smtp_from,
        widget_position, widget_delay, widget_theme, widget_size
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
        $31,$32,$33,$34,$35,$36,$37,$38
      ) RETURNING ${AGENT_FIELDS}`,
      [
        req.userId,
        a.name + ' (Kopie)', a.emoji, a.description, a.color,
        a.system_prompt, a.greeting, a.tone, a.language,
        JSON.stringify(a.quick_chips || []),
        false, // start inactive
        a.widget_enabled, a.chatpage_enabled, false, // api disabled on clone
        false, '', false, '',  // WA/TG disabled on clone
        a.rag_enabled, a.rag_prompt,
        a.cap_calendar, a.cal_link,
        a.cap_leads, JSON.stringify(a.lead_fields || []), a.lead_email,
        a.cap_products, JSON.stringify(a.products_data || []),
        a.cap_multilang, a.cap_email,
        a.smtp_host, a.smtp_port, a.smtp_user, a.smtp_pass, a.smtp_from,
        a.widget_position, a.widget_delay, a.widget_theme, a.widget_size,
      ]
    );
    res.status(201).json({ agent: r.rows[0] });
  } catch (e) {
    console.error('CLONE AGENT:', e.message);
    res.status(500).json({ error: 'Fehler beim Klonen' });
  }
});

/* ── WIDGET CONFIG (public — no auth) ──────────────────── */
// Note: this route is mounted separately in server.js as /api/chat/widget-config/:publicId
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


/* ── TEST AGENT ─────────────────────────────────────────── */
router.post('/:id/test', auth, async (req, res) => {
  const pool = getPool(req);
  if (!(await verifyOwner(pool, req.params.id, req.userId)))
    return res.status(403).json({ error: 'Nicht berechtigt' });

  const { message = 'Hallo! Stelle dich kurz vor.' } = req.body;
  if (String(message).length > 500) return res.status(400).json({ error: 'Testnachricht max. 500 Zeichen' });

  try {
    const r = await pool.query(
      'SELECT system_prompt, greeting, tone, language, model, emoji, name FROM agents WHERE id=$1',
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Agent nicht gefunden' });
    const agent = r.rows[0];

    const { callLLM, calcCost, getProvider } = require('../utils/llm');
    const model = agent.model || 'claude-sonnet-4-6';

    const start  = Date.now();
    const result = await callLLM(model, agent.system_prompt || 'Du bist ein hilfreicher Assistent.',
      [{ role: 'user', content: message }], 512);
    const ms     = Date.now() - start;

    res.json({
      reply:    result.reply,
      ms,
      model,
      provider: getProvider(model),
      tokens:   result.usage,
      cost_usd: calcCost(model, result.usage?.input_tokens||0, result.usage?.output_tokens||0).toFixed(6),
    });
  } catch(e) {
    console.error('Agent test error:', e.message);
    res.status(500).json({ error: 'Test fehlgeschlagen: ' + (e.status === 401 ? 'Ungültiger API-Key' : 'Anthropic-Fehler') });
  }
});


/* ── AVAILABLE MODELS (für Model-Picker im Dashboard) ──── */
router.get('/models/available', require('../middleware/auth'), (req, res) => {
  const { AVAILABLE_MODELS } = require('../utils/llm');

  // Filter by configured API keys
  const configured = {
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    openai:    !!process.env.OPENAI_API_KEY,
    google:    !!process.env.GOOGLE_AI_API_KEY,
    mistral:   !!process.env.MISTRAL_API_KEY,
    groq:      !!process.env.GROQ_API_KEY,
    deepseek:  !!process.env.DEEPSEEK_API_KEY,
  };

  const models = AVAILABLE_MODELS.map(m => ({
    ...m,
    available: !m.requiresEnv || configured[m.provider.toLowerCase()],
  }));

  res.json({ models, configured });
});

module.exports = router;
