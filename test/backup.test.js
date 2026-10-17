/**
 * The backup and the restore.
 *
 * These two commands are the only ones in the repository whose failure is
 * unrecoverable. Everything else can be run again: a failed deploy is rolled
 * back, a wrong figure is superseded, a bad extraction is rejected by a
 * reviewer. A backup that was never a backup is discovered on the one day it
 * was needed, and there is nothing to fall back to.
 *
 * So what is tested here is not that the happy path works — it is the three
 * ways these commands could be quietly wrong:
 *
 *   1. The two halves of `/data` disagree. The database lists a document whose
 *      bytes are not in the backup, so it lists and will not open.
 *   2. A restore destroys state that was not supposed to be touched, because it
 *      was run against the wrong host at the wrong moment.
 *   3. Retention keeps data longer than the addendum promises, or deletes the
 *      only good set.
 *
 * The commands are driven as a deployment drives them — spawned, with
 * arguments, checked by exit code and by what is on disk afterwards — rather
 * than imported. An import would test functions that no deployment calls.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, utimesSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase } from '../src/db/sqlite.js';
import { SCHEMA_PATH } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const BACKUP = join(here, '..', 'tools', 'backup.mjs');
const RESTORE = join(here, '..', 'tools', 'restore.mjs');

/**
 * Run one of the commands and hand back its exit code and both streams.
 *
 * `--experimental-sqlite` is passed explicitly rather than inherited: the test
 * runner has it, and a child spawned without it fails on the import with a
 * message that looks nothing like the thing being tested.
 */
function run(script, args) {
  try {
    const stdout = execFileSync(process.execPath, ['--experimental-sqlite', script, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, json: JSON.parse(stdout.trim().split('\n').pop()) };
  } catch (err) {
    const stdout = err.stdout ?? '';
    let json = null;
    try { json = JSON.parse(stdout.trim().split('\n').pop()); } catch { json = null; }
    return { code: err.status ?? 1, stdout, stderr: err.stderr ?? '', json };
  }
}

/**
 * A `/data` directory with something in it worth losing: one organisation, one
 * document row, and the bytes that document refers to.
 */
function liveData({ objectCount = 3 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'raiseroom-live-'));
  const databaseFile = join(root, 'raiseroom.db');
  const objectsDir = join(root, 'objects');
  mkdirSync(objectsDir, { recursive: true });

  const db = openDatabase({ file: databaseFile, schemaPath: SCHEMA_PATH });
  const org = db.insert('organisation', { name: 'Test Co', path: 'RAISE' });
  for (let i = 0; i < objectCount; i += 1) {
    const key = `orgs/${org.id}/artifacts/doc-${i}.html`;
    mkdirSync(join(objectsDir, dirname(key)), { recursive: true });
    writeFileSync(join(objectsDir, key), `<p>document ${i}</p>`);
  }
  db.raw.close();

  return { root, databaseFile, objectsDir, orgId: org.id };
}

const countFiles = (dir) => (existsSync(dir)
  ? readdirSync(dir, { withFileTypes: true, recursive: true }).filter((e) => e.isFile()).length
  : 0);

const organisationsIn = (file) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM "organisation"').get().n;
  } finally {
    db.close();
  }
};

// ───────────────────────────────────────────────── the round trip ──

test('a backup captures the database and the bytes it refers to, together', () => {
  const live = liveData({ objectCount: 3 });
  const dest = mkdtempSync(join(tmpdir(), 'raiseroom-dest-'));

  const out = run(BACKUP, [
    '--database', live.databaseFile, '--objects', live.objectsDir, '--dest', dest,
  ]);

  assert.equal(out.code, 0, out.stderr);
  assert.equal(out.json.ok, true);
  assert.equal(out.json.database.integrity, 'ok');
  assert.equal(out.json.database.organisations, 1);
  // The count is the point. A backup of the database alone passes every check
  // except this one, and leaves every document listed and unopenable.
  assert.equal(out.json.objects.files, 3);

  const set = out.json.set;
  assert.ok(existsSync(join(set, 'raiseroom.db')));
  assert.equal(countFiles(join(set, 'objects')), 3);

  // The manifest says what was not done, so nobody has to infer it.
  const manifest = JSON.parse(readFileSync(join(set, 'manifest.json'), 'utf8'));
  assert.equal(manifest.encrypted, false);
});

