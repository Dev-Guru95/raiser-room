/**
 * SQLite adapter — used by the test suite and for local development.
 *
 * Production runs Postgres. Everything above this file is dialect-agnostic:
 * the service layer only ever calls the small interface below, so swapping in
 * a Postgres adapter changes this file and nothing else.
 *
 * Tests run against SQLite deliberately. SQLite is the stricter dialect for
 * identifier quoting, so a reserved-word mistake fails here rather than in
 * production. That is the bug that started this port.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export function openDatabase({ file = ':memory:', schemaPath } = {}) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  if (schemaPath) db.exec(readFileSync(schemaPath, 'utf8'));
  return wrap(db);
}

function wrap(db) {
  const api = {
    raw: db,

    /** INSERT, returning the full row. */
    insert(table, data) {
      const row = { id: data.id ?? randomUUID(), created_at: data.created_at ?? new Date().toISOString(), ...data };
      const cols = Object.keys(row);
      // Identifiers are quoted. That alone is not a licence to use reserved
      // words — see test/reserved-words.test.js, which forbids them outright.
      const sql = `INSERT INTO "${table}" (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
      db.prepare(sql).run(...cols.map((c) => norm(row[c])));
      return api.get(table, row.id);
    },

    get(table, id) {
      return db.prepare(`SELECT * FROM "${table}" WHERE id = ?`).get(id) ?? null;
    },

    find(table, where = {}) {
      const keys = Object.keys(where);
      const sql = `SELECT * FROM "${table}"` +
        (keys.length ? ` WHERE ${keys.map((k) => `${q(k)} = ?`).join(' AND ')}` : '');
      return db.prepare(sql).all(...keys.map((k) => norm(where[k])));
    },

    findOne(table, where) {
      return api.find(table, where)[0] ?? null;
    },

    /**
     * Rows whose `column` falls in an inclusive range, ordered by it.
     *
     * Added for the usage counters, which are the only thing in the product
     * queried by a span rather than by a key. It is here rather than as raw SQL
     * at the call site because the whole point of this interface is that a
     * Postgres adapter replaces this file and nothing else — one module reaching
     * for `db.raw` is one module that has to be rewritten too.
     */
    range(table, column, { from, to } = {}) {
      const clauses = [];
      const args = [];
      if (from !== undefined) { clauses.push(`${q(column)} >= ?`); args.push(norm(from)); }
      if (to !== undefined) { clauses.push(`${q(column)} <= ?`); args.push(norm(to)); }
      const sql = `SELECT * FROM "${table}"`
        + (clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '')
        + ` ORDER BY ${q(column)}`;
      return db.prepare(sql).all(...args);
    },

    update(table, id, data) {
      const cols = Object.keys(data);
      if (!cols.length) return api.get(table, id);
      const sql = `UPDATE "${table}" SET ${cols.map((c) => `${q(c)} = ?`).join(', ')} WHERE id = ?`;
      db.prepare(sql).run(...cols.map((c) => norm(data[c])), id);
      return api.get(table, id);
    },

    remove(table, id) {
      db.prepare(`DELETE FROM "${table}" WHERE id = ?`).run(id);
    },

    count(table, where = {}) {
      const keys = Object.keys(where);
      const sql = `SELECT COUNT(*) AS n FROM "${table}"` +
        (keys.length ? ` WHERE ${keys.map((k) => `${q(k)} = ?`).join(' AND ')}` : '');
      return db.prepare(sql).get(...keys.map((k) => norm(where[k]))).n;
    },

    /**
     * Does the database answer?
     *
     * Behind the interface rather than a raw query at the call site, for the
     * same reason as `range`: the health check is the one thing that must keep
     * working when the adapter is swapped, and a health check written against
     * one dialect is a health check that has to be rewritten to prove the other
     * one is healthy.
     */
    ping() {
      const row = db.prepare('SELECT COUNT(*) AS n FROM "organisation"').get();
      if (typeof row?.n !== 'number') throw new Error('unexpected result');
      return true;
    },

    /**
     * The tables that exist, excluding the engine's own.
     *
     * Used by the health check to tell an empty volume from a broken one, and by
     * the export to discover which tables belong to an organisation rather than
     * from a hand-maintained list.
     */
    tables() {
      return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all().map((r) => r.name);
    },

    /**
     * A table's column names.
     *
     * Behind the interface because the export depends on it, and the export is
     * the product's most load-bearing promise — one click, everything, on every
     * plan, including after a subscription ends. Written as a PRAGMA at the call
     * site it was a promise that would quietly stop working the day the adapter
     * changed, in the one feature nobody exercises until they need it most.
     */
    columns(table) {
      return db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
    },

    close() { db.close(); },
  };
  return api;
}

const q = (ident) => `"${ident}"`;

/** node:sqlite accepts null, number, string, bigint, Uint8Array — map the rest. */
function norm(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}
