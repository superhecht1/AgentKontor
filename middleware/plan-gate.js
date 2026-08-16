/**
 * AgentKontor — Plan Gate Middleware
 * Plans: free | pro (trial) | enterprise
 * Supports: 14-day trial, Enterprise unlimited
 */

const LIMITS = {
  free: {
    agents: 3, msgPerMonth: 500, ragDocsPerAgent: 2,
    api: false, whatsapp: false, telegram: false, instagram: false, facebook: false,
    webhooksOut: false, finetune: false, voice: false, actions: false, workspace: false,
  },
  pro: {
    agents: Infinity, msgPerMonth: 10000, ragDocsPerAgent: Infinity,
    api: true, whatsapp: true, telegram: true, instagram: true, facebook: true,
    webhooksOut: true, finetune: true, voice: true, actions: true, workspace: true,
  },
  enterprise: {
    agents: Infinity, msgPerMonth: Infinity, ragDocsPerAgent: Infinity,
    api: true, whatsapp: true, telegram: true, instagram: true, facebook: true,
    webhooksOut: true, finetune: true, voice: true, actions: true, workspace: true,
  },
};

function getLimits(plan) {
  return LIMITS[plan] || LIMITS.free;
}

/** Check if user is in active trial → treat as pro */
function isTrialActive(user) {
  if (!user.trial_ends_at) return false;
  return new Date(user.trial_ends_at) > new Date();
}

/** Get effective plan (includes trial) */
function effectivePlan(user) {
  if (isTrialActive(user)) return 'pro';
  return user.plan || 'free';
}

/** Express middleware factory */
function requirePlan(feature) {
  return async (req, res, next) => {
    const pool = req.app.locals.pool;
    try {
      const r = await pool.query(
        'SELECT plan, trial_ends_at FROM users WHERE id=$1 AND deleted_at IS NULL',
        [req.userId]
      );
      if (!r.rows.length) return res.status(401).json({ error: 'Nicht autorisiert' });
      const plan   = effectivePlan(r.rows[0]);
      const limits = getLimits(plan);
      if (!limits[feature]) {
        return res.status(403).json({
          error: 'Diese Funktion ist nur im Pro-Plan verfügbar.',
          upgrade: true, feature,
        });
      }
      req.userPlan = plan;
      next();
    } catch(e) {
      res.status(500).json({ error: 'Fehler beim Prüfen des Plans' });
    }
  };
}

/** Check monthly message quota; also respects trial */
async function checkMsgQuota(pool, userId) {
  const r = await pool.query(
    'SELECT plan, trial_ends_at, msg_count_month, msg_count_reset FROM users WHERE id=$1 AND deleted_at IS NULL',
    [userId]
  );
  if (!r.rows.length) return { allowed: false };

  const user   = r.rows[0];
  const plan   = effectivePlan(user);
  const limits = getLimits(plan);

  if (limits.msgPerMonth === Infinity) {
    await pool.query('UPDATE users SET msg_count_month=msg_count_month+1 WHERE id=$1', [userId]);
    return { allowed: true, remaining: Infinity };
  }

  const now = new Date();
  const resetDate = new Date(user.msg_count_reset || 0);
  if (now.getMonth() !== resetDate.getMonth() || now.getFullYear() !== resetDate.getFullYear()) {
    await pool.query(
      'UPDATE users SET msg_count_month=1, msg_count_reset=$1 WHERE id=$2',
      [new Date(now.getFullYear(), now.getMonth(), 1), userId]
    );
    return { allowed: true, remaining: limits.msgPerMonth - 1 };
  }

  if (user.msg_count_month >= limits.msgPerMonth) {
    return { allowed: false, limit: limits.msgPerMonth, plan };
  }

  // Atomic increment with ceiling check — prevents race condition on concurrent requests
  const updated = await pool.query(
    'UPDATE users SET msg_count_month=msg_count_month+1 WHERE id=$1 AND msg_count_month < $2 RETURNING msg_count_month',
    [userId, limits.msgPerMonth]
  );
  if (!updated.rows.length) return { allowed: false, limit: limits.msgPerMonth, plan };
  return { allowed: true, remaining: limits.msgPerMonth - updated.rows[0].msg_count_month };
}

/** IP-based rate limiter using DB */
async function rateLimit(pool, key, maxPerHour = 60) {
  try {
    const r = await pool.query('SELECT count, window_end FROM rate_limits WHERE key=$1', [key]);
    if (!r.rows.length) {
      await pool.query("INSERT INTO rate_limits (key,count,window_end) VALUES ($1,1,NOW()+INTERVAL'1 hour')", [key]);
      return { allowed: true, remaining: maxPerHour - 1 };
    }
    const row = r.rows[0];
    if (new Date(row.window_end) < new Date()) {
      await pool.query("UPDATE rate_limits SET count=1, window_end=NOW()+INTERVAL'1 hour' WHERE key=$1", [key]);
      return { allowed: true, remaining: maxPerHour - 1 };
    }
    if (row.count >= maxPerHour) return { allowed: false, retryAfter: row.window_end };
    await pool.query('UPDATE rate_limits SET count=count+1 WHERE key=$1', [key]);
    return { allowed: true, remaining: maxPerHour - row.count - 1 };
  } catch { return { allowed: true }; }
}

/** Log audit event (non-blocking) */
async function auditLog(pool, userId, action, entity = null, entityId = null, metadata = {}, ip = null) {
  try {
    await pool.query(
      'INSERT INTO audit_log (user_id, action, entity, entity_id, metadata, ip_address) VALUES ($1,$2,$3,$4,$5,$6)',
      [userId, action, entity, entityId, JSON.stringify(metadata), ip]
    );
  } catch { /* non-critical */ }
}

module.exports = { getLimits, requirePlan, checkMsgQuota, rateLimit, auditLog, effectivePlan, isTrialActive };
