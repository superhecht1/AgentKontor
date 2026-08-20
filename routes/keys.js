/**
 * AgentKontor — API Keys
 * FIX 5: Keys als SHA-256-Hash gespeichert — Plaintext nur einmalig angezeigt
 *
 * GET    /api/keys        — list keys (never returns full key)
 * POST   /api/keys        — create key (returns full key ONCE)
 * DELETE /api/keys/:id    — delete key
 */

const router = require('express').Router();
const auth   = require('../middleware/auth');
const crypto = require('crypto');

function getPool(req) { return req.app.locals.pool; }

// FIX 5: Hash key for storage
function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

async function ensureHashColumn(pool) {
  await pool.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_hash VARCHAR(64)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash) WHERE key_hash IS NOT NULL`);
}

/* ── LIST KEYS ─────────────────────────────────────────── */
router.get('/', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    if (!await tableExists(pool, 'api_keys')) return res.json({ keys: [] });
    const r = await pool.query(
      `SELECT k.id, k.label, k.key_prefix, k.is_active, k.last_used, k.created_at,
              a.name AS agent_name
       FROM api_keys k
       LEFT JOIN agents a ON k.agent_id=a.id
       WHERE k.user_id=$1
       ORDER BY k.created_at DESC`,
      [req.userId]
    );
    // Never return key_hash or full key
    res.json({ keys: r.rows });
  } catch(e) {
    res.json({ keys: [], error: 'Fehler' });
  }
});

/* ── CREATE KEY ────────────────────────────────────────── */
router.post('/', auth, async (req, res) => {
  const pool = getPool(req);
  const { label, agentId } = req.body;
  if (!label) return res.status(400).json({ error: 'Bezeichnung erforderlich' });

  try {
    if (!await tableExists(pool, 'api_keys')) return res.status(503).json({ error: 'Tabelle noch nicht bereit' });
    await ensureHashColumn(pool);

    // Check plan
    const user = await pool.query('SELECT plan FROM users WHERE id=$1', [req.userId]);
    const { requirePlan } = require('../middleware/plan-gate');
    // API keys only for pro users
    if (user.rows[0]?.plan === 'free')
      return res.status(403).json({ error: 'API-Keys erfordern den Pro-Plan', upgrade: true });

    // Verify agent ownership if agentId provided
    if (agentId) {
      const a = await pool.query('SELECT id FROM agents WHERE id=$1 AND user_id=$2', [agentId, req.userId]);
      if (!a.rows.length) return res.status(403).json({ error: 'Agent nicht gefunden' });
    }

    // Generate key
    const rawKey    = 'ak_live_' + crypto.randomBytes(32).toString('hex');
    const keyPrefix = rawKey.slice(0, 16); // ak_live_xxxxxxxx
    const keyHash   = hashKey(rawKey);     // FIX 5: store hash only

    await pool.query(
      `INSERT INTO api_keys (user_id, agent_id, label, key_prefix, key_hash, is_active)
       VALUES ($1,$2,$3,$4,$5,true)`,
      [req.userId, agentId || null, label, keyPrefix, keyHash]
    );

    // Return full key ONCE — never stored in plaintext
    res.json({
      key: rawKey,
      prefix: keyPrefix,
      notice: 'Dieser Key wird nur einmal angezeigt. Bitte jetzt kopieren und sicher aufbewahren.',
    });
  } catch(e) {
    console.error('CREATE KEY:', e.message);
    res.status(500).json({ error: 'Fehler beim Erstellen' });
  }
});

/* ── DELETE KEY ────────────────────────────────────────── */
router.delete('/:id', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query(
      'DELETE FROM api_keys WHERE id=$1 AND user_id=$2 RETURNING id',
      [req.params.id, req.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Key nicht gefunden' });
    res.json({ success: true });
  } catch(e) {
    res.json({ keys: [], error: 'Fehler' });
  }
});

/* ── VERIFY KEY (used by chat.js) ──────────────────────── */
// Exported helper — verifies key by hash, returns user+agent info
async function verifyApiKey(pool, rawKey, agentId) {
  const keyHash = hashKey(rawKey);
  const r = await pool.query(
    `SELECT k.user_id, k.agent_id, k.is_active,
            u.plan, u.msg_count_month, u.msg_count_reset,
            a.id AS a_id, a.name AS a_name, a.system_prompt,
            a.greeting, a.tone, a.language, a.quick_chips,
            a.is_active AS a_active, a.api_enabled,
            a.rag_enabled, a.rag_prompt,
            a.cap_calendar, a.cal_link, a.cap_leads, a.lead_fields, a.lead_email,
            a.cap_products, a.products_data, a.cap_multilang, a.cap_email,
            a.smtp_host, a.smtp_port, a.smtp_user, a.smtp_pass, a.smtp_from,
            a.model, a.color, a.emoji,
            u.email AS owner_email
     FROM api_keys k
     JOIN users u ON k.user_id=u.id
     JOIN agents a ON a.id=$2 AND a.user_id=k.user_id
     WHERE k.key_hash=$1 AND k.is_active=true AND u.deleted_at IS NULL`,
    [keyHash, agentId]
  );
  return r.rows[0] || null;
}

module.exports = router;
module.exports.verifyApiKey = verifyApiKey;
