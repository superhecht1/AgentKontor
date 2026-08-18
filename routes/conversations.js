/**
 * AgentKontor — Conversation History + CSV Exports
 *
 * GET /api/conversations/:agentId              — list sessions
 * GET /api/conversations/:agentId/:sessionId   — messages in session
 * GET /api/conversations/:agentId/export/csv   — full CSV export
 * GET /api/conversations/:agentId/leads/csv    — leads CSV
 */

const router = require('express').Router();
const auth   = require('../middleware/auth');

function getPool(req) { return req.app.locals.pool; }

async function verifyOwner(pool, agentId, userId) {
  const r = await pool.query('SELECT id FROM agents WHERE id=$1 AND user_id=$2', [agentId, userId]);
  return r.rows.length > 0;
}

/* ── LIST SESSIONS ─────────────────────────────────────────── */
router.get('/:agentId', auth, async (req, res) => {
  const pool = getPool(req);
  if (!(await verifyOwner(pool, req.params.agentId, req.userId)))
    return res.status(403).json({ error: 'Nicht berechtigt' });

  const { channel, limit = 50, offset = 0 } = req.query;
  try {
    let q = `
      SELECT session_id, source,
        MIN(created_at) AS started_at,
        MAX(created_at) AS last_msg_at,
        COUNT(*) FILTER (WHERE role='user')      AS user_msgs,
        COUNT(*) FILTER (WHERE role='assistant') AS bot_msgs,
        COUNT(*)                                  AS total_msgs
      FROM chat_messages
      WHERE agent_id=$1
    `;
    const params = [req.params.agentId];
    if (channel) { q += ` AND source=$${params.length+1}`; params.push(channel); }
    q += ` GROUP BY session_id, source ORDER BY last_msg_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`;
    params.push(parseInt(limit), parseInt(offset));

    const r = await pool.query(q, params);

    // Total count
    const ct = await pool.query('SELECT COUNT(DISTINCT session_id) FROM chat_messages WHERE agent_id=$1', [req.params.agentId]);

    res.json({ sessions: r.rows, total: parseInt(ct.rows[0].count) });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: 'Fehler' });
  }
});

