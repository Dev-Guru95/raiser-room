/**
 * The test that would have caught the bug that caused this port.
 *
 * A column named `index` shipped in the first implementation and broke
 * organisation setup completely on Cloudflare D1:
 *   D1_ERROR: near "index": syntax error at offset 52
 *
 * It was invisible on Postgres because Prisma quotes identifiers. This test
 * makes the schema prove itself against the strictest dialect we support,
 * on every run, for free.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { freshDb, SCHEMA_PATH } from './helpers.js';

/**
 * The set of words that genuinely break as a bare column name is derived by
 * ASKING SQLITE, not from a hand-maintained list.
 *
 * A hand-written list produces false positives — `action`, for instance, is a
 * SQL keyword but is perfectly legal as an identifier — and a test that cries
 * wolf is a test people start ignoring. Probing the engine is both stricter
 * where it matters and silent where it does not, and it stays correct when the
 * engine changes.
 */
const KEYWORDS = [
  'abort', 'action', 'add', 'after', 'all', 'alter', 'analyze', 'and', 'as', 'asc',
  'attach', 'autoincrement', 'before', 'begin', 'between', 'by', 'cascade', 'case',
  'cast', 'check', 'collate', 'column', 'commit', 'conflict', 'constraint', 'create',
  'cross', 'current_date', 'current_time', 'current_timestamp', 'database', 'default',
  'deferrable', 'deferred', 'delete', 'desc', 'detach', 'distinct', 'drop', 'each',
  'else', 'end', 'escape', 'except', 'exclusive', 'exists', 'explain', 'fail', 'for',
  'foreign', 'from', 'full', 'glob', 'group', 'having', 'if', 'ignore', 'immediate',
  'in', 'index', 'indexed', 'initially', 'inner', 'insert', 'instead', 'intersect',
  'into', 'is', 'isnull', 'join', 'limit', 'match', 'natural', 'no', 'not', 'notnull',
  'null', 'of', 'offset', 'on', 'or', 'order', 'outer', 'plan', 'pragma', 'primary',
  'query', 'raise', 'recursive', 'references', 'regexp', 'reindex', 'release',
  'rename', 'replace', 'restrict', 'right', 'rollback', 'row', 'savepoint', 'select',
  'set', 'table', 'temp', 'temporary', 'then', 'to', 'transaction', 'trigger',
  'union', 'unique', 'update', 'using', 'vacuum', 'values', 'view', 'virtual',
  'when', 'where', 'with', 'without',
];

/** Probe each keyword: does SQLite actually refuse it as a bare column name? */
const RESERVED = (() => {
  const breaks = [];
  for (const word of KEYWORDS) {
    const probe = new DatabaseSync(':memory:');
    try {
      probe.exec(`CREATE TABLE probe (id TEXT, ${word} TEXT)`);
    } catch {
      breaks.push(word);
    } finally {
      probe.close();
    }
  }
  return breaks;
})();

test('the schema file applies cleanly to SQLite', () => {
  const db = freshDb();
  assert.ok(db.raw, 'schema applied without a syntax error');
  db.close();
});

test('the probe found the words that genuinely break — including `index`', () => {
  assert.ok(RESERVED.includes('index'), 'the word that caused the original outage must be detected');
  assert.ok(RESERVED.length >= 4, `expected several breaking keywords, found ${RESERVED.length}`);
  assert.equal(RESERVED.includes('action'), false,
    '`action` is a keyword but a legal identifier — the probe must not produce false positives');
});

test('no column in any table is a SQLite reserved word', () => {
  const db = freshDb();
  const tables = db.raw.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  ).all();

  assert.ok(tables.length > 0, 'schema created at least one table');

  const offences = [];
  for (const { name: table } of tables) {
    for (const col of db.raw.prepare(`PRAGMA table_info("${table}")`).all()) {
      if (RESERVED.includes(String(col.name).toLowerCase())) {
        offences.push(`${table}.${col.name}`);
      }
    }
  }

  assert.deepEqual(offences, [],
    `reserved words used as column names: ${offences.join(', ')}. ` +
    'Rename them. Quoting works until someone writes a raw query.');
  db.close();
});

test('every column can be written without quoting — the real-world check', () => {
  // Quoting in our own adapter is not enough: a migration, a raw query or a
  // different client will not quote. Prove the names survive bare DDL.
  const db = freshDb();
  const tables = db.raw.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  ).all();

  for (const { name: table } of tables) {
    const cols = db.raw.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
    const probe = new DatabaseSync(':memory:');
    assert.doesNotThrow(
      () => probe.exec(`CREATE TABLE probe_${table} (${cols.map((c) => `${c} TEXT`).join(', ')})`),
      `table "${table}" has a column name that needs quoting`,
    );
    probe.close();
  }
  db.close();
});

test('the schema never reintroduces a column named "index"', () => {
  const sql = readFileSync(SCHEMA_PATH, 'utf8');
  // CREATE INDEX is fine; a COLUMN called index is not.
  const columnNamedIndex = /^\s*"?index"?\s+\w/im.test(sql);
  assert.equal(columnNamedIndex, false, 'a column named `index` is back — this is the original bug');
});

// ──────────────────────────────── properties with no observable behaviour ──

test('webhook signatures are compared in constant time', () => {
  // A source-level assertion, deliberately, and for the same reason this file
  // exists at all: some properties cannot be observed from the outside. A
  // verifier using `===` behaves identically to one using `timingSafeEqual` in
  // every functional test, and leaks the expected signature a byte at a time to
  // anyone willing to send enough requests — at an endpoint that is, by
  // necessity, reachable by everyone.
  const source = readFileSync(new URL('../src/billing/interface.js', import.meta.url), 'utf8');
  assert.match(source, /timingSafeEqual/,
    'the webhook verifier no longer compares signatures in constant time');
  assert.ok(!/expected\s*===\s*given|given\s*===\s*expected/.test(source),
    'the webhook verifier compares signatures with a plain equality check');
});
