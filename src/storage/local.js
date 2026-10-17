/**
 * A storage driver backed by a directory on disk.
 *
 * This is what a single-box deployment runs, and what the worked example writes
 * to. It is not a toy: it signs its URLs, it expires them, it refuses to serve a
 * key it did not sign, and it keeps the bytes outside the database.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE SIGNATURE
 *
 * An HMAC over `method`, `key` and the expiry, keyed by a secret that is
 * per-deployment. Three properties follow, and all three matter:
 *
 *   · The key is signed, so a URL for one document cannot be edited into a URL
 *     for another. This is the one that protects one organisation's accounts
 *     from another organisation's curiosity.
 *   · The method is signed, so a download URL cannot be turned into an upload
 *     URL by changing the verb. Without this, read access to a document implies
 *     write access to it.
 *   · The expiry is signed and checked, so a URL pasted into a chat message
 *     stops working. Diligence documents get forwarded; this is the backstop
 *     for when they do.
 *
 * The comparison is constant-time. A byte-by-byte comparison that returns early
 * leaks the signature one byte at a time to anybody patient enough to measure.
 */

import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { assertSafeKey } from './interface.js';

const DEFAULT_UPLOAD_TTL = 600;
const DEFAULT_DOWNLOAD_TTL = 300;

/**
 * @param {object} options
 * @param {string} options.root       directory the bytes live under
 * @param {string} options.secret     per-deployment signing secret
 * @param {string} [options.baseUrl]  prefix for signed URLs; relative by default
 * @param {() => number} [options.clock]  milliseconds, injectable for tests
 */
export function localStorageDriver({ root, secret, baseUrl = '', clock = Date.now } = {}) {
  if (!root) throw new Error('localStorageDriver needs a root directory.');
  if (!secret || String(secret).length < 16) {
    throw new Error('localStorageDriver needs a signing secret of at least 16 characters.');
  }

  const base = resolve(root);
  mkdirSync(base, { recursive: true });

  /**
   * The key, resolved to a path, checked twice.
   *
   * `assertSafeKey` rejects the shapes that escape. This then resolves the path
   * and checks it still sits under the root, because a check on the key and a
   * check on the resolved path fail in different ways and the second one is the
   * one that holds if the first is ever loosened.
   */
  const pathFor = (key) => {
    assertSafeKey(key);
    const full = resolve(join(base, key));
    if (full !== base && !full.startsWith(base + sep)) {
      throw new Error(`Storage key "${key}" resolved outside the storage root.`);
    }
    return full;
  };

  const sign = (method, key, expires) => createHmac('sha256', secret)
    .update(`${method}\n${key}\n${expires}`).digest('base64url');

  const url = (method, key, ttl, extra = {}) => {
    const expires = Math.floor(clock() / 1000) + ttl;
    const params = new URLSearchParams({
      expires: String(expires), sig: sign(method, key, expires), ...extra,
    });
    // The key is a path, so each segment is encoded but the slashes stay.
    const encoded = String(key).split('/').map(encodeURIComponent).join('/');
    return `${baseUrl}/objects/${encoded}?${params}`;
  };

  return {
    kind: 'local',
    root: base,

    presignUpload(key, { contentType = 'application/octet-stream', expiresInSeconds = DEFAULT_UPLOAD_TTL } = {}) {
      return {
        url: url('PUT', key, expiresInSeconds),
        method: 'PUT',
        headers: { 'Content-Type': contentType },
      };
    },

    presignDownload(key, { expiresInSeconds = DEFAULT_DOWNLOAD_TTL, filename = null } = {}) {
      return { url: url('GET', key, expiresInSeconds, filename ? { name: filename } : {}) };
    },

    /**
     * Check a signature presented by a request.
     *
     * Returns a reason rather than throwing, because the caller is an HTTP
     * handler that has to turn each case into a status, and because "expired" and
     * "wrong" deserve different wording to a person who followed a stale link.
     */
    verify({ method, key, expires, sig }) {
      try { assertSafeKey(key); } catch { return { ok: false, why: 'bad_key' }; }

      const deadline = Number(expires);
      if (!Number.isFinite(deadline)) return { ok: false, why: 'bad_signature' };

      const expected = Buffer.from(sign(method, key, String(expires)));
      const given = Buffer.from(String(sig ?? ''));
      if (expected.length !== given.length) return { ok: false, why: 'bad_signature' };
      if (!timingSafeEqual(expected, given)) return { ok: false, why: 'bad_signature' };

      // Checked after the signature, so an attacker cannot learn whether a
      // guessed key exists by watching which error comes back first.
      if (deadline * 1000 < clock()) return { ok: false, why: 'expired' };

      return { ok: true };
    },

    put(key, bytes, { contentType } = {}) {
      const full = pathFor(key);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, bytes);
      if (contentType) writeFileSync(`${full}.type`, contentType, 'utf8');
    },

    get(key) {
      const full = pathFor(key);
      if (!existsSync(full) || !statSync(full).isFile()) return null;
      return readFileSync(full);
    },

    contentTypeOf(key) {
      const marker = `${pathFor(key)}.type`;
      return existsSync(marker) ? readFileSync(marker, 'utf8').trim() : null;
    },

    has(key) {
      const full = pathFor(key);
      return existsSync(full) && statSync(full).isFile();
    },

    remove(key) {
      const full = pathFor(key);
      rmSync(full, { force: true });
      rmSync(`${full}.type`, { force: true });
    },
  };
}

