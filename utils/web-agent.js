'use strict';
/**
 * web-agent.js
 * Phase 4: Web-Agent
 *   search()    → Suche mit Brave/DuckDuckGo
 *   scrape()    → Webseite lesen + Text extrahieren
 *   compare()   → Mehrere Quellen vergleichen
 *   research()  → Mehrstufige Recherche mit strukturiertem Ergebnis
 */

const crypto = require('crypto');

// ── SSRF-Schutz ─────────────────────────────────────────────────────────────
const BLOCKED_HOSTS = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|169\.254\.169\.254|::1|fc00:|fd[0-9a-f]{2}:|metadata\.google\.internal|instance-data)/i;

function assertSafeUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Ungültige URL'); }
  if (!['http:','https:'].includes(parsed.protocol)) throw new Error('Nur HTTP/HTTPS erlaubt');
  if (BLOCKED_HOSTS.test(parsed.hostname)) throw new Error('Diese URL ist nicht erlaubt (interne Adresse)');
  return parsed;
}


// ── Web-Suche ───────────────────────────────────────────────────────────────
async function search(pool, { query, maxResults = 10, provider = 'brave', freshness = 'month' }) {
  // Cache prüfen (1h)
  const qHash = crypto.createHash('sha256').update(query).digest('hex');
  if (pool) {
    try {
      const cached = await pool.query(
        'SELECT results FROM web_search_cache WHERE query_hash=$1 AND expires_at>now()',
        [qHash]
      );
      if (cached.rows.length) return JSON.parse(cached.rows[0].results);
    } catch {}
  }

  let results = [];

  // Brave Search API
  if (provider === 'brave' && process.env.BRAVE_SEARCH_API_KEY) {
    const resp = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}&freshness=${freshness}`,
      { headers: { 'Accept': 'application/json', 'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY } }
    );
    if (resp.ok) {
      const data = await resp.json();
      results = (data.web?.results || []).map(r => ({
        title:   r.title,
        url:     r.url,
        snippet: r.description,
        age:     r.age,
      }));
    }
  }

  // DuckDuckGo Fallback (scraping, kein API-Key nötig)
  if (!results.length) {
    try {
      const resp = await fetch(
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AgentKontor/1.0)' } }
      );
      const text = await resp.text();
      // Simple regex extraction
      const matches = [...text.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/g)];
      const snippetMatches = [...text.matchAll(/class="result__snippet"[^>]*>([^<]+)</g)];
      results = matches.slice(0, maxResults).map((m, i) => ({
        title:   m[2].trim(),
        url:     m[1].startsWith('http') ? m[1] : `https://duckduckgo.com${m[1]}`,
        snippet: snippetMatches[i]?.[1]?.trim() || '',
      }));
    } catch {}
  }

  // Cache schreiben
  if (pool && results.length) {
    pool.query(
      `INSERT INTO web_search_cache (query_hash,query,results,provider)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (query_hash) DO UPDATE SET results=$3, expires_at=now()+INTERVAL '1 hour'`,
      [qHash, query, JSON.stringify(results), provider]
    ).catch(() => {});
  }

  return results.slice(0, maxResults);
}

// ── Webseite lesen ──────────────────────────────────────────────────────────
async function scrape(pool, url, { maxLength = 8000 } = {}) {
  // SSRF-Schutz: nur öffentliche URLs erlaubt
  assertSafeUrl(url);
  // Cache prüfen (6h)
  const urlHash = crypto.createHash('sha256').update(url).digest('hex');
  if (pool) {
    try {
      const cached = await pool.query(
        'SELECT title, content FROM page_content_cache WHERE url_hash=$1 AND expires_at>now()',
        [urlHash]
      );
      if (cached.rows.length) return { url, title: cached.rows[0].title, content: cached.rows[0].content };
    } catch {}
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AgentKontor/1.0)' },
    });
    clearTimeout(timeout);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const html = await resp.text();
    const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() || '';

    // HTML → plain text (simpel)
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, ' ')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s{3,}/g, '\n\n')
      .trim()
      .slice(0, maxLength);

    // Cache schreiben
    if (pool) {
      pool.query(
        `INSERT INTO page_content_cache (url_hash,url,title,content,word_count)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (url_hash) DO UPDATE SET content=$4, title=$3, fetched_at=now(), expires_at=now()+INTERVAL '6 hours'`,
        [urlHash, url, title, text, text.split(/\s+/).length]
      ).catch(() => {});
    }

    return { url, title, content: text };
  } catch (e) {
    clearTimeout(timeout);
    throw new Error(`Scraping fehlgeschlagen (${url}): ${e.message}`);
  }
}