test('a backup can be taken while the database is open, which is the only time it is ever taken', () => {
  const live = liveData();
  const dest = mkdtempSync(join(tmpdir(), 'raiseroom-dest-'));

  // Held open for writing for the duration, as the running application holds it.
  const holding = new DatabaseSync(live.databaseFile);
  holding.exec('PRAGMA journal_mode = WAL');
  holding.prepare('INSERT INTO "organisation" (id, created_at, name, path) VALUES (?, ?, ?, ?)')
    .run('org-2', new Date().toISOString(), 'Second Co', 'SELL');

  try {
    const out = run(BACKUP, [
      '--database', live.databaseFile, '--objects', live.objectsDir, '--dest', dest,
    ]);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.json.database.integrity, 'ok');
    assert.equal(out.json.database.organisations, 2);
  } finally {
    holding.close();
  }
});

test('a restored backup holds exactly what the backup held', () => {
  const live = liveData({ objectCount: 4 });
  const dest = mkdtempSync(join(tmpdir(), 'raiseroom-dest-'));
  const target = join(mkdtempSync(join(tmpdir(), 'raiseroom-target-')), 'data');

  const backup = run(BACKUP, [
    '--database', live.databaseFile, '--objects', live.objectsDir, '--dest', dest,
  ]);
  const out = run(RESTORE, ['--from', backup.json.set, '--data-dir', target]);

  assert.equal(out.code, 0, out.stderr);
  assert.equal(out.json.ok, true);
  assert.equal(out.json.database.integrity, 'ok');
  assert.equal(out.json.database.organisations, 1);
  assert.equal(out.json.objects.files, 4);
  assert.equal(organisationsIn(join(target, 'raiseroom.db')), 1);
  assert.equal(countFiles(join(target, 'objects')), 4);
});

test('a dry run says what it would do and writes nothing', () => {
  const live = liveData();
  const dest = mkdtempSync(join(tmpdir(), 'raiseroom-dest-'));
  const target = join(mkdtempSync(join(tmpdir(), 'raiseroom-target-')), 'data');

  const backup = run(BACKUP, [
    '--database', live.databaseFile, '--objects', live.objectsDir, '--dest', dest,
  ]);
  const out = run(RESTORE, ['--from', backup.json.set, '--data-dir', target, '--dry-run']);

  assert.equal(out.code, 0, out.stderr);
  assert.equal(out.json.dry_run, true);
  assert.equal(existsSync(join(target, 'raiseroom.db')), false);
});

// ──────────────────────────────────────── what a restore refuses ──

test('a restore will not write over a database that is already there', () => {
  const live = liveData();
  const dest = mkdtempSync(join(tmpdir(), 'raiseroom-dest-'));
  const backup = run(BACKUP, [
    '--database', live.databaseFile, '--objects', live.objectsDir, '--dest', dest,
  ]);

  // Restoring back over the live directory, which is the wrong-host mistake.
  const out = run(RESTORE, ['--from', backup.json.set, '--data-dir', live.root]);

  assert.equal(out.code, 1);
  assert.equal(out.json.ok, false);
  assert.match(out.json.refused, /already exists/);
  assert.match(out.json.refused, /Nothing has been written/);
});

test('a forced restore moves what was there aside instead of deleting it', () => {
  const live = liveData({ objectCount: 2 });
  const dest = mkdtempSync(join(tmpdir(), 'raiseroom-dest-'));
  const backup = run(BACKUP, [
    '--database', live.databaseFile, '--objects', live.objectsDir, '--dest', dest,
  ]);

  // Something written after the backup: the thing a careless restore loses.
  const after = new DatabaseSync(live.databaseFile);
  after.prepare('INSERT INTO "organisation" (id, created_at, name, path) VALUES (?, ?, ?, ?)')
    .run('org-after', new Date().toISOString(), 'Written Later', 'RAISE');
  after.close();
  assert.equal(organisationsIn(live.databaseFile), 2);

  const out = run(RESTORE, ['--from', backup.json.set, '--data-dir', live.root, '--force']);

  assert.equal(out.code, 0, out.stderr);
  // The restore is the backup's single organisation, as asked.
  assert.equal(organisationsIn(live.databaseFile), 1);
  // And the two-organisation database is still on disk, under another name. An
  // operator who forced a restore onto the wrong box can still get it back.
  assert.equal(out.json.superseded.length, 2);
  const supersededDb = out.json.superseded.find((p) => p.endsWith('.db') || p.includes('.db.'));
  assert.ok(supersededDb, out.json.superseded.join(', '));
  assert.equal(organisationsIn(supersededDb), 2);
});

test('a backup that is not a database is refused before anything is written', () => {
  const target = join(mkdtempSync(join(tmpdir(), 'raiseroom-target-')), 'data');
  const broken = mkdtempSync(join(tmpdir(), 'raiseroom-broken-'));
  // Right name, right place, wrong bytes — a truncated download, or a file that
  // was copied while it was being written.
  writeFileSync(join(broken, 'raiseroom.db'), 'this is not a database');

  const out = run(RESTORE, ['--from', broken, '--data-dir', target]);

  assert.equal(out.code, 1);
  assert.equal(out.json.ok, false);
  assert.equal(existsSync(join(target, 'raiseroom.db')), false);
});

