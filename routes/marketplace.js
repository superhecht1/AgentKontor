'use strict';
const express = require('express');
const router  = express.Router();

// Sicheres Error-Logging: Stack intern, generische Meldung zum Client
function safeErr(res, e, status = 500, context = '') {
  const isProd = process.env.NODE_ENV === 'production';
  if (context) console.error(`[${context}]`, e.message);
  else console.error(e.message);
  const msg = isProd
    ? (status < 500 ? e.message : 'Interner Serverfehler')  // 4xx ok, 5xx generisch
    : e.message;
  return res.status(status).json({ error: msg });
}

const auth    = require('../middleware/auth');
const { getPool } = require('../utils/db');

async function tableExists(pool, table) {
  try { await pool.query(`SELECT 1 FROM ${table} LIMIT 1`); return true; }
  catch { return false; }
}


// ── GET /api/marketplace  — Alle Agenten (mit Kategorien + Install-Status) ──
router.get('/', auth, async (req, res) => {
  const pool = getPool(req);
  const { category, search, featured, limit = 50 } = req.query;
  try {
        if (!await tableExists(pool, 'marketplace_agents')) return res.json({ agents: [] });
const conditions = ['ma.is_active=true'];
    const params     = [req.userId];
    let   i          = 2;

    if (category) { conditions.push(`ma.category_slug=$${i++}`); params.push(category); }
    if (featured)  { conditions.push('ma.is_featured=true'); }
    if (search)   {
      conditions.push(`(ma.name ILIKE $${i} OR ma.tagline ILIKE $${i} OR $${i}=ANY(ma.tags))`);
      params.push('%'+search+'%'); i++;
    }
    params.push(parseInt(limit));

    const r = await pool.query(
      `SELECT ma.*,
         mc.name   AS category_name,
         mc.emoji  AS category_emoji,
         mc.color  AS category_color,
         mi.id     IS NOT NULL AS is_installed,
         mi.agent_id AS installed_agent_id,
         COALESCE(mr.rating, 0) AS user_rating
       FROM marketplace_agents ma
       JOIN marketplace_categories mc ON mc.slug = ma.category_slug
       LEFT JOIN marketplace_installations mi
         ON mi.marketplace_id = ma.id AND mi.user_id = $1
       LEFT JOIN (SELECT marketplace_id, AVG(rating) as rating_avg, COUNT(*) as rating_count FROM marketplace_ratings GROUP BY marketplace_id) mr
         ON mr.marketplace_id = ma.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY ma.is_featured DESC, ma.install_count DESC
       LIMIT $${i}`,
      params
    );
    res.json({ agents: r.rows });
  } catch (e) {
    console.error('LIST MARKETPLACE:', e.message);
    res.json({ agents: [], categories: [] });
  }
});

// ── GET /api/marketplace/categories  — Kategorien ───────────────────────────
router.get('/categories', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    if (!await tableExists(pool, 'marketplace_categories')) return res.json({ categories: [] });
    if (!await tableExists(pool, 'marketplace_agents')) return res.json({ agents: [], categories: [] });
    const r = await pool.query(
      `SELECT mc.*,
         COUNT(ma.id) AS agent_count
       FROM marketplace_categories mc
       LEFT JOIN marketplace_agents ma ON ma.category_slug = mc.slug AND ma.is_active=true
       WHERE mc.is_active=true
       GROUP BY mc.id
       ORDER BY mc.sort_order`
    );
    res.json({ categories: r.rows });
  } catch (e) {
    res.json({ agents: [], categories: [] });
  }
});

// ── GET /api/marketplace/:id  — Detail ──────────────────────────────────────
router.get('/:id', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    if (!await tableExists(pool, 'marketplace_agents')) return res.json({ agents: [], categories: [] });
    const r = await pool.query(
      `SELECT ma.*, mc.name AS category_name, mc.emoji AS category_emoji,
         (mi.id IS NOT NULL) AS is_installed, mi.agent_id AS installed_agent_id
       FROM marketplace_agents ma
       JOIN marketplace_categories mc ON mc.slug=ma.category_slug
       LEFT JOIN marketplace_installations mi ON mi.marketplace_id=ma.id AND mi.user_id=$1
       WHERE ma.id=$2 OR ma.slug=$2`,
      [req.userId, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });

    // Bewertungen laden
    const ratings = await pool.query(
      `SELECT rating, review, created_at FROM marketplace_ratings
       WHERE marketplace_id=$1 ORDER BY created_at DESC LIMIT 10`,
      [r.rows[0].id]
    );
    res.json({ agent: r.rows[0], ratings: ratings.rows });
  } catch (e) {
    res.json({ agents: [], categories: [] });
  }
});

