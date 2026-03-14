/**
 * AgentKontor — Model Engine
 * Supports: Anthropic Claude, OpenAI (+ fine-tuned), Ollama (local)
 */

const https = require('https');
const http  = require('http');

/* ─────────────────────────────────────────────────────
   UNIVERSAL CHAT — routes to correct provider
───────────────────────────────────────────────────── */
async function universalChat({ model, systemPrompt, messages, apiKey, ollamaUrl }) {
  const provider = detectProvider(model);

  switch(provider) {
    case 'anthropic': return chatAnthropic(model, systemPrompt, messages);
    case 'openai':    return chatOpenAI(model, systemPrompt, messages, apiKey);
    case 'ollama':    return chatOllama(model, systemPrompt, messages, ollamaUrl);
    default: throw new Error(`Unbekannter Provider für Modell: ${model}`);
  }
}

function detectProvider(model) {
  if (!model) return 'anthropic';
  if (model.startsWith('claude-'))     return 'anthropic';
  if (model.startsWith('gpt-') || model.startsWith('ft:') || model.startsWith('o1') || model.startsWith('o3')) return 'openai';
  // Ollama models: llama3, mistral, qwen, phi, etc.
  return 'ollama';
}

/* ─────────────────────────────────────────────────────
   ANTHROPIC
───────────────────────────────────────────────────── */
async function chatAnthropic(model, systemPrompt, messages) {
  const Anthropic = require('@anthropic-ai/sdk');
  const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await ai.messages.create({
    model: model || 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: systemPrompt,
    messages: messages.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }))
  });
  return response.content[0]?.text || '...';
}

/* ─────────────────────────────────────────────────────
   OPENAI (incl. fine-tuned models ft:gpt-...)
───────────────────────────────────────────────────── */
async function chatOpenAI(model, systemPrompt, messages, apiKey) {
  const key = apiKey || process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OpenAI API Key fehlt');

  const msgs = [
    { role: 'system', content: systemPrompt },
    ...messages.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }))
  ];

  const body = JSON.stringify({ model, messages: msgs, max_tokens: 1024 });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error.message));
          else resolve(parsed.choices?.[0]?.message?.content || '...');
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/* ─────────────────────────────────────────────────────
   OLLAMA (local models)
───────────────────────────────────────────────────── */
async function chatOllama(model, systemPrompt, messages, baseUrl) {
  const url = new URL(baseUrl || process.env.OLLAMA_URL || 'http://localhost:11434');

  const msgs = [
    { role: 'system', content: systemPrompt },
    ...messages.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }))
  ];

  const body = JSON.stringify({ model, messages: msgs, stream: false });
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 11434),
      path: '/api/chat',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error));
          else resolve(parsed.message?.content || parsed.response || '...');
        } catch(e) { reject(new Error('Ollama Antwort konnte nicht geparst werden: ' + data.slice(0,200))); }
      });
    });
    req.on('error', e => reject(new Error('Ollama nicht erreichbar: ' + e.message)));
    req.write(body);
    req.end();
  });
}

/* ─────────────────────────────────────────────────────
   LIST OLLAMA MODELS
───────────────────────────────────────────────────── */
async function listOllamaModels(baseUrl) {
  const url = new URL(baseUrl || process.env.OLLAMA_URL || 'http://localhost:11434');
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || 11434,
      path: '/api/tags',
      method: 'GET',
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.models?.map(m => m.name) || []);
        } catch(e) { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.end();
  });
}

/* ─────────────────────────────────────────────────────
   OPENAI FINE-TUNING PIPELINE
───────────────────────────────────────────────────── */

// Upload training file
async function uploadTrainingFile(jsonlContent, apiKey) {
  const key = apiKey || process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OpenAI API Key fehlt');

  const boundary = 'boundary' + Date.now();
  const fileContent = Buffer.from(jsonlContent, 'utf-8');

  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nfine-tune\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="training.jsonl"\r\nContent-Type: application/json\r\n\r\n`),
    fileContent,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/files',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error.message));
          else resolve(parsed);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Start fine-tuning job
async function startFineTuning(fileId, baseModel, suffix, apiKey) {
  const key = apiKey || process.env.OPENAI_API_KEY;
  const body = JSON.stringify({
    training_file: fileId,
    model: baseModel || 'gpt-4o-mini-2024-07-18',
    suffix: suffix || 'agentkontor',
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/fine_tuning/jobs',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error.message));
          else resolve(parsed);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Get fine-tuning job status
async function getFineTuningJob(jobId, apiKey) {
  const key = apiKey || process.env.OPENAI_API_KEY;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: `/v1/fine_tuning/jobs/${jobId}`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${key}` }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
}

// List fine-tuning jobs
async function listFineTuningJobs(apiKey) {
  const key = apiKey || process.env.OPENAI_API_KEY;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/fine_tuning/jobs?limit=20',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${key}` }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data).data || []); }
        catch(e) { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.end();
  });
}

// Convert chat history / RAG docs to JSONL training format
function buildTrainingData(systemPrompt, examples) {
  // examples: [{user: "...", assistant: "..."}]
  return examples.map(ex => JSON.stringify({
    messages: [
      { role: 'system',    content: systemPrompt },
      { role: 'user',      content: ex.user },
      { role: 'assistant', content: ex.assistant },
    ]
  })).join('\n');
}

// Auto-generate training data from chat history
async function generateTrainingDataFromHistory(pool, agentId, minPairs = 10) {
  const r = await pool.query(`
    SELECT session_id FROM chat_messages
    WHERE agent_id=$1 AND role='user'
    GROUP BY session_id HAVING COUNT(*)>=2
    LIMIT 100
  `, [agentId]);

  const agent = await pool.query('SELECT system_prompt FROM agents WHERE id=$1', [agentId]);
  const systemPrompt = agent.rows[0]?.system_prompt || '';

  const examples = [];

  for (const row of r.rows) {
    const msgs = await pool.query(
      'SELECT role,content FROM chat_messages WHERE agent_id=$1 AND session_id=$2 ORDER BY created_at ASC',
      [agentId, row.session_id]
    );

    const msgList = msgs.rows;
    for (let i = 0; i < msgList.length - 1; i++) {
      if (msgList[i].role === 'user' && msgList[i+1].role === 'assistant') {
        examples.push({ user: msgList[i].content, assistant: msgList[i+1].content });
      }
    }
  }

  return { systemPrompt, examples, count: examples.length };
}

module.exports = {
  universalChat,
  detectProvider,
  listOllamaModels,
  uploadTrainingFile,
  startFineTuning,
  getFineTuningJob,
  listFineTuningJobs,
  buildTrainingData,
  generateTrainingDataFromHistory,
};
