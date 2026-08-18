'use strict';
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { getPool } = require('../utils/db');

// Identitäts-Einstellungen (Visitenkarte, Avatar, etc.)
router.get('/', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query(
      'SELECT * FROM users WHERE id=$1', [req.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });
    const u = r.rows[0];
    res.json({
      name: u.name, email: u.email,
      avatar_url: u.avatar_url || null,
      company: u.company || '',
      website: u.website || '',
      bio: u.bio || '',
    });
  } catch (e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

router.put('/', auth, async (req, res) => {
  const pool = getPool(req);
  const { name, company, website, bio } = req.body;
  try {
    await pool.query(
      'UPDATE users SET name=$1 WHERE id=$2',
      [name || '', req.userId]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

module.exports = router;
