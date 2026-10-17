/**
 * The deployment entry point.
 *
 *   node --experimental-sqlite src/web/boot.js
 *
 * Everything this process needs comes from the environment, and everything it
 * needs is checked before it listens. A process that starts successfully and
 * then fails on the first request is worse than one that refuses to start: the
 * health check goes green, the deploy is declared done, and the failure is found
 * by a user.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE CHECKS THAT REFUSE TO START
 *
 * In production, three things are fatal if missing, and each one is fatal
 * because the alternative is a product that looks like it is working:
 *
 *   SESSION_SECRET / STORAGE_SECRET — without a configured secret the only
 *     options are to generate one per process, which signs every user out on
 *     every deploy and invalidates every download link, or to use a default,
 *     which is the same as having none. Neither is a thing to discover later.
 *
 *   DATABASE_FILE — the in-memory database is the right default for a test and
 *     catastrophic in production, where it means every organisation created
 *     since the last restart is gone and nobody is told.
 *
 *   STORAGE_DIR — without it, documents are rows with nothing behind them.
 *
 * In development all three default, loudly.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startServer } from './server.js';
import { localStorageDriver } from '../storage/local.js';
import { seedDemonstration, describeDemonstration } from './demo.js';

const here = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = join(here, '..', '..', 'db', 'schema.sql');

export function configure(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const problems = [];
  const warnings = [];

  const need = (name, fallback, why) => {
    const value = env[name];
    if (value) return value;
    if (production) { problems.push(`${name} is not set. ${why}`); return null; }
    warnings.push(`${name} is not set, using a development default. ${why}`);
    return fallback();
  };

  const storageSecret = need('STORAGE_SECRET', () => randomBytes(24).toString('hex'),
    'Download links are signed with it, so a generated one invalidates every link in flight '
    + 'on every restart.');

  const databaseFile = need('DATABASE_FILE', () => ':memory:',
    'Without it the database is in memory and everything is lost on restart.');

  const storageDir = need('STORAGE_DIR', () => resolve('var/objects'),
    'Without it there is nowhere to keep uploaded or generated documents.');

  if (production && storageSecret && storageSecret.length < 32) {
    problems.push('STORAGE_SECRET is shorter than 32 characters. Generate one with '
      + '`openssl rand -hex 32`.');
  }
  if (production && databaseFile === ':memory:') {
    problems.push('DATABASE_FILE is :memory:, which loses everything on restart.');
  }

  // The demonstration seeder refuses to run against a database that already
  // holds anything, so it is safe to leave on. It is still refused outright in
  // production: a deployment serving real companies has no business being able
  // to create invented ones, whatever the database happens to contain today.
  const demo = env.DEMO_SEED === '1';
  if (demo && production) {
    problems.push('DEMO_SEED is set and NODE_ENV is production. The worked example is not loaded '
      + 'into a production deployment; load it from inside the product, into an empty organisation.');
  }

  return {
    production,
    demo,
    problems,
    warnings,
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? '0.0.0.0',
    // `secure` drives the Secure flag on the session cookie and HSTS. It follows
    // NODE_ENV rather than the request, because a request's own idea of whether
    // it arrived over TLS comes from a header a client can set.
    secure: production,
    // Read X-Forwarded-For for rate limiting. Set this if and only if something
    // is terminating TLS in front of the process: with no proxy there, the
    // header came from the caller, and believing it lets them choose their own
    // rate-limit bucket. There is no way to detect this at runtime — a request
    // with that header looks identical either way.
    trustProxy: env.TRUST_PROXY === '1',
    // The origin a browser PUTs an upload to, when that is not this
    // application. Needed in the content-security policy or the upload is
    // blocked by the browser with nothing in the server log to explain it.
    storageOrigin: env.STORAGE_ORIGIN ?? null,
    databaseFile,
    storageDir,
    storageSecret,
    baseUrl: env.BASE_URL ?? '',
    // Undefined rather than a default, so `src/web/legal.js` owns the default in
    // one place instead of two that can drift apart.
    legalDir: env.LEGAL_DIR,
  };
}

export function boot({
  env = process.env,
  log = console,
  // The four external systems. Null here and null in every test, because this
  // build has no production implementation of any of them — see the note in
  // `onListen`, which says so on startup rather than leaving it to be
  // discovered. `server.mjs` is where a deployment supplies them, and it is the
  // only file that needs to change to do it.
  advisor = null,
  translator = null,
  payments = null,
  // The email provider. Unlike the other three, its absence costs somebody
  // their account rather than a feature, so the reset page names the state
  // instead of accepting a request it cannot act on — see `src/web/mail.js`.
  emailer = null,
} = {}) {
  const config = configure(env);

  for (const warning of config.warnings) log.warn(`[config] ${warning}`);

  if (config.problems.length) {
    for (const problem of config.problems) log.error(`[config] ${problem}`);
    throw Object.assign(new Error('The configuration is not fit to serve from.'), {
      problems: config.problems,
    });
  }

  const storage = localStorageDriver({
    root: config.storageDir,
    secret: config.storageSecret,
    baseUrl: config.baseUrl,
  });

  let demonstration = null;

  const started = startServer({
    port: config.port,
    host: config.host,
    file: config.databaseFile,
    schemaPath: SCHEMA_PATH,
    secure: config.secure,
    trustProxy: config.trustProxy,
    storageOrigin: config.storageOrigin,
    storage,
    advisor,
    translator,
    payments,
    emailer,
    baseUrl: config.baseUrl,
    legalDir: config.legalDir,
    // Seeded before the socket is listening. A reviewer who reaches the sign-in
    // page while the example is still being generated gets a half-built
    // organisation, and nine documents take a few seconds to render.
    seed: config.demo
      ? (db) => {
        try {
          demonstration = seedDemonstration({ db, storage });
        } catch (err) {
          if (err.code !== 'demo_refused') throw err;
          // Not fatal. The product is fine; this database just already has
          // something in it, which is the one case the seeder exists to refuse.
          log.warn(`[demo] ${err.message}`);
        }
      }
      : null,
    onListen: ({ port, host }) => {
      const origin = config.baseUrl || `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
      log.log(`RaiseRoom listening on ${origin}`);
      log.log(`  database  ${config.databaseFile}`);
      log.log(`  objects   ${storage.root}`);
      if (!config.production) log.log('  mode      development — the session cookie is not marked Secure');

      // Named rather than left to be discovered. These three are external
      // systems and this build has no production implementation of any of them —
      // only the stubs the tests use, which are deliberately not wired in
      // here, for the reasons in advisor.js, translator.js and payments.js.
      // A reviewer should know which capabilities they are not seeing before
      // they go looking for them.
      const missing = [
        !advisor && 'advisor', !translator && 'translator', !payments && 'payments',
        !emailer && 'email (so there is no password reset and invites are links you copy)',
      ].filter(Boolean);
      if (missing.length) {
        log.log(`  not wired ${missing.join(', ')} — each page says so in a sentence, `
          + 'and nothing else depends on them');
      }

      if (demonstration) log.log(describeDemonstration(demonstration, { origin }));
    },
  });

  return { ...started, config, storage, demonstration };
}

// Run only when executed directly, so importing this file in a test starts
// nothing.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  boot();
}
