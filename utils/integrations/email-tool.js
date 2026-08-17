'use strict';
/**
 * integrations/email-tool.js
 * E-Mail lesen, priorisieren, antworten.
 * Provider: Gmail (OAuth2), IMAP/SMTP (nodemailer + imap-simple)
 */

// ── Gmail API Helpers ───────────────────────────────────────────────────────
async function gmailRequest(endpoint, tokens, options = {}) {
  const resp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${endpoint}`, {
    headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' },
    ...options,
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Gmail API: ${err.error?.message || resp.status}`);
  }
  return resp.json();
}

function decodeBase64(b64) {
  return Buffer.from(b64.replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('utf8');
}

function extractBody(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data)
    return decodeBase64(payload.body.data);
  if (payload.parts) {
    for (const part of payload.parts) {
      const body = extractBody(part);
      if (body) return body;
    }
  }
  return '';
}

// ── Emails laden (Gmail) ────────────────────────────────────────────────────
async function getEmails(cred, pool, { maxResults = 20, query = 'is:inbox is:unread', includeBody = false }) {
  if (cred.provider !== 'google') throw new Error('Nur Gmail unterstützt');
  const tokens = cred.credentials;

  const list = await gmailRequest(
    `/messages?maxResults=${maxResults}&q=${encodeURIComponent(query)}`,
    tokens
  );
  if (!list.messages?.length) return [];

  const emails = [];
  for (const { id } of list.messages.slice(0, maxResults)) {
    const format = includeBody ? 'full' : 'metadata';
    const msg = await gmailRequest(`/messages/${id}?format=${format}`, tokens);
    const headers = msg.payload?.headers || [];
    const get = name => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
    emails.push({
      id:          msg.id,
      threadId:    msg.threadId,
      subject:     get('Subject'),
      from:        get('From'),
      to:          get('To'),
      date:        get('Date'),
      snippet:     msg.snippet || '',
      body:        includeBody ? extractBody(msg.payload) : null,
      labelIds:    msg.labelIds || [],
      isUnread:    (msg.labelIds || []).includes('UNREAD'),
    });
  }
  return emails;
}

// ── Email mit LLM priorisieren ──────────────────────────────────────────────
async function prioritizeEmails(emails, callLLM) {
  if (!emails.length) return [];
  const list = emails.map((e, i) =>
    `${i+1}. Von: ${e.from} | Betreff: ${e.subject} | Vorschau: ${e.snippet.slice(0,100)}`
  ).join('\n');

  const resp = await callLLM(
    'claude-haiku-4-5',
    'Du bist ein E-Mail-Assistent. Antworte nur mit validem JSON.',
    [{ role: 'user', content: `Priorisiere diese E-Mails (1=höchste Priorität). Gib JSON zurück: [{index, priority: "high"|"normal"|"low", reason, suggested_action}]\n\n${list}` }]
  );
  try {
    const m = resp.match(/\[[\s\S]*\]/);
    const priorities = m ? JSON.parse(m[0]) : [];
    return emails.map((e, i) => {
      const p = priorities.find(x => x.index === i+1) || {};
      return { ...e, priority: p.priority || 'normal', reason: p.reason, suggestedAction: p.suggested_action };
    }).sort((a,b) => ({high:0,normal:1,low:2}[a.priority] - {high:0,normal:1,low:2}[b.priority]));
  } catch {
    return emails;
  }
}

// ── E-Mail senden / antworten (Gmail) ──────────────────────────────────────
async function sendEmail(cred, pool, { to, subject, body, replyToMessageId, cc }) {
  if (cred.provider !== 'google') throw new Error('Nur Gmail unterstützt');
  const tokens = cred.credentials;

  // RFC 2822 Nachricht aufbauen
  const fromEmail = cred.credentials.email || 'me';
  let rawEmail = [
    `From: ${fromEmail}`,
    `To: ${to}`,
    cc ? `Cc: ${cc}` : '',
    `Subject: ${replyToMessageId ? 'Re: ' : ''}${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].filter(Boolean).join('\r\n');

  const encoded = Buffer.from(rawEmail).toString('base64url');

  const endpoint = replyToMessageId
    ? `/messages/send`
    : `/messages/send`;

  const payload = { raw: encoded };
  if (replyToMessageId) payload.threadId = replyToMessageId;

  const data = await gmailRequest(endpoint, tokens, {
    method: 'POST',
    body:   JSON.stringify(payload),
  });
  return { sent: true, id: data.id, threadId: data.threadId };
}

// ── LLM-generierte Antwort ──────────────────────────────────────────────────
async function generateReply(email, instructions, callLLM) {
  const prompt = `Schreibe eine professionelle E-Mail-Antwort auf folgende E-Mail.
Anweisungen: ${instructions || 'Antworte höflich und präzise auf Deutsch.'}

Von: ${email.from}
Betreff: ${email.subject}
Inhalt:
${(email.body || email.snippet).slice(0, 2000)}

Schreibe nur den Antwort-Text (kein Betreff, keine Anrede-Formatierung).`;

  return callLLM('claude-sonnet-4-6',
    'Du bist ein professioneller E-Mail-Assistent.',
    [{ role: 'user', content: prompt }]
  );
}

module.exports = { getEmails, prioritizeEmails, sendEmail, generateReply };