// ── Mehrere Quellen analysieren + vergleichen ───────────────────────────────
async function compareResults(sources, { goal, columns = [] }, callLLM) {
  const sourceText = sources.map((s, i) =>
    `QUELLE ${i+1} — ${s.title || s.url}\n${(s.content || s.snippet || '').slice(0, 3000)}`
  ).join('\n\n---\n\n');

  const colStr = columns.length ? columns.join(', ') : 'Name, Preis, Features, Bewertung, Vor/Nachteile';

  const resp = await callLLM('claude-sonnet-4-6',
    'Du bist ein Research-Analyst. Antworte mit validem JSON.',
    [{ role: 'user', content: `Vergleiche die folgenden ${sources.length} Quellen für das Ziel: "${goal}"
Erstelle eine Vergleichstabelle mit Spalten: ${colStr}

${sourceText}

Antworte mit JSON:
{
  "headers": ["Name", ...weitere Spalten],
  "rows": [["Anbieter 1", "..."], ...],
  "winner": "...",
  "recommendation": "...",
  "key_findings": ["...", "..."]
}` }]
  );

  try {
    const m = resp.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : { key_findings: [resp] };
  } catch {
    return { key_findings: [resp] };
  }
}

// ── Mehrstufige Recherche ───────────────────────────────────────────────────
async function research(pool, sessionId, { goal, depth = 3, callLLM, onProgress }) {
  const steps  = [];
  const sources = [];

  const log = (type, data) => {
    steps.push({ type, timestamp: new Date().toISOString(), ...data });
    if (pool && sessionId) {
      pool.query(
        'UPDATE research_sessions SET steps=$1, updated_at=now() WHERE id=$2',
        [JSON.stringify(steps), sessionId]
      ).catch(() => {});
    }
    onProgress?.(type, data);
  };

  // Schritt 1: Initiale Suche
  log('search', { query: goal });
  const initialResults = await search(pool, { query: goal, maxResults: depth * 3 });
  sources.push(...initialResults);

  // Schritt 2: LLM bestimmt welche URLs relevant sind + Folgefragen
  const relevanceResp = await callLLM('claude-haiku-4-5',
    'Analysiere diese Suchergebnisse. Antworte nur mit JSON.',
    [{ role: 'user', content: `Ziel: ${goal}
Suchergebnisse: ${JSON.stringify(initialResults.slice(0, 10))}

Wähle die ${depth} relevantesten URLs zum Scrapen und schlage 2 Folge-Suchanfragen vor.
JSON: {"urls":[{"url":"...","reason":"..."}],"follow_up_queries":["...","..."]}` }]
  );

  let relevance = { urls: initialResults.slice(0, depth).map(r => ({ url: r.url, reason: 'initial' })), follow_up_queries: [] };
  try {
    const m = relevanceResp.match(/\{[\s\S]*\}/);
    if (m) relevance = JSON.parse(m[0]);
  } catch {}

  // Schritt 3: Seiten scrapen
  const scrapedContents = [];
  for (const { url, reason } of relevance.urls.slice(0, depth)) {
    log('scrape', { url, reason });
    try {
      const content = await scrape(pool, url);
      scrapedContents.push(content);
      log('scraped', { url, title: content.title, words: content.content.split(' ').length });
    } catch (e) {
      log('scrape_error', { url, error: e.message });
    }
  }

  // Schritt 4: Folge-Suchen
  for (const q of (relevance.follow_up_queries || []).slice(0, 2)) {
    log('search', { query: q, type: 'follow_up' });
    const followResults = await search(pool, { query: q, maxResults: 5 }).catch(() => []);
    sources.push(...followResults);

    // Top-Ergebnis der Folgesuche scrapen
    if (followResults[0]) {
      try {
        const content = await scrape(pool, followResults[0].url);
        scrapedContents.push(content);
      } catch {}
    }
  }

  // Schritt 5: Vergleich falls relevant
  let resultTable = null;
  if (goal.toLowerCase().includes('vergleich') || goal.toLowerCase().includes('anbieter') || goal.toLowerCase().includes('preis')) {
    log('compare', { sources: scrapedContents.length });
    resultTable = await compareResults(scrapedContents, { goal }).catch(() => null);
  }

  // Schritt 6: Synthese
  log('synthesize', {});
  const allContent = scrapedContents.map((c, i) =>
    `QUELLE ${i+1} (${c.title}):\n${c.content.slice(0, 3000)}`
  ).join('\n\n---\n\n');

  const finalReport = await callLLM('claude-sonnet-4-6',
    'Du bist ein professioneller Research-Analyst. Schreibe auf Deutsch.',
    [{ role: 'user', content: `Erstelle einen strukturierten Forschungsbericht zum Thema: "${goal}"

Quellen:
${allContent}

Bericht-Format:
## Zusammenfassung
## Wichtigste Erkenntnisse
## Details (mit Quellenangaben)
## Schlussfolgerung und Empfehlung` }]
  );

  // Session abschließen
  if (pool && sessionId) {
    await pool.query(
      `UPDATE research_sessions
         SET status='completed', result=$1, result_table=$2, sources=$3, steps=$4, updated_at=now()
       WHERE id=$5`,
      [finalReport, resultTable ? JSON.stringify(resultTable) : null,
       JSON.stringify(sources.slice(0, 20)), JSON.stringify(steps), sessionId]
    ).catch(() => {});
  }

  return { report: finalReport, table: resultTable, sources, steps };
}

module.exports = { search, scrape, compareResults, research };
