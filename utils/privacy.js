/**
 * AgentKontor — Privacy Utilities
 *
 * - AES-256-GCM encryption for sensitive DB columns
 * - IP anonymization (truncate last octet IPv4, first 80 bits IPv6)
 * - Session identifier hashing (SHA-256)
 * - PII detection / minimization before Anthropic calls
 */

'use strict';
const crypto = require('crypto');

// ── ENCRYPTION KEY ────────────────────────────────────────
// Set ENCRYPTION_KEY env var: 32 random bytes as hex (64 hex chars)
// Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
function getKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw || raw.length < 32) {
    // Derive a stable key from JWT_SECRET as fallback (not ideal but functional)
    return crypto.createHash('sha256').update(process.env.JWT_SECRET || 'fallback').digest();
  }
  return Buffer.from(raw.slice(0, 64), 'hex');
}

// ── AES-256-GCM ENCRYPT ───────────────────────────────────
function encrypt(plaintext) {
  if (!plaintext) return { ciphertext: '', iv: '', tag: '' };
  try {
    const key = getKey();
    const iv  = crypto.randomBytes(12); // 96-bit IV for GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      ciphertext: encrypted.toString('hex'),
      iv:         iv.toString('hex'),
      tag:        tag.toString('hex'),
      encrypted:  true,
    };
  } catch(e) {
    console.error('Encrypt error:', e.message);
    return { ciphertext: plaintext, iv: '', tag: '', encrypted: false };
  }
}

// ── AES-256-GCM DECRYPT ───────────────────────────────────
function decrypt(ciphertext, iv, tag) {
  if (!ciphertext || !iv || !tag) return ciphertext || '';
  try {
    const key     = getKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'hex')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch(e) {
    console.error('Decrypt error:', e.message);
    return '[Entschlüsselung fehlgeschlagen]';
  }
}

// ── ENCRYPT MEMORY FACTS (JSON array of strings) ─────────
function encryptFacts(factsArray) {
  const json = JSON.stringify(factsArray || []);
  return encrypt(json);
}

function decryptFacts(ciphertext, iv, tag) {
  if (!ciphertext) return [];
  try {
    const json = decrypt(ciphertext, iv, tag);
    return JSON.parse(json);
  } catch { return []; }
}

// ── IP ANONYMIZATION ──────────────────────────────────────
function anonymizeIp(ip) {
  if (!ip) return null;
  // IPv4: zero last octet → 192.168.1.0
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    return ip.replace(/\.\d+$/, '.0');
  }
  // IPv6: keep first 4 groups, zero rest → 2001:db8:85a3:0::
  if (ip.includes(':')) {
    const parts = ip.split(':');
    return parts.slice(0, 4).join(':') + '::';
  }
  return ip.slice(0, -3) + 'xxx'; // fallback
}

function hashIp(ip) {
  if (!ip) return null;
  const anonymized = anonymizeIp(ip);
  return crypto.createHash('sha256').update(anonymized + (process.env.IP_SALT || 'ak')).digest('hex').slice(0, 16);
}

// ── SESSION IDENTIFIER HASHING ────────────────────────────
function hashSessionId(sessionIdentifier) {
  if (!sessionIdentifier) return null;
  return crypto.createHash('sha256')
    .update(sessionIdentifier + (process.env.SESSION_SALT || 'aksession'))
    .digest('hex');
}

// ── PII MINIMIZATION for Anthropic API calls ─────────────
// Redact obvious PII patterns from messages before sending to external API
const PII_PATTERNS = [
  // IBAN
  { regex: /\b[A-Z]{2}\d{2}[\s]?(\d{4}[\s]?){4,6}\d{0,4}\b/g, replace: '[IBAN]' },
  // German ID / passport
  { regex: /\b[A-Z0-9]{9}\b(?=\s|$)/g, replace: '[AUSWEIS-NR]' },
  // Credit card (simple heuristic)
  { regex: /\b\d{4}[\s-]\d{4}[\s-]\d{4}[\s-]\d{4}\b/g, replace: '[KARTENNUMMER]' },
  // German phone (loose)
  { regex: /\b(\+49|0049|0)\s?[\d\s\-\/]{8,}\b/g, replace: '[TELEFON]' },
  // Social security / Sozialversicherungsnummer
  { regex: /\b\d{2}\s?\d{6}\s?[A-Z]\s?\d{3}\b/gi, replace: '[SV-NR]' },
];

function minimizePii(text) {
  if (!text || typeof text !== 'string') return text;
  let result = text;
  for (const p of PII_PATTERNS) {
    result = result.replace(p.regex, p.replace);
  }
  return result;
}

function minimizeMessages(messages) {
  return messages.map(m => {
    if (typeof m.content === 'string') {
      return { ...m, content: minimizePii(m.content) };
    }
    if (Array.isArray(m.content)) {
      return {
        ...m,
        content: m.content.map(block =>
          block.type === 'text' ? { ...block, text: minimizePii(block.text) } : block
        ),
      };
    }
    return m;
  });
}

// ── COOKIE HELPERS ────────────────────────────────────────
function setAuthCookie(res, token) {
  res.cookie('ak_token', token, {
    httpOnly:  true,
    secure:    process.env.NODE_ENV === 'production',
    sameSite:  'Lax',
    maxAge:    30 * 24 * 60 * 60 * 1000, // 30 days
    path:      '/',
  });
}

function clearAuthCookie(res) {
  res.clearCookie('ak_token', { httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
}

module.exports = {
  encrypt,
  decrypt,
  encryptFacts,
  decryptFacts,
  anonymizeIp,
  hashIp,
  hashSessionId,
  minimizePii,
  minimizeMessages,
  setAuthCookie,
  clearAuthCookie,
};
