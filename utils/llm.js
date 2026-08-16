/**
 * AgentKontor — Universal LLM Client
 *
 * Unterstützte Anbieter:
 * ─ Anthropic  : claude-sonnet-4-6, claude-haiku-4-5, claude-opus-4-6
 * ─ OpenAI     : gpt-4o, gpt-4o-mini, o1-mini
 * ─ Google     : gemini-2.0-flash, gemini-1.5-pro, gemini-1.5-flash
 * ─ Mistral    : mistral-large-latest, mistral-small-latest, open-mistral-nemo
 * ─ Groq       : llama-3.3-70b-versatile, mixtral-8x7b-32768, gemma2-9b-it
 * ─ DeepSeek   : deepseek-chat, deepseek-reasoner
 *
 * Alle Modelle liefern: { reply: string, usage: { input_tokens, output_tokens }, provider }
 * Streaming: nur bei Anthropic und OpenAI vollständig unterstützt
 */

'use strict';

// ── MODELL-ROUTING ────────────────────────────────────────
const MODEL_PROVIDERS = {
  // Anthropic
  'claude-sonnet-4-6':         'anthropic',
  'claude-opus-4-6':           'anthropic',
  'claude-haiku-4-5':          'anthropic',
  'claude-haiku-4-5-20251001': 'anthropic',
  // OpenAI
  'gpt-4o':                    'openai',
  'gpt-4o-mini':               'openai',
  'gpt-4o-mini-2024-07-18':   'openai',
  'o1-mini':                   'openai',
  // Google Gemini
  'gemini-2.0-flash':          'google',
  'gemini-1.5-pro':            'google',
  'gemini-1.5-flash':          'google',
  // Mistral (EU-based — DSGVO-freundlich)
  'mistral-large-latest':      'mistral',
  'mistral-small-latest':      'mistral',
  'open-mistral-nemo':         'mistral',
  'codestral-latest':          'mistral',
  // Groq (ultraschnell)
  'llama-3.3-70b-versatile':   'groq',
  'llama-3.1-8b-instant':      'groq',
  'mixtral-8x7b-32768':        'groq',
  'gemma2-9b-it':              'groq',
  // DeepSeek
  'deepseek-chat':             'deepseek',
  'deepseek-reasoner':         'deepseek',
};

// ── PREISTABELLE (USD pro Million Tokens) ─────────────────
const MODEL_COSTS = {
  // Anthropic
  'claude-sonnet-4-6':         { in: 3.00,  out: 15.00 },
  'claude-opus-4-6':           { in: 15.00, out: 75.00 },
  'claude-haiku-4-5':          { in: 0.80,  out: 4.00  },
  'claude-haiku-4-5-20251001': { in: 0.80,  out: 4.00  },
  // OpenAI
  'gpt-4o':                    { in: 2.50,  out: 10.00 },
  'gpt-4o-mini':               { in: 0.15,  out: 0.60  },
  'gpt-4o-mini-2024-07-18':   { in: 0.15,  out: 0.60  },
  'o1-mini':                   { in: 3.00,  out: 12.00 },
  // Google Gemini
  'gemini-2.0-flash':          { in: 0.10,  out: 0.40  },
  'gemini-1.5-pro':            { in: 1.25,  out: 5.00  },
  'gemini-1.5-flash':          { in: 0.075, out: 0.30  },
  // Mistral
  'mistral-large-latest':      { in: 2.00,  out: 6.00  },
  'mistral-small-latest':      { in: 0.10,  out: 0.30  },
  'open-mistral-nemo':         { in: 0.15,  out: 0.15  },
  'codestral-latest':          { in: 1.00,  out: 3.00  },
  // Groq (sehr günstig)
  'llama-3.3-70b-versatile':   { in: 0.59,  out: 0.79  },
  'llama-3.1-8b-instant':      { in: 0.05,  out: 0.08  },
  'mixtral-8x7b-32768':        { in: 0.24,  out: 0.24  },
  'gemma2-9b-it':              { in: 0.20,  out: 0.20  },
  // DeepSeek
  'deepseek-chat':             { in: 0.27,  out: 1.10  },
  'deepseek-reasoner':         { in: 0.55,  out: 2.19  },
};

function getProvider(model) {
  if (model.startsWith('ft:')) return 'openai'; // Fine-tuned models
  return MODEL_PROVIDERS[model] || 'anthropic';
}

function calcCost(model, inputTokens, outputTokens) {
  const costs = MODEL_COSTS[model] || MODEL_COSTS['claude-sonnet-4-6'];
  return ((inputTokens * costs.in) + (outputTokens * costs.out)) / 1_000_000;
}

