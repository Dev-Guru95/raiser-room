/**
 * Put a backup back, and say enough about what came back to be believed.
 *
 *   node tools/restore.mjs --from /var/backups/raiseroom/2026-10-17T02-00-00-000Z \
 *                          --data-dir /data
 *
 * Exits 0 when the restored state is present and coherent, 1 otherwise.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A COMMAND AND NOT A PARAGRAPH IN THE RUNBOOK
 *
 * The privacy policy says backups are tested. That sentence is only true if
 * somebody actually restores one, and people do not rehearse a procedure that
 * takes an afternoon of reading. A restore that is one command gets rehearsed;
 * one that is nine steps gets rehearsed once, by the person who wrote it.
 *
 * The drill the handover asks for is this command run on a SECOND host, followed
 * by signing in. Both halves matter: this command can tell you the database
 * opens and the objects are there, and it cannot tell you the application is
 * happy with what it found. Only signing in does that.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IT REFUSES TO DO
 *
 * It will not write over a database that already exists unless `--force` is
 * passed. A restore is run at the worst moment of the worst day, frequently
 * onto the wrong box, and the cost of the two directions is not symmetrical: a
 * refused restore costs ten seconds, and a restore that overwrites a live
 * database loses everything written since the backup.
 *
 * `--force` moves what is there aside rather than deleting it: the database
 * becomes `<name>.superseded-<timestamp>` and the objects directory likewise.
 * Even forced, nothing is destroyed — because the operator who typed `--force`
 * at 3am may have been wrong about which host they were on.
 */

import { argv, exit, stderr, stdout } from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const argFor = (flag, fallback = null) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const has = (flag) => argv.includes(flag);

const from = argFor('--from');
const dataDir = argFor('--data-dir', '/data');
const databaseFile = argFor('--database', join(dataDir, 'raiseroom.db'));
const objectsDir = argFor('--objects', join(dataDir, 'objects'));
const force = has('--force');
const dryRun = has('--dry-run');

