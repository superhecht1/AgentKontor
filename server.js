require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initDb() {
  const fs = require('fs');
  const sqls = ['migrations/init.sql', 'migrations/add_rag.sql', 'migrations/add_capabilities.sql'];
  for (const file of sqls) {
    try {
      const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');
      await pool.query(sql);
    } catch (e) {
      // Ignore "already exists" errors from IF NOT EXISTS
      if (!e.message.includes('already exists') && !e.message.includes('does not exist')) {
        console.warn('Migration warning (' + file + '):', e.message);
      }
    }
  }
  console.log('✅ DB ready');
}

app.locals.pool = pool;

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Core routes
app.use('/api/auth',   require('./routes/auth'));
app.use('/api/agents', require('./routes/agents'));
app.use('/api/chat',   require('./routes/chat'));
app.use('/api/keys',   require('./routes/keys'));
app.use('/webhook',    require('./routes/webhooks'));

// RAG — graceful fallback if multer not installed yet
try {
  app.use('/api/rag', require('./routes/rag'));
  console.log('✅ RAG routes loaded');
} catch (e) {
  console.warn('⚠️  RAG skipped (run npm install):', e.message);
  app.use('/api/rag', (req, res) => res.status(503).json({ error: 'RAG not available — run npm install' }));
}

// Pages
app.get('/chat/:publicId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));
app.get('/app/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('*', (req, res) => res.redirect('/'));

initDb().then(() => {
  app.listen(PORT, () => console.log(`🚀 AgentKontor on port ${PORT}`));
});
// Capabilities migration runs on startup
