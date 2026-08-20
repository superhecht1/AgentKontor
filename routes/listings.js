'use strict';
/**
 * routes/listings.js
 * Agent Marketplace — Nutzer können eigene Agenten veröffentlichen und vermieten.
 *
 * GET    /listings                  — Öffentliche Community-Listings browsen
 * POST   /listings                  — Neues Listing erstellen (aus eigenem Agent)
 * GET    /listings/my               — Eigene Listings verwalten
 * GET    /listings/purchased        — Gekaufte/installierte Listings
 * GET    /listings/earnings         — Einnahmen-Übersicht
 * GET    /listings/:id              — Listing-Detail (öffentlich)
 * PUT    /listings/:id              — Listing bearbeiten
 * POST   /listings/:id/submit       — Zur Freigabe einreichen
 * POST   /listings/:id/pause        — Listing pausieren
 * POST   /listings/:id/purchase     — Agent kaufen/abonnieren
 * POST   /listings/:id/review       — Bewertung abgeben
 * DELETE /listings/:id              — Listing löschen
 * GET    /listings/admin/pending    — Admin: wartende Listings (adminOnly)
 * POST   /listings/admin/:id/approve — Admin: freigeben
 * POST   /listings/admin/:id/reject  — Admin: ablehnen
 */

const express   = require('express');
const router    = express.Router();
const auth      = require('../middleware/auth');
const { getPool } = require('../utils/db');

const COMMISSION = 20; // 20% Provision

async function tableExists(pool, table) {
  try { await pool.query(`SELECT 1 FROM ${table} LIMIT 1`); return true; }
  catch { return false; }
}

// ── ÖFFENTLICHES BROWSEN ──────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const pool = getPool(req);
  const { category, sort = 'popular', q, limit = 24, offset = 0 } = req.query;
  try {
    if (!await tableExists(pool, 'agent_listings')) return res.json({ listings: [], total: 0 });

    const conditions = ["l.status='active'"];
    const params = [];
    let i = 1;
    if (category && category !== 'all') { conditions.push(`l.category=$${i++}`); params.push(category); }
    if (q) { conditions.push(`(l.title ILIKE $${i} OR l.tagline ILIKE $${i} OR l.tags @> ARRAY[$${i+1}])`); params.push(`%${q}%`); params.push(q); i += 2; }

    const orderBy = {
      popular:  'l.install_count DESC, l.rating_avg DESC',
      newest:   'l.approved_at DESC',
      rating:   'l.rating_avg DESC, l.rating_count DESC',
      price_asc:'l.price_cents ASC',
    }[sort] || 'l.install_count DESC';

    params.push(parseInt(limit)||24, parseInt(offset)||0);
    const where = 'WHERE ' + conditions.join(' AND ');

    const [rows, total] = await Promise.all([
      pool.query(`
        SELECT l.id, l.title, l.tagline, l.emoji, l.color, l.category, l.tags,
               l.price_model, l.price_cents, l.install_count, l.rating_avg, l.rating_count,
               l.preview_msgs, l.quick_chips, l.approved_at,
               u.name AS seller_name, u.id AS seller_id
        FROM agent_listings l
        JOIN users u ON u.id = l.user_id
        ${where}
        ORDER BY ${orderBy}
        LIMIT $${i} OFFSET $${i+1}
      `, params),
      pool.query(`SELECT COUNT(*) FROM agent_listings l ${where}`, params.slice(0,-2))
    ]);
    res.json({ listings: rows.rows, total: parseInt(total.rows[0].count) });
  } catch(e) {
    console.error('LISTINGS:', e.message);
    res.json({ listings: [], total: 0 });
  }
});

// ── MEINE LISTINGS ────────────────────────────────────────────────────────────
router.get('/my', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    if (!await tableExists(pool, 'agent_listings')) return res.json({ listings: [] });
    const r = await pool.query(`
      SELECT l.*, a.name AS agent_name, a.emoji AS agent_emoji,
             (SELECT COUNT(*) FROM listing_purchases p WHERE p.listing_id=l.id AND p.status='active') AS active_buyers
      FROM agent_listings l
      JOIN agents a ON a.id = l.agent_id
      WHERE l.user_id=$1
      ORDER BY l.created_at DESC
    `, [req.userId]);
    res.json({ listings: r.rows });
  } catch(e) { res.json({ listings: [] }); }
});

