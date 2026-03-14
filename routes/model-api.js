const router = require('express').Router();
const auth = require('../middleware/auth');
const {
  listOllamaModels,
  uploadTrainingFile,
  startFineTuning,
  getFineTuningJob,
  listFineTuningJobs,
  buildTrainingData,
  generateTrainingDataFromHistory,
} = require('./models');

function getPool(req) { return req.app.locals.pool; }

/* ─── AVAILABLE MODELS ──────────────────────────── */
const BUILTIN_MODELS = [
  // Anthropic
  { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4 (Empfohlen)', provider: 'anthropic', tier: 'pro' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4 (Schnell & günstig)', provider: 'anthropic', tier: 'free' },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4 (Mächtigste)', provider: 'anthropic', tier: 'pro' },
  // OpenAI
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', tier: 'pro' },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini (Schnell)', provider: 'openai', tier: 'free' },
  { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', provider: 'openai', tier: 'pro' },
];

// GET /api/models — list all available models
router.get('/', auth, async (req, res) => {
  const pool = getPool(req);
  const models = [...BUILTIN_MODELS];

  // Add fine-tuned models from DB
  try {
    const finetuned = await pool.query(
      'SELECT * FROM fine_tuning_jobs WHERE user_id=$1 AND status=$2 ORDER BY created_at DESC',
      [req.userId, 'succeeded']
    );
    for (const job of finetuned.rows) {
      if (job.fine_tuned_model) {
        models.push({
          id: job.fine_tuned_model,
          name: `🎯 ${job.name || 'Fine-Tuned'} (${job.fine_tuned_model.slice(-8)})`,
          provider: 'openai',
          tier: 'custom',
          isFineTuned: true,
        });
      }
    }
  } catch(e) { /* table might not exist yet */ }

  // Try to add Ollama models
  try {
    const ollamaModels = await listOllamaModels(req.query.ollamaUrl);
    for (const m of ollamaModels) {
      models.push({ id: m, name: `🖥️ ${m} (Lokal)`, provider: 'ollama', tier: 'local' });
    }
  } catch(e) { /* Ollama not running */ }

  res.json({ models });
});

// GET /api/models/ollama — check Ollama + list models
router.get('/ollama', auth, async (req, res) => {
  const url = req.query.url || process.env.OLLAMA_URL || 'http://localhost:11434';
  try {
    const models = await listOllamaModels(url);
    res.json({ connected: true, models, url });
  } catch(e) {
    res.json({ connected: false, models: [], error: e.message });
  }
});

/* ─── FINE-TUNING ───────────────────────────────── */

// GET /api/models/finetune — list jobs
router.get('/finetune', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query(
      'SELECT * FROM fine_tuning_jobs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20',
      [req.userId]
    );
    res.json({ jobs: r.rows });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/models/finetune/prepare — generate training data from agent history
router.post('/finetune/prepare', auth, async (req, res) => {
  const pool = getPool(req);
  const { agentId } = req.body;
  if (!agentId) return res.status(400).json({ error: 'agentId fehlt' });

  const check = await pool.query('SELECT id FROM agents WHERE id=$1 AND user_id=$2', [agentId, req.userId]);
  if (!check.rows.length) return res.status(403).json({ error: 'Nicht berechtigt' });

  try {
    const { systemPrompt, examples, count } = await generateTrainingDataFromHistory(pool, agentId);
    const jsonl = buildTrainingData(systemPrompt, examples);

    res.json({
      count,
      preview: examples.slice(0, 3),
      jsonl: jsonl.slice(0, 2000) + (jsonl.length > 2000 ? '\n...' : ''),
      ready: count >= 10,
      message: count < 10
        ? `Noch ${10 - count} Trainingspaare fehlen. Führe zuerst mehr Gespräche mit dem Agenten.`
        : `${count} Trainingspaare bereit für Fine-Tuning.`,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/models/finetune/start — upload + start fine-tuning
router.post('/finetune/start', auth, async (req, res) => {
  const pool = getPool(req);
  const { agentId, baseModel, name, openaiKey } = req.body;
  if (!agentId) return res.status(400).json({ error: 'agentId fehlt' });

  const check = await pool.query(
    'SELECT id,name FROM agents WHERE id=$1 AND user_id=$2', [agentId, req.userId]
  );
  if (!check.rows.length) return res.status(403).json({ error: 'Nicht berechtigt' });

  const apiKey = openaiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'OpenAI API Key erforderlich' });

  try {
    const { systemPrompt, examples, count } = await generateTrainingDataFromHistory(pool, agentId);
    if (count < 10) return res.status(400).json({ error: `Mindestens 10 Trainingspaare nötig. Aktuell: ${count}` });

    const jsonl = buildTrainingData(systemPrompt, examples);

    // Upload file to OpenAI
    const file = await uploadTrainingFile(jsonl, apiKey);

    // Start fine-tuning job
    const job = await startFineTuning(
      file.id,
      baseModel || 'gpt-4o-mini-2024-07-18',
      `ak-${check.rows[0].name.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,18)}`,
      apiKey
    );

    // Save to DB
    await pool.query(`
      INSERT INTO fine_tuning_jobs
        (user_id, agent_id, openai_job_id, file_id, name, base_model, status, training_pairs, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
    `, [req.userId, agentId, job.id, file.id, name || check.rows[0].name, baseModel || 'gpt-4o-mini-2024-07-18', job.status, count]);

    res.json({
      success: true,
      jobId: job.id,
      status: job.status,
      message: 'Fine-Tuning gestartet! Das dauert 10–60 Minuten. Du bekommst eine E-Mail wenn es fertig ist.',
    });
  } catch(e) {
    console.error('Fine-tune error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/models/finetune/:jobId/status — poll job status
router.get('/finetune/:jobId/status', auth, async (req, res) => {
  const pool = getPool(req);

  const dbJob = await pool.query(
    'SELECT * FROM fine_tuning_jobs WHERE openai_job_id=$1 AND user_id=$2',
    [req.params.jobId, req.userId]
  );
  if (!dbJob.rows.length) return res.status(404).json({ error: 'Job nicht gefunden' });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.json({ job: dbJob.rows[0] });

  try {
    const openaiJob = await getFineTuningJob(req.params.jobId, apiKey);

    // Update DB
    await pool.query(
      'UPDATE fine_tuning_jobs SET status=$1, fine_tuned_model=$2, error_msg=$3 WHERE openai_job_id=$4',
      [openaiJob.status, openaiJob.fine_tuned_model || null, openaiJob.error?.message || null, req.params.jobId]
    );

    // If succeeded — auto-assign to agent
    if (openaiJob.status === 'succeeded' && openaiJob.fine_tuned_model && dbJob.rows[0].agent_id) {
      await pool.query(
        'UPDATE agents SET model=$1 WHERE id=$2',
        [openaiJob.fine_tuned_model, dbJob.rows[0].agent_id]
      );
    }

    res.json({
      job: { ...dbJob.rows[0], status: openaiJob.status, fine_tuned_model: openaiJob.fine_tuned_model },
      openai: {
        status: openaiJob.status,
        model: openaiJob.fine_tuned_model,
        trainedTokens: openaiJob.trained_tokens,
        estimatedFinish: openaiJob.estimated_finish,
      }
    });
  } catch(e) {
    res.json({ job: dbJob.rows[0], error: e.message });
  }
});

module.exports = router;
