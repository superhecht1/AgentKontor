const router = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const { v4: uuidv4 } = require('uuid');

const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
function getPool(req) { return req.app.locals.pool; }

async function getAgent(pool, identifier, byPublicId = true) {
  const col = byPublicId ? 'public_id' : 'id';
  const result = await pool.query(
    `SELECT id, name, emoji, system_prompt, greeting, language, quick_chips, color, is_active,
            widget_enabled, chatpage_enabled, api_enabled
     FROM agents WHERE ${col}=$1`, [identifier]
  );
  return result.rows[0] || null;
}

async function chat(pool, agent, messages, source = 'web') {
  const response = await ai.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: agent.system_prompt,
    messages: messages.slice(-14).map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content
    }))
  });
  return response.content[0]?.text || '...';
}

// POST /api/chat/:publicId — web/widget chat (no auth needed)
router.post('/:publicId', async (req, res) => {
  const pool = getPool(req);
  const { messages, sessionId, source = 'web' } = req.body;
  if (!messages?.length) return res.status(400).json({ error: 'messages fehlt' });

  try {
    const agent = await getAgent(pool, req.params.publicId);
    if (!agent || !agent.is_active) return res.status(404).json({ error: 'Agent nicht verfügbar' });

    const sid = sessionId || uuidv4();
    const userMsg = messages[messages.length - 1];

    // Save user message
    await pool.query(
      'INSERT INTO chat_messages (agent_id, session_id, role, content, source) VALUES ($1,$2,$3,$4,$5)',
      [agent.id, sid, 'user', userMsg.content, source]
    );

    // Get AI reply
    const reply = await chat(pool, agent, messages, source);

    // Save assistant message
    await pool.query(
      'INSERT INTO chat_messages (agent_id, session_id, role, content, source) VALUES ($1,$2,$3,$4,$5)',
      [agent.id, sid, 'assistant', reply, source]
    );

    // Increment counter
    await pool.query('UPDATE agents SET total_messages = total_messages + 1 WHERE id=$1', [agent.id]);

    res.json({ reply, sessionId: sid });
  } catch (e) {
    console.error('Chat error:', e.message);
    res.status(500).json({ error: 'KI-Fehler', reply: 'Es gab einen Fehler. Bitte versuche es erneut.' });
  }
});

// POST /api/chat/api/:agentId — API access with key auth
router.post('/api/:agentId', async (req, res) => {
  const pool = getPool(req);
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!apiKey) return res.status(401).json({ error: 'API Key fehlt (Header: x-api-key)' });

  try {
    const bcrypt = require('bcryptjs');
    // Find matching key
    const keys = await pool.query(
      'SELECT k.key_hash, k.is_active, k.agent_id, a.user_id FROM api_keys k JOIN agents a ON k.agent_id=a.id WHERE k.key_prefix=$1 AND k.is_active=true',
      [apiKey.slice(0, 12)]
    );

    let validKey = null;
    for (const row of keys.rows) {
      if (await bcrypt.compare(apiKey, row.key_hash)) { validKey = row; break; }
    }
    if (!validKey) return res.status(401).json({ error: 'Ungültiger API Key' });

    const agent = await getAgent(pool, validKey.agent_id, false);
    if (!agent || !agent.is_active || !agent.api_enabled)
      return res.status(403).json({ error: 'API-Zugang nicht aktiviert' });

    const { messages, sessionId } = req.body;
    if (!messages?.length) return res.status(400).json({ error: 'messages fehlt' });

    const sid = sessionId || uuidv4();
    const reply = await chat(pool, agent, messages, 'api');

    await pool.query('UPDATE api_keys SET last_used=NOW() WHERE key_hash=$1', [validKey.key_hash]);
    await pool.query('UPDATE agents SET total_messages = total_messages + 1 WHERE id=$1', [agent.id]);
    await pool.query(
      'INSERT INTO chat_messages (agent_id, session_id, role, content, source) VALUES ($1,$2,$3,$4,$5)',
      [agent.id, sid, 'assistant', reply, 'api']
    );

    res.json({ reply, sessionId: sid, agent: agent.name });
  } catch (e) {
    console.error('API chat error:', e);
    res.status(500).json({ error: 'Fehler' });
  }
});

// GET /api/chat/:publicId/history?sessionId=xxx
router.get('/:publicId/history', async (req, res) => {
  const pool = getPool(req);
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ error: 'sessionId fehlt' });

  try {
    const agent = await getAgent(pool, req.params.publicId);
    if (!agent) return res.status(404).json({ error: 'Agent nicht gefunden' });

    const msgs = await pool.query(
      'SELECT role, content, created_at FROM chat_messages WHERE agent_id=$1 AND session_id=$2 ORDER BY created_at ASC LIMIT 100',
      [agent.id, sessionId]
    );
    res.json({ messages: msgs.rows });
  } catch (e) {
    res.status(500).json({ error: 'Fehler' });
  }
});

module.exports = router;
