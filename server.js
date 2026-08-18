require('dotenv').config();
const cookieParser = require('cookie-parser');
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { Pool } = require('pg');

const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET', 'ANTHROPIC_API_KEY'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) throw new Error(`❌ Env var fehlt: ${key}`);
}

const app  = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max:                    parseInt(process.env.DB_POOL_MAX)    || 20,  // FIX 11: bigger pool
  idleTimeoutMillis:      parseInt(process.env.DB_IDLE_MS)    || 30000,
  connectionTimeoutMillis:parseInt(process.env.DB_CONNECT_MS) || 5000, // FIX 4: fail fast
  statement_timeout:      parseInt(process.env.DB_STMT_MS)    || 30000,
});

async function initDb() {
  const fs = require('fs');

  // FIX 11: Migration versioning — track which migrations have run
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    VARCHAR(128) PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});

  const sqls = [
    'migrations/init.sql',
    'migrations/add_rag.sql',
    'migrations/add_capabilities.sql',
    'migrations/add_identity.sql',
    'migrations/add_models.sql',
    'migrations/add_features.sql',
    'migrations/add_extras.sql',
    'migrations/add_security.sql',
    'migrations/add_reset.sql',
    'migrations/add_privacy.sql',
    'migrations/add_features2.sql',
    'migrations/add_features3.sql',
    'migrations/add_features4.sql',
    'migrations/add_features5.sql',
    'migrations/add_privacy2.sql',
    'migrations/add_security2.sql',
    'migrations/add_features6.sql',
    'migrations/add_indexes.sql',
    'migrations/004_add_missing_agent_columns.sql',
    'migrations/005_agent_phase1.sql',
    'migrations/006_planner_approvals.sql',
    'migrations/007_integrations_webagent.sql',
    'migrations/008_multi_agent.sql',
    'migrations/009_marketplace.sql',
    'migrations/010_goal_engine.sql',
  ];
  for (const file of sqls) {
    const fp = path.join(__dirname, file);
    if (!fs.existsSync(fp)) continue;
    try {
      // Check if already applied
      const applied = await pool.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [file]);
      if (applied.rows.length) { continue; }

      const sql   = fs.readFileSync(fp, 'utf8');
      const stmts = sql.split(';').map(s => s.trim()).filter(s => s.length > 3 && !s.startsWith('--'));
      for (const stmt of stmts) {
        try { await pool.query(stmt); }
        catch(e) {
          const m = e.message;
          if (m.includes('already exists') || m.includes('does not exist') ||
              m.includes('duplicate') || m.includes('extension') ||
              m.includes('ivfflat') || m.includes('vector')) continue;
          console.warn(`  ⚠ ${file}: ${m.slice(0,100)}`);
        }
      }
      await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
      console.log('✅ Migration applied:', file);
    } catch(e) { console.error('❌ Migration failed:', file, e.message); }
  }
  console.log('✅ DB ready');
}

app.locals.pool = pool;

// Helmet + CSP
try {
  const helmet = require('helmet');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc:  ["'self'"],
        scriptSrc:   ["'self'", "'unsafe-eval'", "'unsafe-inline'", "unpkg.com", "cdnjs.cloudflare.com"],
        styleSrc:    ["'self'", "'unsafe-inline'", "fonts.googleapis.com"],
        fontSrc:     ["'self'", "fonts.gstatic.com", "data:"],
        imgSrc:      ["'self'", "data:", "https:"],
        connectSrc:  ["'self'"],
        frameSrc:    ["'none'"],
        objectSrc:   ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
} catch { console.warn('⚠ helmet nicht installiert'); }

// Stripe raw body before json
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

const allowedOrigin = process.env.CORS_ORIGIN ||
  (process.env.NODE_ENV === 'production' ? 'https://agentkontor.de' : '*');

// FIX 1: Widget endpoints need open CORS (embedded on any customer domain)
// App/Auth endpoints stay restricted
app.use('/api/chat/stream', cors({ origin: '*', credentials: false }));
app.use('/api/chat/web',    cors({ origin: '*', credentials: false }));
app.use('/api/chat/widget-config', cors({ origin: '*', credentials: false }));
app.use('/api/widget',      cors({ origin: '*', credentials: false }));
app.use('/api/voice/speak', cors({ origin: '*', credentials: false }));

// All other endpoints: restricted CORS
app.use(cors({ origin: allowedOrigin, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '5mb' }));
// FIX 5: Compression middleware (gzip/br)
try {
  const compression = require('compression');
  app.use(compression({ threshold: 1024 })); // only compress >1KB
} catch { console.warn('compression not installed: npm install compression'); }

app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint
app.get('/og-image.png', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(require('path').join(__dirname, 'public', 'og-image.svg'));
});

app.get('/health', async (req, res) => {
  const start = Date.now();
  try {
    await pool.query('SELECT 1');
    const dbMs = Date.now() - start;
    const memMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    res.json({
      status: dbMs < 2000 ? 'ok' : 'degraded',
      db: 'connected', db_ms: dbMs,
      uptime: Math.round(process.uptime()),
      memory_mb: memMb,
      ts: new Date().toISOString(),
    });
  } catch(e) {
    res.status(503).json({ status: 'error', db: 'disconnected', db_ms: Date.now()-start });
  }
});

// Auth rate limiter — fail CLOSED
const authLimiter = async (req, res, next) => {
  try {
    const { rateLimit } = require('./middleware/plan-gate');
    const ip = req.ip || 'unknown';
    const r  = await rateLimit(pool, `auth:${ip}`, 30);
    if (!r.allowed) return res.status(429).json({ error: 'Zu viele Anfragen. Bitte später versuchen.' });
    next();
  } catch(e) {
    console.error('Rate limiter error:', e.message);
    return res.status(503).json({ error: 'Dienst vorübergehend nicht verfügbar' });
  }
};

