/**
 * AgentKontor — Analytics API
 * GET /api/analytics/overview        — dashboard-level stats
 * GET /api/analytics/:agentId        — per-agent stats
 * GET /api/analytics/:agentId/leads  — lead captures for agent
 */

const router = require('express').Router();
const auth   = require('../middleware/auth');

function getPool(req) { return req.app.locals.pool; }

/* ── OVERVIEW (all agents of user) ──────────────────────── */
router.get('/overview', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    // Total messages last 30 days by day
    const byDay = await pool.query(`
      SELECT
        DATE_TRUNC('day', cm.created_at) AS day,
        COUNT(*) AS count
      FROM chat_messages cm
      JOIN agents a ON cm.agent_id = a.id
      WHERE a.user_id=$1
        AND cm.role='user'
        AND cm.created_at >= NOW() - INTERVAL '30 days'
      GROUP BY day ORDER BY day ASC
    `, [req.userId]);

    // Messages by channel last 30 days
    const byChannel = await pool.query(`
      SELECT cm.source, COUNT(*) AS count
      FROM chat_messages cm
      JOIN agents a ON cm.agent_id = a.id
      WHERE a.user_id=$1
        AND cm.role='user'
        AND cm.created_at >= NOW() - INTERVAL '30 days'
      GROUP BY cm.source
    `, [req.userId]);

    // Summary stats
    const totals = await pool.query(`
      SELECT
        COUNT(DISTINCT cm.id) FILTER (WHERE cm.role='user')       AS total_messages,
        COUNT(DISTINCT cm.session_id)                              AS unique_sessions,
        COUNT(DISTINCT a.id) FILTER (WHERE a.is_active=true)      AS active_agents,
        COUNT(DISTINCT a.id)                                       AS total_agents
      FROM agents a
      LEFT JOIN chat_messages cm ON cm.agent_id = a.id
        AND cm.created_at >= NOW() - INTERVAL '30 days'
      WHERE a.user_id=$1
    `, [req.userId]);

    // Lead count
    const leads = await pool.query(`
      SELECT COUNT(*) AS count
      FROM lead_captures lc
      JOIN agents a ON lc.agent_id = a.id
      WHERE a.user_id=$1
        AND lc.created_at >= NOW() - INTERVAL '30 days'
    `, [req.userId]);

    // Top agents by messages last 30 days
    const topAgents = await pool.query(`
      SELECT a.id, a.name, a.emoji, a.color,
        COUNT(cm.id) FILTER (WHERE cm.role='user') AS msg_count
      FROM agents a
      LEFT JOIN chat_messages cm ON cm.agent_id = a.id
        AND cm.created_at >= NOW() - INTERVAL '30 days'
      WHERE a.user_id=$1
      GROUP BY a.id ORDER BY msg_count DESC LIMIT 5
    `, [req.userId]);

    res.json({
      byDay:       byDay.rows,
      byChannel:   byChannel.rows,
      totals:      totals.rows[0],
      leadsMonth:  parseInt(leads.rows[0]?.count || 0),
      topAgents:   topAgents.rows,
    });
  } catch(e) {
    console.error('Analytics overview error:', e);
    res.status(500).json({ error: 'Fehler beim Laden der Analytics' });
  }
});

/* ── PER-AGENT ───────────────────────────────────────────── */
router.get('/:agentId', auth, async (req, res) => {
  const pool = getPool(req);
  const { agentId } = req.params;

  // Verify ownership
  const check = await pool.query(
    'SELECT id FROM agents WHERE id=$1 AND user_id=$2', [agentId, req.userId]
  );
  if (!check.rows.length) return res.status(403).json({ error: 'Nicht berechtigt' });

  try {
    // Messages by day last 30 days
    const byDay = await pool.query(`
      SELECT DATE_TRUNC('day', created_at) AS day, COUNT(*) AS count
      FROM chat_messages
      WHERE agent_id=$1 AND role='user'
        AND created_at >= NOW() - INTERVAL '30 days'
      GROUP BY day ORDER BY day ASC
    `, [agentId]);

    // By channel
    const byChannel = await pool.query(`
      SELECT source, COUNT(*) AS count
      FROM chat_messages
      WHERE agent_id=$1 AND role='user'
        AND created_at >= NOW() - INTERVAL '30 days'
      GROUP BY source
    `, [agentId]);

    // Summary
    const totals = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE role='user') AS total_messages,
        COUNT(DISTINCT session_id)           AS unique_sessions,
        COUNT(*) FILTER (WHERE role='user' AND created_at >= NOW()-INTERVAL '7 days') AS week_messages,
        COUNT(*) FILTER (WHERE role='user' AND created_at >= NOW()-INTERVAL '24 hours') AS day_messages
      FROM chat_messages WHERE agent_id=$1
    `, [agentId]);

    // Avg response length
    const avgResp = await pool.query(`
      SELECT ROUND(AVG(LENGTH(content))) AS avg_chars
      FROM chat_messages WHERE agent_id=$1 AND role='assistant'
    `, [agentId]);

    // Recent sessions
    const sessions = await pool.query(`
      SELECT session_id, source,
        MIN(created_at) AS started_at,
        COUNT(*) FILTER (WHERE role='user') AS user_msgs
      FROM chat_messages WHERE agent_id=$1
      GROUP BY session_id, source
      ORDER BY started_at DESC LIMIT 10
    `, [agentId]);

    res.json({
      byDay:    byDay.rows,
      byChannel: byChannel.rows,
      totals:   { ...totals.rows[0], avg_response_chars: avgResp.rows[0]?.avg_chars || 0 },
      sessions: sessions.rows,
    });
  } catch(e) {
    console.error('Agent analytics error:', e);
    res.status(500).json({ error: 'Fehler' });
  }
});

/* ── LEADS FOR AGENT ─────────────────────────────────────── */
router.get('/:agentId/leads', auth, async (req, res) => {
  const pool = getPool(req);
  const { agentId } = req.params;

  const check = await pool.query(
    'SELECT id FROM agents WHERE id=$1 AND user_id=$2', [agentId, req.userId]
  );
  if (!check.rows.length) return res.status(403).json({ error: 'Nicht berechtigt' });

  try {
    const leads = await pool.query(`
      SELECT id, session_id, source, data, created_at
      FROM lead_captures WHERE agent_id=$1
      ORDER BY created_at DESC LIMIT 100
    `, [agentId]);
    res.json({ leads: leads.rows });
  } catch(e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

/* ── GLOBAL LEADS (all agents) ───────────────────────────── */
router.get('/leads/all', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const leads = await pool.query(`
      SELECT lc.id, lc.session_id, lc.source, lc.data, lc.created_at,
             a.name AS agent_name, a.emoji AS agent_emoji
      FROM lead_captures lc
      JOIN agents a ON lc.agent_id = a.id
      WHERE a.user_id=$1
      ORDER BY lc.created_at DESC LIMIT 200
    `, [req.userId]);
    res.json({ leads: leads.rows });
  } catch(e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

module.exports = router;
