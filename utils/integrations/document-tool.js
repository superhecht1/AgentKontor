'use strict';
/**
 * integrations/document-tool.js
 * Dokumente (PDF, DOCX, TXT) analysieren:
 *   - Zusammenfassung
 *   - Risiko-Analyse (Verträge)
 *   - Schlüssel-Extraktion
 *   - Vergleich mehrerer Dokumente
 */

const fs = require('fs');
const path = require('path');

// ── Text aus Dokument extrahieren ───────────────────────────────────────────
async function extractText(filePath, mimeType) {
  const ext = path.extname(filePath).toLowerCase();

  // TXT / MD direkt lesen
  if (['.txt','.md','.csv'].includes(ext)) {
    return fs.readFileSync(filePath, 'utf8').slice(0, 50000);
  }

  // PDF — nutzt bestehende RAG-Pipeline
  if (ext === '.pdf') {
    try {
      const { execSync } = require('child_process');
      // pdftotext muss auf System verfügbar sein (Render.com hat es)
      const text = execSync(`pdftotext "${filePath}" -`, { timeout: 15000 }).toString();
      return text.slice(0, 50000);
    } catch {
      // Fallback: binär lesen und nach Text suchen
      const buf = fs.readFileSync(filePath);
      const text = buf.toString('latin1').replace(/[^\x20-\x7E\n]/g,' ').replace(/\s+/g,' ');
      return text.slice(0, 30000);
    }
  }

  // DOCX — einfaches XML-Parsing
  if (ext === '.docx') {
    try {
      const { execSync } = require('child_process');
      const text = execSync(`unzip -p "${filePath}" word/document.xml | sed 's/<[^>]*>//g'`, { timeout: 10000 }).toString();
      return text.trim().slice(0, 50000);
    } catch {
      return 'DOCX-Extraktion fehlgeschlagen';
    }
  }

  return 'Dateiformat nicht unterstützt';
}

// ── Dokument-Analyse (allgemein) ───────────────────────────────────────────
async function analyzeDocument(text, { analysisType = 'summary', language = 'de' }, callLLM) {
  const prompts = {
    summary: `Erstelle eine strukturierte Zusammenfassung (max. 300 Wörter) mit: Kernaussagen, wichtige Punkte, Fazit.`,
    risks: `Analysiere dieses Dokument auf Risiken und kritische Punkte. Gib JSON zurück:
{
  "risk_level": "high|medium|low",
  "risks": [{"category":"...","description":"...","severity":"high|medium|low","recommendation":"..."}],
  "key_clauses": [...],
  "recommendations": [...]
}`,
    key_info: `Extrahiere alle wichtigen Informationen aus diesem Dokument als strukturiertes JSON:
{
  "parties": [...],
  "dates": [...],
  "amounts": [...],
  "obligations": [...],
  "deadlines": [...],
  "contact_info": {...}
}`,
    contract: `Analysiere diesen Vertrag als erfahrener Jurist (kein Rechtsrat). Gib JSON zurück:
{
  "document_type": "...",
  "parties": [...],
  "term": "...",
  "key_obligations": [...],
  "risks": [{"issue":"...","severity":"high|medium|low","clause":"..."}],
  "unusual_clauses": [...],
  "missing_clauses": [...],
  "overall_risk": "high|medium|low",
  "summary": "..."
}`,
    questions: `Beantworte Fragen zu diesem Dokument. Was sind die 5 wichtigsten Fragen die man stellen würde und ihre Antworten? JSON: [{"question":"...","answer":"..."}]`,
  };

  const systemPrompt = `Du bist ein erfahrener Dokumenten-Analyst. Antworte auf ${language === 'de' ? 'Deutsch' : 'Englisch'}.${analysisType !== 'summary' ? ' Antworte nur mit validem JSON.' : ''}`;
  const userPrompt = `${prompts[analysisType] || prompts.summary}\n\n--- DOKUMENT ---\n${text.slice(0, 40000)}`;

  const resp = await callLLM('claude-sonnet-4-6', systemPrompt, [{ role: 'user', content: userPrompt }]);

  if (['risks','key_info','contract','questions'].includes(analysisType)) {
    try {
      const m = resp.match(/[\[\{][\s\S]*[\]\}]/);
      return m ? JSON.parse(m[0]) : resp;
    } catch {
      return resp;
    }
  }
  return resp;
}

// ── Dokument aus DB laden (RAG-Docs) ───────────────────────────────────────
async function getDocumentFromDB(pool, { docId, agentId }) {
  const r = await pool.query(
    'SELECT * FROM agent_documents WHERE id=$1 AND agent_id=$2',
    [docId, agentId]
  );
  if (!r.rows.length) throw new Error('Dokument nicht gefunden');
  const doc = r.rows[0];
  // Text aus der Chunks-Tabelle zusammensetzen
  const chunks = await pool.query(
    'SELECT content FROM document_chunks WHERE doc_id=$1 ORDER BY chunk_index',
    [docId]
  );
  const text = chunks.rows.map(c => c.content).join('\n\n');
  return { ...doc, text };
}

// ── Mehrere Dokumente vergleichen ──────────────────────────────────────────
async function compareDocuments(docs, { comparisonAspects = [] }, callLLM) {
  const aspects = comparisonAspects.length
    ? comparisonAspects
    : ['Inhalt', 'Vollständigkeit', 'Risiken', 'Konditionen'];

  const summaries = docs.map((d, i) =>
    `DOKUMENT ${i+1} (${d.name || 'Unbenannt'}):\n${d.text.slice(0, 5000)}`
  ).join('\n\n---\n\n');

  const resp = await callLLM('claude-sonnet-4-6',
    'Du bist ein Dokumenten-Analyst. Antworte mit validem JSON.',
    [{ role: 'user', content: `Vergleiche diese ${docs.length} Dokumente nach: ${aspects.join(', ')}.

${summaries}

Antworte mit JSON:
{
  "comparison_table": [
    {"aspect":"...","doc_1":"...","doc_2":"...","winner":"doc_1|doc_2|gleich"}
  ],
  "key_differences": [...],
  "recommendation": "...",
  "summary": "..."
}` }]
  );

  try {
    const m = resp.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : { summary: resp };
  } catch {
    return { summary: resp };
  }
}

module.exports = { extractText, analyzeDocument, getDocumentFromDB, compareDocuments };