// ── ROUTES ──────────────────────────────────────────────
app.use('/api/auth',          authLimiter, require('./routes/auth'));
app.use('/api/auth',          require('./routes/auth-extra'));
app.use('/api/agents',        require('./routes/agents'));
app.use('/api/chat',          require('./routes/chat'));
app.use('/api/keys',          require('./routes/keys'));
app.use('/api/analytics',     require('./routes/analytics'));
app.use('/api/account',       require('./routes/account'));
app.use('/api/stripe',        require('./routes/stripe'));
app.use('/api/webhooks-out',  require('./routes/webhooks-out'));
app.use('/api/conversations', require('./routes/conversations'));
app.use('/api/admin',         require('./routes/admin'));
app.use('/api/finetune',      require('./routes/finetune'));
app.use('/api/identity',      require('./routes/identity'));
app.use('/api/models',        require('./routes/model-api'));
app.use('/webhook',           require('./routes/webhooks'));
app.use('/api',               require('./routes/extras'));
app.use('/api/voice',         require('./routes/voice'));
app.use('/api/actions',       require('./routes/actions'));
app.use('/api/workspace',     require('./routes/workspace'));
app.use('/api/auth',          require('./routes/twofa'));
app.use('/api/referral',      require('./routes/referral'));
app.use('/api/invoices',      require('./routes/invoices'));
app.use('/webhook',           require('./routes/social-webhooks'));
app.use('/webhook',           require('./routes/slack-webhook')); // feedback, cron, changelog, handoff, versions

// ── Phase 1: Tool-System, Memory, Task-Engine ──────────────────────────────
app.use('/api/tools',     require('./routes/tools'));
app.use('/api/memory',    require('./routes/memory'));
app.use('/api/tasks',     require('./routes/tasks'));

// ── Phase 2: Planner, Approval-System ──────────────────────────────────────
app.use('/api/planner',        require('./routes/planner'));
app.use('/api/approvals',      require('./routes/approvals'));

// ── Phase 3+4: Integrations, Web-Agent ─────────────────────────────────────
app.use('/api/integrations',   require('./routes/integrations'));
app.use('/api/web',            require('./routes/web-agent'));

// ── Phase 5: Super Agent / Multi-Agent ─────────────────────────────────────
app.use('/api/super',          require('./routes/super-agent'));

// ── Agent Marketplace ───────────────────────────────────────────────────────
app.use('/api/marketplace',    require('./routes/marketplace'));

// ── Super Agent Mode: Goal Engine ──────────────────────────────────────────
app.use('/api/goals',          require('./routes/goals'));

try {
  app.use('/api/rag', require('./routes/rag'));
  console.log('✅ RAG routes loaded');
} catch(e) {
  console.warn('⚠️  RAG skipped:', e.message);
  app.use('/api/rag', (req, res) => res.status(503).json({ error: 'RAG not available' }));
}

// ── PAGES ────────────────────────────────────────────────
app.get('/chat/:publicId',          (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));
app.get('/app',                     (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));
app.get('/app/*',                   (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));
app.get('/admin',                   (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/docs',                    (req, res) => res.sendFile(path.join(__dirname, 'public', 'docs.html')));
app.get('/docs.html',               (req, res) => res.sendFile(path.join(__dirname, 'public', 'docs.html')));
app.get('/avv.html',                (req, res) => res.sendFile(path.join(__dirname, 'public', 'avv.html')));
app.get('/cookie-richtlinie.html',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'cookie-richtlinie.html')));
app.get('/impressum.html',          (req, res) => res.sendFile(path.join(__dirname, 'public', 'impressum.html')));
app.get('/datenschutz.html',        (req, res) => res.sendFile(path.join(__dirname, 'public', 'datenschutz.html')));
app.get('/agb.html',                (req, res) => res.sendFile(path.join(__dirname, 'public', 'agb.html')));
app.get('/',                        (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
// FIX 10: API 404 handler — return JSON not HTML
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: `Endpoint nicht gefunden: ${req.method} ${req.originalUrl}` });
});

app.get('*',                        (req, res) => res.redirect('/'));

// FIX 6: Global error handler middleware (must be last)
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Interner Serverfehler' : err.message,
  });
});

initDb().then(async () => {
  // Ensure all required DB columns exist (idempotent, runs once at startup)
  try {
    const { ensureColumnsOnce } = require('./routes/auth');
    await ensureColumnsOnce(pool);
    console.log('✅ DB columns verified');
  } catch(e) { console.warn('ensureColumns:', e.message); }

  const server = app.listen(PORT, () => {
    console.log(`🚀 AgentKontor on port ${PORT}`);
    // Task-Engine Hintergrundprozessor starten (alle 5s nach fälligen Tasks schauen)
    try {
      const { taskRunner } = require('./utils/task-runner');
      taskRunner.startBackgroundRunner(5000);
    } catch(e) { console.warn('[task-runner] Start fehlgeschlagen:', e.message); }
  });

  // FIX 10: Graceful shutdown — close DB pool and server cleanly
  async function shutdown(signal) {
    console.log(`${signal} received — shutting down gracefully`);
    server.close(async () => {
      try { await pool.end(); console.log('DB pool closed'); } catch {}
      process.exit(0);
    });
    // Force exit after 10s
    setTimeout(() => { console.error('Forced shutdown'); process.exit(1); }, 10000);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('uncaughtException', (e) => { console.error('Uncaught:', e.message); });
  process.on('unhandledRejection', (r) => { console.error('Unhandled:', r); });
});
