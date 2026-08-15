/**
 * Plan Gate Middleware & Helper
 * Free: 3 agents, 500 msg/month, 2 RAG docs/agent, no API/WA/TG/Webhooks
 * Pro:  unlimited agents, 10.000 msg/month, unlimited RAG, all channels
 */

const LIMITS = {
  free: {
    agents: 3,
    msgPerMonth: 500,
    ragDocsPerAgent: 2,
    api: false,
    whatsapp: false,
    telegram: false,
    webhooksOut: false,
    finetune: false,
  },
  pro: {
    agents: Infinity,
    msgPerMonth: 10000,
    ragDocsPerAgent: Infinity,
    api: true,
    whatsapp: true,
    telegram: true,
    webhooksOut: true,
    finetune: true,
  },
  enterprise: {
    agents: Infinity,
    msgPerMonth: Infinity,
    ragDocsPerAgent: Infinity,
    api: true,
    whatsapp: true,
    telegram: true,
    webhooksOut: true,
    finetune: true,
  },
};

function getLimits(plan) {
  return LIMITS[plan] || LIMITS.free;
}

/** Express middleware factory — gate a specific feature */
function requirePlan(feature) {
  return async (req, res, next) => {
    const pool = req.app.locals.pool;
    try {
      const r = await pool.query('SELECT plan FROM users WHERE id=$1', [req.userId]);
      if (!r.rows.length) return res.status(401).json({ error: 'Nicht autorisiert' });
      const limits = getLimits(r.rows[0].plan);
      if (!limits[feature]) {
        return res.status(403).json({
          error: 'Diese Funktion ist nur im Pro-Plan verfügbar.',
          upgrade: true,
          feature,
        });
      }
      req.userPlan = r.rows[0].plan;
      next();
    } catch (e) {
      res.status(500).json({ error: 'Fehler beim Prüfen des Plans' });
    }
  };
}

/** Check monthly message quota; increments counter */
async function checkMsgQuota(pool, userId) {
  const r = await pool.query(
    'SELECT plan, msg_count_month, msg_count_reset FROM users WHERE id=$1',
    [userId]
  );
  if (!r.rows.length) return { allowed: false };

  const user = r.rows[0];
  const limits = getLimits(user.plan);
  const now = new Date();
  const resetDate = new Date(user.msg_count_reset);

  // Reset counter if new month
  if (now.getMonth() !== resetDate.getMonth() || now.getFullYear() !== resetDate.getFullYear()) {
    await pool.query(
      'UPDATE users SET msg_count_month=1, msg_count_reset=$1 WHERE id=$2',
      [new Date(now.getFullYear(), now.getMonth(), 1), userId]
    );
    return { allowed: true, remaining: limits.msgPerMonth - 1 };
  }

  if (user.msg_count_month >= limits.msgPerMonth) {
    return {
      allowed: false,
      limit: limits.msgPerMonth,
      plan: user.plan,
    };
  }

  await pool.query('UPDATE users SET msg_count_month=msg_count_month+1 WHERE id=$1', [userId]);
  return { allowed: true, remaining: limits.msgPerMonth - user.msg_count_month - 1 };
}

/** Simple IP-based rate limiter using DB */
async function rateLimit(pool, key, maxPerHour = 60) {
  try {
    const r = await pool.query(
      'SELECT count, window_end FROM rate_limits WHERE key=$1',
      [key]
    );

    if (!r.rows.length) {
      await pool.query(
        'INSERT INTO rate_limits (key,count,window_end) VALUES ($1,1,NOW()+INTERVAL\'1 hour\')',
        [key]
      );
      return { allowed: true, remaining: maxPerHour - 1 };
    }

    const row = r.rows[0];
    if (new Date(row.window_end) < new Date()) {
      // Window expired — reset
      await pool.query(
        'UPDATE rate_limits SET count=1, window_end=NOW()+INTERVAL\'1 hour\' WHERE key=$1',
        [key]
      );
      return { allowed: true, remaining: maxPerHour - 1 };
    }

    if (row.count >= maxPerHour) {
      return { allowed: false, retryAfter: row.window_end };
    }

    await pool.query('UPDATE rate_limits SET count=count+1 WHERE key=$1', [key]);
    return { allowed: true, remaining: maxPerHour - row.count - 1 };
  } catch {
    return { allowed: true }; // Fail open
  }
}

module.exports = { getLimits, requirePlan, checkMsgQuota, rateLimit };
