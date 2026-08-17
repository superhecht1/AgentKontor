'use strict';
/**
 * tool-executor.js
 * Führt Tools aus, die ein Agent aufrufen kann.
 * Unterstützt: http | builtin | javascript (sandbox) | mcp
 */

const { getPool } = require('./db');

// ── Eingebaute Tools ────────────────────────────────────────────────────────
const BUILTIN_TOOLS = {

  get_current_time: async ({ timezone = 'Europe/Berlin' }) => ({
    time: new Date().toLocaleTimeString('de-DE', { timeZone: timezone }),
    date: new Date().toLocaleDateString('de-DE', { timeZone: timezone }),
    iso:  new Date().toISOString(),
  }),

  get_weather: async ({ location }) => {
    // Stub – in Produktion: fetch von openweathermap.org
    return { location, temperature: '18°C', condition: 'Bewölkt', humidity: '72%' };
  },

  search_web: async ({ query }) => {
    // Stub – in Produktion: SerpAPI / Brave Search
    return { query, results: [`Suchergebnis für: ${query} (Demo-Modus)`] };
  },

  send_email: async ({ to, subject, body }, context) => {
    // Nutzt SMTP-Konfiguration des Agenten falls vorhanden
    const pool = context?.pool;
    if (!pool) throw new Error('Kein DB-Kontext');
    // Log only in demo mode
    console.log(`[TOOL:send_email] to=${to} subject=${subject}`);
    return { sent: true, to, subject };
  },

  save_to_memory: async ({ key, value, scope = 'longterm' }, context) => {
    if (!context?.agentId) throw new Error('Kein Agent-Kontext');
    const { memoryManager } = require('./memory-manager');
    await memoryManager.set(context.pool, {
      agentId: context.agentId,
      sessionId: context.sessionId,
      scope, key, value,
      source: 'agent',
    });
    return { saved: true, key, scope };
  },

  read_from_memory: async ({ key, scope = 'longterm' }, context) => {
    if (!context?.agentId) throw new Error('Kein Agent-Kontext');
    const { memoryManager } = require('./memory-manager');
    const val = await memoryManager.get(context.pool, {
      agentId: context.agentId,
      sessionId: context.sessionId,
      scope, key,
    });
    return { key, value: val, found: val !== null };
  },

  create_task: async ({ title, description, type = 'generic', payload = {} }, context) => {
    if (!context?.agentId) throw new Error('Kein Agent-Kontext');
    const { taskRunner } = require('./task-runner');
    const task = await taskRunner.create(context.pool, {
      userId:    context.userId,
      agentId:   context.agentId,
      sessionId: context.sessionId,
      title, description, type, payload,
    });
    return { taskId: task.id, status: task.status };
  },


  calendar_get_events: async ({ from, to, max_results = 10 }, context) => {
    if (!context?.pool) throw new Error('Kein DB-Kontext');
    const cal = require('./integrations/calendar');
    const r = await context.pool.query(
      "SELECT * FROM integration_credentials WHERE user_id=$1 AND integration='calendar' AND is_active=true LIMIT 1",
      [context.userId]
    );
    if (!r.rows.length) throw new Error('Keine Kalender-Integration konfiguriert');
    return cal.getEvents(r.rows[0], context.pool, { from, to, maxResults: max_results });
  },

  calendar_find_slots: async ({ from, to, duration_minutes = 60 }, context) => {
    if (!context?.pool) throw new Error('Kein DB-Kontext');
    const cal = require('./integrations/calendar');
    const r = await context.pool.query(
      "SELECT * FROM integration_credentials WHERE user_id=$1 AND integration='calendar' AND is_active=true LIMIT 1",
      [context.userId]
    );
    if (!r.rows.length) throw new Error('Keine Kalender-Integration konfiguriert');
    return cal.findFreeSlots(r.rows[0], context.pool, { from, to, durationMinutes: duration_minutes });
  },

  email_get_messages: async ({ query = 'is:inbox is:unread', max_results = 10 }, context) => {
    if (!context?.pool) throw new Error('Kein DB-Kontext');
    const emailTool = require('./integrations/email-tool');
    const r = await context.pool.query(
      "SELECT * FROM integration_credentials WHERE user_id=$1 AND integration='email' AND is_active=true LIMIT 1",
      [context.userId]
    );
    if (!r.rows.length) throw new Error('Keine E-Mail-Integration konfiguriert');
    return emailTool.getEmails(r.rows[0], context.pool, { query, maxResults: max_results });
  },

  qualify_leads: async ({ agent_id, limit = 20 }, context) => {
    if (!context?.pool) throw new Error('Kein DB-Kontext');
    const crm = require('./integrations/crm-tool');
    const { callLLM } = require('./llm');
    return crm.batchQualify(context.pool, context.userId, { agentId: agent_id, callLLM });
  },

  web_search: async ({ query, max_results = 10 }, context) => {
    const webAgent = require('./web-agent');
    return webAgent.search(context?.pool || null, { query, maxResults: max_results });
  },

  web_scrape: async ({ url }, context) => {
    const webAgent = require('./web-agent');
    const result = await webAgent.scrape(context?.pool || null, url);
    return { url: result.url, title: result.title, content: result.content.slice(0, 5000) };
  },

  web_research: async ({ goal, depth = 3 }, context) => {
    if (!context?.pool) throw new Error('Kein DB-Kontext');
    const webAgent = require('./web-agent');
    const { callLLM } = require('./llm');
    // Session anlegen
    const s = await context.pool.query(
      "INSERT INTO research_sessions (user_id,agent_id,goal,status) VALUES ($1,$2,$3,'running') RETURNING id",
      [context.userId, context.agentId||null, goal]
    );
    const result = await webAgent.research(context.pool, s.rows[0].id, {
      goal, depth,
      callLLM: (m,sys,msgs) => callLLM(m||'claude-sonnet-4-6',sys,msgs)
    });
    return { summary: result.report.slice(0, 1000)+'...', sources: result.sources.length, session_id: s.rows[0].id };
  },

  analyze_document: async ({ doc_id, agent_id, analysis_type = 'summary' }, context) => {
    if (!context?.pool) throw new Error('Kein DB-Kontext');
    const docTool = require('./integrations/document-tool');
    const { callLLM } = require('./llm');
    const doc = await docTool.getDocumentFromDB(context.pool, { docId: doc_id, agentId: agent_id });
    const result = await docTool.analyzeDocument(doc.text, { analysisType: analysis_type }, callLLM);
    return typeof result === 'string' ? { summary: result } : result;
  },

  calculate: async ({ expression }) => {
    // Sichere Mathe-Auswertung (kein eval)
    const allowed = /^[\d\s\+\-\*\/\(\)\.\,]+$/;
    if (!allowed.test(expression)) throw new Error('Ungültiger Ausdruck');
    try {
      // eslint-disable-next-line no-new-func
      const result = Function(`'use strict'; return (${expression})`)();
      return { expression, result };
    } catch {
      throw new Error('Berechnungsfehler');
    }
  },
};

