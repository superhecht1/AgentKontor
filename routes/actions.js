/**
 * AgentKontor — Agentic Actions (Tool Use)
 *
 * Agent kann echte Aktionen ausführen:
 * - web_search   — DuckDuckGo / SerpAPI
 * - send_email   — SMTP
 * - book_calendar — Google Calendar
 * - add_crm      — HubSpot / Pipedrive (HTTP)
 * - http_request — beliebige HTTP-Anfragen
 *
 * GET  /api/actions/:agentId          — list tools
 * POST /api/actions/:agentId          — create tool
 * PUT  /api/actions/:agentId/:toolId  — update tool
 * DELETE /api/actions/:agentId/:toolId — delete tool
 */

const router = require('express').Router();
const auth   = require('../middleware/auth');

function getPool(req) { return req.app.locals.pool; }

async function verifyOwner(pool, agentId, userId) {
  const r = await pool.query('SELECT id FROM agents WHERE id=$1 AND user_id=$2', [agentId, userId]);
  return r.rows.length > 0;
}

/* ── LIST TOOLS ─────────────────────────────────────────── */
router.get('/:agentId', auth, async (req, res) => {
  const pool = getPool(req);
  if (!(await verifyOwner(pool, req.params.agentId, req.userId)))
    return res.status(403).json({ error: 'Nicht berechtigt' });
  try {
    const r = await pool.query(
      'SELECT * FROM agent_tools WHERE agent_id=$1 ORDER BY created_at ASC',
      [req.params.agentId]
    );
    res.json({ tools: r.rows });
  } catch(e) { res.json({ tools: [] }); }
});

/* ── CREATE TOOL ────────────────────────────────────────── */
router.post('/:agentId', auth, async (req, res) => {
  const pool = getPool(req);
  if (!(await verifyOwner(pool, req.params.agentId, req.userId)))
    return res.status(403).json({ error: 'Nicht berechtigt' });
  const { tool_type, tool_name, tool_desc, config } = req.body;
  if (!tool_type || !tool_name) return res.status(400).json({ error: 'tool_type und tool_name erforderlich' });
  try {
    const r = await pool.query(
      'INSERT INTO agent_tools (agent_id, tool_type, tool_name, tool_desc, config) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.params.agentId, tool_type, tool_name, tool_desc || '', JSON.stringify(config || {})]
    );
    res.json({ tool: r.rows[0] });
  } catch(e) { res.status(500).json({ error: 'Fehler' }); }
});

/* ── UPDATE TOOL ────────────────────────────────────────── */
router.put('/:agentId/:toolId', auth, async (req, res) => {
  const pool = getPool(req);
  if (!(await verifyOwner(pool, req.params.agentId, req.userId)))
    return res.status(403).json({ error: 'Nicht berechtigt' });
  const { tool_name, tool_desc, config, is_enabled } = req.body;
  try {
    const r = await pool.query(
      'UPDATE agent_tools SET tool_name=$1, tool_desc=$2, config=$3, is_enabled=$4 WHERE id=$5 AND agent_id=$6 RETURNING *',
      [tool_name, tool_desc, JSON.stringify(config||{}), is_enabled!==false, req.params.toolId, req.params.agentId]
    );
    res.json({ tool: r.rows[0] });
  } catch(e) { res.status(500).json({ error: 'Fehler' }); }
});

