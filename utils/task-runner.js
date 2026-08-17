'use strict';
/**
 * task-runner.js
 * Status-Machine: pending → running → waiting → completed | failed
 * Hintergrundverarbeitung per setInterval (kein Bull/Queue nötig für MVP)
 */

const { getPool } = require('./db');

// ── Task erstellen ──────────────────────────────────────────────────────────
async function create(pool, {
  userId, agentId, sessionId,
  title, description = '',
  type = 'generic',
  payload = {},
  priority = 5,
  maxRetries = 3,
  scheduledAt,
  dependsOn,
}) {
  const r = await pool.query(
    `INSERT INTO agent_tasks
       (user_id, agent_id, session_id, title, description, type,
        payload, priority, max_retries, scheduled_at, depends_on)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [userId, agentId, sessionId||null, title, description, type,
     JSON.stringify(payload), priority, maxRetries,
     scheduledAt || new Date().toISOString(),
     dependsOn||null]
  );
  await log(pool, r.rows[0].id, 'info', `Task erstellt: ${title}`);
  return r.rows[0];
}

// ── Status-Übergang ─────────────────────────────────────────────────────────
async function transition(pool, taskId, newStatus, { result, errorMsg } = {}) {
  const now = new Date().toISOString();
  const updates = { status: newStatus, updated_at: now };
  if (newStatus === 'running')   updates.started_at   = now;
  if (newStatus === 'completed') updates.completed_at = now;
  if (newStatus === 'failed')    updates.completed_at = now;
  if (result)   updates.result    = JSON.stringify(result);
  if (errorMsg) updates.error_msg = errorMsg;

  const setClauses = Object.keys(updates).map((k, i) => `${k}=$${i + 2}`).join(', ');
  const values     = [taskId, ...Object.values(updates)];

  const r = await pool.query(
    `UPDATE agent_tasks SET ${setClauses} WHERE id=$1 RETURNING *`,
    values
  );
  await log(pool, taskId, newStatus === 'failed' ? 'error' : 'info',
    `Status → ${newStatus}${errorMsg ? ': ' + errorMsg : ''}`);
  return r.rows[0];
}

// ── Log-Eintrag ─────────────────────────────────────────────────────────────
async function log(pool, taskId, level, message, data) {
  try {
    await pool.query(
      'INSERT INTO task_logs (task_id,level,message,data) VALUES ($1,$2,$3,$4)',
      [taskId, level, message, data ? JSON.stringify(data) : null]
    );
  } catch {}
}

// ── Task-Logs laden ─────────────────────────────────────────────────────────
async function getLogs(pool, taskId, limit = 50) {
  const r = await pool.query(
    'SELECT * FROM task_logs WHERE task_id=$1 ORDER BY created_at DESC LIMIT $2',
    [taskId, limit]
  );
  return r.rows;
}

// ── Fällige Tasks abrufen ───────────────────────────────────────────────────
async function getPending(pool, limit = 10) {
  const r = await pool.query(
    `SELECT t.* FROM agent_tasks t
     WHERE t.status = 'pending'
       AND t.scheduled_at <= now()
       AND (t.depends_on IS NULL
            OR EXISTS (
              SELECT 1 FROM agent_tasks dep
              WHERE dep.id = t.depends_on AND dep.status = 'completed'
            ))
     ORDER BY t.priority ASC, t.scheduled_at ASC
     LIMIT $1
     FOR UPDATE SKIP LOCKED`,
    [limit]
  );
  return r.rows;
}

// ── Task-Handler Registry ───────────────────────────────────────────────────
const handlers = {};

function registerHandler(type, fn) {
  handlers[type] = fn;
}

// Standard-Handler registrieren
registerHandler('generic', async (task, pool) => {
  // Generische Aufgabe: nichts zu tun außer Kontext loggen
  return { message: 'Aufgabe abgeschlossen', payload: task.payload };
});

registerHandler('http_call', async (task, pool) => {
  const { url, method = 'POST', headers = {}, body } = task.payload;
  if (!url) throw new Error('URL fehlt im Payload');

  const resp = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body:    method !== 'GET' ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return { status: resp.status, data };
});

registerHandler('email', async (task, pool) => {
  const { to, subject, body } = task.payload;
  if (!to || !subject) throw new Error('to und subject sind Pflichtfelder');
  // In Produktion: nodemailer mit SMTP-Konfiguration des Users
  console.log(`[TASK:email] to=${to} subject=${subject}`);
  return { sent: true, to, subject };
});

registerHandler('rag_index', async (task, pool) => {
  const { agentId, docId } = task.payload;
  // Auslösen der RAG-Indizierung
  console.log(`[TASK:rag_index] agent=${agentId} doc=${docId}`);
  return { indexed: true, docId };
});

// ── Einzelnen Task ausführen ────────────────────────────────────────────────
async function runTask(pool, task) {
  await transition(pool, task.id, 'running');

  const handler = handlers[task.type] || handlers['generic'];
  try {
    const result = await handler(task, pool);
    await transition(pool, task.id, 'completed', { result });
    return { success: true, result };
  } catch (e) {
    const retryCount = (task.retry_count || 0) + 1;
    await pool.query(
      'UPDATE agent_tasks SET retry_count=$1 WHERE id=$2',
      [retryCount, task.id]
    );

    if (retryCount < (task.max_retries || 3)) {
      // Retry mit exponential backoff
      const delayMs = Math.min(60000, (task.retry_delay_s || 60) * 1000 * Math.pow(2, retryCount - 1));
      const retryAt = new Date(Date.now() + delayMs).toISOString();
      await pool.query(
        `UPDATE agent_tasks SET status='pending', scheduled_at=$1 WHERE id=$2`,
        [retryAt, task.id]
      );
      await log(pool, task.id, 'warn',
        `Fehler (Versuch ${retryCount}/${task.max_retries}), Retry um ${retryAt}`,
        { error: e.message });
    } else {
      await transition(pool, task.id, 'failed', { errorMsg: e.message });
    }
    return { success: false, error: e.message };
  }
}

// ── Hintergrund-Prozessor ───────────────────────────────────────────────────
let _runnerInterval = null;
let _isRunning = false;

async function startBackgroundRunner(intervalMs = 5000) {
  if (_runnerInterval) return;

  // Warten bis Tabelle existiert (Migration muss zuerst laufen)
  const pool = getPool();
  try {
    await pool.query('SELECT 1 FROM agent_tasks LIMIT 1');
  } catch {
    console.warn('[task-runner] Tabelle agent_tasks fehlt noch — warte auf Migration');
    setTimeout(() => startBackgroundRunner(intervalMs), 15000);
    return;
  }

  console.log(`[task-runner] Background-Runner gestartet (Intervall: ${intervalMs}ms)`);

  _runnerInterval = setInterval(async () => {
    if (_isRunning) return; // Kein paralleler Lauf
    _isRunning = true;
    try {
      const pool = getPool();
      await pool.query('BEGIN');
      const tasks = await getPending(pool, 5);
      await pool.query('COMMIT');

      for (const task of tasks) {
        await runTask(pool, task).catch(e =>
          console.error(`[task-runner] Task ${task.id} Fehler:`, e.message)
        );
      }
    } catch (e) {
      console.error('[task-runner] Runner-Fehler:', e.message);
      try {
        const pool = getPool();
        await pool.query('ROLLBACK').catch(() => {});
      } catch {}
    } finally {
      _isRunning = false;
    }
  }, intervalMs);
}

function stopBackgroundRunner() {
  if (_runnerInterval) {
    clearInterval(_runnerInterval);
    _runnerInterval = null;
    console.log('[task-runner] Background-Runner gestoppt');
  }
}

// ── Task-Liste für User ─────────────────────────────────────────────────────
async function list(pool, { userId, agentId, status, limit = 50, offset = 0 }) {
  const conditions = ['user_id=$1'];
  const params = [userId];
  let i = 2;
  if (agentId) { conditions.push(`agent_id=$${i++}`); params.push(agentId); }
  if (status)  { conditions.push(`status=$${i++}`);   params.push(status); }
  params.push(limit, offset);
  const r = await pool.query(
    `SELECT t.*, a.name as agent_name, a.emoji as agent_emoji
     FROM agent_tasks t
     LEFT JOIN agents a ON a.id = t.agent_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY t.created_at DESC
     LIMIT $${i} OFFSET $${i+1}`,
    params
  );
  return r.rows;
}

// ── Task abbrechen ──────────────────────────────────────────────────────────
async function cancel(pool, { taskId, userId }) {
  const r = await pool.query(
    `UPDATE agent_tasks SET status='cancelled', updated_at=now()
     WHERE id=$1 AND user_id=$2 AND status IN ('pending','waiting')
     RETURNING id`,
    [taskId, userId]
  );
  if (!r.rows.length) throw new Error('Task nicht gefunden oder nicht abbrechbar');
  await log(pool, taskId, 'info', 'Task abgebrochen');
  return true;
}

const taskRunner = {
  create, transition, log, getLogs,
  getPending, runTask,
  startBackgroundRunner, stopBackgroundRunner,
  list, cancel, registerHandler,
};

module.exports = { taskRunner };