const problems = [];
const stop = (says) => {
  stderr.write(`RaiseRoom — restore refused\n\n  ${says}\n\n`);
  stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ok: false, refused: says })}\n`);
  exit(1);
};

if (!from) {
  stop('Pass --from <backup directory>. That is the directory holding raiseroom.db, '
    + 'objects/ and manifest.json, not the directory holding all of them.');
}

const setDir = resolve(from);
const sourceDb = join(setDir, 'raiseroom.db');
const sourceObjects = join(setDir, 'objects');

if (!existsSync(sourceDb)) {
  stop(`${sourceDb} does not exist. If --from points at the backups root rather than at one `
    + 'set, pick one of the timestamped directories inside it.');
}

/**
 * Read the manifest if there is one, and carry on without it if there is not.
 *
 * A backup taken by hand with the two commands in docs/DEPLOY.md has no
 * manifest, and refusing to restore it would make this command useless in
 * exactly the situation it exists for.
 */
let manifest = null;
try {
  manifest = JSON.parse(readFileSync(join(setDir, 'manifest.json'), 'utf8'));
} catch {
  manifest = null;
}

// ── verify the source before touching the destination ──────────────────────
// A corrupt backup discovered after the live database has been moved aside is
// two problems. Discovered now, it is one, and the previous set is still there.
const incoming = new DatabaseSync(sourceDb, { readOnly: true });
let integrity = 'unknown';
let counts = {};
try {
  integrity = incoming.prepare('PRAGMA integrity_check').get()?.integrity_check ?? 'unknown';
  for (const table of ['organisation', 'membership', 'fact', 'document', 'artifact']) {
    counts[table] = incoming.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get()?.n ?? null;
  }
} catch (err) {
  problems.push(`the backup could not be read as a database: ${err?.message ?? String(err)}`);
} finally {
  incoming.close();
}
if (integrity !== 'ok') problems.push(`the backup failed PRAGMA integrity_check: ${integrity}`);
if (problems.length) stop(problems.join('\n  '));

const objectsInBackup = existsSync(sourceObjects)
  ? readdirSync(sourceObjects, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile()).length
  : 0;

if (dryRun) {
  stderr.write(`RaiseRoom — restore dry run\n\n`
    + `  from       ${setDir}\n`
    + `  taken      ${manifest?.at ?? 'unknown (no manifest)'}\n`
    + `  integrity  ${integrity}\n`
    + `  holds      ${counts.organisation} organisation${counts.organisation === 1 ? '' : 's'}`
    + ` · ${counts.fact} facts`
    + ` · ${counts.document} documents · ${objectsInBackup} stored files\n`
    + `  would write ${databaseFile}\n`
    + `              ${objectsDir}\n\n`
    + `Nothing was written. Drop --dry-run to restore.\n`);
  stdout.write(`${JSON.stringify({
    at: new Date().toISOString(), ok: true, dry_run: true, from: setDir, integrity, counts,
    objects: objectsInBackup,
  })}\n`);
  exit(0);
}

// ── move aside whatever is already there ───────────────────────────────────
const superseded = [];
const asideStamp = new Date().toISOString().replace(/[:.]/g, '-');
const moveAside = (path) => {
  if (!existsSync(path)) return;
  if (!force) {
    stop(`${path} already exists. Pass --force to move it aside and restore over it, `
      + 'or point --data-dir at an empty directory. Nothing has been written.');
  }
  const aside = `${path}.superseded-${asideStamp}`;
  renameSync(path, aside);
  superseded.push(aside);
};

moveAside(databaseFile);
moveAside(objectsDir);

mkdirSync(dirname(databaseFile), { recursive: true });
copyFileSync(sourceDb, databaseFile);

if (objectsInBackup > 0) {
  cpSync(sourceObjects, objectsDir, { recursive: true });
} else {
  // The application creates this on first write, but a directory that exists
  // and is empty is easier to tell apart from one the restore forgot.
  mkdirSync(objectsDir, { recursive: true });
}

// ── verify the destination, which is not the same as verifying the source ──
// The copy itself can fail: a full disk, a filesystem that truncates, a
// permission that applies to the directory but not the file.
const restored = new DatabaseSync(databaseFile, { readOnly: true });
let restoredIntegrity = 'unknown';
let restoredOrgs = null;
try {
  restoredIntegrity = restored.prepare('PRAGMA integrity_check').get()?.integrity_check ?? 'unknown';
  restoredOrgs = restored.prepare('SELECT COUNT(*) AS n FROM "organisation"').get()?.n ?? null;
} finally {
  restored.close();
}

const restoredObjects = existsSync(objectsDir)
  ? readdirSync(objectsDir, { withFileTypes: true, recursive: true }).filter((e) => e.isFile()).length
  : 0;

const alerts = [];
if (restoredIntegrity !== 'ok') {
  alerts.push({
    code: 'restored_corrupt',
    says: `the restored database fails PRAGMA integrity_check: ${restoredIntegrity}`,
  });
}
if (restoredOrgs !== counts.organisation) {
  alerts.push({
    code: 'organisation_count_differs',
    says: `the backup holds ${counts.organisation} organisations and the restore has ${restoredOrgs}`,
  });
}
if (restoredObjects !== objectsInBackup) {
  alerts.push({
    code: 'object_count_differs',
    says: `the backup holds ${objectsInBackup} stored files and the restore has ${restoredObjects}. `
      + 'Documents whose bytes are missing will list but not open.',
  });
}

const ok = alerts.length === 0;
stdout.write(`${JSON.stringify({
  at: new Date().toISOString(),
  ok,
  from: setDir,
  taken: manifest?.at ?? null,
  database: { file: databaseFile, integrity: restoredIntegrity, organisations: restoredOrgs },
  objects: { dir: objectsDir, files: restoredObjects },
  superseded,
  alerts,
})}\n`);

if (ok) {
  stderr.write(`RaiseRoom — restored\n\n`
    + `  from       ${setDir}\n`
    + `  taken      ${manifest?.at ?? 'unknown (no manifest)'}\n`
    + `  database   ${databaseFile} · integrity ${restoredIntegrity}`
    + ` · ${restoredOrgs} organisation${restoredOrgs === 1 ? '' : 's'}\n`
    + `  objects    ${objectsDir} · ${restoredObjects} files\n`
    + (superseded.length ? `  moved aside\n${superseded.map((p) => `             ${p}\n`).join('')}` : '')
    + `\nNow sign in. This command proves the data is readable; only signing in proves\n`
    + `the application is happy with what it found — which is the half of the drill\n`
    + `that has actually caught things.\n`);
} else {
  stderr.write(`RaiseRoom — restore finished with ${alerts.length} problem(s)\n\n`
    + alerts.map((a) => `  ✗ ${a.code}\n    ${a.says}\n`).join('')
    + (superseded.length
      ? `\nWhat was there is at:\n${superseded.map((p) => `  ${p}\n`).join('')}`
      : '')
    + '\n');
}

exit(ok ? 0 : 1);
