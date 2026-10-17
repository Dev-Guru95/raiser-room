import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase } from '../src/db/sqlite.js';

const here = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = join(here, '..', 'db', 'schema.sql');

/**
 * Four fixture legal documents.
 *
 * Not the real ones — those are deliberately outside this repository, which is
 * why a deployment with nothing in its legal directory serves a 404 that says
 * so. The page-render tests want the PUBLISHED state of those pages, so they
 * point at these.
 */
export const FIXTURE_LEGAL_DIR = join(here, 'fixtures', 'legal');

let clock = 0;
/** Monotonic ISO timestamps so ordering assertions are deterministic. */
export const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString();

export function freshDb() {
  return openDatabase({ schemaPath: SCHEMA_PATH });
}

export function ctxFor(db, userId, email = `${userId}@example.com`) {
  return { db, auth: { userId, email }, now };
}

/** In-memory stand-in for S3/R2. Records what was asked of it. */
export function fakeStorage() {
  const removed = [];
  return {
    removed,
    presignUpload: (key, opts) => ({ url: `https://storage.test/${key}?sig=up`, method: 'PUT', ...opts }),
    presignDownload: (key, opts) => ({ url: `https://storage.test/${key}?sig=down`, ...opts }),
    remove: (key) => { removed.push(key); },
  };
}

/** Assert a call throws with a given code and HTTP status. */
export function expectRefusal(fn, code, status) {
  try {
    fn();
  } catch (err) {
    if (err.code !== code) throw new Error(`expected code "${code}", got "${err.code}" (${err.message})`);
    if (status !== undefined && err.status !== status) {
      throw new Error(`expected status ${status} for "${code}", got ${err.status}`);
    }
    return err;
  }
  throw new Error(`expected a refusal with code "${code}", but the call succeeded`);
}

/**
 * Put an organisation on a plan.
 *
 * A new organisation is on a computed trial of the preparation plan, which is
 * what most tests want. Anything testing a capability the trial does not include
 * — custom brand, the forecast ledger, the portfolio — needs a subscription, and
 * saying so in the fixture is more honest than widening the trial until the
 * tests pass.
 */
export function onPlan(db, orgId, planKey, { state = 'ACTIVE', term = 'ANNUAL' } = {}) {
  return db.insert('subscription', {
    org_id: orgId, plan_key: planKey, state, term,
    provider: 'fake-billing', provider_ref: `sub_${orgId}`,
    seats: null, current_period_end: '2027-01-01T00:00:00.000Z',
    last_event_at: null, started_at: now(), created_at: now(),
  });
}