// ── GEKAUFTE LISTINGS ─────────────────────────────────────────────────────────
router.get('/purchased', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    if (!await tableExists(pool, 'listing_purchases')) return res.json({ purchases: [] });
    const r = await pool.query(`
      SELECT p.*, l.title, l.emoji, l.tagline, l.price_model, l.price_cents,
             a.id AS installed_agent_id, a.name AS installed_agent_name
      FROM listing_purchases p
      JOIN agent_listings l ON l.id = p.listing_id
      LEFT JOIN agents a ON a.id = p.agent_id
      WHERE p.buyer_id=$1 AND p.status='active'
      ORDER BY p.purchased_at DESC
    `, [req.userId]);
    res.json({ purchases: r.rows });
  } catch(e) { res.json({ purchases: [] }); }
});

// ── EINNAHMEN ─────────────────────────────────────────────────────────────────
router.get('/earnings', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    if (!await tableExists(pool, 'listing_purchases')) return res.json({ earnings: { total:0, this_month:0, pending:0, listings:[] } });

    const [total, monthly, byListing] = await Promise.all([
      pool.query(`
        SELECT COALESCE(SUM(price_cents * (1 - platform_fee_pct/100.0)), 0) AS net
        FROM listing_purchases WHERE seller_id=$1 AND status='active'
      `, [req.userId]),
      pool.query(`
        SELECT COALESCE(SUM(price_cents * (1 - platform_fee_pct/100.0)), 0) AS net
        FROM listing_purchases
        WHERE seller_id=$1 AND status='active'
          AND DATE_TRUNC('month',purchased_at)=DATE_TRUNC('month',NOW())
      `, [req.userId]),
      pool.query(`
        SELECT l.id, l.title, l.emoji, l.price_cents, l.price_model,
               COUNT(p.id) AS buyer_count,
               COALESCE(SUM(p.price_cents * (1-p.platform_fee_pct/100.0)),0) AS net_revenue
        FROM agent_listings l
        LEFT JOIN listing_purchases p ON p.listing_id=l.id AND p.status='active'
        WHERE l.user_id=$1
        GROUP BY l.id ORDER BY net_revenue DESC
      `, [req.userId]),
    ]);

    res.json({
      earnings: {
        total_cents:       parseInt(total.rows[0].net)   || 0,
        this_month_cents:  parseInt(monthly.rows[0].net) || 0,
        commission_pct:    COMMISSION,
        listings:          byListing.rows,
      }
    });
  } catch(e) { res.json({ earnings: { total_cents:0, this_month_cents:0, listings:[] } }); }
});

// ── LISTING DETAIL ────────────────────────────────────────────────────────────
router.get('/:id(\\d+)', async (req, res) => {
  const pool = getPool(req);
  try {
    if (!await tableExists(pool, 'agent_listings')) return res.status(404).json({ error: 'Nicht gefunden' });

    const [listing, reviews] = await Promise.all([
      pool.query(`
        SELECT l.*, u.name AS seller_name, u.id AS seller_id,
               (SELECT COUNT(*) FROM agent_listings l2 WHERE l2.user_id=l.user_id AND l2.status='active') AS seller_listing_count
        FROM agent_listings l
        JOIN users u ON u.id=l.user_id
        WHERE l.id=$1 AND l.status='active'
      `, [parseInt(req.params.id)]),
      pool.query(`
        SELECT r.rating, r.review_text, r.created_at, u.name AS reviewer_name
        FROM listing_reviews r
        JOIN users u ON u.id=r.user_id
        WHERE r.listing_id=$1
        ORDER BY r.created_at DESC LIMIT 20
      `, [parseInt(req.params.id)]),
    ]);

    if (!listing.rows.length) return res.status(404).json({ error: 'Listing nicht gefunden oder nicht aktiv' });
    const l = listing.rows[0];
    // Prompt verbergen wenn hide_prompt=true
    if (l.hide_prompt) delete l.agent_id;
    res.json({ listing: l, reviews: reviews.rows });
  } catch(e) { res.status(500).json({ error: 'Fehler' }); }
});

