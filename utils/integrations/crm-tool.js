'use strict';
/**
 * integrations/crm-tool.js
 * Lead-Qualifizierung, Anreicherung und CRM-Sync.
 * Intern: AgentKontor-Leads. Extern: Airtable, HubSpot (webhook-basiert).
 */

// ── Leads laden (intern aus AgentKontor) ───────────────────────────────────
async function getLeads(pool, userId, { agentId, since, limit = 50, unqualified = false }) {
  const conditions = ['l.user_id=$1'];
  const params     = [userId];
  let i = 2;
  if (agentId) { conditions.push(`l.agent_id=$${i++}`); params.push(agentId); }
  if (since)   { conditions.push(`l.created_at>=$${i++}`); params.push(since); }
  if (unqualified) conditions.push(`(l.score IS NULL OR l.score=0)`);
  params.push(limit);

  const r = await pool.query(
    `SELECT l.*, a.name as agent_name, a.emoji as agent_emoji
     FROM leads l
     LEFT JOIN agents a ON a.id=l.agent_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY l.created_at DESC
     LIMIT $${i}`,
    params
  );
  return r.rows;
}

// ── Lead mit LLM qualifizieren (BANT/MEDDIC) ─────────────────────────────
async function qualifyLead(lead, callLLM, criteria = 'BANT') {
  const data = typeof lead.data === 'string' ? JSON.parse(lead.data) : (lead.data || {});
  const dataStr = Object.entries(data).map(([k,v]) => `${k}: ${v}`).join('\n') || 'Keine Daten';

  const prompt = `Qualifiziere diesen Sales-Lead nach ${criteria}-Kriterien.
Lead-Daten:
${dataStr}
Quelle: ${lead.source || 'unbekannt'}
Agent: ${lead.agent_name || ''}

Antworte NUR mit JSON:
{
  "score": 0-10,
  "qualification": "hot|warm|cold",
  "budget": "ja|unklar|nein|unbekannt",
  "authority": "entscheider|beeinflusser|unklar",
  "need": "klar|unklar|kein_bedarf",
  "timeline": "sofort|3_monate|6_monate|unklar",
  "reasoning": "...",
  "next_action": "...",
  "enrichment": {"company_size":"...","industry":"...","pain_points":[]}
}`;

  const resp = await callLLM('claude-haiku-4-5',
    'Du bist ein erfahrener Sales-Analyst. Antworte nur mit JSON.',
    [{ role: 'user', content: prompt }]
  );
  try {
    const m = resp.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : { score: 0, qualification: 'cold', reasoning: resp };
  } catch {
    return { score: 0, qualification: 'cold', reasoning: 'Parse-Fehler' };
  }
}

// ── Lead-Score in DB speichern ──────────────────────────────────────────────
async function updateLeadScore(pool, leadId, qualification) {
  await pool.query(
    'UPDATE leads SET score=$1, updated_at=now() WHERE id=$2',
    [qualification.score || 0, leadId]
  );
}

// ── Leads an externes CRM senden (Webhook) ──────────────────────────────────
async function syncToCRM(lead, webhookUrl, apiKey) {
  const payload = {
    id:         lead.id,
    data:       lead.data,
    score:      lead.score,
    source:     lead.source || 'agentkontor',
    agent:      lead.agent_name,
    created_at: lead.created_at,
  };
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const resp = await fetch(webhookUrl, { method: 'POST', headers, body: JSON.stringify(payload) });
  if (!resp.ok) throw new Error(`CRM-Sync fehlgeschlagen: ${resp.status}`);
  return { synced: true, status: resp.status };
}

// ── Batch-Qualifizierung ────────────────────────────────────────────────────
async function batchQualify(pool, userId, { agentId, callLLM, crmWebhook, crmApiKey }) {
  const leads = await getLeads(pool, userId, { agentId, unqualified: true, limit: 20 });
  const results = [];

  for (const lead of leads) {
    try {
      const q = await qualifyLead(lead, callLLM);
      await updateLeadScore(pool, lead.id, q);
      if (crmWebhook) await syncToCRM({ ...lead, ...q }, crmWebhook, crmApiKey).catch(() => {});
      results.push({ id: lead.id, ...q });
    } catch (e) {
      results.push({ id: lead.id, error: e.message });
    }
  }
  return results;
}

// ── Kampagnen-Text generieren ────────────────────────────────────────────────
async function generateOutreach(lead, callLLM, { tone = 'professionell', language = 'de' }) {
  const data = typeof lead.data === 'string' ? JSON.parse(lead.data) : (lead.data || {});
  const name  = data.name || data.vorname || 'Interessent';
  const firma = data.firma || data.company || '';

  const resp = await callLLM('claude-sonnet-4-6',
    `Du schreibst ${language === 'de' ? 'deutsche' : 'englische'} Outreach-Texte im Stil: ${tone}.`,
    [{ role: 'user', content: `Schreibe eine kurze, persönliche Kontaktanfrage (max. 120 Wörter) für:
Name: ${name}
Firma: ${firma}
Score: ${lead.score}/10
Qualifizierung: ${lead.qualification || 'warm'}

Kein Betreff, nur den Text.` }]
  );
  return resp;
}

module.exports = { getLeads, qualifyLead, updateLeadScore, syncToCRM, batchQualify, generateOutreach };
