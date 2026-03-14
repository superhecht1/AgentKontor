require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// DB
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Auto-migrate on startup
async function initDb() {
  const fs = require('fs');
  const sql = fs.readFileSync(path.join(__dirname, 'migrations/init.sql'), 'utf8');
  try {
    await pool.query(sql);
    console.log('✅ DB ready');
  } catch (e) {
    console.error('DB init error:', e.message);
  }
}

// Make pool available to routes
app.locals.pool = pool;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/api/auth',   require('./routes/auth'));
app.use('/api/agents', require('./routes/agents'));
app.use('/api/chat',   require('./routes/chat'));
app.use('/api/keys',   require('./routes/keys'));
app.use('/webhook',    require('./routes/webhooks'));

// Public chat page
app.get('/chat/:publicId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

// App dashboard
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});
app.get('/app/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// Landing page (root)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 404
app.get('*', (req, res) => {
  res.redirect('/');
});

initDb().then(() => {
  app.listen(PORT, () => console.log(`🚀 AgentKontor on port ${PORT}`));
});
