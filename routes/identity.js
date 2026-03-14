const router = require('express').Router();
const auth = require('../middleware/auth');
const https = require('https');

function getPool(req) { return req.app.locals.pool; }

/* ─── GET /api/identity/:agentId ─── */
router.get('/:agentId', auth, async (req, res) => {
  const pool = getPool(req);
  const check = await pool.query('SELECT id FROM agents WHERE id=$1 AND user_id=$2', [req.params.agentId, req.userId]);
  if (!check.rows.length) return res.status(403).json({ error: 'Nicht berechtigt' });

  const r = await pool.query('SELECT * FROM agent_identities WHERE agent_id=$1', [req.params.agentId]);
  if (!r.rows.length) return res.json({ identity: null });

  // Never expose tokens to frontend
  const { google_access_token, google_refresh_token, calendly_token, credentials, smtp_pass, ...safe } = r.rows[0];
  safe.has_google   = !!google_access_token;
  safe.has_calendly = !!calendly_token;

  res.json({ identity: safe });
});

/* ─── POST /api/identity/:agentId ─── Setup/update identity ─── */
router.post('/:agentId', auth, async (req, res) => {
  const pool = getPool(req);
  const { agentId } = req.params;
  const check = await pool.query('SELECT id FROM agents WHERE id=$1 AND user_id=$2', [agentId, req.userId]);
  if (!check.rows.length) return res.status(403).json({ error: 'Nicht berechtigt' });

  const { display_name, email_address, google_calendar_id, calendly_token } = req.body;

  try {
    await pool.query(`
      INSERT INTO agent_identities (agent_id, display_name, email_address, google_calendar_id, calendly_token, is_configured)
      VALUES ($1,$2,$3,$4,$5,true)
      ON CONFLICT (agent_id) DO UPDATE SET
        display_name=$2, email_address=$3, google_calendar_id=$4,
        calendly_token=COALESCE($5, agent_identities.calendly_token),
        is_configured=true, updated_at=NOW()
    `, [agentId, display_name || '', email_address || null, google_calendar_id || null, calendly_token || null]);

    await pool.query('UPDATE agents SET has_identity=true WHERE id=$1', [agentId]);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

/* ─── GET /api/identity/:agentId/google/auth ─── Start Google OAuth ─── */
router.get('/:agentId/google/auth', auth, async (req, res) => {
  const { agentId } = req.params;
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'GOOGLE_CLIENT_ID nicht konfiguriert' });

  const redirectUri = `${process.env.APP_URL || 'https://your-app.onrender.com'}/api/identity/${agentId}/google/callback`;
  const scopes = [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ].join(' ');

  const url = `https://accounts.google.com/o/oauth2/v2/auth?` + new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         scopes,
    access_type:   'offline',
    prompt:        'consent',
    state:         `${agentId}:${req.userId}`,
  });

  res.redirect(url);
});

/* ─── GET /api/identity/:agentId/google/callback ─── Google OAuth callback ─── */
router.get('/:agentId/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const { agentId } = req.params;
  const pool = req.app.locals.pool;

  if (error) return res.redirect(`/app?error=google_auth_failed`);
  if (!code)  return res.redirect(`/app?error=no_code`);

  const redirectUri = `${process.env.APP_URL || 'https://your-app.onrender.com'}/api/identity/${agentId}/google/callback`;

  const body = JSON.stringify({
    code,
    client_id:     process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri:  redirectUri,
    grant_type:    'authorization_code',
  });

  try {
    const tokens = await new Promise((resolve, reject) => {
      const req2 = https.request({
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, r => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => resolve(JSON.parse(d)));
      });
      req2.on('error', reject);
      req2.write(body);
      req2.end();
    });

    if (!tokens.access_token) throw new Error('No access token: ' + JSON.stringify(tokens));

    // Get user info
    const userInfo = await new Promise((resolve, reject) => {
      const req3 = https.request({
        hostname: 'www.googleapis.com',
        path: '/oauth2/v2/userinfo',
        headers: { 'Authorization': `Bearer ${tokens.access_token}` }
      }, r => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => resolve(JSON.parse(d)));
      });
      req3.on('error', reject);
      req3.end();
    });

    const expiry = new Date(Date.now() + (tokens.expires_in || 3600) * 1000);

    await pool.query(`
      INSERT INTO agent_identities (agent_id, display_name, email_address, google_access_token, google_refresh_token, google_token_expiry, google_scopes, is_configured)
      VALUES ($1,$2,$3,$4,$5,$6,$7,true)
      ON CONFLICT (agent_id) DO UPDATE SET
        display_name=COALESCE($2, agent_identities.display_name),
        email_address=COALESCE($3, agent_identities.email_address),
        google_access_token=$4,
        google_refresh_token=COALESCE($5, agent_identities.google_refresh_token),
        google_token_expiry=$6,
        google_scopes=$7,
        is_configured=true,
        updated_at=NOW()
    `, [
      agentId,
      userInfo.name || '',
      userInfo.email || null,
      tokens.access_token,
      tokens.refresh_token || null,
      expiry,
      tokens.scope || '',
    ]);

    await pool.query('UPDATE agents SET has_identity=true WHERE id=$1', [agentId]);
    res.redirect(`/app?success=google_connected&agent=${agentId}`);
  } catch(e) {
    console.error('Google OAuth error:', e);
    res.redirect(`/app?error=google_auth_error`);
  }
});

/* ─── DELETE /api/identity/:agentId/google ─── Disconnect Google ─── */
router.delete('/:agentId/google', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    await pool.query(`
      UPDATE agent_identities SET
        google_access_token=NULL, google_refresh_token=NULL,
        google_token_expiry=NULL, google_scopes=NULL
      WHERE agent_id=$1
    `, [req.params.agentId]);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

/* ─── GET /api/identity/:agentId/actions ─── Action history ─── */
router.get('/:agentId/actions', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query(
      'SELECT id,action_type,status,action_data,result,error_msg,created_at FROM agent_actions WHERE agent_id=$1 ORDER BY created_at DESC LIMIT 50',
      [req.params.agentId]
    );
    res.json({ actions: r.rows });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