/* ── DELETE TOOL ────────────────────────────────────────── */
router.delete('/:agentId/:toolId', auth, async (req, res) => {
  const pool = getPool(req);
  if (!(await verifyOwner(pool, req.params.agentId, req.userId)))
    return res.status(403).json({ error: 'Nicht berechtigt' });
  try {
    await pool.query('DELETE FROM agent_tools WHERE id=$1 AND agent_id=$2', [req.params.toolId, req.params.agentId]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Fehler' }); }
});

/* ═══════════════════════════════════════════════════════════
   TOOL EXECUTION ENGINE
   Called by chat.js when Claude returns tool_use blocks
   ═══════════════════════════════════════════════════════════ */

/**
 * Build Anthropic tool definitions from agent_tools config
 */
function buildToolDefinitions(tools) {
  return tools.filter(t => t.is_enabled).map(t => {
    switch (t.tool_type) {
      case 'web_search':
        return {
          name: 'web_search',
          description: t.tool_desc || 'Suche im Internet nach aktuellen Informationen.',
          input_schema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Suchanfrage' },
            },
            required: ['query'],
          },
        };

      case 'send_email':
        return {
          name: 'send_email',
          description: t.tool_desc || 'Sende eine E-Mail im Namen des Nutzers.',
          input_schema: {
            type: 'object',
            properties: {
              to:      { type: 'string', description: 'Empfänger E-Mail' },
              subject: { type: 'string', description: 'Betreff' },
              body:    { type: 'string', description: 'E-Mail-Text' },
            },
            required: ['to', 'subject', 'body'],
          },
        };

      case 'book_calendar':
        return {
          name: 'book_calendar',
          description: t.tool_desc || 'Buche einen Termin im Kalender.',
          input_schema: {
            type: 'object',
            properties: {
              title:       { type: 'string', description: 'Titel des Termins' },
              start_time:  { type: 'string', description: 'Startzeit (ISO 8601)' },
              end_time:    { type: 'string', description: 'Endzeit (ISO 8601)' },
              description: { type: 'string', description: 'Beschreibung' },
              attendee_email: { type: 'string', description: 'E-Mail des Teilnehmers' },
            },
            required: ['title', 'start_time', 'end_time'],
          },
        };

      case 'add_crm':
        return {
          name: 'add_crm',
          description: t.tool_desc || 'Füge einen Lead oder Kontakt ins CRM ein.',
          input_schema: {
            type: 'object',
            properties: {
              name:    { type: 'string', description: 'Name des Kontakts' },
              email:   { type: 'string', description: 'E-Mail' },
              phone:   { type: 'string', description: 'Telefon' },
              notes:   { type: 'string', description: 'Notizen' },
              company: { type: 'string', description: 'Unternehmen' },
            },
            required: ['name'],
          },
        };

      case 'http_request':
        return {
          name: t.tool_name.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
          description: t.tool_desc || 'Führe eine HTTP-Anfrage aus.',
          input_schema: {
            type: 'object',
            properties: {
              params: { type: 'object', description: 'Parameter für die Anfrage' },
            },
          },
        };

      default:
        return null;
    }
  }).filter(Boolean);
}

/**
 * Execute a single tool call
 */
// SSRF Protection — block internal/private IPs
const SSRF_BLOCKED = [
  /^10\./, /^172\.(1[6-9]|2[0-9]|3[01])\./, /^192\.168\./,
  /^127\./, /^0\./, /^169\.254\./, /^::1$/, /^fc00:/, /^fe80:/,
  /^localhost$/i, /metadata\.google\.internal/i,
  /169\.254\.169\.254/, /100\.100\.100\.200/, // AWS/Alibaba metadata
];

function isSsrfBlocked(url) {
  try {
    const parsed = new URL(url);
    const host   = parsed.hostname;
    return SSRF_BLOCKED.some(r => r.test(host));
  } catch { return true; }
}

