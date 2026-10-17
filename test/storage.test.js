/**
 * Object storage.
 *
 * Both drivers are put through the same tests, because the whole point of the
 * interface is that the calling code cannot tell them apart. A test that only
 * ran against the memory driver would be a test about a Map.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localStorageDriver, memoryStorageDriver } from '../src/storage/local.js';
import { assertSafeKey } from '../src/storage/interface.js';

const SECRET = 'a-secret-long-enough-to-be-a-secret';
const KEY = 'orgs/org-1/documents/doc-1/accounts.pdf';

const drivers = () => {
  const root = mkdtempSync(join(tmpdir(), 'rr-storage-'));
  return [
    ['local', localStorageDriver({ root, secret: SECRET }), root],
    ['memory', memoryStorageDriver({ secret: SECRET }), null],
  ];
};

for (const [name] of drivers()) {
  const make = (opts = {}) => (name === 'local'
    ? localStorageDriver({ root: mkdtempSync(join(tmpdir(), 'rr-storage-')), secret: SECRET, ...opts })
    : memoryStorageDriver({ secret: SECRET, ...opts }));

  test(`${name}: bytes written come back exactly`, () => {
    const s = make();
    const bytes = Buffer.from('%PDF-1.7\nnot really a pdf\n');
    s.put(KEY, bytes, { contentType: 'application/pdf' });
    assert.deepEqual(s.get(KEY), bytes);
    assert.equal(s.has(KEY), true);
    assert.equal(s.contentTypeOf(KEY), 'application/pdf');
  });

  test(`${name}: nothing stored is null, not an exception`, () => {
    // An abandoned upload is a normal state. A driver that threw here would turn
    // a tidy-up sweep into an error log.
    const s = make();
    assert.equal(s.get('orgs/org-1/documents/never/arrived.pdf'), null);
    assert.equal(s.has('orgs/org-1/documents/never/arrived.pdf'), false);
  });

  test(`${name}: remove is idempotent`, () => {
    const s = make();
    s.put(KEY, 'x');
    s.remove(KEY);
    s.remove(KEY);
    assert.equal(s.has(KEY), false);
  });

  test(`${name}: a signed download URL verifies`, () => {
    const s = make();
    const { url } = s.presignDownload(KEY);
    const q = new URL(url, 'https://app.test').searchParams;
    assert.equal(s.verify({ method: 'GET', key: KEY, expires: q.get('expires'), sig: q.get('sig') }).ok, true);
  });

  test(`${name}: a signature for one key does not work for another`, () => {
    // The property that keeps one organisation's accounts away from another's
    // curiosity. Everything else here is detail; this is the one.
    const s = make();
    const { url } = s.presignDownload('orgs/org-1/documents/doc-1/accounts.pdf');
    const q = new URL(url, 'https://app.test').searchParams;
    const check = s.verify({
      method: 'GET', key: 'orgs/org-2/documents/doc-9/accounts.pdf',
      expires: q.get('expires'), sig: q.get('sig'),
    });
    assert.equal(check.ok, false);
    assert.equal(check.why, 'bad_signature');
  });

  test(`${name}: a download URL cannot be used to upload`, () => {
    // Without the method in the signature, read access to a document would imply
    // write access to it.
    const s = make();
    const { url } = s.presignDownload(KEY);
    const q = new URL(url, 'https://app.test').searchParams;
    assert.equal(s.verify({ method: 'PUT', key: KEY, expires: q.get('expires'), sig: q.get('sig') }).ok, false);
  });

  test(`${name}: a signature expires`, () => {
    let nowMs = 1_000_000_000_000;
    const s = make({ clock: () => nowMs });
    const { url } = s.presignDownload(KEY, { expiresInSeconds: 60 });
    const q = new URL(url, 'https://app.test').searchParams;

    assert.equal(s.verify({ method: 'GET', key: KEY, expires: q.get('expires'), sig: q.get('sig') }).ok, true);
    nowMs += 61_000;
    const after = s.verify({ method: 'GET', key: KEY, expires: q.get('expires'), sig: q.get('sig') });
    assert.equal(after.ok, false);
    assert.equal(after.why, 'expired');
  });

  test(`${name}: an edited expiry does not extend the link`, () => {
    // The expiry is signed, so pushing it out invalidates the signature rather
    // than buying another hour.
    let nowMs = 1_000_000_000_000;
    const s = make({ clock: () => nowMs });
    const { url } = s.presignDownload(KEY, { expiresInSeconds: 60 });
    const q = new URL(url, 'https://app.test').searchParams;
    const later = String(Number(q.get('expires')) + 100_000);
    assert.equal(s.verify({ method: 'GET', key: KEY, expires: later, sig: q.get('sig') }).ok, false);
  });

  test(`${name}: a missing or malformed signature is refused`, () => {
    const s = make();
    for (const sig of [undefined, null, '', 'nonsense', 'a'.repeat(43)]) {
      assert.equal(s.verify({ method: 'GET', key: KEY, expires: '9999999999', sig }).ok, false);
    }
    assert.equal(s.verify({ method: 'GET', key: KEY, expires: 'soon', sig: 'x' }).ok, false);
  });

  test(`${name}: a key that escapes its namespace is refused`, () => {
    const s = make();
    for (const key of [
      '../../etc/passwd',
      'orgs/org-1/../org-2/documents/d/a.pdf',
      '/etc/passwd',
      'orgs//org-1/a.pdf',
      'orgs/./org-1/a.pdf',
      'orgs/org-1/..%2f..%2fetc/passwd',
    ]) {
      assert.throws(() => s.put(key, 'x'), undefined, `put accepted ${key}`);
      assert.throws(() => s.get(key), undefined, `get accepted ${key}`);
      assert.equal(s.verify({ method: 'GET', key, expires: '9999999999', sig: 'x' }).why, 'bad_key');
    }
  });
}

test('the local driver keeps bytes under its root and nowhere else', () => {
  const root = mkdtempSync(join(tmpdir(), 'rr-storage-'));
  const s = localStorageDriver({ root, secret: SECRET });
  s.put('orgs/org-1/documents/doc-1/accounts.pdf', 'bytes');
  assert.ok(existsSync(join(root, 'orgs/org-1/documents/doc-1/accounts.pdf')));
});

test('the local driver will not read a file it did not put there', () => {
  // The resolved-path check, tested on its own: a key that passes the shape
  // check must still land under the root.
  const root = mkdtempSync(join(tmpdir(), 'rr-storage-'));
  const outside = join(root, 'outside.txt');
  writeFileSync(outside, 'secret');
  const s = localStorageDriver({ root: join(root, 'store'), secret: SECRET });
  assert.throws(() => s.get('../outside.txt'));
  assert.equal(readFileSync(outside, 'utf8'), 'secret');
});

test('a driver refuses to start without a real secret', () => {
  // An unsigned driver is a public bucket, and defaulting the secret is how one
  // gets deployed by accident.
  const root = mkdtempSync(join(tmpdir(), 'rr-storage-'));
  assert.throws(() => localStorageDriver({ root }), /secret/);
  assert.throws(() => localStorageDriver({ root, secret: 'short' }), /secret/);
  assert.throws(() => localStorageDriver({ secret: SECRET }), /root/);
});

test('assertSafeKey accepts an ordinary key and rejects the rest', () => {
  assert.equal(assertSafeKey('orgs/a/documents/b/c.pdf'), 'orgs/a/documents/b/c.pdf');
  for (const bad of ['', '/a', 'a//b', 'a/../b', 'a/./b', 'a\\b', 'a\0b', 'x'.repeat(1100)]) {
    assert.throws(() => assertSafeKey(bad), undefined, `accepted ${JSON.stringify(bad)}`);
  }
});

test('two drivers with different secrets do not accept each other signatures', () => {
  const a = memoryStorageDriver({ secret: SECRET });
  const b = memoryStorageDriver({ secret: `${SECRET}-different` });
  const { url } = a.presignDownload(KEY);
  const q = new URL(url, 'https://app.test').searchParams;
  assert.equal(b.verify({ method: 'GET', key: KEY, expires: q.get('expires'), sig: q.get('sig') }).ok, false);
});
