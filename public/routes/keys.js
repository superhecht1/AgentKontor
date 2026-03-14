const router = require('express').Router();
const auth = require('../middleware/auth');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

function getPool(req) { return req.app.locals.pool; }

function generateApiKey() {
  const raw = 'ak_live_' + crypto.randomBytes(24).toString('hex');
  return raw;
}

// GET /api/keys — list keys
router.get('/', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const result = await pool.query(
      `SELECT k.id, k.key_prefix, k.label, k.is_active, k.last_used, k.created_at, a.name as agent_name
       FROM api_keys k LEFT JOIN agents a ON k.agent_id = a.id
       WHERE k.user_id=$1 ORDER BY k.created_at DESC`,
      [req.userId]
    );
    res.json({ keys: result.rows });
  } catch (e) {
    res.status(500).json({ error: 'Fehler beim Laden' });
  }
});

// POST /api/keys — create key
router.post('/', auth, async (req, res) => {
  const pool = getPool(req);
  const { agentId, label = 'API Key' } = req.body;

  // Verify agent ownership
  if (agentId) {
    const check = await pool.query('SELECT id FROM agents WHERE id=$1 AND user_id=$2', [agentId, req.userId]);
    if (!check.rows.length) return res.status(403).json({ error: 'Agent nicht gefunden' });
  }

  const rawKey = generateApiKey();
  const hash = await bcrypt.hash(rawKey, 10);
  const prefix = rawKey.slice(0, 12);

  try {
    await pool.query(
      'INSERT INTO api_keys (user_id, agent_id, key_hash, key_prefix, label) VALUES ($1,$2,$3,$4,$5)',
      [req.userId, agentId || null, hash, prefix, label]
    );
    // Only show raw key ONCE
    res.json({ key: rawKey, prefix, label, message: 'Speichere diesen Key jetzt — er wird nur einmal angezeigt!' });
  } catch (e) {
    res.status(500).json({ error: 'Key konnte nicht erstellt werden' });
  }
});

// DELETE /api/keys/:id
router.delete('/:id', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    await pool.query('DELETE FROM api_keys WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Löschen fehlgeschlagen' });
  }
});

module.exports = router;