async function executeTool(toolName, toolInput, toolConfig, agent) {
  const start = Date.now();
  let output = '', success = true;

  try {
    switch (toolName) {

      case 'web_search': {
        const query = toolInput.query;
        // Use DuckDuckGo Instant Answer API (free, no key)
        const r = await fetch(
          `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
          { headers: { 'User-Agent': 'AgentKontor/1.0' } }
        );
        const d = await r.json();
        if (d.AbstractText) {
          output = `${d.AbstractText}\nQuelle: ${d.AbstractURL}`;
        } else if (d.RelatedTopics?.length) {
          output = d.RelatedTopics.slice(0, 5).map(t => t.Text || '').filter(Boolean).join('\n');
        } else {
          output = `Keine direkten Ergebnisse für "${query}" gefunden.`;
        }
        break;
      }

      case 'send_email': {
        if (!process.env.SMTP_HOST && !agent.smtp_host)
          return { output: 'SMTP nicht konfiguriert', success: false };

        const nodemailer = require('nodemailer');
        const t = nodemailer.createTransport({
          host: agent.smtp_host || process.env.SMTP_HOST,
          port: parseInt(agent.smtp_port || process.env.SMTP_PORT || '587'),
          secure: false,
          auth: {
            user: agent.smtp_user || process.env.SMTP_USER,
            pass: agent.smtp_pass || process.env.SMTP_PASS,
          },
        });
        await t.sendMail({
          from: agent.smtp_from || process.env.SMTP_FROM || `${agent.name} <noreply@agentkontor.de>`,
          to:   toolInput.to,
          subject: toolInput.subject,
          text: toolInput.body,
        });
        output = `E-Mail erfolgreich gesendet an ${toolInput.to}`;
        break;
      }

      case 'book_calendar': {
        // Calendly create scheduling link or Google Calendar event
        const calLink = toolConfig.calendar_url || agent.cal_link;
        if (calLink) {
          // Return a pre-filled Calendly link
          output = `Buchungslink: ${calLink} — Bitte diesen Link nutzen für: ${toolInput.title} am ${toolInput.start_time}`;
        } else {
          output = `Termin notiert: "${toolInput.title}" für ${toolInput.start_time} bis ${toolInput.end_time}`;
        }
        break;
      }

      case 'add_crm': {
        const crmUrl   = toolConfig.webhook_url || toolConfig.hubspot_url;
        const apiKey   = toolConfig.api_key;

        if (crmUrl && isSsrfBlocked(crmUrl)) { output = 'CRM-URL nicht erlaubt'; success = false; break; }

        if (!crmUrl) {
          output = `Lead erfasst: ${toolInput.name} (${toolInput.email || 'keine E-Mail'})`;
          break;
        }

        // POST to CRM webhook (Zapier, HubSpot, etc.)
        const crmResp = await fetch(crmUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            name:    toolInput.name,
            email:   toolInput.email,
            phone:   toolInput.phone,
            notes:   toolInput.notes,
            company: toolInput.company,
            source:  'AgentKontor',
          }),
        });
        output = crmResp.ok
          ? `Kontakt "${toolInput.name}" erfolgreich ins CRM eingetragen.`
          : `CRM-Eintrag fehlgeschlagen (HTTP ${crmResp.status})`;
        break;
      }

      default: {
        // Generic HTTP request tool
        const url    = toolConfig.url;
        const method = toolConfig.method || 'POST';
        if (!url) { output = 'Tool-URL nicht konfiguriert'; success = false; break; }

        const resp = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json', ...(toolConfig.headers || {}) },
          body: method !== 'GET' ? JSON.stringify({ ...toolInput, agent_name: agent.name }) : undefined,
        });
        output = resp.ok ? `Aktion erfolgreich ausgeführt (HTTP ${resp.status})` : `Fehler (HTTP ${resp.status})`;
        success = resp.ok;
        break;
      }
    }
  } catch(e) {
    output = `Fehler: ${e.message}`;
    success = false;
  }

  return { output, success, duration_ms: Date.now() - start };
}

/**
 * Main: run agentic chat with tool use loop
 * Called from chat.js instead of simple client.messages.create()
 */
async function runAgenticChat(client, model, systemPrompt, messages, agentTools, pool, agentId, sessionId) {
  const toolDefs = buildToolDefinitions(agentTools);
  if (!toolDefs.length) {
    // No tools — standard call
    const r = await client.messages.create({ model, max_tokens: 1024, system: systemPrompt, messages });
    return { reply: r.content[0]?.text || '', usage: r.usage };
  }

  let currentMessages = [...messages];
  let totalUsage = { input_tokens: 0, output_tokens: 0 };
  const MAX_ROUNDS = 5;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: currentMessages,
      tools: toolDefs,
    });

    totalUsage.input_tokens  += response.usage?.input_tokens  || 0;
    totalUsage.output_tokens += response.usage?.output_tokens || 0;

    // If no tool use, return the text reply
    if (response.stop_reason !== 'tool_use') {
      const text = response.content.find(b => b.type === 'text')?.text || '';
      return { reply: text, usage: totalUsage };
    }

    // Process tool calls
    const toolUseBlocks  = response.content.filter(b => b.type === 'tool_use');
    const toolResultContent = [];

    for (const block of toolUseBlocks) {
      const toolDef = agentTools.find(t =>
        t.tool_type === block.name ||
        t.tool_name.toLowerCase().replace(/[^a-z0-9_]/g, '_') === block.name
      );

      const config = toolDef?.config || {};
      const result = await executeTool(block.name, block.input, config, {});

      // Log execution
      try {
        await pool.query(
          'INSERT INTO tool_executions (agent_id, session_id, tool_type, input, output, success, duration_ms) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [agentId, sessionId, block.name, JSON.stringify(block.input), result.output, result.success, result.duration_ms]
        );
      } catch {}

      toolResultContent.push({
        type:        'tool_result',
        tool_use_id: block.id,
        content:     result.output,
      });
    }

    // Append assistant response + tool results
    currentMessages = [
      ...currentMessages,
      { role: 'assistant', content: response.content },
      { role: 'user', content: toolResultContent },
    ];
  }

  // Fallback if max rounds exceeded
  return { reply: 'Ich konnte die Aufgabe nach mehreren Versuchen nicht abschließen.', usage: totalUsage };
}

module.exports = router;
module.exports.buildToolDefinitions = buildToolDefinitions;
module.exports.runAgenticChat       = runAgenticChat;