test('a restore from a directory with no backup in it says which directory it wanted', () => {
  const empty = mkdtempSync(join(tmpdir(), 'raiseroom-empty-'));
  const out = run(RESTORE, ['--from', empty, '--data-dir', join(empty, 'data')]);

  assert.equal(out.code, 1);
  assert.match(out.json.refused, /does not exist/);
});

// ─────────────────────────────────────────────────── retention ──

test('retention removes sets older than the window and never the newest', () => {
  const live = liveData();
  const dest = mkdtempSync(join(tmpdir(), 'raiseroom-dest-'));

  // Two sets from well outside the window, and one from inside it.
  const old1 = join(dest, '2026-01-01T02-00-00-000Z');
  const old2 = join(dest, '2026-02-01T02-00-00-000Z');
  const recent = join(dest, '2026-10-01T02-00-00-000Z');
  for (const dir of [old1, old2, recent]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'raiseroom.db'), 'placeholder');
  }
  const longAgo = new Date('2026-01-01T02:00:00Z').getTime() / 1000;
  utimesSync(old1, longAgo, longAgo);
  utimesSync(old2, longAgo, longAgo);
  const nearly = Date.now() / 1000 - 3 * 86_400;
  utimesSync(recent, nearly, nearly);

  const out = run(BACKUP, [
    '--database', live.databaseFile, '--objects', live.objectsDir, '--dest', dest,
    '--retain-days', '35',
  ]);

  assert.equal(out.code, 0, out.stderr);
  assert.equal(out.json.pruned.length, 2);
  assert.equal(existsSync(old1), false);
  assert.equal(existsSync(old2), false);
  assert.equal(existsSync(recent), true);
  // Tonight's set, which is the one that would be catastrophic to prune.
  assert.equal(existsSync(out.json.set), true);
});

test('retention is skipped rather than guessed when the window is not a number', () => {
  const live = liveData();
  const dest = mkdtempSync(join(tmpdir(), 'raiseroom-dest-'));
  const old = join(dest, '2026-01-01T02-00-00-000Z');
  mkdirSync(old, { recursive: true });
  const longAgo = new Date('2026-01-01T02:00:00Z').getTime() / 1000;
  utimesSync(old, longAgo, longAgo);

  const out = run(BACKUP, [
    '--database', live.databaseFile, '--objects', live.objectsDir, '--dest', dest,
    '--retain-days', 'forever',
  ]);

  // A typo in a cron line must not become an unbounded delete.
  assert.equal(out.code, 0, out.stderr);
  assert.equal(out.json.pruned.length, 0);
  assert.equal(existsSync(old), true);
});

// ───────────────────────────────────────── when there is nothing ──

test('a missing database is a failure, loudly, because cron is the only reader', () => {
  const dest = mkdtempSync(join(tmpdir(), 'raiseroom-dest-'));
  const out = run(BACKUP, [
    '--database', join(dest, 'nothing-here.db'), '--objects', join(dest, 'objects'),
    '--dest', dest,
  ]);

  assert.equal(out.code, 1);
  assert.equal(out.json.ok, false);
  assert.equal(out.json.alerts[0].code, 'database_missing');
});

test('a deployment nobody has uploaded to yet still backs up', () => {
  const root = mkdtempSync(join(tmpdir(), 'raiseroom-live-'));
  const databaseFile = join(root, 'raiseroom.db');
  openDatabase({ file: databaseFile, schemaPath: SCHEMA_PATH }).raw.close();
  const dest = mkdtempSync(join(tmpdir(), 'raiseroom-dest-'));

  const out = run(BACKUP, [
    '--database', databaseFile, '--objects', join(root, 'objects'), '--dest', dest,
  ]);

  // No objects directory is the normal state of a new deployment, not a fault.
  assert.equal(out.code, 0, out.stderr);
  assert.equal(out.json.objects.files, 0);
  assert.match(out.json.objects.note, /does not exist yet/);
});

test('every backup lands in its own directory, so one night cannot overwrite another', () => {
  const live = liveData();
  const dest = mkdtempSync(join(tmpdir(), 'raiseroom-dest-'));

  const first = run(BACKUP, ['--database', live.databaseFile, '--objects', live.objectsDir, '--dest', dest]);
  const second = run(BACKUP, ['--database', live.databaseFile, '--objects', live.objectsDir, '--dest', dest]);

  assert.notEqual(first.json.set, second.json.set);
  assert.equal(readdirSync(dest, { withFileTypes: true }).filter((e) => e.isDirectory()).length, 2);
  assert.ok(statSync(join(first.json.set, 'raiseroom.db')).size > 0);
});
