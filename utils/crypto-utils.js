
'use strict';
/**
 * crypto-utils.js
 * AES-256-GCM Verschlüsselung für Integration-Credentials (OAuth-Tokens, API-Keys).
 * Key: ENCRYPTION_KEY env var (32 Bytes / 64 Hex-Zeichen).
 * Fallback: Klartext mit Warning (Entwicklungsumgebung).
 */
const crypto = require('crypto');

const KEY_HEX = process.env.ENCRYPTION_KEY;
const KEY     = KEY_HEX ? Buffer.from(KEY_HEX, 'hex') : null;

if (!KEY && process.env.NODE_ENV === 'production') {
  console.error('❌ ENCRYPTION_KEY nicht gesetzt! Credentials werden NICHT verschlüsselt.');
}

function encrypt(plaintext) {
  if (!KEY) return JSON.stringify({ encrypted: false, data: plaintext });
  const iv         = crypto.randomBytes(12);
  const cipher     = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted  = Buffer.concat([cipher.update(JSON.stringify(plaintext), 'utf8'), cipher.final()]);
  const authTag    = cipher.getAuthTag();
  return JSON.stringify({
    encrypted: true,
    iv:      iv.toString('hex'),
    tag:     authTag.toString('hex'),
    data:    encrypted.toString('hex'),
  });
}

function decrypt(stored) {
  let obj;
  try { obj = typeof stored === 'string' ? JSON.parse(stored) : stored; }
  catch { return stored; }

  if (!obj.encrypted) return obj.data ?? obj;
  if (!KEY) throw new Error('ENCRYPTION_KEY nicht gesetzt — Credentials nicht entschlüsselbar');

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm', KEY,
    Buffer.from(obj.iv, 'hex')
  );
  decipher.setAuthTag(Buffer.from(obj.tag, 'hex'));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(obj.data, 'hex')),
    decipher.final(),
  ]);
  return JSON.parse(dec.toString('utf8'));
}

module.exports = { encrypt, decrypt };
