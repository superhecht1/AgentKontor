'use strict';
/**
 * integrations/calendar.js
 * Kalender-Tool für den Agent.
 * Provider: Google Calendar, Microsoft (Outlook), CalDAV/iCal-URL
 */

// ── Google Calendar Helpers ────────────────────────────────────────────────
async function refreshGoogleToken(cred, pool) {
  if (!cred.credentials.refresh_token) throw new Error('Kein Refresh-Token');
  const expires = new Date(cred.credentials.expires_at);
  if (expires > new Date(Date.now() + 60000)) return cred.credentials; // noch gültig

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: cred.credentials.refresh_token,
      grant_type:    'refresh_token',
    }),
  });
  const data = await resp.json();
  if (data.error) throw new Error('Token-Refresh fehlgeschlagen: ' + data.error);

  const updated = {
    ...cred.credentials,
    access_token: data.access_token,
    expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
  };
  await pool.query(
    'UPDATE integration_credentials SET credentials=$1, updated_at=now() WHERE id=$2',
    [JSON.stringify(updated), cred.id]
  );
  return updated;
}

async function googleCalendarRequest(endpoint, cred, pool, options = {}) {
  const tokens = await refreshGoogleToken(cred, pool);
  const resp = await fetch(`https://www.googleapis.com/calendar/v3${endpoint}`, {
    headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' },
    ...options,
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Google Calendar API Fehler: ${err.error?.message || resp.status}`);
  }
  return resp.json();
}

// ── Events laden ────────────────────────────────────────────────────────────
async function getEvents(cred, pool, { from, to, maxResults = 20 }) {
  const timeMin = from || new Date().toISOString();
  const timeMax = to   || new Date(Date.now() + 7 * 86400000).toISOString();

  if (cred.provider === 'google') {
    const data = await googleCalendarRequest(
      `/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&maxResults=${maxResults}&singleEvents=true&orderBy=startTime`,
      cred, pool
    );
    return (data.items || []).map(e => ({
      id:          e.id,
      title:       e.summary,
      start:       e.start?.dateTime || e.start?.date,
      end:         e.end?.dateTime   || e.end?.date,
      location:    e.location,
      description: e.description,
      attendees:   (e.attendees || []).map(a => a.email),
      status:      e.status,
    }));
  }

  // CalDAV / iCal URL (read-only)
  if (cred.provider === 'ical_url' && cred.credentials.url) {
    const resp = await fetch(cred.credentials.url).catch(() => null);
    if (!resp?.ok) throw new Error('iCal-URL nicht erreichbar');
    // Minimal iCal parsing
    const text = await resp.text();
    return parseIcal(text, timeMin, timeMax);
  }

  throw new Error(`Provider ${cred.provider} wird nicht unterstützt`);
}

// ── Freie Slots finden ──────────────────────────────────────────────────────
async function findFreeSlots(cred, pool, { from, to, durationMinutes = 60 }) {
  const events = await getEvents(cred, pool, { from, to, maxResults: 50 });
  const busy = events.map(e => ({ start: new Date(e.start), end: new Date(e.end) }));
  const slots = [];
  let cursor = new Date(from || Date.now());
  const end   = new Date(to || Date.now() + 7 * 86400000);
  const dur   = durationMinutes * 60000;

  while (cursor < end && slots.length < 10) {
    const slotEnd = new Date(cursor.getTime() + dur);
    const hour = cursor.getHours();
    // Nur Bürozeiten 8–18
    if (hour >= 8 && hour < 18) {
      const overlap = busy.some(b => cursor < b.end && slotEnd > b.start);
      if (!overlap) {
        slots.push({
          start: cursor.toISOString(),
          end:   slotEnd.toISOString(),
          label: cursor.toLocaleString('de-DE', { weekday:'long', hour:'2-digit', minute:'2-digit' }),
        });
      }
    }
    cursor = new Date(cursor.getTime() + 30 * 60000); // 30min Schritte
  }
  return slots;
}

// ── Event erstellen ─────────────────────────────────────────────────────────
async function createEvent(cred, pool, { title, start, end, description, attendees = [], location }) {
  if (cred.provider !== 'google') throw new Error('Event-Erstellung nur für Google Calendar');

  const event = {
    summary:     title,
    description: description || '',
    location:    location || '',
    start:       { dateTime: start, timeZone: 'Europe/Berlin' },
    end:         { dateTime: end,   timeZone: 'Europe/Berlin' },
    attendees:   attendees.map(email => ({ email })),
  };

  const data = await googleCalendarRequest('/calendars/primary/events', cred, pool, {
    method: 'POST',
    body:   JSON.stringify(event),
  });
  return { id: data.id, title: data.summary, start: data.start?.dateTime, link: data.htmlLink };
}

// ── Minimaler iCal-Parser ────────────────────────────────────────────────────
function parseIcal(text, timeMin, timeMax) {
  const events = [];
  const blocks = text.split('BEGIN:VEVENT');
  const min = new Date(timeMin);
  const max = new Date(timeMax);
  for (const block of blocks.slice(1)) {
    const get = key => {
      const m = block.match(new RegExp(key + ':([^\r\n]+)'));
      return m?.[1]?.trim() || '';
    };
    const dtStart = get('DTSTART(?:;[^:]+)?');
    const dtEnd   = get('DTEND(?:;[^:]+)?');
    const start   = dtStart ? parseIcalDate(dtStart) : null;
    const end     = dtEnd   ? parseIcalDate(dtEnd)   : null;
    if (start && start >= min && start <= max) {
      events.push({ title: get('SUMMARY'), start: start.toISOString(), end: end?.toISOString(), id: get('UID') });
    }
  }
  return events;
}

function parseIcalDate(s) {
  // YYYYMMDDTHHMMSSZ or YYYYMMDD
  if (s.length >= 8) {
    const y = s.slice(0,4), m = s.slice(4,6), d = s.slice(6,8);
    const t = s.length > 8 ? `T${s.slice(9,11)}:${s.slice(11,13)}:${s.slice(13,15)}Z` : '';
    return new Date(`${y}-${m}-${d}${t}`);
  }
  return null;
}

module.exports = { getEvents, findFreeSlots, createEvent };
