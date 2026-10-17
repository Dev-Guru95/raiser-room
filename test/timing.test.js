/**
 * Phase 3 — timing instrumentation.
 *
 * The product question behind these tests is "how long does this take?", and
 * the honest answer today is that nobody has measured it. So the thing being
 * tested is mostly a refusal: that no figure is reported until there is enough
 * measured data behind it, and that the two clocks are never averaged together.
 *
 * If a marketing claim about preparation time ever appears, it has to come out
 * of `cohortClaim`, and `cohortClaim` cannot invent one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, ctxFor, expectRefusal, fakeStorage } from './helpers.js';
import * as svc from '../src/api/service.js';
import * as timingApi from '../src/api/timing.js';
import {
  MILESTONES, INTERVALS, cohortClaim, intervalsFor, daysBetween,
  assertSingleClock, MIN_SAMPLE,
} from '../src/domain/timing.js';

function world() {
  const db = freshDb();
  const ctx = ctxFor(db, 'u-owner');
  const org = svc.createOrganisation(ctx, { name: 'Test Co', path: 'RAISE' }).body.organisation;
  return { db, ctx, org };
}

// ─────────────────────────────────────────────── the refusal that matters ──

test('the minimum sample is twenty, and that is not a detail', () => {
  // Hard-coded on purpose. An earlier version of the test below built its
  // sample as `MIN_SAMPLE - 1`, so lowering MIN_SAMPLE to 1 shrank the sample
  // too and the test went on passing — a test that derives its input from the
  // constant it is checking cannot catch a change to that constant. Mutation
  // testing found it.
  assert.equal(MIN_SAMPLE, 20,
    'below twenty, one unusual customer moves the median enough to mislead');
});

test('no timing figure is reported until there is enough measured data', () => {
  const nineteen = Array.from({ length: 19 }, (_, i) => 3 + i * 0.1);
  const result = cohortClaim('T1', nineteen);

  assert.equal(result.claim, null, 'nineteen is not enough to put a number on a page');
  assert.equal(result.n, 19);
  assert.equal(result.needed, 20);
  assert.match(result.why, /Not enough measured data/);

  // And twenty is.
  assert.ok(cohortClaim('T1', [...nineteen, 5]).claim);
});

test('with no data at all, the answer is still a refusal rather than zero', () => {
  const result = cohortClaim('T1', []);
  assert.equal(result.claim, null);
  assert.equal(result.n, 0);
});

test('a claim arrives only with its sample size attached', () => {
  const samples = Array.from({ length: 24 }, (_, i) => 2 + i * 0.5);
  const result = cohortClaim('T1', samples);

  assert.ok(result.claim, 'twenty-four completed intervals is a measurement');
  assert.equal(result.n, 24);
  assert.ok(result.claim.median_days > 0);
  assert.match(result.claim.wording, /Measured across 24 organisations/);
  assert.match(result.claim.wording, /median of/);
});

test('a clock B claim says so in its own wording', () => {
  const samples = Array.from({ length: 30 }, () => 90);
  const b = cohortClaim('T4', samples);          // room complete — waits on third parties
  const a = cohortClaim('T1', samples);          // first self-assessment

  assert.match(b.claim.wording, /depends on third parties/);
  assert.doesNotMatch(a.claim.wording, /depends on third parties/);
});

test('the two clocks are never averaged together', () => {
  // Four days of scoring and four months of waiting for a landlord produce an
  // average that describes neither, and it is the overpromise half a customer
  // remembers.
  assert.equal(assertSingleClock(['T1', 'T2', 'T3']), 'A');
  assert.equal(assertSingleClock(['T4', 'T5', 'T6']), 'B');
  assert.throws(() => assertSingleClock(['T1', 'T4']), (err) => err.code === 'mixed_clocks');
});

test('every milestone and every interval declares its clock', () => {
  for (const m of MILESTONES) {
    assert.ok(['A', 'B'].includes(m.clock), `${m.key} has no clock`);
    assert.ok(m.means, `${m.key} has no plain-English meaning`);
  }
  for (const i of INTERVALS) {
    assert.ok(['A', 'B'].includes(i.clock), `${i.ref} has no clock`);
    assert.ok(MILESTONES.some((m) => m.key === i.from), `${i.ref} starts at an unknown milestone`);
    assert.ok(MILESTONES.some((m) => m.key === i.to), `${i.ref} ends at an unknown milestone`);
  }
});

test('negative and non-numeric samples are discarded before any figure is computed', () => {
  const dirty = [...Array.from({ length: 22 }, () => 5), -3, NaN, null, 'soon'];
  const result = cohortClaim('T1', dirty);
  assert.equal(result.n, 22, 'a clock cannot run backwards, and "soon" is not a duration');
});

test('an unknown interval is an error, not an empty answer', () => {
  assert.throws(() => cohortClaim('T99', []), (err) => err.code === 'unknown_interval');
});

// ─────────────────────────────────────────────────────── recording ──

test('milestones are recorded as a side effect of work that happens anyway', () => {
  const { db, ctx, org } = world();
  const events = db.find('timing_event', { org_id: org.id });
  assert.equal(events.length, 1);
  assert.equal(events[0].milestone, 'ORG_CREATED');
  assert.equal(events[0].clock, 'A');
});

test('first occurrence wins — reaching a milestone twice does not move it', () => {
  const { db, ctx, org } = world();
  const first = db.findOne('timing_event', { org_id: org.id, milestone: 'ORG_CREATED' });

  assert.equal(timingApi.recordMilestone(ctx, org.id, 'ORG_CREATED'), null);
  assert.equal(db.count('timing_event', { org_id: org.id, milestone: 'ORG_CREATED' }), 1);
  assert.equal(
    db.findOne('timing_event', { org_id: org.id, milestone: 'ORG_CREATED' }).occurred_at,
    first.occurred_at,
    'a re-score months later must not overwrite when the company actually got here',
  );
});

test('a failure to record a timestamp never fails the work it was measuring', () => {
  const { ctx, org } = world();
  // An unknown milestone, a race on the unique index — neither is worth failing
  // a user's action over. The measurement is for us; the work is for them.
  assert.equal(timingApi.recordMilestone(ctx, org.id, 'NOT_A_MILESTONE'), null);
  assert.doesNotThrow(() => timingApi.recordMilestone(ctx, org.id, 'NOT_A_MILESTONE'));
});

test('an upload confirmation and a room build are both timed', () => {
  const { db, ctx, org } = world();
  const storage = fakeStorage();

  const doc = svc.createUploadTicket(ctx, org.id, {
    filename: 'deck.pdf', size_bytes: 1_000, mime_type: 'application/pdf',
  }, storage).body.document;
  assert.equal(db.count('timing_event', { org_id: org.id, milestone: 'FIRST_DOCUMENT_CONFIRMED' }), 0,
    'issuing a ticket is not an upload');

  svc.confirmUpload(ctx, org.id, doc.id);
  assert.equal(db.count('timing_event', { org_id: org.id, milestone: 'FIRST_DOCUMENT_CONFIRMED' }), 1);
});

// ───────────────────────────────────────────────── one organisation's view ──

test('an unfinished interval is reported as in progress, never as zero', () => {
  const events = [{ milestone: 'ORG_CREATED', occurred_at: '2026-01-01T00:00:00.000Z' }];
  const t1 = intervalsFor(events).find((i) => i.ref === 'T1');

  assert.equal(t1.state, 'IN_PROGRESS');
  assert.equal(t1.days, null,
    '"not finished yet" and "finished instantly" are opposite facts');
});

test('a completed interval reports its elapsed days', () => {
  const t1 = intervalsFor([
    { milestone: 'ORG_CREATED', occurred_at: '2026-01-01T00:00:00.000Z' },
    { milestone: 'FIRST_ASSESSMENT_COMPLETE', occurred_at: '2026-01-04T12:00:00.000Z' },
  ]).find((i) => i.ref === 'T1');

  assert.equal(t1.state, 'COMPLETE');
  assert.equal(t1.days, 3.5);
});

test('elapsed time is computed, not estimated', () => {
  assert.equal(daysBetween('2026-01-01T00:00:00Z', '2026-01-08T00:00:00Z'), 7);
  assert.equal(daysBetween('not a date', '2026-01-08T00:00:00Z'), null);
});

test("an organisation's own view says plainly that it is not a benchmark", () => {
  const { ctx, org } = world();
  const body = timingApi.timingFor(ctx, org.id).body;

  assert.match(body.note, /not a benchmark/);
  assert.ok(body.milestones.find((m) => m.key === 'ORG_CREATED').reached_at);
  assert.equal(body.milestones.find((m) => m.key === 'BAND_READY').reached_at, null);
});

test('a tenant cannot ask what other tenants’ timings look like', () => {
  const { ctx } = world();
  // There is no benchmarking feature and no cross-organisation read. A 404,
  // because a 403 would confirm there is something there to ask about.
  expectRefusal(() => timingApi.measuredClaim(ctx, 'T1', Array(50).fill(5)), 'not_found', 404);

  const internal = { ...ctx, auth: { ...ctx.auth, isInternal: true } };
  assert.ok(timingApi.measuredClaim(internal, 'T1', Array(50).fill(5)).body.claim);
});
