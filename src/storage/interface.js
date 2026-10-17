/**
 * Object storage: the contract, and nothing else.
 *
 * Documents are not kept in the database. A signed set of accounts is ten
 * megabytes of PDF, and a database row holding it is a database nobody can back
 * up or restore in a hurry. So the row holds a `storage_key` and the bytes live
 * behind this interface.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY PRESIGNING, AND WHY IT IS THE INTERFACE RATHER THAN AN OPTIMISATION
 *
 * The upload and download methods return a *URL and a method*, not a stream.
 * That shape is deliberate, and it is the shape the hosted drivers need:
 * against S3 or R2 the file goes from the browser straight to the bucket and
 * never passes through this application, so a hundred-megabyte upload does not
 * occupy a request worker for two minutes and does not sit in the application's
 * memory on the way past.
 *
 * The local driver has no such requirement, but it implements the same shape
 * anyway — it signs a URL back to this application's own upload endpoint. A
 * driver that returned a stream instead would work locally and then force the
 * calling code to be rewritten the day the product moves to a bucket, which is
 * the day there is least appetite for rewriting calling code.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT A DRIVER MUST GUARANTEE
 *
 *   1. A key is opaque. Drivers must not interpret the key's shape, and must
 *      not let a key escape the namespace it was given. `../` in a key is an
 *      attempt to read another organisation's documents.
 *
 *   2. A signature is per-key and expires. A URL that works for any key, or
 *      forever, is a public bucket with extra steps.
 *
 *   3. `remove` is idempotent. Deleting a document whose bytes never arrived
 *      must not throw; the row is the thing being deleted.
 *
 *   4. Nothing is ever overwritten silently at a key that already has bytes
 *      under a *different* document id. Keys embed the document id for exactly
 *      this reason, so this is a property of the key scheme rather than a check
 *      every driver repeats.
 *
 * @typedef {object} Storage
 * @property {(key: string, opts?: {contentType?: string, expiresInSeconds?: number}) =>
 *            {url: string, method: string, headers?: object}} presignUpload
 * @property {(key: string, opts?: {expiresInSeconds?: number, filename?: string}) =>
 *            {url: string}} presignDownload
 * @property {(key: string, bytes: Buffer|string, opts?: {contentType?: string}) => void} put
 *   Server-side write, for bytes this application generated itself — a rendered
 *   document, a PDF. These never travel through a browser, so they never need a
 *   signature.
 * @property {(key: string) => Buffer|null} get
 *   Server-side read. Null when nothing is stored at the key, which is a normal
 *   state for a document whose upload was abandoned.
 * @property {(key: string) => void} remove
 * @property {(key: string) => boolean} has
 */

/** Keys are opaque, but they are not permitted to escape. */
export function assertSafeKey(key) {
  const text = String(key ?? '');
  if (!text) throw new Error('A storage key cannot be empty.');
  if (text.length > 1024) throw new Error('A storage key cannot be longer than 1024 characters.');
  if (text.startsWith('/') || text.includes('\\')) {
    throw new Error(`Storage key "${text}" is not relative.`);
  }
  // Checked on the decoded form too: `..%2f` is the same attempt wearing a hat.
  let decoded = text;
  try { decoded = decodeURIComponent(text); } catch { /* malformed escape, check the raw form */ }
  for (const form of [text, decoded]) {
    if (form.split('/').some((part) => part === '..' || part === '.' || part === '')) {
      throw new Error(`Storage key "${text}" contains a path segment that escapes its namespace.`);
    }
    if (form.includes('\0')) throw new Error('A storage key cannot contain a null byte.');
  }
  return text;
}