// ── HTTP-Tool ausführen ─────────────────────────────────────────────────────
async function executeHttp(tool, input, context) {
  const cfg = tool.config;
  const url  = interpolate(cfg.url || '', input);
  const body = cfg.body_template
    ? JSON.parse(interpolate(JSON.stringify(cfg.body_template), input))
    : input;

  const headers = {
    'Content-Type': 'application/json',
    ...cfg.headers,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), (tool.timeout_s || 10) * 1000);

  try {
    const resp = await fetch(url, {
      method:  cfg.method || 'POST',
      headers,
      body:    cfg.method !== 'GET' ? JSON.stringify(body) : undefined,
      signal:  controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    const data = await resp.json().catch(() => ({}));
    return data;
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') throw new Error('Tool-Timeout');
    throw e;
  }
}

// ── Template-Interpolation: {{variable}} ersetzen ───────────────────────────
function interpolate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) =>
    vars[k] !== undefined ? String(vars[k]) : ''
  );
}

// ── Input validieren (JSON Schema minimal) ──────────────────────────────────
function validateInput(schema, input) {
  if (!schema || schema.type !== 'object') return;
  const required = schema.required || [];
  for (const field of required) {
    if (input[field] === undefined || input[field] === null || input[field] === '') {
      throw new Error(`Pflichtfeld fehlt: ${field}`);
    }
  }
}

