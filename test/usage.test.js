/**
 * Operational analytics.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THESE TESTS ARE FOR
 *
 * Two different jobs, and they pull in opposite directions.
 *
 * The first is ordinary: the counters count. `record()` swallows storage errors
 * so that a failed counter write can never fail somebody's upload, and the cost
 * of that is a whole class of bug that would otherwise be silent. So the
 * increments are asserted here rather than left to be noticed in production.
 *
 * The second is the one that matters. The product's central promise is that no
 * aggregate is ever computed across companies and that no code path reads across
 * organisations. Usage analytics is the feature most likely to erode that — not
 * by anybody deciding to, but by an `org_id` being added to the counter table one
 * afternoon because somebody wanted to know which account was busiest. The tests
 * below assert the SHAPE of what is stored, so that adding that column fails
 * here first.
 *
 * Those are structural assertions, not greps for suspicious words. A test that
 * searched the source for "org_id" would fire on every legitimate line in the
 * product; this one reads the columns the table actually has.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, ctxFor, now, onPlan, expectRefusal } from './helpers.js';
import * as usage from '../src/api/usage.js';
import * as svc from '../src/api/service.js';
import {
  CAPABILITIES, CAPABILITY_KEYS, OUTCOMES, COHORTS, RETENTION_DAYS,
  cohortOf, dayOf, cutoffDay, triedSet, disclosure,
} from '../src/domain/usage.js';

function withOrg({ plan = null, term = 'ANNUAL' } = {}) {
  const db = freshDb();
  const ctx = ctxFor(db, 'u1');
  const org = svc.createOrganisation(ctx, { name: 'Northwind' }).body.organisation;
  if (plan) onPlan(db, org.id, plan, { term });
  return { db, ctx, org };
}

const buckets = (db) => db.find('usage_counter', {});

// ─────────────────────────────────────────────── what is stored, and what is not ──

test('a counter row cannot name a company, a person, or a moment', () => {
  const { db, ctx, org } = withOrg();
  usage.record(ctx, org.id, 'FACT_RECORDED');

  const [row] = buckets(db);
  assert.ok(row, 'a bucket was written');

  // The whole point of the design, asserted on the row itself rather than
  // promised in a comment. Anything that could identify a company, a person or a
  // moment finer than a day is absent — so the question "what is company X
  // doing" has no answer in this table, which is a stronger guarantee than a
  // rule saying nobody may ask it.
  const forbidden = ['org_id', 'organisation_id', 'user_id', 'actor_id', 'email',
    'session_id', 'document_id', 'fact_id', 'ip', 'at', 'occurred_at'];
  for (const column of forbidden) {
    assert.ok(!Object.hasOwn(row, column),
      `usage_counter must not have a "${column}" column — it would make the product's `
      + 'promise about cross-organisation data a matter of discipline rather than of shape');
  }

  assert.deepEqual(Object.keys(row).sort(), [
    'capability', 'cohort', 'created_at', 'day', 'events', 'first_time', 'id', 'ms_max',
    'ms_total', 'outcome',
  ]);
  assert.match(row.day, /^\d{4}-\d{2}-\d{2}$/);
});

test('the only per-organisation state is a set of capability keys', () => {
  const { db, ctx, org } = withOrg();
  usage.record(ctx, org.id, 'FACT_RECORDED');
  usage.record(ctx, org.id, 'SHARE_CREATED');

  // Not a log, not timestamps, nothing an order of events could be rebuilt from.
  // It lives on the organisation row so that deleting the organisation deletes
  // it, with no sweeper to forget.
  const stored = JSON.parse(db.get('organisation', org.id).tried);
  assert.deepEqual(stored.sort(), ['FACT_RECORDED', 'SHARE_CREATED']);
});

// ──────────────────────────────────────────────────────────── the counting ──

test('events accumulate in one bucket per day, capability, cohort and outcome', () => {
  const { db, ctx, org } = withOrg({ plan: 'FIRM' });

  usage.record(ctx, org.id, 'FACT_RECORDED');
  usage.record(ctx, org.id, 'FACT_RECORDED');
  usage.record(ctx, org.id, 'FACT_RECORDED', { outcome: 'REFUSED' });

  const rows = buckets(db);
  assert.equal(rows.length, 2, 'a refusal is its own bucket, not a flag on the same one');

  const done = rows.find((r) => r.outcome === 'DONE');
  assert.equal(done.events, 2);
  assert.equal(done.cohort, 'FIRM');
  assert.equal(rows.find((r) => r.outcome === 'REFUSED').events, 1);
});

test('first use of a capability is counted once, ever', () => {
  const { db, ctx, org } = withOrg();
  usage.record(ctx, org.id, 'SHARE_CREATED');
  usage.record(ctx, org.id, 'SHARE_CREATED');
  usage.record(ctx, org.id, 'SHARE_CREATED');

  const [row] = buckets(db);
  assert.equal(row.events, 3);
  assert.equal(row.first_time, 1,
    'adoption is how many organisations tried it, which volume alone hides');
});

test('a duration is kept only for a capability declared as timed', () => {
  const { db, ctx, org } = withOrg();

  usage.record(ctx, org.id, 'ARTIFACT_GENERATED', { ms: 900 });
  usage.record(ctx, org.id, 'ARTIFACT_GENERATED', { ms: 1500 });
  // Not timed. A stray duration here would make the mean a mean of whichever
  // call sites happened to pass one.
  usage.record(ctx, org.id, 'SHARE_CREATED', { ms: 4000 });

  const timed = buckets(db).find((r) => r.capability === 'ARTIFACT_GENERATED');
  assert.equal(timed.ms_total, 2400);
  assert.equal(timed.ms_max, 1500);

  const untimed = buckets(db).find((r) => r.capability === 'SHARE_CREATED');
  assert.equal(untimed.ms_total, 0);
  assert.equal(untimed.ms_max, 0);
});

test('a trial is its own cohort, not folded into the plan it trials', () => {
  // The implied trial: no subscription row, organisation created inside the
  // window. What a trial user does before deciding is the most useful thing in
  // the report, and plan key alone would file it under RAISEROOM.
  const { db, ctx, org } = withOrg();
  usage.record(ctx, org.id, 'ASSESSMENT_SCORED');
  assert.equal(buckets(db)[0].cohort, 'TRIAL');
});

test('a demonstration organisation is not counted at all', () => {
  const { db, ctx, org } = withOrg();
  db.insert('subscription', {
    org_id: org.id, plan_key: 'FIRM', state: 'ACTIVE', term: 'ANNUAL',
    provider: 'demonstration', provider_ref: null, seats: 10,
    current_period_end: null, last_event_at: null, started_at: now(), created_at: now(),
  });

  assert.equal(usage.record(ctx, org.id, 'ARTIFACT_GENERATED'), false);
  assert.equal(buckets(db).length, 0,
    'the worked example is driven by a seeder and would otherwise be the busiest account');
});

test('a capability outside the catalogue throws rather than being counted', () => {
  const { ctx, org } = withOrg();

  // Loudly, and before storage is touched. A key invented at a call site is a
  // dimension nobody declared, and the first typo would split a metric in two
  // for as long as nobody noticed.
  assert.throws(() => usage.record(ctx, org.id, 'SOMETHING_ELSE'), /not in the usage catalogue/);
  assert.throws(() => usage.record(ctx, org.id, 'FACT_RECORDED', { outcome: 'MAYBE' }),
    /not a usage outcome/);
});

test('a storage failure is swallowed, so a counter can never fail the work', () => {
  const { ctx, org } = withOrg();
  const broken = { ...ctx, db: { ...ctx.db, get: () => { throw new Error('database gone'); } } };

  // Somebody uploading a document the night before a deadline should not see it
  // fail because a counter could not be written.
  assert.equal(usage.record(broken, org.id, 'DOCUMENT_UPLOADED'), false);
});

// ─────────────────────────────────────────────────────────── the opt-out ──

test('an organisation that has objected is not counted', () => {
  const { db, ctx, org } = withOrg();
  usage.setAnalytics(ctx, org.id, false);

  assert.equal(usage.record(ctx, org.id, 'FACT_RECORDED'), false);
  assert.equal(buckets(db).length, 0);

  // And nothing about the organisation is written either — an opted-out
  // organisation is not even classified into a cohort.
  assert.equal(db.get('organisation', org.id).tried, null);
});

test('turning counting off and on again is in the organisation own audit log', () => {
  const { db, ctx, org } = withOrg();
  usage.setAnalytics(ctx, org.id, false);
  usage.setAnalytics(ctx, org.id, true);

  const actions = db.find('audit_log', { org_id: org.id }).map((r) => r.action);
  assert.ok(actions.includes('usage.analytics_off'));
  assert.ok(actions.includes('usage.analytics_on'));

  assert.equal(usage.record(ctx, org.id, 'FACT_RECORDED'), true, 'and counting resumes');
});

test('only an owner can change what is collected', () => {
  const { db, org } = withOrg();
  db.insert('membership', {
    org_id: org.id, user_id: 'u2', email: 'u2@example.com', role: 'EDITOR', created_at: now(),
  });
  const editor = ctxFor(db, 'u2');

  expectRefusal(() => usage.setAnalytics(editor, org.id, false), 'forbidden', 403);
  // A non-member gets the product's standard answer, which does not confirm the
  // organisation exists.
  expectRefusal(() => usage.setAnalytics(ctxFor(db, 'u3'), org.id, false), 'not_found', 404);
});

test('the list shown to a customer is generated from the catalogue', () => {
  const { ctx, org } = withOrg();
  const setting = usage.analyticsSetting(ctx, org.id).body;

  assert.equal(setting.on, true);
  assert.equal(setting.recorded.length, CAPABILITY_KEYS.length,
    'the published list and the code that counts cannot diverge, because there is one list');
  assert.deepEqual(setting.recorded.map((r) => r.key), CAPABILITY_KEYS);
  for (const entry of setting.recorded) {
    assert.ok(entry.label && entry.why, `${entry.key} has words for the customer`);
  }
  assert.equal(setting.retention_days, RETENTION_DAYS);
});

// ─────────────────────────────────────────────────────────── retention ──

test('counters past the retention window are deleted, and the boundary day is kept', () => {
  const { db, ctx, org } = withOrg();
  usage.record(ctx, org.id, 'FACT_RECORDED');

  const today = '2028-06-01T00:00:00.000Z';
  const cutoff = cutoffDay(today);
  const keep = (day) => db.insert('usage_counter', {
    day, capability: 'FACT_RECORDED', cohort: 'FREE', outcome: 'DONE',
    events: 1, first_time: 0, ms_total: 0, ms_max: 0, created_at: now(),
  });

  keep('2020-01-01');       // long past
  keep(cutoff);             // the oldest day still inside the window
  keep('2028-05-31');       // yesterday

  const { deleted } = usage.prune(db, today);
  const days = db.find('usage_counter', {}).map((r) => r.day).sort();

  assert.ok(deleted >= 1);
  assert.ok(!days.includes('2020-01-01'));
  assert.ok(days.includes(cutoff),
    'the cutoff day is inside the window; deleting it would make retention 729 days, not the published 730');
  assert.ok(days.includes('2028-05-31'));
});

test('the retention window is the one the privacy policy publishes', () => {
  // 24 months, stated in the policy. A number that drifted from the published
  // one would be a broken promise nobody noticed, so it is asserted rather than
  // left as a constant somebody might tune.
  assert.equal(RETENTION_DAYS, 730);
  assert.equal(cutoffDay('2026-01-01T12:00:00.000Z', 730), '2024-01-02');
});

// ─────────────────────────────────────────────────────────── the report ──

test('the report names every capability, including the ones nobody has used', () => {
  const { db, ctx, org } = withOrg({ plan: 'RAISEROOM' });
  usage.record(ctx, org.id, 'ARTIFACT_GENERATED', { ms: 1200 });
  usage.record(ctx, org.id, 'ARTIFACT_GENERATED', { ms: 800, outcome: 'REFUSED' });
  usage.record(ctx, org.id, 'ADVISOR_ASKED', { ms: 400, outcome: 'FAILED' });

  const r = usage.report(db, { from: '2020-01-01', to: '2030-01-01' });

  assert.equal(r.capabilities.length, CAPABILITY_KEYS.length,
    'a capability nobody has ever used is the most actionable row in the report');
  assert.ok(r.untouched.includes('PERIOD_CLOSED'));

  const generated = r.capabilities.find((c) => c.key === 'ARTIFACT_GENERATED');
  assert.equal(generated.events, 2);
  assert.equal(generated.outcomes.REFUSED, 1);
  // Over the one that succeeded. The refused 800ms is not a generation time.
  assert.equal(generated.ms_mean, 1200);
  assert.equal(generated.ms_max, 1200);
  assert.equal(generated.cohorts.RAISEROOM, 2);

  assert.deepEqual(r.failures.map((f) => f.key), ['ADVISOR_ASKED']);
  assert.deepEqual(r.refusals.map((f) => f.key), ['ARTIFACT_GENERATED']);
});

test('a mean over no observations is unknown, not fast', () => {
  const { db } = withOrg();
  const r = usage.report(db, { from: '2020-01-01', to: '2030-01-01' });
  const timed = r.capabilities.find((c) => c.key === 'ARTIFACT_GENERATED');
  assert.equal(timed.ms_mean, null);
});

test('the report says in itself that nothing in it is attributable', () => {
  const { db } = withOrg();
  const r = usage.report(db, { days: 7 });

  // Anybody who opens this and starts wondering which customer is behind a
  // number should find the answer in the report rather than have to reason about
  // the schema.
  assert.match(r.scope, /No organisation, person or record is identified/);
});

test('a historical row for a capability no longer in the catalogue does not crash the report', () => {
  const { db } = withOrg();
  db.insert('usage_counter', {
    day: '2026-03-01', capability: 'SOMETHING_RETIRED', cohort: 'FREE', outcome: 'DONE',
    events: 9, first_time: 1, ms_total: 0, ms_max: 0, created_at: now(),
  });

  const r = usage.report(db, { from: '2026-01-01', to: '2026-12-31' });
  assert.ok(r.capabilities.every((c) => c.key !== 'SOMETHING_RETIRED'));
});

// ───────────────────────────────────────────── the catalogue itself ──

test('every capability in the catalogue is recorded somewhere in the code', async () => {
  // A catalogue entry with no call site is a metric that will always read zero,
  // which is worse than a missing metric: it looks like evidence that nobody
  // uses something. This walks the API layer and asserts each key appears.
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../src/api/', import.meta.url);
  const source = readdirSync(dir)
    .filter((f) => f.endsWith('.js') && f !== 'usage.js')
    .map((f) => readFileSync(new URL(f, dir), 'utf8'))
    .join('\n');

  const absent = CAPABILITY_KEYS.filter((key) => !source.includes(`'${key}'`));
  assert.deepEqual(absent, [],
    'these capabilities are declared but never counted — either wire them up or remove them');
});

test('the catalogue, outcomes and cohorts are frozen', () => {
  assert.throws(() => { CAPABILITIES.FACT_RECORDED = null; });
  assert.throws(() => { OUTCOMES.push('MAYBE'); });
  assert.throws(() => { COHORTS.push('ENTERPRISE'); });
});

test('cohorts cover every plan, so nothing is filed under a cohort that does not exist', async () => {
  const { PLAN_KEYS } = await import('../src/domain/billing.js');
  for (const key of PLAN_KEYS) {
    assert.ok(COHORTS.includes(key), `plan ${key} has no cohort to be counted in`);
  }
});

test('an unknown plan is counted as FREE rather than inventing a cohort', () => {
  assert.equal(cohortOf({ plan_key: 'LEGACY_THING', term: 'ANNUAL' }), 'FREE');
  assert.equal(cohortOf(null), 'FREE');
  assert.equal(cohortOf({ plan_key: 'FIRM' }, { demonstration: true }), null);
});

test('a corrupt tried-set is treated as empty rather than taking down the capability', () => {
  // This value only ever decides whether a first-time counter is incremented.
  // Throwing here would break the capability it was recording.
  assert.equal(triedSet(null).size, 0);
  assert.equal(triedSet('not json').size, 0);
  assert.equal(triedSet('{"a":1}').size, 0);
  assert.equal(triedSet('["FACT_RECORDED", 7]').size, 1);
});

test('a day is read from a timestamp and nothing finer is kept', () => {
  assert.equal(dayOf('2026-10-14T23:59:59.999Z'), '2026-10-14');
  assert.throws(() => dayOf('whenever'), /cannot read a day/);
});

test('the disclosure says which capabilities are timed', () => {
  const timed = disclosure().filter((d) => d.timed).map((d) => d.key);
  assert.deepEqual(timed.sort(),
    ['ADVISOR_ASKED', 'ARTIFACT_GENERATED', 'EXTRACTION_RUN', 'TRANSLATION_WRITTEN']);
});

test('a mean duration ignores refusals, which are decided in a millisecond', () => {
  const { db, ctx, org } = withOrg({ plan: 'RAISEROOM' });
  usage.record(ctx, org.id, 'ARTIFACT_GENERATED', { ms: 2000 });
  usage.record(ctx, org.id, 'ARTIFACT_GENERATED', { ms: 1, outcome: 'REFUSED' });
  usage.record(ctx, org.id, 'ARTIFACT_GENERATED', { ms: 2, outcome: 'REFUSED' });

  const c = usage.report(db, { from: '2020-01-01', to: '2030-01-01' })
    .capabilities.find((x) => x.key === 'ARTIFACT_GENERATED');

  assert.equal(c.events, 3, 'attempts, so that wanting something and being refused still shows');
  assert.equal(c.outcomes.REFUSED, 2);
  assert.equal(c.ms_mean, 2000,
    'folding refusals in would make a slow capability look fast exactly when it is being refused most');
  assert.equal(c.ms_max, 2000);
});