// ── ENV KEY HELPER ────────────────────────────────────────
function getApiKey(provider) {
  switch (provider) {
    case 'anthropic': return process.env.ANTHROPIC_API_KEY;
    case 'openai':    return process.env.OPENAI_API_KEY;
    case 'google':    return process.env.GOOGLE_AI_API_KEY;
    case 'mistral':   return process.env.MISTRAL_API_KEY;
    case 'groq':      return process.env.GROQ_API_KEY;
    case 'deepseek':  return process.env.DEEPSEEK_API_KEY;
    default:          return process.env.ANTHROPIC_API_KEY;
  }
}

// ── OPENAI-COMPATIBLE FETCH (Mistral, Groq, DeepSeek) ─────
async function openAICompat(baseUrl, apiKey, model, systemPrompt, messages, maxTokens = 1024) {
  const body = {
    model,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: systemPrompt || 'Du bist ein hilfreicher Assistent.' },
      ...messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string'
          ? m.content
          : m.content.map(b => b.type === 'text' ? b.text : '[Bild]').join(' '),
      })),
    ],
  };

  const resp = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`${resp.status}: ${err.slice(0, 200)}`);
  }

  const data = await resp.json();
  const reply = data.choices?.[0]?.message?.content || '';
  const usage = {
    input_tokens:  data.usage?.prompt_tokens     || 0,
    output_tokens: data.usage?.completion_tokens || 0,
  };
  return { reply, usage };
}

// ── ANTHROPIC ─────────────────────────────────────────────
async function callAnthropic(model, systemPrompt, messages, maxTokens = 1024) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response  = await client.messages.create({
    model, max_tokens: maxTokens, system: systemPrompt, messages,
  });
  return {
    reply:  response.content[0]?.text || '',
    usage:  response.usage || {},
    provider: 'anthropic',
  };
}

// ── OPENAI ────────────────────────────────────────────────
async function callOpenAI(model, systemPrompt, messages, maxTokens = 1024) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY nicht konfiguriert');
  const result = await openAICompat(
    'https://api.openai.com/v1/chat/completions',
    process.env.OPENAI_API_KEY,
    model, systemPrompt, messages, maxTokens
  );
  return { ...result, provider: 'openai' };
}

// ── GOOGLE GEMINI ─────────────────────────────────────────
async function callGoogle(model, systemPrompt, messages, maxTokens = 1024) {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_AI_API_KEY nicht konfiguriert');

  const url  = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt || '' }] },
    contents: messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: typeof m.content === 'string'
        ? [{ text: m.content }]
        : m.content.map(b => b.type === 'text' ? { text: b.text } : { text: '[Bild]' }),
    })),
    generationConfig: { maxOutputTokens: maxTokens },
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });

  if (!resp.ok) throw new Error(`Google AI ${resp.status}: ${await resp.text()}`);
  const data  = await resp.json();
  const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const usage = {
    input_tokens:  data.usageMetadata?.promptTokenCount     || 0,
    output_tokens: data.usageMetadata?.candidatesTokenCount || 0,
  };
  return { reply, usage, provider: 'google' };
}

// ── MISTRAL ───────────────────────────────────────────────
async function callMistral(model, systemPrompt, messages, maxTokens = 1024) {
  if (!process.env.MISTRAL_API_KEY) throw new Error('MISTRAL_API_KEY nicht konfiguriert');
  const result = await openAICompat(
    'https://api.mistral.ai/v1/chat/completions',
    process.env.MISTRAL_API_KEY,
    model, systemPrompt, messages, maxTokens
  );
  return { ...result, provider: 'mistral' };
}

// ── GROQ ──────────────────────────────────────────────────
async function callGroq(model, systemPrompt, messages, maxTokens = 1024) {
  if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY nicht konfiguriert');
  const result = await openAICompat(
    'https://api.groq.com/openai/v1/chat/completions',
    process.env.GROQ_API_KEY,
    model, systemPrompt, messages, maxTokens
  );
  return { ...result, provider: 'groq' };
}

// ── DEEPSEEK ──────────────────────────────────────────────
async function callDeepSeek(model, systemPrompt, messages, maxTokens = 1024) {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY nicht konfiguriert');
  const result = await openAICompat(
    'https://api.deepseek.com/v1/chat/completions',
    process.env.DEEPSEEK_API_KEY,
    model, systemPrompt, messages, maxTokens
  );
  return { ...result, provider: 'deepseek' };
}

// ── HAUPTFUNKTION: universeller LLM-Call ─────────────────
async function callLLM(model, systemPrompt, messages, maxTokens = 1024) {
  const provider = getProvider(model);
  switch (provider) {
    case 'anthropic': return callAnthropic(model, systemPrompt, messages, maxTokens);
    case 'openai':    return callOpenAI(model, systemPrompt, messages, maxTokens);
    case 'google':    return callGoogle(model, systemPrompt, messages, maxTokens);
    case 'mistral':   return callMistral(model, systemPrompt, messages, maxTokens);
    case 'groq':      return callGroq(model, systemPrompt, messages, maxTokens);
    case 'deepseek':  return callDeepSeek(model, systemPrompt, messages, maxTokens);
    default:          return callAnthropic(model, systemPrompt, messages, maxTokens);
  }
}

