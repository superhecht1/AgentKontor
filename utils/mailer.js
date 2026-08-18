'use strict';
/**
 * utils/mailer.js
 * E-Mail versenden — mehrere Provider:
 *   1. Resend API   (RESEND_API_KEY)      → kein SMTP, HTTPS, Render-freundlich
 *   2. SendGrid API (SENDGRID_API_KEY)    → kein SMTP, HTTPS
 *   3. SMTP         (SMTP_HOST)           → klassisch, oft geblockt auf Cloud
 *   4. Console      (Entwicklung)         → loggt statt zu senden
 *
 * Verwendung:
 *   const { sendMail } = require('../utils/mailer');
 *   await sendMail({ to, subject, html, text });
 */

async function sendMail({ to, subject, html, text, from, replyTo }) {
  // WICHTIG: fromAddr muss eine in Brevo verifizierte Sender-Adresse sein!
  // Brevo → Senders & IPs → Senders — dort die verifizierte E-Mail eintragen
  const fromAddr = from ||
    process.env.MAIL_FROM ||
    process.env.SMTP_FROM ||
    process.env.BREVO_SENDER ||   // Fallback: BREVO_SENDER env var
    'info@think-cloud.org';     // muss in Brevo verifiziert sein

  // ── 1. Brevo API ──────────────────────────────────────────────────────────
  if (process.env.BREVO_API_KEY) {
    const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key':      process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept':       'application/json',
      },
      body: JSON.stringify({
        sender:   { name: fromAddr.replace(/<.*>/, '').trim() || 'AgentKontor',
                    email: fromAddr.replace(/.*<(.+)>/, '$1').trim() || fromAddr },
        to:       (Array.isArray(to) ? to : [to]).map(e => ({ email: e })),
        subject,
        htmlContent: html || text || '',
        textContent: text || '',
        ...(replyTo ? { replyTo: { email: replyTo } } : {}),
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      // Brevo Fehler-Details loggen
      console.error('[Brevo Error]', resp.status, JSON.stringify(data));
      throw new Error(`Brevo ${resp.status}: ${data.message || data.code || 'Unbekannter Fehler'}`);
    }
    if (!data.messageId) {
      console.warn('[Brevo Warning] Keine messageId — E-Mail möglicherweise nicht zugestellt:', data);
    }
    console.log('[Brevo] Gesendet:', data.messageId, '→', Array.isArray(to) ? to.join(',') : to);
    return { provider: 'brevo', id: data.messageId };
  }

  // ── 2. Resend API ─────────────────────────────────────────────────────────
  if (process.env.RESEND_API_KEY) {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from:     fromAddr,
        to:       Array.isArray(to) ? to : [to],
        subject,
        html:     html || text || '',
        text:     text || '',
        reply_to: replyTo,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(`Resend: ${data.message || resp.status}`);
    return { provider: 'resend', id: data.id };
  }

  // ── 3. SendGrid API ───────────────────────────────────────────────────────
  if (process.env.SENDGRID_API_KEY) {
    const resp = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: Array.isArray(to) ? to[0] : to }] }],
        from: { email: fromAddr.replace(/.*<(.+)>/, '$1'), name: fromAddr.replace(/<.*>/, '').trim() },
        subject,
        content: [
          { type: 'text/plain', value: text || 'Bitte in HTML-fähigem E-Mail-Client öffnen.' },
          ...(html ? [{ type: 'text/html', value: html }] : []),
        ],
      }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(`SendGrid: ${err.errors?.[0]?.message || resp.status}`);
    }
    return { provider: 'sendgrid' };
  }

  // ── 4. SMTP (Nodemailer) ──────────────────────────────────────────────────
  if (process.env.SMTP_HOST) {
    const nodemailer = require('nodemailer');
    const transport = nodemailer.createTransport({
      host:              process.env.SMTP_HOST,
      port:              parseInt(process.env.SMTP_PORT || '587'),
      secure:            process.env.SMTP_SECURE === 'true',
      connectionTimeout: 8000,
      greetingTimeout:   5000,
      socketTimeout:     15000,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    await transport.verify().catch(e => {
      throw new Error(`SMTP-Verbindung fehlgeschlagen: ${e.message}. Tipp: Nutze RESEND_API_KEY statt SMTP.`);
    });

    const info = await transport.sendMail({
      from:    fromAddr,
      to:      Array.isArray(to) ? to.join(', ') : to,
      subject,
      html:    html || '',
      text:    text || '',
      replyTo,
    });

    return { provider: 'smtp', id: info.messageId };
  }

  // ── 5. Entwicklungs-Fallback ──────────────────────────────────────────────
  if (process.env.NODE_ENV !== 'production') {
    console.log('\n📧 [MAILER DEV] E-Mail würde gesendet:');
    console.log('  To:', to);
    console.log('  Subject:', subject);
    console.log('  Text:', (text || html || '').slice(0, 200));
    console.log('');
    return { provider: 'console' };
  }

  throw new Error(
    'Kein E-Mail-Provider konfiguriert. ' +
    'Bitte BREVO_API_KEY (Brevo/Sendinblue), RESEND_API_KEY, SENDGRID_API_KEY oder SMTP_HOST setzen. ' +
    'Brevo: api-key im Brevo-Dashboard unter Transactional → SMTP & API kopieren.'
  );
}

/**
 * Mehrere Empfänger — mit Rate-Limiting (max 5/s)
 */
async function sendMailBatch(recipients, { subject, htmlFn, textFn, from } = {}) {
  const results = { sent: 0, failed: 0, errors: [] };
  for (const r of recipients) {
    try {
      await sendMail({
        to:      r.email,
        subject,
        html:    htmlFn ? htmlFn(r) : undefined,
        text:    textFn ? textFn(r) : undefined,
        from,
      });
      results.sent++;
      // Kurze Pause um Rate-Limits zu respektieren
      await new Promise(res => setTimeout(res, 200));
    } catch (e) {
      results.failed++;
      results.errors.push({ email: r.email, error: e.message });
    }
  }
  return results;
}

module.exports = { sendMail, sendMailBatch };