/**
 * A driver holding everything in a Map.
 *
 * For tests, and for the worked example when it is only being inspected. It is
 * the same contract, so a test that passes against this one is a test about the
 * calling code rather than about the filesystem.
 */
export function memoryStorageDriver({ secret = randomBytes(24).toString('hex'), baseUrl = '', clock = Date.now } = {}) {
  const objects = new Map();
  const types = new Map();

  const sign = (method, key, expires) => createHmac('sha256', secret)
    .update(`${method}\n${key}\n${expires}`).digest('base64url');

  const url = (method, key, ttl, extra = {}) => {
    const expires = Math.floor(clock() / 1000) + ttl;
    const params = new URLSearchParams({ expires: String(expires), sig: sign(method, key, expires), ...extra });
    return `${baseUrl}/objects/${String(key).split('/').map(encodeURIComponent).join('/')}?${params}`;
  };

  return {
    kind: 'memory',
    objects,

    presignUpload(key, { contentType = 'application/octet-stream', expiresInSeconds = DEFAULT_UPLOAD_TTL } = {}) {
      assertSafeKey(key);
      return { url: url('PUT', key, expiresInSeconds), method: 'PUT', headers: { 'Content-Type': contentType } };
    },
    presignDownload(key, { expiresInSeconds = DEFAULT_DOWNLOAD_TTL, filename = null } = {}) {
      assertSafeKey(key);
      return { url: url('GET', key, expiresInSeconds, filename ? { name: filename } : {}) };
    },
    verify({ method, key, expires, sig }) {
      try { assertSafeKey(key); } catch { return { ok: false, why: 'bad_key' }; }
      const deadline = Number(expires);
      if (!Number.isFinite(deadline)) return { ok: false, why: 'bad_signature' };
      const expected = Buffer.from(sign(method, key, String(expires)));
      const given = Buffer.from(String(sig ?? ''));
      if (expected.length !== given.length) return { ok: false, why: 'bad_signature' };
      if (!timingSafeEqual(expected, given)) return { ok: false, why: 'bad_signature' };
      if (deadline * 1000 < clock()) return { ok: false, why: 'expired' };
      return { ok: true };
    },
    put(key, bytes, { contentType } = {}) {
      assertSafeKey(key);
      objects.set(key, Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes)));
      if (contentType) types.set(key, contentType);
    },
    get(key) { assertSafeKey(key); return objects.get(key) ?? null; },
    contentTypeOf(key) { assertSafeKey(key); return types.get(key) ?? null; },
    has(key) { assertSafeKey(key); return objects.has(key); },
    remove(key) { assertSafeKey(key); objects.delete(key); types.delete(key); },
  };
}