// ── LISTING ERSTELLEN ─────────────────────────────────────────────────────────
router.post('/', auth, async (req, res) => {
  const pool = getPool(req);
  const { agentId, title, tagline, description, category, tags,
          priceModel, priceCents, hidePrompt, previewMsgs, quickChips, color } = req.body;

  if (!agentId || !title?.trim() || !tagline?.trim() || !description?.trim())
    return res.status(400).json({ error: 'Agent, Titel, Tagline und Beschreibung erforderlich' });
  if (!['free','onetime','monthly'].includes(priceModel))
    return res.status(400).json({ error: 'Ungültiges Preismodell' });

  try {
    if (!await tableExists(pool, 'agent_listings')) return res.status(503).json({ error: 'Service nicht bereit' });

    // Agent gehört dem User?
    const agent = await pool.query(
      'SELECT id, name, emoji FROM agents WHERE id=$1 AND user_id=$2',
      [agentId, req.userId]
    );
    if (!agent.rows.length) return res.status(403).json({ error: 'Agent nicht gefunden' });

    // Bereits ein Listing für diesen Agent?
    const existing = await pool.query(
      'SELECT id FROM agent_listings WHERE agent_id=$1', [agentId]
    );
    if (existing.rows.length)
      return res.status(409).json({ error: 'Für diesen Agenten existiert bereits ein Listing', listingId: existing.rows[0].id });

    const r = await pool.query(`
      INSERT INTO agent_listings
        (agent_id, user_id, title, tagline, description, category, tags,
         emoji, color, price_model, price_cents, hide_prompt, preview_msgs, quick_chips)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING *
    `, [
      agentId, req.userId,
      title.trim().slice(0,100), tagline.trim().slice(0,200), description.trim().slice(0,2000),
      category || 'sonstiges', tags || [],
      agent.rows[0].emoji || '🤖', color || '#7c3aed',
      priceModel, Math.max(0, parseInt(priceCents)||0),
      hidePrompt !== false, previewMsgs || [], quickChips || [],
    ]);

    // Agent als gelistet markieren
    await pool.query('UPDATE agents SET listing_id=$1, is_listed=true WHERE id=$2', [r.rows[0].id, agentId]);

    res.status(201).json({ listing: r.rows[0] });
  } catch(e) {
    console.error('CREATE LISTING:', e.message);
    res.status(500).json({ error: 'Fehler beim Erstellen' });
  }
});

// ── LISTING BEARBEITEN ────────────────────────────────────────────────────────
router.put('/:id', auth, async (req, res) => {
  const pool = getPool(req);
  const { title, tagline, description, category, tags,
          priceModel, priceCents, hidePrompt, previewMsgs, quickChips, color } = req.body;
  try {
    const r = await pool.query(`
      UPDATE agent_listings SET
        title=$1, tagline=$2, description=$3, category=$4, tags=$5,
        price_model=$6, price_cents=$7, hide_prompt=$8,
        preview_msgs=$9, quick_chips=$10, color=$11,
        updated_at=now(),
        status=CASE WHEN status='active' THEN 'pending' ELSE status END
      WHERE id=$12 AND user_id=$13 AND status NOT IN ('draft')
      RETURNING *
    `, [
      title?.trim(), tagline?.trim(), description?.trim(),
      category, tags || [],
      priceModel, Math.max(0, parseInt(priceCents)||0),
      hidePrompt !== false, previewMsgs || [], quickChips || [],
      color || '#7c3aed',
      req.params.id, req.userId,
    ]);
    if (!r.rows.length) return res.status(404).json({ error: 'Nicht gefunden oder keine Berechtigung' });
    res.json({ listing: r.rows[0] });
  } catch(e) { res.status(500).json({ error: 'Fehler' }); }
});

// ── ZUR FREIGABE EINREICHEN ───────────────────────────────────────────────────
router.post('/:id/submit', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query(`
      UPDATE agent_listings SET status='pending', submitted_at=now()
      WHERE id=$1 AND user_id=$2 AND status IN ('draft','rejected')
      RETURNING id, title, status
    `, [req.params.id, req.userId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Nicht gefunden oder falscher Status' });
    res.json({ success: true, listing: r.rows[0] });
  } catch(e) { res.status(500).json({ error: 'Fehler' }); }
});

// ── LISTING PAUSIEREN ─────────────────────────────────────────────────────────
router.post('/:id/pause', auth, async (req, res) => {
  const pool = getPool(req);
  const { pause } = req.body;
  const newStatus = pause ? 'paused' : 'active';
  const r = await pool.query(
    `UPDATE agent_listings SET status=$1 WHERE id=$2 AND user_id=$3 AND status IN ('active','paused') RETURNING id`,
    [newStatus, req.params.id, req.userId]
  ).catch(() => ({ rows: [] }));
  if (!r.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });
  res.json({ success: true, status: newStatus });
});

