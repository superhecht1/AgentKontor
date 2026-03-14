const router = require('express').Router();
const auth = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

function getPool(req) { return req.app.locals.pool; }
function makePublicId() { return uuidv4().replace(/-/g,'').slice(0,16); }

// GET /api/agents — list my agents
router.get('/', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const result = await pool.query(
      `SELECT id, public_id, name, emoji, description, color, is_active,
              widget_enabled, chatpage_enabled, api_enabled,
              whatsapp_enabled, telegram_enabled, total_messages, created_at
       FROM agents WHERE user_id=$1 ORDER BY created_at DESC`,
      [req.userId]
    );
    res.json({ agents: result.rows });
  } catch (e) {
    res.status(500).json({ error: 'Fehler beim Laden' });
  }
});

// POST /api/agents — create agent
router.post('/', auth, async (req, res) => {
  const pool = getPool(req);
  const {
    name, emoji = '🤖', description = '', system_prompt, greeting,
    tone = 'professionell', language = 'de', quick_chips = [], color = '#6c5ce7'
  } = req.body;

  if (!name || !system_prompt) return res.status(400).json({ error: 'Name und System-Prompt erforderlich' });

  // Limit free plan to 3 agents
  const count = await pool.query('SELECT COUNT(*) FROM agents WHERE user_id=$1', [req.userId]);
  const userRes = await pool.query('SELECT plan FROM users WHERE id=$1', [req.userId]);
  if (userRes.rows[0].plan === 'free' && parseInt(count.rows[0].count) >= 3)
    return res.status(403).json({ error: 'Free Plan: max. 3 Agenten. Upgrade für mehr.' });

  const publicId = makePublicId();
  const greet = greeting || `Hallo! Ich bin ${name}. Wie kann ich dir helfen?`;

  try {
    const result = await pool.query(
      `INSERT INTO agents (user_id, public_id, name, emoji, description, system_prompt, greeting, tone, language, quick_chips, color)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.userId, publicId, name, emoji, description, system_prompt, greet, tone, language, JSON.stringify(quick_chips), color]
    );
    res.json({ agent: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Agent konnte nicht erstellt werden' });
  }
});

// GET /api/agents/:id — get single agent (owner)
router.get('/:id', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const result = await pool.query(
      'SELECT * FROM agents WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Agent nicht gefunden' });
    res.json({ agent: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// PUT /api/agents/:id — update agent
router.put('/:id', auth, async (req, res) => {
  const pool = getPool(req);
  const {
    name, emoji, description, system_prompt, greeting, tone, language,
    quick_chips, color, is_active,
    widget_enabled, chatpage_enabled, api_enabled,
    whatsapp_enabled, whatsapp_number, telegram_enabled, telegram_token,
    rag_enabled, rag_prompt,
    cap_calendar, cal_link, cap_leads, lead_fields, lead_email,
    cap_products, products_data, cap_multilang, cap_email,
    smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from
  } = req.body;

  try {
    const result = await pool.query(
      `UPDATE agents SET
        name=$1, emoji=$2, description=$3, system_prompt=$4, greeting=$5,
        tone=$6, language=$7, quick_chips=$8, color=$9, is_active=$10,
        widget_enabled=$11, chatpage_enabled=$12, api_enabled=$13,
        whatsapp_enabled=$14, whatsapp_number=$15, telegram_enabled=$16, telegram_token=$17,
        rag_enabled=$18, rag_prompt=$19,
        cap_calendar=$20, cal_link=$21, cap_leads=$22, lead_fields=$23, lead_email=$24,
        cap_products=$25, products_data=$26, cap_multilang=$27, cap_email=$28,
        smtp_host=$29, smtp_port=$30, smtp_user=$31, smtp_pass=$32, smtp_from=$33,
        updated_at=NOW()
       WHERE id=$34 AND user_id=$35 RETURNING *`,
      [name, emoji, description, system_prompt, greeting, tone, language,
       JSON.stringify(quick_chips || []), color, is_active ?? true,
       widget_enabled ?? true, chatpage_enabled ?? true, api_enabled ?? false,
       whatsapp_enabled ?? false, whatsapp_number || null,
       telegram_enabled ?? false, telegram_token || null,
       rag_enabled ?? false, rag_prompt || '',
       cap_calendar ?? false, cal_link || null,
       cap_leads ?? false, JSON.stringify(lead_fields || []), lead_email || null,
       cap_products ?? false, JSON.stringify(products_data || []),
       cap_multilang ?? false, cap_email ?? false,
       smtp_host || null, smtp_port || 587, smtp_user || null, smtp_pass || null, smtp_from || null,
       req.params.id, req.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Agent nicht gefunden' });
    res.json({ agent: result.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Update fehlgeschlagen' });
  }
});

// DELETE /api/agents/:id
router.delete('/:id', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    await pool.query('DELETE FROM agents WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Löschen fehlgeschlagen' });
  }
});

// GET /api/agents/:id/stats
router.get('/:id/stats', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const msgs = await pool.query(
      `SELECT source, COUNT(*) as count, DATE_TRUNC('day', created_at) as day
       FROM chat_messages WHERE agent_id=$1 AND role='user'
       GROUP BY source, day ORDER BY day DESC LIMIT 30`,
      [req.params.id]
    );
    const total = await pool.query(
      'SELECT total_messages FROM agents WHERE id=$1 AND user_id=$2',
      [req.params.id, req.userId]
    );
    res.json({ stats: msgs.rows, total: total.rows[0]?.total_messages || 0 });
  } catch (e) {
    res.status(500).json({ error: 'Fehler beim Laden der Stats' });
  }
});

// GET /api/agents/public/:publicId — public info (no auth needed)
router.get('/public/:publicId', async (req, res) => {
  const pool = getPool(req);
  try {
    const result = await pool.query(
      `SELECT public_id, name, emoji, description, greeting, color, language, quick_chips, is_active, chatpage_enabled
       FROM agents WHERE public_id=$1`,
      [req.params.publicId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Agent nicht gefunden' });
    const agent = result.rows[0];
    if (!agent.is_active || !agent.chatpage_enabled)
      return res.status(403).json({ error: 'Agent nicht verfügbar' });
    res.json({ agent });
  } catch (e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

module.exports = router;
