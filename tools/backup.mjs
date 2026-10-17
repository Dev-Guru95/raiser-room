/**
 * One consistent backup of everything a customer would lose.
 *
 *   node tools/backup.mjs --data-dir /data --dest /var/backups/raiseroom
 *
 * Run it nightly from cron. It exits 0 when a verified backup is on disk and 1
 * when there is not one, so cron mailing a failure is enough to notice.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY `VACUUM INTO` AND NEVER `cp`
 *
 * SQLite writes a page at a time. Copying the file while the application is
 * running can capture a write that is half applied — a backup that restores
 * without complaint and is quietly missing or corrupting the last thing
 * somebody did. `VACUUM INTO` goes through SQLite itself, which knows what a
 * consistent snapshot is. The product never has to be stopped for this.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE ORDER OF THE TWO HALVES, WHICH IS THE WHOLE CORRECTNESS ARGUMENT
 *
 * `/data` is two things that reference each other: the database, which holds a
 * row per uploaded document, and `/data/objects`, which holds the bytes. A
 * backup of one without the other is a list of documents that cannot be opened,
 * or a pile of bytes nobody can name.
 *
 * They cannot be captured in the same instant, so the order has to make the gap
 * harmless. The database is snapshotted FIRST and the objects copied SECOND,
 * because the product only records a document as uploaded once its bytes are
 * actually stored (`src/web/routes/work.js`, and the test that holds it there).
 * So:
 *
 *   · Anything the database snapshot refers to was written to disk before the
 *     snapshot was taken, which means the later object copy catches it.
 *   · Anything that lands during the copy has no row yet, so it is an orphaned
 *     file in the backup — invisible, harmless, and gone at the next retention
 *     sweep.
 *
 * Reverse the order and the gap inverts into the one failure that matters: a
 * row pointing at bytes the backup does not contain.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES NOT DO, AND MUST NOT BE ASSUMED TO DO
 *
 * It writes to a local path. A backup on the same box as the thing it backs up
 * survives a mistake, not a dead disk. Shipping it off the machine is the next
 * step and belongs to whatever already holds credentials for your storage.
 *
 * It does not encrypt. The data processing addendum promises *encrypted*
 * backups overwritten within 35 days; this command owns the 35 days, and the
 * step that ships it off the box owns the encryption. The manifest and the
 * output both record `encrypted: false`, so a deployment cannot quietly end up
 * believing otherwise.
 */

import { argv, exit, stderr, stdout } from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import {
  mkdirSync, cpSync, existsSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const argFor = (flag, fallback = null) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const dataDir = argFor('--data-dir', '/data');
const databaseFile = argFor('--database', join(dataDir, 'raiseroom.db'));
const objectsDir = argFor('--objects', join(dataDir, 'objects'));
const dest = resolve(argFor('--dest', join(dataDir, 'backups')));
const retainDays = Number(argFor('--retain-days', '35'));

/** A directory name that sorts chronologically and is legal on every filesystem. */
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const setDir = join(dest, stamp);

/** Files and bytes under a directory, counted after the copy rather than before. */
const measure = (dir) => {
  let files = 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    files += 1;
    total += statSync(join(entry.parentPath ?? entry.path, entry.name)).size;
  }
  return { files, total };
};

const alerts = [];
const fail = (code, says) => alerts.push({ code, says });

let database = null;
let objects = null;