// ── LISTING LÖSCHEN ───────────────────────────────────────────────────────────
router.delete('/:id', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const listing = await pool.query(
      'SELECT id, agent_id FROM agent_listings WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]
    );
    if (!listing.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });

    // Aktive Käufer? Nur pausieren, nicht löschen
    const buyers = await pool.query(
      "SELECT COUNT(*) FROM listing_purchases WHERE listing_id=$1 AND status='active'", [parseInt(req.params.id)]
    ).catch(() => ({ rows: [{ count: 0 }] }));

    if (parseInt(buyers.rows[0].count) > 0)
      return res.status(409).json({ error: 'Aktive Abonnenten vorhanden. Bitte erst pausieren.' });

    await pool.query('DELETE FROM agent_listings WHERE id=$1', [parseInt(req.params.id)]);
    await pool.query('UPDATE agents SET listing_id=NULL, is_listed=false WHERE id=$1', [listing.rows[0].agent_id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Fehler' }); }
});

// ── KAUFEN / INSTALLIEREN ─────────────────────────────────────────────────────
router.post('/:id/purchase', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    if (!await tableExists(pool, 'listing_purchases')) return res.status(503).json({ error: 'Service nicht bereit' });

    const listing = await pool.query(
      "SELECT * FROM agent_listings WHERE id=$1 AND status='active'", [parseInt(req.params.id)]
    );
    if (!listing.rows.length) return res.status(404).json({ error: 'Listing nicht gefunden' });
    const l = listing.rows[0];

    if (l.user_id === req.userId)
      return res.status(400).json({ error: 'Du kannst deinen eigenen Agenten nicht kaufen' });

    // Bereits gekauft?
    const existing = await pool.query(
      "SELECT id FROM listing_purchases WHERE listing_id=$1 AND buyer_id=$2 AND status='active'",
      [req.params.id, req.userId]
    ).catch(() => ({ rows: [] }));
    if (existing.rows.length)
      return res.status(409).json({ error: 'Bereits installiert', purchaseId: existing.rows[0].id });

    // Kostenlos: sofort installieren
    if (l.price_cents === 0 || l.price_model === 'free') {
      const newAgent = await installAgent(pool, l, req.userId);
      const purchase = await pool.query(`
        INSERT INTO listing_purchases (listing_id, buyer_id, seller_id, agent_id, price_cents, status)
        VALUES ($1,$2,$3,$4,0,'active') RETURNING *
      `, [l.id, req.userId, l.user_id, newAgent.id]);
      await pool.query('UPDATE agent_listings SET install_count=install_count+1 WHERE id=$1', [l.id]);
      return res.json({ success: true, agentId: newAgent.id, purchase: purchase.rows[0] });
    }

    // Bezahlt: Stripe Checkout erstellen
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    if (!stripe) return res.status(503).json({ error: 'Stripe nicht konfiguriert' });

    const baseUrl = process.env.BASE_URL || `https://${req.get('host')}`;

    if (l.price_model === 'monthly') {
      // Abo
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: 'eur',
            product_data: { name: l.title, description: l.tagline },
            unit_amount: l.price_cents,
            recurring: { interval: 'month' },
          },
          quantity: 1,
        }],
        metadata: { listing_id: l.id, buyer_id: req.userId, seller_id: l.user_id },
        success_url: `${baseUrl}/app.html?listing_purchased=${l.id}`,
        cancel_url:  `${baseUrl}/app.html#marketplace`,
      });
      return res.json({ checkoutUrl: session.url });
    } else {
      // Einmalzahlung
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: 'eur',
            product_data: { name: l.title, description: l.tagline },
            unit_amount: l.price_cents,
          },
          quantity: 1,
        }],
        metadata: { listing_id: l.id, buyer_id: req.userId, seller_id: l.user_id },
        success_url: `${baseUrl}/app.html?listing_purchased=${l.id}`,
        cancel_url:  `${baseUrl}/app.html#marketplace`,
      });
      return res.json({ checkoutUrl: session.url });
    }
  } catch(e) {
    console.error('PURCHASE:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Hilfsfunktion: Agent kopieren
async function installAgent(pool, listing, buyerId) {
  // Originalen Agent laden (ohne System-Prompt wenn hide_prompt=true)
  const orig = await pool.query('SELECT * FROM agents WHERE id=$1', [listing.agent_id]);
  if (!orig.rows.length) throw new Error('Original-Agent nicht gefunden');
  const a = orig.rows[0];

  const r = await pool.query(`
    INSERT INTO agents (user_id, name, emoji, description, color,
      system_prompt, greeting, tone, language, quick_chips,
      is_active, model, cap_leads, cap_email)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11,$12,$13)
    RETURNING id
  `, [
    buyerId,
    a.name, a.emoji, a.description || listing.tagline, a.color,
    listing.hide_prompt ? `# ${a.name}\n\n${listing.description}\n\n[System-Prompt vom Anbieter geschützt]` : a.system_prompt,
    a.greeting || listing.preview_msgs?.[0]?.content || `Hallo! Ich bin ${a.name}. Wie kann ich helfen?`,
    a.tone || 'freundlich', a.language || 'de',
    JSON.stringify(listing.quick_chips || []),
    a.model || 'claude-sonnet-4-6',
    a.cap_leads || false, a.cap_email || false,
  ]);
  return r.rows[0];
}

// ── BEWERTUNG ─────────────────────────────────────────────────────────────────
router.post('/:id/review', auth, async (req, res) => {
  const pool = getPool(req);
  const { rating, reviewText } = req.body;
  if (!rating || rating < 1 || rating > 5)
    return res.status(400).json({ error: 'Bewertung zwischen 1 und 5 erforderlich' });

  try {
    // Hat der User gekauft?
    const purchased = await pool.query(
      "SELECT id FROM listing_purchases WHERE listing_id=$1 AND buyer_id=$2 AND status='active'",
      [req.params.id, req.userId]
    ).catch(() => ({ rows: [] }));
    if (!purchased.rows.length)
      return res.status(403).json({ error: 'Nur Käufer können bewerten' });

    await pool.query(`
      INSERT INTO listing_reviews (listing_id, user_id, rating, review_text)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (listing_id, user_id) DO UPDATE SET rating=$3, review_text=$4
    `, [req.params.id, req.userId, rating, reviewText?.trim().slice(0,500)]);

    // Durchschnitt neu berechnen
    const avg = await pool.query(
      'SELECT AVG(rating) AS avg, COUNT(*) AS cnt FROM listing_reviews WHERE listing_id=$1',
      [parseInt(req.params.id)]
    );
    await pool.query(
      'UPDATE agent_listings SET rating_avg=$1, rating_count=$2 WHERE id=$3',
      [parseFloat(avg.rows[0].avg).toFixed(1), avg.rows[0].cnt, req.params.id]
    );

    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Fehler' }); }
});

// ── ADMIN: AUSSTEHENDE LISTINGS ───────────────────────────────────────────────
router.get('/admin/pending', auth, async (req, res) => {
  const pool = getPool(req);
  const user = await pool.query('SELECT is_admin FROM users WHERE id=$1', [req.userId]).catch(()=>({rows:[{}]}));
  if (!user.rows[0]?.is_admin) return res.status(403).json({ error: 'Nur Admins' });
  try {
    const r = await pool.query(`
      SELECT l.*, u.email AS seller_email, u.name AS seller_name, a.name AS agent_name
      FROM agent_listings l
      JOIN users u ON u.id=l.user_id
      JOIN agents a ON a.id=l.agent_id
      WHERE l.status='pending'
      ORDER BY l.submitted_at ASC
    `).catch(() => ({ rows: [] }));
    res.json({ listings: r.rows });
  } catch(e) { res.json({ listings: [] }); }
});

// ── ADMIN: FREIGEBEN ──────────────────────────────────────────────────────────
router.post('/admin/:id/approve', auth, async (req, res) => {
  const pool = getPool(req);
  const user = await pool.query('SELECT is_admin FROM users WHERE id=$1', [req.userId]).catch(()=>({rows:[{}]}));
  if (!user.rows[0]?.is_admin) return res.status(403).json({ error: 'Nur Admins' });
  await pool.query(
    "UPDATE agent_listings SET status='active', approved_at=now(), reject_reason=NULL WHERE id=$1",
    [parseInt(req.params.id)]
  ).catch(() => {});
  res.json({ success: true });
});

// ── ADMIN: ABLEHNEN ───────────────────────────────────────────────────────────
router.post('/admin/:id/reject', auth, async (req, res) => {
  const pool = getPool(req);
  const user = await pool.query('SELECT is_admin FROM users WHERE id=$1', [req.userId]).catch(()=>({rows:[{}]}));
  if (!user.rows[0]?.is_admin) return res.status(403).json({ error: 'Nur Admins' });
  const { reason } = req.body;
  await pool.query(
    "UPDATE agent_listings SET status='rejected', reject_reason=$1 WHERE id=$2",
    [reason || 'Kein Grund angegeben', req.params.id]
  ).catch(() => {});
  res.json({ success: true });
});

module.exports = router;
