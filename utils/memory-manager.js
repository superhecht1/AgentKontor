'use strict';
/**
 * memory-manager.js
 * Verwaltet alle vier Memory-Scopes:
 *   session   – Kurzzeit, nur diese Sitzung
 *   longterm  – Dauerhaft für diesen Agenten
 *   contact   – Pro Kontakt/Nutzer
 *   business  – Global für den Account (alle Agenten)
 */

// ── Eintrag schreiben (upsert) ──────────────────────────────────────────────
async function set(pool, { agentId, userId, sessionId, scope = 'session',
                           contactId, key, value, source = 'system',
                           confidence = 1.0, metadata = {}, ttlSeconds }) {
  const expiresAt = ttlSeconds
    ? new Date(Date.now() + ttlSeconds * 1000).toISOString()
    : null;

  await pool.query(
    `INSERT INTO agent_memory
       (agent_id, user_id, session_id, scope, contact_id, key, value,
        source, confidence, metadata, expires_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
     ON CONFLICT (agent_id, scope, COALESCE(session_id,''), COALESCE(contact_id,''), key)
     DO UPDATE SET
       value      = EXCLUDED.value,
       source     = EXCLUDED.source,
       confidence = EXCLUDED.confidence,
       metadata   = EXCLUDED.metadata,
       expires_at = EXCLUDED.expires_at,
       updated_at = now()`,
    [agentId, userId||null, sessionId||null, scope, contactId||null,
     key, String(value), source, confidence,
     JSON.stringify(metadata), expiresAt]
  );
}

// ── Eintrag lesen ───────────────────────────────────────────────────────────
async function get(pool, { agentId, sessionId, scope = 'session', contactId, key }) {
  const r = await pool.query(
    `SELECT value FROM agent_memory
     WHERE agent_id=$1 AND scope=$2
       AND COALESCE(session_id,'')  = COALESCE($3,'')
       AND COALESCE(contact_id,'') = COALESCE($4,'')
       AND key=$5
       AND (expires_at IS NULL OR expires_at > now())
     LIMIT 1`,
    [agentId, scope, sessionId||null, contactId||null, key]
  );
  return r.rows[0]?.value ?? null;
}

// ── Alle Einträge eines Scopes laden ────────────────────────────────────────
async function getAll(pool, { agentId, userId, sessionId, scope, contactId, limit = 100 }) {
  const conditions = ['agent_id=$1', '(expires_at IS NULL OR expires_at > now())'];
  const params = [agentId];
  let i = 2;

  if (scope)     { conditions.push(`scope=$${i++}`);      params.push(scope); }
  if (sessionId) { conditions.push(`session_id=$${i++}`); params.push(sessionId); }
  if (contactId) { conditions.push(`contact_id=$${i++}`); params.push(contactId); }
  if (userId)    { conditions.push(`user_id=$${i++}`);    params.push(userId); }

  const r = await pool.query(
    `SELECT id, scope, key, value, source, confidence, metadata, expires_at, updated_at
     FROM agent_memory
     WHERE ${conditions.join(' AND ')}
     ORDER BY updated_at DESC
     LIMIT $${i}`,
    [...params, limit]
  );
  return r.rows;
}

// ── Eintrag löschen ─────────────────────────────────────────────────────────
async function remove(pool, { agentId, id }) {
  await pool.query(
    'DELETE FROM agent_memory WHERE id=$1 AND agent_id=$2',
    [id, agentId]
  );
}

// ── Abgelaufene Einträge bereinigen ─────────────────────────────────────────
async function cleanup(pool) {
  const r = await pool.query(
    'DELETE FROM agent_memory WHERE expires_at IS NOT NULL AND expires_at < now()'
  );
  return r.rowCount;
}

// ── Memory in System-Prompt injizieren ─────────────────────────────────────
async function buildMemoryContext(pool, { agentId, userId, sessionId, contactId }) {
  const sections = [];

  // 1. Business-Memory (gilt für alle Agenten des Users)
  try {
    const biz = await getAll(pool, { agentId, userId, scope: 'business', limit: 20 });
    if (biz.length) {
      sections.push('## Unternehmenswissen\n' +
        biz.map(m => `- ${m.key}: ${m.value}`).join('\n'));
    }
  } catch {}

  // 2. Langzeit-Memory (für diesen Agenten dauerhaft)
  try {
    const lt = await getAll(pool, { agentId, scope: 'longterm', limit: 30 });
    if (lt.length) {
      sections.push('## Gespeichertes Wissen\n' +
        lt.map(m => `- ${m.key}: ${m.value}`).join('\n'));
    }
  } catch {}

  // 3. Kontakt-Memory (für diesen spezifischen Nutzer)
  if (contactId) {
    try {
      const contact = await getAll(pool, { agentId, scope: 'contact', contactId, limit: 20 });
      if (contact.length) {
        sections.push('## Über diesen Nutzer\n' +
          contact.map(m => `- ${m.key}: ${m.value}`).join('\n'));
      }
    } catch {}
  }

  // 4. Session-Memory (kurzfristig, diese Sitzung)
  if (sessionId) {
    try {
      const sess = await getAll(pool, { agentId, scope: 'session', sessionId, limit: 10 });
      if (sess.length) {
        sections.push('## Kontext dieser Sitzung\n' +
          sess.map(m => `- ${m.key}: ${m.value}`).join('\n'));
      }
    } catch {}
  }

  return sections.length
    ? '\n\n---\n' + sections.join('\n\n')
    : '';
}

// ── Fakten aus einer Konversation extrahieren (simple heuristics) ───────────
// In Produktion: LLM-basierte Extraktion
function extractFacts(message) {
  const facts = [];
  const text = message.toLowerCase();

  // Name
  const nameMatch = message.match(/(?:ich heiße|mein name ist|ich bin)\s+([A-ZÄÖÜ][a-zäöü]+(?: [A-ZÄÖÜ][a-zäöü]+)?)/i);
  if (nameMatch) facts.push({ key: 'name', value: nameMatch[1] });

  // E-Mail
  const emailMatch = message.match(/[\w.+-]+@[\w-]+\.[a-z]{2,}/);
  if (emailMatch) facts.push({ key: 'email', value: emailMatch[0] });

  // Telefon
  const phoneMatch = message.match(/(?:\+49|0049|0)\s?[\d\s\-\/]{8,14}/);
  if (phoneMatch) facts.push({ key: 'phone', value: phoneMatch[0].trim() });

  // Firma
  const firmMatch = message.match(/(?:firma|unternehmen|company|arbeite bei|bei der?\s+firma)\s+([^\.,!?]{3,40})/i);
  if (firmMatch) facts.push({ key: 'firma', value: firmMatch[1].trim() });

  return facts;
}

// ── Fakten aus Gespräch automatisch in contact-Memory speichern ─────────────
async function extractAndStore(pool, { agentId, userId, sessionId, contactId, userMessage }) {
  if (!userMessage || !contactId) return;
  const facts = extractFacts(userMessage);
  for (const { key, value } of facts) {
    try {
      await set(pool, {
        agentId, userId, sessionId,
        scope: 'contact', contactId,
        key, value,
        source: 'extracted',
        confidence: 0.8,
      });
    } catch {}
  }
  return facts;
}

const memoryManager = {
  set, get, getAll, remove, cleanup,
  buildMemoryContext, extractFacts, extractAndStore,
};

module.exports = { memoryManager };