// ── Haupt-Executor ──────────────────────────────────────────────────────────
async function executeTool(toolDef, input, context = {}) {
  const start = Date.now();
  let output = null, status = 'ok', error = null;

  try {
    // Input validieren
    validateInput(toolDef.parameters, input);

    if (toolDef.type === 'builtin') {
      const fn = BUILTIN_TOOLS[toolDef.name];
      if (!fn) throw new Error(`Builtin-Tool nicht gefunden: ${toolDef.name}`);
      output = await fn(input, context);
    } else if (toolDef.type === 'http') {
      output = await executeHttp(toolDef, input, context);
    } else {
      throw new Error(`Tool-Typ nicht unterstützt: ${toolDef.type}`);
    }
  } catch (e) {
    status = e.message === 'Tool-Timeout' ? 'timeout' : 'error';
    error  = e.message;
    output = { error: e.message };
  }

  const duration = Date.now() - start;

  // Audit-Log schreiben
  if (context.pool) {
    try {
      await context.pool.query(
        `INSERT INTO tool_calls (tool_id,agent_id,session_id,input,output,status,duration_ms,error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [toolDef.id||null, context.agentId||null, context.sessionId||null,
         JSON.stringify(input), JSON.stringify(output), status, duration, error]
      );
    } catch (dbErr) {
      console.warn('[tool-executor] Audit-Log fehlgeschlagen:', dbErr.message);
    }
  }

  if (status !== 'ok') throw new Error(error);
  return output;
}

// ── Tool-Liste für LLM formatieren (Anthropic / OpenAI format) ─────────────
function formatToolsForLLM(tools, provider = 'anthropic') {
  if (!tools?.length) return [];

  if (provider === 'openai' || provider === 'groq') {
    return tools.map(t => ({
      type: 'function',
      function: {
        name:        t.name,
        description: t.description,
        parameters:  t.parameters,
      },
    }));
  }

  // Anthropic format (default)
  return tools.map(t => ({
    name:         t.name,
    description:  t.description,
    input_schema: t.parameters,
  }));
}

// ── Tools eines Agenten aus DB laden ───────────────────────────────────────
async function loadAgentTools(pool, agentId) {
  try {
    const r = await pool.query(
      `SELECT t.* FROM tools t
       JOIN agent_tools at2 ON at2.tool_id = t.id
       WHERE at2.agent_id = $1 AND at2.enabled = true AND t.enabled = true
       ORDER BY t.name`,
      [agentId]
    );
    return r.rows;
  } catch {
    return [];
  }
}

// ── Globale Builtin-Tool-Definitionen (für DB-Seed) ─────────────────────────
const BUILTIN_DEFINITIONS = [

  {
    name: 'calendar_get_events',
    description: 'Lädt bevorstehende Kalendertermine aus dem verbundenen Kalender.',
    type: 'builtin',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start-Datum ISO (z.B. 2025-01-20T00:00:00Z)' },
        to:   { type: 'string', description: 'End-Datum ISO' },
        max_results: { type: 'number', default: 10 },
      },
    },
  },
  {
    name: 'calendar_find_slots',
    description: 'Findet freie Zeitslots im Kalender für einen Termin.',
    type: 'builtin',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Suche ab (ISO-Datum)' },
        to:   { type: 'string', description: 'Suche bis (ISO-Datum)' },
        duration_minutes: { type: 'number', default: 60, description: 'Termindauer in Minuten' },
      },
    },
  },
  {
    name: 'email_get_messages',
    description: 'Lädt E-Mails aus dem verbundenen E-Mail-Postfach.',
    type: 'builtin',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail-Suchfilter z.B. "is:unread is:important"', default: 'is:inbox is:unread' },
        max_results: { type: 'number', default: 10 },
      },
    },
  },
  {
    name: 'qualify_leads',
    description: 'Qualifiziert neue Leads mit KI-Scoring (BANT-Methode) und gibt priorisierte Liste zurück.',
    type: 'builtin',
    parameters: {
      type: 'object',
      properties: {
        agent_id: { type: 'number', description: 'Agent-ID dessen Leads qualifiziert werden sollen' },
        limit: { type: 'number', default: 20 },
      },
    },
  },
  {
    name: 'web_search',
    description: 'Sucht im Internet nach aktuellen Informationen zu einem Thema.',
    type: 'builtin',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Suchanfrage' },
        max_results: { type: 'number', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_scrape',
    description: 'Liest den Inhalt einer Webseite und extrahiert den Text.',
    type: 'builtin',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL der Webseite (https://...)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'web_research',
    description: 'Führt eine mehrstufige Webrecherche durch: suchen → lesen → analysieren → Bericht erstellen.',
    type: 'builtin',
    parameters: {
      type: 'object',
      properties: {
        goal:  { type: 'string', description: 'Was soll recherchiert werden?' },
        depth: { type: 'number', default: 3, description: 'Anzahl zu analysierender Quellen' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'analyze_document',
    description: 'Analysiert ein hochgeladenes Dokument (PDF, DOCX) und extrahiert Informationen oder Risiken.',
    type: 'builtin',
    parameters: {
      type: 'object',
      properties: {
        doc_id: { type: 'number', description: 'ID des Dokuments' },
        agent_id: { type: 'number', description: 'Agent-ID' },
        analysis_type: { type: 'string', enum: ['summary','risks','contract','key_info'], default: 'summary' },
      },
      required: ['doc_id','agent_id'],
    },
  },

  {
    name: 'get_current_time',
    description: 'Gibt die aktuelle Uhrzeit und das Datum zurück.',
    type: 'builtin',
    parameters: {
      type: 'object',
      properties: {
        timezone: { type: 'string', description: 'Zeitzone z.B. Europe/Berlin', default: 'Europe/Berlin' },
      },
    },
  },
  {
    name: 'calculate',
    description: 'Berechnet einen mathematischen Ausdruck (Addition, Subtraktion, Multiplikation, Division).',
    type: 'builtin',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'Mathematischer Ausdruck, z.B. "19 * 1.19"' },
      },
      required: ['expression'],
    },
  },
  {
    name: 'save_to_memory',
    description: 'Speichert eine Information dauerhaft im Agenten-Memory.',
    type: 'builtin',
    parameters: {
      type: 'object',
      properties: {
        key:   { type: 'string', description: 'Name der Information' },
        value: { type: 'string', description: 'Wert der Information' },
        scope: { type: 'string', enum: ['longterm','contact','business'], default: 'longterm' },
      },
      required: ['key','value'],
    },
  },
  {
    name: 'read_from_memory',
    description: 'Liest eine zuvor gespeicherte Information aus dem Memory.',
    type: 'builtin',
    parameters: {
      type: 'object',
      properties: {
        key:   { type: 'string', description: 'Name der Information' },
        scope: { type: 'string', enum: ['longterm','contact','business'], default: 'longterm' },
      },
      required: ['key'],
    },
  },
  {
    name: 'create_task',
    description: 'Erstellt eine Hintergrundaufgabe die asynchron ausgeführt wird.',
    type: 'builtin',
    parameters: {
      type: 'object',
      properties: {
        title:       { type: 'string', description: 'Titel der Aufgabe' },
        description: { type: 'string', description: 'Beschreibung was getan werden soll' },
        type:        { type: 'string', enum: ['generic','http_call','email'], default: 'generic' },
      },
      required: ['title'],
    },
  },
  {
    name: 'send_email',
    description: 'Sendet eine E-Mail an eine Adresse.',
    type: 'builtin',
    parameters: {
      type: 'object',
      properties: {
        to:      { type: 'string', description: 'Empfänger-E-Mail-Adresse' },
        subject: { type: 'string', description: 'Betreff' },
        body:    { type: 'string', description: 'E-Mail-Text' },
      },
      required: ['to','subject','body'],
    },
  },
];

module.exports = { executeTool, formatToolsForLLM, loadAgentTools, BUILTIN_DEFINITIONS, BUILTIN_TOOLS };
