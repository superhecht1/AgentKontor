/**
 * AgentKontor — Fine-Tuning API (OpenAI)
 *
 * GET  /api/finetune/:agentId              — list jobs for agent
 * POST /api/finetune/:agentId/prepare      — prepare training data from conversations
 * POST /api/finetune/:agentId/start        — start fine-tune job
 * GET  /api/finetune/:agentId/jobs/:jobId  — poll job status
 * POST /api/finetune/:agentId/apply        — apply fine-tuned model to agent
 */

const router = require('express').Router();
const auth   = require('../middleware/auth');
const { minimizePii } = require('../utils/privacy');
const { requirePlan } = require('../middleware/plan-gate');

function getPool(req) { return req.app.locals.pool; }

function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY nicht gesetzt');
  const OpenAI = require('openai');
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

async function verifyOwner(pool, agentId, userId) {
  const r = await pool.query('SELECT id, name FROM agents WHERE id=$1 AND user_id=$2', [agentId, userId]);
  return r.rows[0] || null;
}

/* ── LIST JOBS ─────────────────────────────────────────── */
router.get('/:agentId', auth, requirePlan('finetune'), async (req, res) => {
  const pool = getPool(req);
  const agent = await verifyOwner(pool, req.params.agentId, req.userId);
  if (!agent) return res.status(403).json({ error: 'Nicht berechtigt' });

  try {
    const r = await pool.query(
      `SELECT * FROM finetune_jobs WHERE agent_id=$1 ORDER BY created_at DESC LIMIT 20`,
      [req.params.agentId]
    );
    res.json({ jobs: r.rows });
  } catch (e) {
    // Table might not exist yet
    res.json({ jobs: [] });
  }
});

/* ── PREPARE TRAINING DATA ─────────────────────────────── */
router.post('/:agentId/prepare', auth, requirePlan('finetune'), async (req, res) => {
  const pool  = getPool(req);
  const agent = await verifyOwner(pool, req.params.agentId, req.userId);
  if (!agent) return res.status(403).json({ error: 'Nicht berechtigt' });

  try {
    // Fetch agent config for system prompt
    const ar = await pool.query('SELECT system_prompt, name FROM agents WHERE id=$1', [req.params.agentId]);
    if (!ar.rows.length) return res.status(404).json({ error: 'Agent nicht gefunden' });
    const { system_prompt, name } = ar.rows[0];

    // Fetch conversations grouped by session
    const sessions = await pool.query(
      `SELECT session_id FROM chat_messages WHERE agent_id=$1 AND role='user'
       GROUP BY session_id HAVING COUNT(*)>=2 ORDER BY MAX(created_at) DESC LIMIT 200`,
      [req.params.agentId]
    );

    if (sessions.rows.length < 10) {
      return res.status(400).json({
        error: `Zu wenige Gespräche für Fine-Tuning. Mindestens 10 Sessions nötig, aktuell: ${sessions.rows.length}.`
      });
    }

    // Build JSONL training data (OpenAI chat format)
    const lines = [];
    for (const { session_id } of sessions.rows) {
      const msgs = await pool.query(
        'SELECT role, content FROM chat_messages WHERE agent_id=$1 AND session_id=$2 ORDER BY created_at ASC',
        [req.params.agentId, session_id]
      );
      if (msgs.rows.length < 2) continue;

      const messages = [
        { role: 'system', content: system_prompt || `Du bist ${name}, ein hilfreicher KI-Assistent.` },
        ...msgs.rows.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
      ];
      lines.push(JSON.stringify({ messages }));
    }

    const jsonl    = lines.join('\n');
    const sizeKB   = Math.round(Buffer.byteLength(jsonl, 'utf8') / 1024);
    const examples = lines.length;

    res.json({
      success: true,
      examples,
      sizeKB,
      preview: lines.slice(0, 2).map(l => JSON.parse(l)),
      jsonl,  // returned so frontend can show preview; actual upload happens on /start
    });
  } catch (e) {
    console.error('PREPARE FINETUNE:', e.message);
    res.status(500).json({ error: 'Fehler beim Vorbereiten' });
  }
});

