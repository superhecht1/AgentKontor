'use strict';
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { getPool } = require('../utils/db');

// Dokument-Upload + Suche (RAG)
router.get('/documents', auth, async (req, res) => {
  const pool = getPool(req);
  const { agentId } = req.query;
  try {
    const r = await pool.query(
      'SELECT id, filename, file_size, chunk_count, created_at FROM agent_documents WHERE agent_id=$1 ORDER BY created_at DESC',
      [agentId]
    );
    res.json({ documents: r.rows });
  } catch {
    res.json({ documents: [] });
  }
});

router.delete('/documents/:id', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    await pool.query('DELETE FROM agent_documents WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Fehler' });
  }
});

module.exports = router;
