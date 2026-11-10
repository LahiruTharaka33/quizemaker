// Storage for QuizLock.
//
// The app keeps all state in one in-memory object (`db`) for speed (live quizzes update many times a second).
// This module loads that object at startup and persists it:
//   - DATABASE_URL set  -> PostgreSQL: one row per record in table `ql_records` (kind, id, data jsonb).
//                          Each save writes only the records that changed since the last save, in one transaction.
//   - otherwise         -> a local JSON file (data.json).
//
// Run a single server instance per database (state is cached in memory).

const fs = require('fs');

const KINDS = ['quizzes', 'runs', 'attempts', 'users', 'sessions', 'resets']; // runs = started sessions of a saved quiz
const empty = () => Object.fromEntries(KINDS.map((k) => [k, {}]));
function normalize(obj) {
  const db = obj && typeof obj === 'object' ? obj : {};
  for (const k of KINDS) if (!db[k] || typeof db[k] !== 'object') db[k] = {};
  return db;
}

// ---------------------------------------------------------------- JSON file
function jsonStorage(file) {
  let db = empty();
  if (fs.existsSync(file)) {
    try {
      db = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); // tolerate a BOM from Windows editors
    } catch (e) {
      // Never start empty over an unreadable file: the next save would wipe everyone's data.
      throw new Error(`Could not read ${file}: ${e.message}. Fix the file or restore a backup (nothing was changed).`);
    }
  }
  db = normalize(db);
  let timer = null;
  const write = () => {
    timer = null;
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, file);
  };
  return {
    kind: `file ${file}`,
    db,
    save() { clearTimeout(timer); timer = setTimeout(write, 300); },
    async flush() { if (timer) { clearTimeout(timer); write(); } },
    async close() { await this.flush(); },
  };
}

// ---------------------------------------------------------------- PostgreSQL
async function pgStorage(url, { table = 'ql_records', importFile } = {}) {
  const { Pool } = require('pg');
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error('Bad table name');
  // `sslmode=require` currently means full certificate verification in node-postgres; say so explicitly.
  const connectionString = url.replace(/([?&])sslmode=(require|prefer|verify-ca)\b/, '$1sslmode=verify-full');
  const pool = new Pool({ connectionString, max: 4, idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000 });
  pool.on('error', (e) => console.error('[db] idle connection error:', e.message)); // e.g. Neon closing idle sockets

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${table} (
      kind       text        NOT NULL,
      id         text        NOT NULL,
      data       jsonb       NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (kind, id)
    )`);

  const db = empty();
  const { rows } = await pool.query(`SELECT kind, id, data FROM ${table}`);
  for (const r of rows) if (db[r.kind]) db[r.kind][r.id] = r.data;

  // What the database currently holds, as JSON text per record, to find changes cheaply.
  const persisted = new Map(); // "kind\u0000id" -> json
  for (const k of KINDS) for (const [id, v] of Object.entries(db[k])) persisted.set(k + '\u0000' + id, JSON.stringify(v));

  // One-time import of an existing data.json into an empty database.
  let imported = 0;
  if (!rows.length && importFile && fs.existsSync(importFile)) {
    const old = normalize(JSON.parse(fs.readFileSync(importFile, 'utf8').replace(/^﻿/, '')));
    for (const k of KINDS) Object.assign(db[k], old[k]);
    imported = KINDS.reduce((n, k) => n + Object.keys(old[k]).length, 0);
  }

  let timer = null;
  let running = null; // promise of the flush in progress
  let again = false;  // another save arrived while flushing
  let failures = 0;

  async function flushOnce() {
    const upK = [], upI = [], upD = [], seen = new Set();
    for (const k of KINDS) {
      for (const [id, v] of Object.entries(db[k])) {
        const key = k + '\u0000' + id;
        seen.add(key);
        const json = JSON.stringify(v);
        if (persisted.get(key) !== json) { upK.push(k); upI.push(id); upD.push(json); }
      }
    }
    const delK = [], delI = [];
    for (const key of persisted.keys()) if (!seen.has(key)) { const [k, id] = key.split('\u0000'); delK.push(k); delI.push(id); }
    if (!upK.length && !delK.length) return;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (upK.length) {
        await client.query(
          `INSERT INTO ${table} (kind, id, data)
           SELECT * FROM unnest($1::text[], $2::text[], $3::jsonb[])
           ON CONFLICT (kind, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
          [upK, upI, upD]);
      }
      if (delK.length) {
        await client.query(
          `DELETE FROM ${table} t USING unnest($1::text[], $2::text[]) AS d(kind, id)
           WHERE t.kind = d.kind AND t.id = d.id`,
          [delK, delI]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    // Only mark as saved after the commit succeeded; on failure the same changes are retried.
    upK.forEach((k, i) => persisted.set(k + '\u0000' + upI[i], upD[i]));
    delK.forEach((k, i) => persisted.delete(k + '\u0000' + delI[i]));
  }

  async function flush() {
    clearTimeout(timer); timer = null;
    if (running) { again = true; return running; }
    running = (async () => {
      try {
        do { again = false; await flushOnce(); } while (again);
        if (failures) console.log('[db] saving works again');
        failures = 0;
      } catch (e) {
        failures++;
        const wait = Math.min(30000, 1000 * 2 ** Math.min(failures, 5));
        console.error(`[db] save failed (${e.message}); retrying in ${wait / 1000}s — nothing is lost while the server runs`);
        clearTimeout(timer); timer = setTimeout(flush, wait);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  const store = {
    kind: `PostgreSQL (table ${table})`,
    db,
    imported,
    save() { if (!timer) timer = setTimeout(flush, 300); },
    flush,
    async close() { await flush(); if (running) await running; await pool.end(); },
    pool,
  };
  if (imported) await flush();
  return store;
}

async function openStorage({ databaseUrl, dataFile, table }) {
  if (databaseUrl) return pgStorage(databaseUrl, { table, importFile: dataFile });
  return jsonStorage(dataFile);
}

module.exports = { openStorage };
