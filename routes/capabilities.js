/**
 * Capabilities middleware — injected into chat system prompt
 * based on agent config
 */

function buildCapabilityPrompt(agent) {
  const parts = [];

  if (agent.cap_calendar && agent.cal_link) {
    parts.push(`TERMINE: Wenn ein Nutzer einen Termin buchen möchte, antworte mit: "Hier kannst du direkt einen Termin buchen: ${agent.cal_link}" und führe ihn dorthin.`);
  }

  if (agent.cap_leads && agent.lead_fields?.length) {
    const fields = agent.lead_fields.map(f => f.label || f).join(', ');
    parts.push(`LEAD-ERFASSUNG: Wenn ein Nutzer Interesse zeigt oder Kontakt aufnehmen möchte, sammle folgende Informationen freundlich im Gespräch: ${fields}. Sage danach: "Ich habe deine Daten notiert und werde mich melden." Antworte dann im Format: LEAD_DATA:{"fields":{"name":"...", ...}}`);
  }

  if (agent.cap_products && agent.products_data?.length) {
    const products = agent.products_data.map(p => `${p.name}: ${p.description} (${p.price||''})`).join('\n');
    parts.push(`PRODUKTE: Du kennst folgende Produkte/Angebote:\n${products}\nEmpfehle passende Produkte basierend auf den Anfragen des Nutzers.`);
  }

  if (agent.cap_multilang) {
    parts.push(`MEHRSPRACHIGKEIT: Erkenne automatisch die Sprache des Nutzers und antworte in derselben Sprache. Wechsle die Sprache wenn der Nutzer sie wechselt.`);
  }

  if (agent.cap_email) {
    parts.push(`E-MAIL: Wenn ein Nutzer explizit darum bittet, dass du ihm eine Zusammenfassung oder Information per E-Mail schickst, antworte: "Gib mir deine E-Mail-Adresse und ich schicke dir die Informationen." Dann antworte im Format: SEND_EMAIL:{"to":"email@example.com","subject":"...","body":"..."}`);
  }

  return parts.length > 0 ? '\n\n## Fähigkeiten\n' + parts.join('\n\n') : '';
}

async function parseAgentActions(reply, agent, pool, sessionId, source) {
  // Parse LEAD_DATA action
  const leadMatch = reply.match(/LEAD_DATA:(\{[^}]+\})/s);
  if (leadMatch && agent.cap_leads) {
    try {
      const leadData = JSON.parse(leadMatch[1]);
      await pool.query(
        'INSERT INTO lead_captures (agent_id, session_id, data, source) VALUES ($1,$2,$3,$4)',
        [agent.id, sessionId, JSON.stringify(leadData.fields || leadData), source]
      );
      // Send email notification if configured
      if (agent.lead_email && agent.cap_email && agent.smtp_host) {
        await sendEmail(agent, agent.lead_email,
          `Neuer Lead von ${agent.name}`,
          `Neuer Lead erfasst:\n\n${JSON.stringify(leadData.fields || leadData, null, 2)}`
        );
      }
    } catch (e) { console.warn('Lead parse error:', e.message); }
  }

  // Parse SEND_EMAIL action
  const emailMatch = reply.match(/SEND_EMAIL:(\{[\s\S]+?\})/);
  if (emailMatch && agent.cap_email && agent.smtp_host) {
    try {
      const emailData = JSON.parse(emailMatch[1]);
      await sendEmail(agent, emailData.to, emailData.subject, emailData.body);
    } catch (e) { console.warn('Email send error:', e.message); }
  }

  // Clean action tokens from user-visible reply
  return reply
    .replace(/LEAD_DATA:\{[^}]+\}/gs, '')
    .replace(/SEND_EMAIL:\{[\s\S]+?\}/g, '')
    .trim();
}

async function sendEmail(agent, to, subject, body) {
  if (!agent.smtp_host) return;
  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: agent.smtp_host,
      port: agent.smtp_port || 587,
      secure: agent.smtp_port === 465,
      auth: { user: agent.smtp_user, pass: agent.smtp_pass }
    });
    await transporter.sendMail({ from: agent.smtp_from || agent.smtp_user, to, subject, text: body });
  } catch (e) { console.warn('Email error:', e.message); }
}

module.exports = { buildCapabilityPrompt, parseAgentActions };
