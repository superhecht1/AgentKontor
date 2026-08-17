'use strict';
const express = require('express');
const router  = express.Router();
const auth = require('../middleware/auth');
const { getPool } = require('../utils/db');
const { callLLM } = require('../utils/llm');
const webAgent = require('../utils/web-agent');

// ── POST /api/web/search  — Websuche ─────────────────────────────────────────
router.post('/search', auth, async (req, res) => {
  const pool = getPool(req);
  const { query, maxResults = 10, provider } = req.body;
  if (!query) return res.status(400).json({ error: 'query erforderlich' });
  try {
    const results = await webAgent.search(pool, { query, maxResults, provider });
    res.json({ results, count: results.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── POST /api/web/scrape  — Webseite lesen ────────────────────────────────────
router.post('/scrape', auth, async (req, res) => {
  const pool = getPool(req);
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url erforderlich' });
  try {
    const result = await webAgent.scrape(pool, url);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── POST /api/web/compare  — Quellen vergleichen ──────────────────────────────
router.post('/compare', auth, async (req, res) => {
  const pool = getPool(req);
  const { urls, goal, columns } = req.body;
  if (!urls?.length || !goal) return res.status(400).json({ error: 'urls und goal erforderlich' });

  try {
    // Seiten scrapen
    const contents = [];
    for (const url of urls.slice(0, 8)) {
      try {
        const c = await webAgent.scrape(pool, url);
        contents.push(c);
      } catch (e) {
        contents.push({ url, title: url, content: '', error: e.message });
      }
    }
    const result = await webAgent.compareResults(contents, { goal, columns }, callLLM);
    res.json({ result, sources: contents.map(c => ({ url: c.url, title: c.title })) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── POST /api/web/research  — Mehrstufige Recherche starten ──────────────────
router.post('/research', auth, async (req, res) => {
  const pool = getPool(req);
  const { goal, depth = 3, agentId, model } = req.body;
  if (!goal) return res.status(400).json({ error: 'goal erforderlich' });

  // Session anlegen
  const sessionRow = await pool.query(
    `INSERT INTO research_sessions (user_id, agent_id, goal, model, status)
     VALUES ($1,$2,$3,$4,'running') RETURNING id`,
    [req.userId, agentId||null, goal, model||'claude-sonnet-4-6']
  );
  const sessionId = sessionRow.rows[0].id;

  // Antwort sofort mit Session-ID — Recherche läuft asynchron
  res.status(202).json({ sessionId, status: 'running', message: 'Recherche gestartet' });

  // Asynchron ausführen
  setImmediate(async () => {
    const llm = (model, sys, msgs) => callLLM(model || 'claude-sonnet-4-6', sys, msgs);
    try {
      await webAgent.research(pool, sessionId, { goal, depth, callLLM: llm });
    } catch (e) {
      await pool.query(
        "UPDATE research_sessions SET status='failed', result=$1, updated_at=now() WHERE id=$2",
        [e.message, sessionId]
      ).catch(() => {});
    }
  });
});

// ── GET /api/web/research/:id  — Recherche-Status ─────────────────────────────
router.get('/research/:id', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query(
      'SELECT * FROM research_sessions WHERE id=$1 AND user_id=$2',
      [req.params.id, req.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });
    const session = r.rows[0];
    res.json({
      id: session.id,
      status: session.status,
      goal: session.goal,
      result: session.result,
      table: session.result_table,
      sources: session.sources,
      steps: session.steps,
      updated_at: session.updated_at,
    });
  } catch (e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// ── GET /api/web/research  — Alle Recherchen des Users ────────────────────────
router.get('/research', auth, async (req, res) => {
  const pool = getPool(req);
  const { limit = 20 } = req.query;
  try {
    const r = await pool.query(
      `SELECT id, goal, status, created_at, updated_at,
         length(result::text) as result_length,
         jsonb_array_length(COALESCE(sources,'[]'::jsonb)) as source_count
       FROM research_sessions
       WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`,
      [req.userId, parseInt(limit)]
    );
    res.json({ sessions: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// ── DELETE /api/web/research/:id ──────────────────────────────────────────────
router.delete('/research/:id', auth, async (req, res) => {
  const pool = getPool(req);
  await pool.query('DELETE FROM research_sessions WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
  res.json({ success: true });
});

module.exports = router;