// ── POST /api/marketplace/:id/install  — Agent installieren ─────────────────
router.post('/:id/install', auth, async (req, res) => {
  const pool = getPool(req);
  const { agentName } = req.body; // optionaler Custom-Name

  try {
    if (!await tableExists(pool, 'marketplace_agents')) return res.json({ agents: [], categories: [] });
    // Marketplace-Agent laden
    const mr = await pool.query(
      'SELECT * FROM marketplace_agents WHERE id=$1 OR slug=$1',
      [req.params.id]
    );
    if (!mr.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });
    const template = mr.rows[0];

    // Bereits installiert?
    const existing = await pool.query(
      'SELECT * FROM marketplace_installations WHERE user_id=$1 AND marketplace_id=$2',
      [req.userId, template.id]
    );
    if (existing.rows.length && existing.rows[0].agent_id) {
      return res.json({ success: true, agentId: existing.rows[0].agent_id, alreadyInstalled: true });
    }

    // Plan-Gate prüfen
    const user = await pool.query('SELECT plan FROM users WHERE id=$1', [req.userId]);
    const isPro = user.rows[0]?.plan === 'pro';
    const agentCount = await pool.query(
      'SELECT COUNT(*) FROM agents WHERE user_id=$1', [req.userId]
    );
    if (!isPro && parseInt(agentCount.rows[0].count) >= 3) {
      return res.status(403).json({ error: 'Free-Plan: Max. 3 Agenten. Upgrade auf Pro für unbegrenzte Agenten.' });
    }

    // Capabilities aus Template parsen
    const caps = typeof template.capabilities === 'string'
      ? JSON.parse(template.capabilities)
      : (template.capabilities || {});
    const chips = typeof template.quick_chips === 'string'
      ? JSON.parse(template.quick_chips)
      : (template.quick_chips || []);

    // Agent erstellen
    const ar = await pool.query(
      `INSERT INTO agents
         (user_id, name, emoji, description, system_prompt, greeting, tone, language,
          quick_chips, color, is_active, widget_enabled, chatpage_enabled,
          cap_leads, lead_fields, lead_email, cap_calendar, cap_products, cap_multilang,
          model)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,true,true,$11,$12,$13,$14,$15,false,'claude-sonnet-4-6')
       RETURNING id`,
      [
        req.userId,
        agentName || template.name,
        template.emoji,
        template.tagline,
        template.system_prompt,
        template.greeting,
        template.tone || 'freundlich',
        template.language || 'de',
        JSON.stringify(chips),
        template.color || '#7c3aed',
        caps.cap_leads    || false,
        JSON.stringify(caps.lead_fields || []),
        caps.lead_email   || '',
        caps.cap_calendar || false,
        caps.cap_products || false,
      ]
    );
    const agentId = ar.rows[0].id;

    // Installation speichern
    await pool.query(
      `INSERT INTO marketplace_installations (user_id, marketplace_id, agent_id)
       VALUES ($1,$2,$3)
       ON CONFLICT (user_id, marketplace_id) DO UPDATE SET agent_id=$3`,
      [req.userId, template.id, agentId]
    );

    // Install-Count erhöhen
    await pool.query(
      'UPDATE marketplace_agents SET install_count=install_count+1 WHERE id=$1',
      [template.id]
    );

    res.status(201).json({ success: true, agentId, agentName: agentName || template.name });
  } catch (e) {
    console.error('INSTALL AGENT:', e.message);
    safeErr(res, e, 500);
  }
});

// ── POST /api/marketplace/:id/rate  — Bewerten ───────────────────────────────
router.post('/:id/rate', auth, async (req, res) => {
  const pool = getPool(req);
  const { rating, review } = req.body;
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating 1-5 erforderlich' });

  try {
    if (!await tableExists(pool, 'marketplace_agents')) return res.json({ agents: [], categories: [] });
    await pool.query(
      `INSERT INTO marketplace_ratings (user_id, marketplace_id, rating, review)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, marketplace_id) DO UPDATE SET rating=$3, review=$4`,
      [req.userId, req.params.id, rating, review || '']
    );

    // Durchschnitt aktualisieren
    await pool.query(
      `UPDATE marketplace_agents SET
         rating_avg  = (SELECT AVG(rating) FROM marketplace_ratings WHERE marketplace_id=$1),
         rating_count= (SELECT COUNT(*)   FROM marketplace_ratings WHERE marketplace_id=$1)
       WHERE id=$1`,
      [req.params.id]
    );
    res.json({ success: true });
  } catch (e) {
    res.json({ agents: [], categories: [] });
  }
});

// ── GET /api/marketplace/my/installs  — Meine installierten Agenten ──────────
router.get('/my/installs', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    if (!await tableExists(pool, 'marketplace_installations')) return res.json({ installs: [] });
    if (!await tableExists(pool, 'marketplace_agents')) return res.json({ agents: [], categories: [] });
    const r = await pool.query(
      `SELECT mi.*, ma.name AS template_name, ma.emoji, ma.tagline, ma.category_slug,
         a.name AS agent_name, a.is_active
       FROM marketplace_installations mi
       JOIN marketplace_agents ma ON ma.id = mi.marketplace_id
       LEFT JOIN agents a ON a.id = mi.agent_id
       WHERE mi.user_id=$1
       ORDER BY mi.installed_at DESC`,
      [req.userId]
    );
    res.json({ installations: r.rows });
  } catch (e) {
    res.json({ agents: [], categories: [] });
  }
});

module.exports = router;
