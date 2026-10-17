/**
 * `/health` — whether this process can actually serve.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE FAILURE THIS IS WRITTEN AGAINST
 *
 * A health check that returns 200 as long as the process is running goes green
 * the moment the container starts. The balancer sends traffic, the deploy is
 * declared done, and the first person to open a page discovers the database
 * credentials are wrong. The check reported on the only thing that was never in
 * doubt.
 *
 * So this one answers a narrower and more useful question: can a request be
 * served right now. That means touching the database, because a reachable
 * database is the one dependency without which nothing in this product works.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IT MUST NOT SAY
 *
 * It is unauthenticated, because it has to answer before anybody can sign in and
 * because a balancer has no credentials. So it says whether each dependency is
 * working and nothing else: no version string, no hostnames, no connection
 * strings, no counts of organisations or users. A health endpoint that reports
 * "4 organisations, 11 users" is a business metrics endpoint with no password on
 * it, and the number of customers a company has is not public information.
 *
 * The codes below are deliberately about state rather than cause:
 * `database_unreachable` tells an operator where to look without telling a
 * stranger what software is behind it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY STORAGE IS A WARNING AND NOT A FAILURE
 *
 * Without file storage, documents cannot be uploaded or generated — but every
 * figure, assessment, gap and audit record still works, and so does every
 * export. Reporting unhealthy would take a mostly-working deployment out of
 * service; reporting nothing would hide a deployment where half the product
 * quietly refuses. So it is reported, and it does not fail the check.
 *
 * The line between the two is whether a person can still get their own data out.
 * If they can, it is a warning.
 */

/**
 * @param {object} deps
 * @param {object} deps.db       the database adapter
 * @param {object|null} deps.storage
 * @returns {{status: number, body: object}}
 */
export function healthReport({ db, storage = null } = {}) {
  const checks = [];

  // The real question, asked the only way that answers it: run a query. A
  // connection object that exists proves nothing — the pool hands one out
  // before it has tried to use it.
  checks.push(probe('database', () => { db.ping(); },
    { fatal: true, code: 'database_unreachable' }));

  // Reads the schema rather than the data. A database that is reachable but has
  // never had the schema applied is the state after a fresh volume is mounted,
  // and it answers every query with an error that looks like a code bug.
  checks.push(probe('schema', () => {
    const names = db.tables();
    for (const table of ['organisation', 'fact', 'user_account', 'web_session', 'usage_counter']) {
      if (!names.includes(table)) throw new Error(`missing ${table}`);
    }
  }, { fatal: true, code: 'schema_incomplete' }));

  checks.push(storage
    ? probe('storage', () => {
      if (typeof storage.presignUpload !== 'function') throw new Error('not a storage driver');
    }, { fatal: false, code: 'storage_unusable' })
    : { name: 'storage', ok: false, fatal: false, code: 'storage_unconfigured' });

  const failed = checks.filter((c) => !c.ok && c.fatal);
  const degraded = checks.filter((c) => !c.ok && !c.fatal);

  return {
    status: failed.length ? 503 : 200,
    body: {
      ok: failed.length === 0,
      // Three states rather than two. "degraded" is the one an operator wants to
      // see on a deployment that is serving but cannot take an upload, and
      // folding it into either of the others loses exactly that case.
      state: failed.length ? 'unhealthy' : (degraded.length ? 'degraded' : 'ok'),
      checks: checks.map((c) => ({ name: c.name, ok: c.ok, ...(c.ok ? {} : { code: c.code }) })),
    },
  };
}

function probe(name, fn, { fatal, code }) {
  try {
    fn();
    return { name, ok: true, fatal, code: null };
  } catch {
    // The thrown error is deliberately not reported. It carries file paths,
    // table names and sometimes credentials, and this endpoint has no password
    // on it.
    return { name, ok: false, fatal, code };
  }
}