// ── MODELL-LISTE für Frontend ─────────────────────────────
const AVAILABLE_MODELS = [
  // Anthropic (default)
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'Anthropic', tier: 'pro', desc: 'Bestes Gesamtpaket', badge: '⭐ Empfohlen', costPer1k: 0.018 },
  { id: 'claude-haiku-4-5',  name: 'Claude Haiku 4.5',  provider: 'Anthropic', tier: 'free', desc: 'Schnell & günstig',  badge: '⚡ Schnell',  costPer1k: 0.005 },
  { id: 'claude-opus-4-6',   name: 'Claude Opus 4.6',   provider: 'Anthropic', tier: 'pro',  desc: 'Maximale Intelligenz', badge: '🧠 Stark',  costPer1k: 0.090 },
  // OpenAI
  { id: 'gpt-4o',            name: 'GPT-4o',             provider: 'OpenAI',    tier: 'pro', desc: 'Multimodal, sehr leistungsfähig',      badge: '', costPer1k: 0.013, requiresEnv: 'OPENAI_API_KEY' },
  { id: 'gpt-4o-mini',       name: 'GPT-4o mini',        provider: 'OpenAI',    tier: 'free',desc: 'Günstig, gut für einfache Aufgaben',   badge: '💰 Günstig', costPer1k: 0.001, requiresEnv: 'OPENAI_API_KEY' },
  // Google Gemini
  { id: 'gemini-2.0-flash',  name: 'Gemini 2.0 Flash',   provider: 'Google',    tier: 'free', desc: 'Sehr schnell, multimodal, günstig', badge: '🚀 Neu', costPer1k: 0.001, requiresEnv: 'GOOGLE_AI_API_KEY' },
  { id: 'gemini-1.5-pro',    name: 'Gemini 1.5 Pro',     provider: 'Google',    tier: 'pro',  desc: 'Riesiges Kontextfenster (1M Tokens)', badge: '📄 Große Kontexte', costPer1k: 0.006, requiresEnv: 'GOOGLE_AI_API_KEY' },
  // Mistral (EU / DSGVO-freundlich)
  { id: 'mistral-large-latest', name: 'Mistral Large',    provider: 'Mistral',   tier: 'pro', desc: 'EU-Anbieter, DSGVO-freundlich',       badge: '🇪🇺 EU', costPer1k: 0.008, requiresEnv: 'MISTRAL_API_KEY' },
  { id: 'mistral-small-latest', name: 'Mistral Small',    provider: 'Mistral',   tier: 'free',desc: 'EU, schnell & günstig',               badge: '🇪🇺 EU günstig', costPer1k: 0.001, requiresEnv: 'MISTRAL_API_KEY' },
  { id: 'open-mistral-nemo',    name: 'Mistral Nemo',     provider: 'Mistral',   tier: 'free',desc: 'Open-source, EU, sehr günstig',       badge: '🆓 Open', costPer1k: 0.001, requiresEnv: 'MISTRAL_API_KEY' },
  // Groq (ultraschnell)
  { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', provider: 'Groq',    tier: 'free',desc: 'Meta Llama via Groq — extrem schnell', badge: '⚡ Ultra-schnell', costPer1k: 0.001, requiresEnv: 'GROQ_API_KEY' },
  { id: 'llama-3.1-8b-instant',    name: 'Llama 3.1 8B',  provider: 'Groq',    tier: 'free',desc: 'Kleineres Modell, maximale Geschwindigkeit', badge: '🏎️ Instant', costPer1k: 0.0001, requiresEnv: 'GROQ_API_KEY' },
  // DeepSeek
  { id: 'deepseek-chat',     name: 'DeepSeek Chat',       provider: 'DeepSeek',  tier: 'free',desc: 'Sehr günstig, stark bei Code & Analyse', badge: '💡 Günstig', costPer1k: 0.001, requiresEnv: 'DEEPSEEK_API_KEY' },
  { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner',   provider: 'DeepSeek',  tier: 'pro', desc: 'Reasoning-Modell (wie o1), langsamer', badge: '🤔 Reasoning', costPer1k: 0.003, requiresEnv: 'DEEPSEEK_API_KEY' },
];

module.exports = {
  callLLM,
  calcCost,
  getProvider,
  MODEL_COSTS,
  MODEL_PROVIDERS,
  AVAILABLE_MODELS,
};