/* ── MESSAGES IN SESSION ───────────────────────────────────── */
router.get('/:agentId/:sessionId', auth, async (req, res) => {
  const pool = getPool(req);
  if (!(await verifyOwner(pool, req.params.agentId, req.userId)))
    return res.status(403).json({ error: 'Nicht berechtigt' });

  try {
    const r = await pool.query(
      'SELECT id, role, content, source, created_at FROM chat_messages WHERE agent_id=$1 AND session_id=$2 ORDER BY created_at ASC',
      [req.params.agentId, req.params.sessionId]
    );
    res.json({ messages: r.rows });
  } catch(e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

/* ── EXPORT: ALL CONVERSATIONS AS CSV ──────────────────────── */
router.get('/:agentId/export/csv', auth, async (req, res) => {
  const pool = getPool(req);
  if (!(await verifyOwner(pool, req.params.agentId, req.userId)))
    return res.status(403).json({ error: 'Nicht berechtigt' });

  try {
    const agent = await pool.query('SELECT name FROM agents WHERE id=$1', [req.params.agentId]);
    const r = await pool.query(
      'SELECT session_id, role, content, source, created_at FROM chat_messages WHERE agent_id=$1 ORDER BY session_id, created_at ASC',
      [req.params.agentId]
    );

    const header = 'session_id,role,source,created_at,content\n';
    const rows = r.rows.map(row =>
      [row.session_id, row.role, row.source, row.created_at.toISOString(),
        '"' + (row.content || '').replace(/"/g, '""').replace(/\n/g, ' ') + '"'
      ].join(',')
    ).join('\n');

    const agentName = (agent.rows[0]?.name || 'agent').replace(/[^a-z0-9]/gi, '-');
    res.setHeader('Content-Disposition', `attachment; filename="${agentName}-conversations.csv"`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send('\uFEFF' + header + rows); // BOM for Excel
  } catch(e) {
    res.status(500).json({ error: 'Export fehlgeschlagen' });
  }
});

/* ── EXPORT: LEADS AS CSV ──────────────────────────────────── */
router.get('/:agentId/leads/csv', auth, async (req, res) => {
  const pool = getPool(req);
  if (!(await verifyOwner(pool, req.params.agentId, req.userId)))
    return res.status(403).json({ error: 'Nicht berechtigt' });

  try {
    const agent = await pool.query('SELECT name FROM agents WHERE id=$1', [req.params.agentId]);
    const r = await pool.query(
      'SELECT session_id, source, data, created_at FROM lead_captures WHERE agent_id=$1 ORDER BY created_at DESC',
      [req.params.agentId]
    );

    if (!r.rows.length) {
      res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      return res.send('\uFEFFDatum,Kanal,Name,E-Mail,Telefon,Daten\n');
    }

    // Collect all field keys
    const allKeys = new Set();
    r.rows.forEach(row => { if (row.data && typeof row.data === 'object') Object.keys(row.data).forEach(k => allKeys.add(k)); });
    const fieldKeys = [...allKeys];

    const header = ['Datum', 'Kanal', 'Session', ...fieldKeys].join(',') + '\n';
    const rows = r.rows.map(row => {
      const d = row.data || {};
      return [
        row.created_at.toISOString(),
        row.source,
        row.session_id,
        ...fieldKeys.map(k => '"' + String(d[k] || '').replace(/"/g, '""') + '"'),
      ].join(',');
    }).join('\n');

    const agentName = (agent.rows[0]?.name || 'agent').replace(/[^a-z0-9]/gi, '-');
    res.setHeader('Content-Disposition', `attachment; filename="${agentName}-leads.csv"`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send('\uFEFF' + header + rows);
  } catch(e) {
    res.status(500).json({ error: 'Export fehlgeschlagen' });
  }
});

/* ── ALL LEADS CSV (alle Agenten) ──────────────────────────── */
router.get('/all/leads/csv', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query(`
      SELECT lc.session_id, lc.source, lc.data, lc.created_at,
             a.name AS agent_name
      FROM lead_captures lc
      JOIN agents a ON lc.agent_id=a.id
      WHERE a.user_id=$1
      ORDER BY lc.created_at DESC
    `, [req.userId]).catch(() => ({ rows: [] }));

    const allKeys = new Set();
    r.rows.forEach(row => { if (row.data && typeof row.data === 'object') Object.keys(row.data).forEach(k => allKeys.add(k)); });
    const fieldKeys = [...allKeys];

    const header = ['Datum', 'Agent', 'Kanal', 'Session', ...fieldKeys].join(',') + '\n';
    const rows = r.rows.map(row => {
      const d = row.data || {};
      return [
        row.created_at.toISOString(),
        '"' + (row.agent_name||'').replace(/"/g,'""') + '"',
        row.source, row.session_id,
        ...fieldKeys.map(k => '"' + String(d[k] || '').replace(/"/g, '""') + '"'),
      ].join(',');
    }).join('\n');

    res.setHeader('Content-Disposition', 'attachment; filename="alle-leads.csv"');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send('\uFEFF' + header + rows);
  } catch(e) {
    res.status(500).json({ error: 'Export fehlgeschlagen' });
  }
});


/* ── SEARCH CONVERSATIONS ──────────────────────────────── */
router.get('/:agentId/search', auth, async (req, res) => {
  const pool = getPool(req);
  if (!(await verifyOwner(pool, req.params.agentId, req.userId)))
    return res.status(403).json({ error: 'Nicht berechtigt' });

  const { q, source, from, to, limit = 20 } = req.query;
  if (!q || q.length < 2) return res.status(400).json({ error: 'Suchbegriff erforderlich (min. 2 Zeichen)' });

  try {
    let query = `
      SELECT DISTINCT ON (session_id)
        session_id, source, created_at,
        content AS match_content
      FROM chat_messages
      WHERE agent_id=$1
        AND content ILIKE $2
    `;
    const params = [req.params.agentId, '%' + q + '%'];

    if (source) { query += ` AND source=$${params.length+1}`; params.push(source); }
    if (from)   { query += ` AND created_at >= $${params.length+1}`; params.push(from); }
    if (to)     { query += ` AND created_at <= $${params.length+1}`; params.push(to); }

    query += ` ORDER BY session_id, created_at DESC LIMIT $${params.length+1}`;
    params.push(parseInt(limit)).catch(() => ({ rows: [] })).catch(() => ({ rows: [] }));

    const r = await pool.query(query, params);
    res.json({ results: r.rows, query: q });
  } catch(e) {
    res.status(500).json({ error: 'Suche fehlgeschlagen' });
  }
});

module.exports = router;
