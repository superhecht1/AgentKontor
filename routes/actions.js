/**
 * AgentKontor — Action Engine
 * Handles real-world actions: calendar, email, calendly, forms
 */

const https = require('https');
const http  = require('http');

/* ─────────────────────────────────────────────────────
   IDENTITY LOADER
───────────────────────────────────────────────────── */
async function getIdentity(pool, agentId) {
  const r = await pool.query(
    'SELECT * FROM agent_identities WHERE agent_id=$1', [agentId]
  );
  return r.rows[0] || null;
}

/* ─────────────────────────────────────────────────────
   GOOGLE TOKEN REFRESH
───────────────────────────────────────────────────── */
async function refreshGoogleToken(pool, identity) {
  if (!identity.google_refresh_token) return null;

  // Check if still valid
  if (identity.google_token_expiry && new Date(identity.google_token_expiry) > new Date(Date.now() + 60000)) {
    return identity.google_access_token;
  }

  const body = JSON.stringify({
    client_id:     process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: identity.google_refresh_token,
    grant_type:    'refresh_token',
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', async () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.access_token) {
            const expiry = new Date(Date.now() + parsed.expires_in * 1000);
            await pool.query(
              'UPDATE agent_identities SET google_access_token=$1, google_token_expiry=$2 WHERE agent_id=$3',
              [parsed.access_token, expiry, identity.agent_id]
            );
            resolve(parsed.access_token);
          } else {
            reject(new Error('Token refresh failed: ' + data));
          }
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/* ─────────────────────────────────────────────────────
   GOOGLE CALENDAR — Create Event
───────────────────────────────────────────────────── */
async function createCalendarEvent(pool, identity, eventData) {
  const token = await refreshGoogleToken(pool, identity);
  if (!token) throw new Error('Google nicht verbunden');

  const calendarId = identity.google_calendar_id || 'primary';
  const event = {
    summary:     eventData.title || 'Termin',
    description: eventData.description || '',
    location:    eventData.location || '',
    start: {
      dateTime: eventData.startTime,  // ISO 8601
      timeZone: eventData.timeZone || 'Europe/Berlin',
    },
    end: {
      dateTime: eventData.endTime,
      timeZone: eventData.timeZone || 'Europe/Berlin',
    },
    attendees: eventData.attendees?.map(email => ({ email })) || [],
    reminders: {
      useDefault: false,
      overrides: [{ method: 'email', minutes: 1440 }, { method: 'popup', minutes: 30 }],
    },
    conferenceData: eventData.videoCall ? {
      createRequest: { requestId: Date.now().toString(), conferenceSolutionKey: { type: 'hangoutsMeet' } }
    } : undefined,
  };

  const body = JSON.stringify(event);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'www.googleapis.com',
      path: `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?conferenceDataVersion=1&sendUpdates=all`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.id) resolve({ eventId: parsed.id, link: parsed.htmlLink, meetLink: parsed.hangoutLink });
          else reject(new Error('Kalender-Fehler: ' + JSON.stringify(parsed)));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/* ─────────────────────────────────────────────────────
   GMAIL — Send Email as Agent
───────────────────────────────────────────────────── */
async function sendGmail(pool, identity, emailData) {
  const token = await refreshGoogleToken(pool, identity);
  if (!token) throw new Error('Google nicht verbunden');

  // Build RFC 2822 message
  const from = identity.email_address || identity.display_name || 'Agent';
  const boundary = 'boundary_' + Date.now();
  const message = [
    `From: ${identity.display_name || 'Agent'} <${from}>`,
    `To: ${emailData.to}`,
    `Subject: ${emailData.subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    emailData.body,
  ].join('\r\n');

  const encoded = Buffer.from(message).toString('base64url');
  const body = JSON.stringify({ raw: encoded });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'gmail.googleapis.com',
      path: '/gmail/v1/users/me/messages/send',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.id) resolve({ messageId: parsed.id });
          else reject(new Error('Gmail-Fehler: ' + JSON.stringify(parsed)));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/* ─────────────────────────────────────────────────────
   CALENDLY — Get available slots + book
───────────────────────────────────────────────────── */
async function getCalendlySlots(identity, eventTypeUri) {
  if (!identity.calendly_token) throw new Error('Calendly nicht verbunden');

  const startTime = new Date().toISOString();
  const endTime = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.calendly.com',
      path: `/event_type_available_times?event_type=${encodeURIComponent(eventTypeUri)}&start_time=${startTime}&end_time=${endTime}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${identity.calendly_token}`,
        'Content-Type': 'application/json',
      }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const slots = parsed.collection?.map(s => ({
            startTime: s.start_time,
            inviteesRemaining: s.invitees_remaining,
          })).slice(0, 10) || [];
          resolve(slots);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function createCalendlyInvite(identity, eventTypeUri, inviteeData) {
  if (!identity.calendly_token) throw new Error('Calendly nicht verbunden');

  const body = JSON.stringify({
    event_type_uuid: eventTypeUri,
    start_time: inviteeData.startTime,
    invitee: {
      name: inviteeData.name,
      email: inviteeData.email,
      timezone: inviteeData.timezone || 'Europe/Berlin',
    },
    ...(inviteeData.notes ? { event: { notes: inviteeData.notes } } : {}),
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.calendly.com',
      path: '/scheduled_events',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${identity.calendly_token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.resource) resolve({ eventUri: parsed.resource.uri, startTime: parsed.resource.start_time });
          else reject(new Error('Calendly-Fehler: ' + JSON.stringify(parsed)));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/* ─────────────────────────────────────────────────────
   FORM FILLING — Playwright headless browser
───────────────────────────────────────────────────── */
async function fillForm(url, fields) {
  let playwright;
  try {
    playwright = require('playwright');
  } catch(e) {
    throw new Error('Playwright nicht installiert. Führe: npm install playwright aus.');
  }

  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    for (const field of fields) {
      try {
        if (field.selector) {
          await page.waitForSelector(field.selector, { timeout: 5000 });
          const el = await page.$(field.selector);
          if (!el) continue;

          const tagName = await el.evaluate(e => e.tagName.toLowerCase());
          const type = await el.evaluate(e => e.type?.toLowerCase() || '');

          if (tagName === 'select') {
            await page.selectOption(field.selector, field.value);
          } else if (type === 'checkbox' || type === 'radio') {
            if (field.value === true || field.value === 'true') await page.check(field.selector);
          } else {
            await page.fill(field.selector, String(field.value));
          }
        } else if (field.label) {
          // Try to find by label text
          await page.getByLabel(field.label, { exact: false }).fill(String(field.value)).catch(() => {});
        }
      } catch(fieldErr) {
        console.warn(`Form field error (${field.selector || field.label}):`, fieldErr.message);
      }
    }

    // Take screenshot before submit
    const screenshot = await page.screenshot({ type: 'png', fullPage: false });
    const screenshotB64 = screenshot.toString('base64');

    // Submit if requested
    let submitResult = null;
    if (fields.find(f => f.action === 'submit')) {
      const submitBtn = await page.$('[type="submit"], button[type="submit"], input[type="submit"]');
      if (submitBtn) {
        await submitBtn.click();
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        submitResult = { url: page.url(), title: await page.title() };
      }
    }

    return {
      success: true,
      screenshot: screenshotB64,
      currentUrl: page.url(),
      pageTitle: await page.title(),
      submitResult,
    };
  } finally {
    await browser.close();
  }
}

/* ─────────────────────────────────────────────────────
   ACTION PARSER — reads agent reply for action tokens
───────────────────────────────────────────────────── */
const ACTION_PATTERNS = {
  CALENDAR_CREATE: /ACTION:CALENDAR_CREATE:([\s\S]+?)(?=ACTION:|$)/,
  EMAIL_SEND:      /ACTION:EMAIL_SEND:([\s\S]+?)(?=ACTION:|$)/,
  CALENDLY_SLOTS:  /ACTION:CALENDLY_SLOTS:([\s\S]+?)(?=ACTION:|$)/,
  CALENDLY_BOOK:   /ACTION:CALENDLY_BOOK:([\s\S]+?)(?=ACTION:|$)/,
  FORM_FILL:       /ACTION:FORM_FILL:([\s\S]+?)(?=ACTION:|$)/,
};

async function executeActions(reply, agent, identity, pool, sessionId, source) {
  if (!identity?.is_configured) return reply;

  let cleanReply = reply;
  const results = [];

  for (const [actionType, pattern] of Object.entries(ACTION_PATTERNS)) {
    const match = reply.match(pattern);
    if (!match) continue;

    let actionData;
    try {
      actionData = JSON.parse(match[1].trim());
    } catch(e) {
      console.warn(`Action ${actionType} parse error:`, e.message);
      continue;
    }

    // Log action
    const logResult = await pool.query(
      'INSERT INTO agent_actions (agent_id,session_id,action_type,action_data,status) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [agent.id, sessionId, actionType, JSON.stringify(actionData), 'pending']
    );
    const actionId = logResult.rows[0].id;

    let result = null;
    let status = 'success';
    let errorMsg = null;

    try {
      switch(actionType) {
        case 'CALENDAR_CREATE':
          result = await createCalendarEvent(pool, identity, actionData);
          break;
        case 'EMAIL_SEND':
          result = await sendGmail(pool, identity, actionData);
          break;
        case 'CALENDLY_SLOTS':
          result = await getCalendlySlots(identity, actionData.eventTypeUri);
          break;
        case 'CALENDLY_BOOK':
          result = await createCalendlyInvite(identity, actionData.eventTypeUri, actionData);
          break;
        case 'FORM_FILL':
          result = await fillForm(actionData.url, actionData.fields);
          break;
      }
      results.push({ type: actionType, success: true, result });
    } catch(e) {
      console.error(`Action ${actionType} failed:`, e.message);
      status = 'error';
      errorMsg = e.message;
      results.push({ type: actionType, success: false, error: e.message });
    }

    // Update action log
    await pool.query(
      'UPDATE agent_actions SET result=$1, status=$2, error_msg=$3 WHERE id=$4',
      [JSON.stringify(result), status, errorMsg, actionId]
    );

    // Remove action token from reply
    cleanReply = cleanReply.replace(match[0], '').trim();
  }

  // Append action results to reply
  if (results.length > 0) {
    const resultTexts = results.map(r => {
      if (!r.success) return `⚠️ Aktion fehlgeschlagen: ${r.error}`;
      switch(r.type) {
        case 'CALENDAR_CREATE':
          return `✅ Termin erstellt! [Kalender öffnen](${r.result.link})${r.result.meetLink ? ` · [Meeting-Link](${r.result.meetLink})` : ''}`;
        case 'EMAIL_SEND':
          return `✅ E-Mail wurde gesendet.`;
        case 'CALENDLY_SLOTS':
          const slots = r.result.slice(0,5).map(s => new Date(s.startTime).toLocaleString('de-DE')).join('\n');
          return `📅 Verfügbare Termine:\n${slots}`;
        case 'CALENDLY_BOOK':
          return `✅ Termin gebucht für ${new Date(r.result.startTime).toLocaleString('de-DE')}!`;
        case 'FORM_FILL':
          return `✅ Formular ${r.result.submitResult ? 'ausgefüllt und abgesendet' : 'ausgefüllt'}.`;
        default: return `✅ Aktion ausgeführt.`;
      }
    });
    cleanReply = cleanReply + '\n\n' + resultTexts.join('\n');
  }

  return cleanReply;
}

/* ─────────────────────────────────────────────────────
   IDENTITY SYSTEM PROMPT ADDON
───────────────────────────────────────────────────── */
function buildIdentityPrompt(agent, identity) {
  if (!identity?.is_configured) return '';

  const parts = [`
## Deine Identität
Du agierst als: **${identity.display_name || agent.name}**
${identity.email_address ? `Deine E-Mail-Adresse: ${identity.email_address}` : ''}

Du kannst echte Aktionen ausführen. Verwende diese Befehle wenn nötig:`];

  if (identity.google_access_token) {
    parts.push(`
### Kalender-Termin erstellen
ACTION:CALENDAR_CREATE:{"title":"Titel","description":"Beschreibung","startTime":"2025-01-15T10:00:00+01:00","endTime":"2025-01-15T11:00:00+01:00","attendees":["email@example.com"],"videoCall":false}

### E-Mail senden (als ${identity.display_name || agent.name})
ACTION:EMAIL_SEND:{"to":"empfaenger@example.com","subject":"Betreff","body":"Text der E-Mail"}`);
  }

  if (identity.calendly_token) {
    parts.push(`
### Verfügbare Calendly-Slots abfragen
ACTION:CALENDLY_SLOTS:{"eventTypeUri":"https://api.calendly.com/event_types/XXXXX"}

### Calendly-Termin buchen
ACTION:CALENDLY_BOOK:{"eventTypeUri":"https://api.calendly.com/event_types/XXXXX","startTime":"2025-01-15T10:00:00Z","name":"Max Mustermann","email":"max@example.com"}`);
  }

  parts.push(`
### Formular auf Website ausfüllen
ACTION:FORM_FILL:{"url":"https://example.com/contact","fields":[{"selector":"#name","value":"Max"},{"selector":"#email","value":"max@example.com"},{"action":"submit"}]}

**Wichtig:** Führe Aktionen nur aus wenn der Nutzer explizit darum bittet und alle nötigen Informationen vorhanden sind. Bestätige vor dem Ausführen kurz was du tun wirst.`);

  return '\n\n' + parts.join('');
}

module.exports = {
  getIdentity,
  executeActions,
  buildIdentityPrompt,
  createCalendarEvent,
  sendGmail,
  getCalendlySlots,
  createCalendlyInvite,
  fillForm,
};
