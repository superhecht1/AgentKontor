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

const AGENT_FIELDS = `
  id, public_id, user_id, name, emoji, description, color,
  system_prompt, greeting, tone, language, quick_chips,
  is_active, widget_enabled, chatpage_enabled, api_enabled,
  whatsapp_enabled, whatsapp_number, telegram_enabled, telegram_token,
  rag_enabled, rag_prompt,
  cap_calendar, cal_link, cap_leads, lead_fields, lead_email,
  cap_products, products_data, cap_multilang, cap_email,
  smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from,
  widget_position, widget_delay, widget_theme, widget_size,
  total_messages, created_at
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
        widget_position, widget_delay, widget_theme, widget_size
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
        $31,$32,$33,$34,$35,$36,$37,$38
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
        widget_position=$34, widget_delay=$35, widget_theme=$36, widget_size=$37
      WHERE id=$38 AND user_id=$39
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
        smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from,
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

module.exports = router;