try {
  if (!existsSync(databaseFile)) {
    fail('database_missing', `${databaseFile} does not exist, so nothing was backed up. `
      + 'Check --data-dir, or --database if the file is not in the usual place.');
  } else {
    mkdirSync(setDir, { recursive: true });
    const snapshot = join(setDir, 'raiseroom.db');

    // ── half one: the database, through SQLite ──────────────────────────────
    const live = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      // The quoting is SQLite's own: a single-quoted literal with any quote in
      // the path doubled. VACUUM INTO takes a literal rather than a parameter,
      // so this is the one escape that has to be right.
      live.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
    } finally {
      live.close();
    }

    // A snapshot nobody opened is a hope rather than a backup. This is the
    // cheapest available proof that the file is a database and its pages hang
    // together — it is not a proof that the contents are what you expect, which
    // is what the restore drill in docs/DEPLOY.md is for.
    const taken = new DatabaseSync(snapshot, { readOnly: true });
    let integrity = 'unknown';
    let organisations = null;
    try {
      integrity = taken.prepare('PRAGMA integrity_check').get()?.integrity_check ?? 'unknown';
      organisations = taken.prepare('SELECT COUNT(*) AS n FROM "organisation"').get()?.n ?? null;
    } finally {
      taken.close();
    }
    if (integrity !== 'ok') {
      fail('database_corrupt', `the snapshot failed PRAGMA integrity_check: ${integrity}. `
        + 'Do not ship this set, and do not prune the one before it.');
    }
    database = {
      file: snapshot, bytes: statSync(snapshot).size, integrity, organisations,
    };

    // ── half two: the objects, after the database, deliberately ─────────────
    if (!existsSync(objectsDir)) {
      // Not a failure: a deployment nobody has uploaded to yet has no directory,
      // and loses nothing by not having one backed up.
      objects = { files: 0, bytes: 0, note: `${objectsDir} does not exist yet` };
    } else {
      cpSync(objectsDir, join(setDir, 'objects'), { recursive: true });
      const counted = measure(join(setDir, 'objects'));
      objects = { files: counted.files, bytes: counted.total };
    }

    writeFileSync(join(setDir, 'manifest.json'), `${JSON.stringify({
      at: new Date().toISOString(),
      source: { database: databaseFile, objects: objectsDir },
      database,
      objects,
      encrypted: false,
      restore_with: 'node tools/restore.mjs --from <this directory> --data-dir <target>',
    }, null, 2)}\n`);
  }
} catch (err) {
  fail('backup_failed', `${err?.code ?? 'error'}: ${err?.message ?? String(err)}`);
}

/**
 * Retention, which is a contractual commitment rather than housekeeping: the
 * data processing addendum says backups are overwritten within 35 days.
 *
 * Two deliberate choices. Pruning runs even when tonight's backup failed, since
 * the promise is about how long data is kept and a failure is not a reason to
 * keep it longer. And a set that failed its integrity check is still pruned on
 * age — the alternative is a directory that fills up with sets nobody can
 * restore, on a volume the product needs.
 */
const pruned = [];
if (existsSync(dest) && Number.isFinite(retainDays) && retainDays > 0) {
  const cutoff = Date.now() - retainDays * 86_400_000;
  for (const entry of readdirSync(dest, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === stamp) continue;
    try {
      if (statSync(join(dest, entry.name)).mtimeMs < cutoff) {
        rmSync(join(dest, entry.name), { recursive: true, force: true });
        pruned.push(entry.name);
      }
    } catch (err) {
      fail('prune_failed', `could not remove ${entry.name}: ${err?.message ?? String(err)}`);
    }
  }
}

const ok = alerts.length === 0;

// One JSON object per run on stdout for a log shipper, and a human summary on
// stderr — the same split as tools/watch.mjs, so the same command serves cron
// and a person running it by hand.
stdout.write(`${JSON.stringify({
  at: new Date().toISOString(),
  ok,
  set: ok ? setDir : null,
  database,
  objects,
  retain_days: retainDays,
  pruned,
  encrypted: false,
  alerts,
})}\n`);

if (ok) {
  stderr.write(`RaiseRoom — backup ${stamp}\n\n`
    + `  database  ${(database.bytes / 1e6).toFixed(1)} MB · integrity ${database.integrity}`
    + ` · ${database.organisations} organisation${database.organisations === 1 ? '' : 's'}\n`
    + `  objects   ${objects.files} files · ${(objects.bytes / 1e6).toFixed(1)} MB\n`
    + `  at        ${setDir}\n`
    + (pruned.length ? `  pruned    ${pruned.length} set(s) over ${retainDays} days old\n` : '')
    + '\nNot a backup until it leaves this machine. Ship it, encrypted.\n');
} else {
  stderr.write(`RaiseRoom — backup FAILED (${alerts.length})\n\n`
    + alerts.map((a) => `  ✗ ${a.code}\n    ${a.says}\n`).join('')
    + '\n');
}

exit(ok ? 0 : 1);