/* ── START FINE-TUNE JOB ───────────────────────────────── */
router.post('/:agentId/start', auth, requirePlan('finetune'), async (req, res) => {
  const pool  = getPool(req);
  const agent = await verifyOwner(pool, req.params.agentId, req.userId);
  if (!agent) return res.status(403).json({ error: 'Nicht berechtigt' });

  const { jsonl, baseModel = 'gpt-4o-mini-2024-07-18', suffix } = req.body;
  if (!jsonl) return res.status(400).json({ error: 'jsonl Daten erforderlich' });

  try {
    const openai = getOpenAI();

    // Upload training file
    const blob = new Blob([jsonl], { type: 'application/jsonl' });
    const file = await openai.files.create({
      file: new File([blob], 'training.jsonl', { type: 'application/jsonl' }),
      purpose: 'fine-tune',
    });

    // Start fine-tune
    const jobName = suffix || `ak-${agent.name.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 18)}`;
    const job = await openai.fineTuning.jobs.create({
      training_file: file.id,
      model: baseModel,
      suffix: jobName,
    });

    // Save job to DB
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS finetune_jobs (
        id SERIAL PRIMARY KEY, agent_id INTEGER, user_id INTEGER,
        job_id VARCHAR(128), file_id VARCHAR(128), base_model VARCHAR(128),
        fine_tuned_model VARCHAR(256), status VARCHAR(32) DEFAULT 'running',
        examples INTEGER, created_at TIMESTAMPTZ DEFAULT NOW(), finished_at TIMESTAMPTZ
      )`);
      await pool.query(
        `INSERT INTO finetune_jobs (agent_id, user_id, job_id, file_id, base_model, examples)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [req.params.agentId, req.userId, job.id, file.id, baseModel, jsonl.split('\n').length]
      );
    } catch { /* non-critical */ }

    res.json({
      success: true,
      jobId:   job.id,
      fileId:  file.id,
      status:  job.status,
      model:   baseModel,
    });
  } catch (e) {
    console.error('START FINETUNE:', e.message);
    res.status(500).json({ error: 'Fine-Tuning konnte nicht gestartet werden: ' + (e.message.includes('API') ? 'OpenAI API-Fehler' : 'Fehler') });
  }
});

/* ── POLL JOB STATUS ───────────────────────────────────── */
router.get('/:agentId/jobs/:jobId', auth, requirePlan('finetune'), async (req, res) => {
  const pool  = getPool(req);
  const agent = await verifyOwner(pool, req.params.agentId, req.userId);
  if (!agent) return res.status(403).json({ error: 'Nicht berechtigt' });

  try {
    const openai = getOpenAI();
    const job    = await openai.fineTuning.jobs.retrieve(req.params.jobId);

    // Update status in DB
    try {
      await pool.query(
        `UPDATE finetune_jobs SET status=$1, fine_tuned_model=$2,
         finished_at=CASE WHEN $1 IN ('succeeded','failed','cancelled') THEN NOW() ELSE finished_at END
         WHERE job_id=$3`,
        [job.status, job.fine_tuned_model, job.id]
      );
    } catch { /* non-critical */ }

    res.json({
      jobId:          job.id,
      status:         job.status,
      fineTunedModel: job.fine_tuned_model,
      trainedTokens:  job.trained_tokens,
      createdAt:      job.created_at,
      finishedAt:     job.finished_at,
    });
  } catch (e) {
    res.status(500).json({ error: 'Fehler beim Abrufen' });
  }
});

/* ── APPLY MODEL TO AGENT ──────────────────────────────── */
router.post('/:agentId/apply', auth, requirePlan('finetune'), async (req, res) => {
  const pool  = getPool(req);
  const agent = await verifyOwner(pool, req.params.agentId, req.userId);
  if (!agent) return res.status(403).json({ error: 'Nicht berechtigt' });

  const { model } = req.body;
  if (!model) return res.status(400).json({ error: 'model erforderlich' });

  try {
    await pool.query('UPDATE agents SET model=$1 WHERE id=$2 AND user_id=$3', [model, req.params.agentId, req.userId]);
    res.json({ success: true, model });
  } catch (e) {
    res.status(500).json({ error: 'Fehler beim Anwenden' });
  }
});

module.exports = router;
