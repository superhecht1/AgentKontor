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
