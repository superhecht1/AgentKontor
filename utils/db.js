'use strict';
/**
 * utils/db.js
 * Zentraler Pool-Zugriff.
 *
 * In Routes:          getPool(req)           → req.app.locals.pool
 * In Hintergrund-Utils (task-runner etc.):   getPool()  → globaler Pool
 */

const { Pool } = require('pg');

let _globalPool = null;

/**
 * Gibt den Pool zurück.
 * - Mit req: nutzt app.locals.pool (bevorzugt, kein zweiter Pool)
 * - Ohne req: erstellt / gibt globalen Singleton zurück
 */
function getPool(req) {
  if (req && req.app && req.app.locals && req.app.locals.pool) {
    return req.app.locals.pool;
  }
  if (!_globalPool) {
    _globalPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      statement_timeout: 30000,
    });
  }
  return _globalPool;
}

module.exports = { getPool };
