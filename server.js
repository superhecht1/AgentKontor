require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
});

async function initDb() {
  const fs   = require('fs');
  const sqls = [
    'migrations/init.sql',
    'migrations/add_rag.sql',
    'migrations/add_capabilities.sql',
    'migrations/add_identity.sql',
    'migrations/add_models.sql',
    'migrations/add_features.sql',
    'migrations/add_extras.sql',
  ];
  for (const file of sqls) {
    const fp = path.join(__dirname, file);
    if (!fs.existsSync(fp)) continue;
    try {
      const sql = fs.readFileSync(fp, 'utf8');
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
      console.log('✅ Migration:', file);
    } catch(e) { console.error('❌ Migration failed:', file, e.message); }
  }
  console.log('✅ DB ready');
}

app.locals.pool = pool;

// Stripe webhook raw body — must be BEFORE express.json()
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: true }));
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Auth rate limiter
const authLimiter = async (req, res, next) => {
  try {
    const { rateLimit } = require('./middleware/plan-gate');
    const ip = req.ip || 'unknown';
    const r = await rateLimit(pool, `auth:${ip}`, 30);
    if (!r.allowed) return res.status(429).json({ error: 'Zu viele Anfragen. Bitte später erneut versuchen.' });
    next();
  } catch { next(); }
};

// ── ROUTES ──────────────────────────────────────────────────────
app.use('/api/auth',          authLimiter, require('./routes/auth'));
app.use('/api/agents',        require('./routes/agents'));
app.use('/api/chat',          require('./routes/chat'));
app.use('/api/keys',          require('./routes/keys'));
app.use('/api/analytics',     require('./routes/analytics'));
app.use('/api/account',       require('./routes/account'));
app.use('/api/stripe',        require('./routes/stripe'));
app.use('/api/webhooks-out',  require('./routes/webhooks-out'));
app.use('/api/conversations', require('./routes/conversations'));
app.use('/api/admin',         require('./routes/admin'));
app.use('/api/identity',      require('./routes/identity'));
app.use('/api/models',        require('./routes/model-api'));
app.use('/webhook',           require('./routes/webhooks'));

try {
  app.use('/api/rag', require('./routes/rag'));
  console.log('✅ RAG routes loaded');
} catch(e) {
  console.warn('⚠️  RAG skipped:', e.message);
  app.use('/api/rag', (req, res) => res.status(503).json({ error: 'RAG not available' }));
}

// ── PAGES ────────────────────────────────────────────────────────
app.get('/chat/:publicId',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));
app.get('/app',               (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));
app.get('/app/*',             (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));
app.get('/admin',             (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/impressum.html',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'impressum.html')));
app.get('/datenschutz.html',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'datenschutz.html')));
app.get('/agb.html',          (req, res) => res.sendFile(path.join(__dirname, 'public', 'agb.html')));
app.get('/',                  (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('*',                  (req, res) => res.redirect('/'));

initDb().then(() => {
  app.listen(PORT, () => console.log(`🚀 AgentKontor on port ${PORT}`));
});
