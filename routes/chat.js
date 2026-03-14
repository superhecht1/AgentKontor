const router = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const { v4: uuidv4 } = require('uuid');
const { buildCapabilityPrompt, parseAgentActions } = require('./capabilities');
const { getIdentity, executeActions, buildIdentityPrompt } = require('./actions');

const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
function getPool(req) { return req.app.locals.pool; }

async function getAgent(pool, identifier, byPublicId = true) {
  const col = byPublicId ? 'public_id' : 'id';
  const r = await pool.query(`SELECT * FROM agents WHERE ${col}=$1`, [identifier]);
  return r.rows[0] || null;
}

async function buildSystem(agent, userMsg, pool) {
  let system = agent.system_prompt;

  // RAG
  if (agent.rag_enabled) {
    try {
      const { retrieveContext } = require('./rag');
      const chunks = await retrieveContext(pool, agent.id, userMsg, 5);
      if (chunks.length > 0)
        system += `\n\n${agent.rag_prompt||'Nutze folgende Dokumente:'}\n<context>\n${chunks.join('\n\n---\n\n')}\n</context>`;
    } catch(e) { console.warn('RAG:', e.message); }
  }

  // Capabilities (leads, calendar link, products etc.)
  system += buildCapabilityPrompt(agent);

  // Identity & real actions
  if (agent.has_identity) {
    try {
      const identity = await getIdentity(pool, agent.id);
      system += buildIdentityPrompt(agent, identity);
    } catch(e) { console.warn('Identity:', e.message); }
  }

  return system;
}

// POST /api/chat/:publicId
router.post('/:publicId', async (req, res) => {
  const pool = getPool(req);
  const { messages, sessionId, source = 'web' } = req.body;
  if (!messages?.length) return res.status(400).json({ error: 'messages fehlt' });
  try {
    const agent = await getAgent(pool, req.params.publicId);
    if (!agent || !agent.is_active) return res.status(404).json({ error: 'Agent nicht verfügbar' });
    const sid = sessionId || uuidv4();
    const userMsg = messages[messages.length - 1];
    await pool.query('INSERT INTO chat_messages(agent_id,session_id,role,content,source)VALUES($1,$2,$3,$4,$5)',[agent.id,sid,'user',userMsg.content,source]);
    const system = await buildSystem(agent, userMsg.content, pool);
    const response = await ai.messages.create({
      model: 'claude-sonnet-4-20250514', max_tokens: 1024, system,
      messages: messages.slice(-14).map(m=>({role:m.role==='user'?'user':'assistant',content:m.content}))
    });
    let reply = response.content[0]?.text || '...';

    // Execute capability actions (leads, email via SMTP)
    reply = await parseAgentActions(reply, agent, pool, sid, source);

    // Execute identity actions (Google Calendar, Gmail, Calendly, Forms)
    if (agent.has_identity) {
      try {
        const identity = await getIdentity(pool, agent.id);
        reply = await executeActions(reply, agent, identity, pool, sid, source);
      } catch(e) { console.warn('Action exec:', e.message); }
    }

    await pool.query('INSERT INTO chat_messages(agent_id,session_id,role,content,source)VALUES($1,$2,$3,$4,$5)',[agent.id,sid,'assistant',reply,source]);
    await pool.query('UPDATE agents SET total_messages=total_messages+1 WHERE id=$1',[agent.id]);
    res.json({ reply, sessionId: sid });
  } catch(e) { console.error(e); res.status(500).json({ error:'Fehler',reply:'Fehler. Bitte erneut versuchen.' }); }
});

// POST /api/chat/api/:agentId
router.post('/api/:agentId', async (req, res) => {
  const pool = getPool(req);
  const apiKey = req.headers['x-api-key']||req.headers['authorization']?.replace('Bearer ','');
  if (!apiKey) return res.status(401).json({ error:'API Key fehlt' });
  try {
    const bcrypt = require('bcryptjs');
    const keys = await pool.query('SELECT key_hash,agent_id FROM api_keys WHERE key_prefix=$1 AND is_active=true',[apiKey.slice(0,12)]);
    let vk=null;
    for(const row of keys.rows){if(await bcrypt.compare(apiKey,row.key_hash)){vk=row;break;}}
    if(!vk) return res.status(401).json({error:'Ungültiger Key'});
    const agent = await getAgent(pool,vk.agent_id,false);
    if(!agent||!agent.is_active||!agent.api_enabled) return res.status(403).json({error:'API nicht aktiv'});
    const{messages,sessionId}=req.body;
    if(!messages?.length) return res.status(400).json({error:'messages fehlt'});
    const sid=sessionId||uuidv4();
    const system=await buildSystem(agent,messages[messages.length-1].content,pool);
    const response=await ai.messages.create({model:'claude-sonnet-4-20250514',max_tokens:1024,system,messages:messages.slice(-14).map(m=>({role:m.role==='user'?'user':'assistant',content:m.content}))});
    let reply=response.content[0]?.text||'...';
    reply=await parseAgentActions(reply,agent,pool,sid,'api');
    if(agent.has_identity){try{const id=await getIdentity(pool,agent.id);reply=await executeActions(reply,agent,id,pool,sid,'api');}catch(e){}}
    await pool.query('UPDATE api_keys SET last_used=NOW() WHERE key_hash=$1',[vk.key_hash]);
    await pool.query('UPDATE agents SET total_messages=total_messages+1 WHERE id=$1',[agent.id]);
    res.json({reply,sessionId:sid});
  } catch(e){console.error(e);res.status(500).json({error:'Fehler'});}
});

// GET /api/chat/:publicId/history
router.get('/:publicId/history', async (req, res) => {
  const pool = getPool(req);
  const{sessionId}=req.query;
  if(!sessionId) return res.status(400).json({error:'sessionId fehlt'});
  try {
    const agent=await getAgent(pool,req.params.publicId);
    if(!agent) return res.status(404).json({error:'Nicht gefunden'});
    const msgs=await pool.query('SELECT role,content,created_at FROM chat_messages WHERE agent_id=$1 AND session_id=$2 ORDER BY created_at ASC LIMIT 100',[agent.id,sessionId]);
    res.json({messages:msgs.rows});
  } catch(e){res.status(500).json({error:'Fehler'});}
});

module.exports = router;
