/**
 * Phase 7 — staleness propagation.
 *
 * Two things are being protected.
 *
 * The signal: if every change raises the same flag, people stop reading flags,
 * and the one that mattered goes past unread. So most of these tests check that
 * something does NOT raise an alarm.
 *
 * The record: a document somebody outside the company is holding is never
 * rewritten, and what they saw stays recoverable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, ctxFor, expectRefusal, fakeStorage } from './helpers.js';
import * as svc from '../src/api/service.js';
import * as artifacts from '../src/api/artifacts.js';
import * as api from '../src/api/freshness.js';
import {
  resolveChain, artifactStaleness, severityOf, documentFreshness,
  regenerationDiff, policyFor, FRESHNESS_POLICY, STALENESS_REASONS,
} from '../src/domain/freshness.js';

function world() {
  const db = freshDb();
  const ctx = ctxFor(db, 'u-owner');
  const storage = fakeStorage();
  const org = svc.createOrganisation(ctx, { name: 'Northwind Systems', path: 'RAISE' }).body.organisation;
  return { db, ctx, org, storage };
}

function docFor(ctx, org, storage, filename, kind = 'ACCOUNTS') {
  const d = svc.createUploadTicket(ctx, org.id, {
    filename, size_bytes: 1_000, mime_type: 'application/pdf', kind,
  }, storage).body.document;
  svc.confirmUpload(ctx, org.id, d.id);
  return d.id;
}

/** An org with a generated FINANCIAL_SUMMARY resting on two facts. */
function withArtifact(ctx, org, storage) {
  const doc = docFor(ctx, org, storage, 'accounts.pdf');
  const revenue = svc.createFact(ctx, org.id, {
    fact_key: 'financials.revenue.ttm', label: 'Revenue', value_numeric: 3_600_000, unit: 'USD',
    period_start: '2025-01-01', period_end: '2025-12-31',
    source: 'USER_CONFIRMED', source_doc_id: doc, source_page: 4,
  }).body.fact;
  svc.createFact(ctx, org.id, {
    fact_key: 'financials.gross_margin', label: 'Gross margin', value_numeric: 63.9, unit: 'percent',
    source: 'USER_CONFIRMED', source_doc_id: doc, source_page: 4,
  });
  svc.createFact(ctx, org.id, {
    fact_key: 'company.name', label: 'Registered name',
    value_text: 'Northwind Systems Inc.', source: 'USER_ENTERED',
  });

  const artifact = artifacts.generate(ctx, org.id, 'FINANCIAL_SUMMARY').body.artifact;
  return { artifact, revenue, doc };
}

// ─────────────────────────────────────── the signal, and not crying wolf ──

test('a corrected figure makes the artifact stale', () => {
  const { ctx, org, storage } = world();
  const { artifact, revenue } = withArtifact(ctx, org, storage);

  svc.supersedeFact(ctx, org.id, revenue.id, { value_numeric: 3_400_000 });

  const health = api.artifactHealth(ctx, org.id).body;
  const row = health.artifacts.find((a) => a.id === artifact.id);

  assert.equal(row.severity, 'REVIEW', 'a draft resting on a changed figure needs regenerating, not panic');
  const reason = row.reasons.find((r) => r.reason === 'VALUE_CHANGED');
  assert.ok(reason);
  assert.equal(reason.was, 3_600_000);
  assert.equal(reason.now, 3_400_000);
});

test('a figure gaining better evidence does not cry wolf', () => {
  // The same number, now confirmed against a document rather than typed. The
  // artifact is not wrong; its appendix just understates the evidence. Grading
  // this the same as a corrected figure is how a staleness flag becomes noise.
  const { ctx, org, storage } = world();
  const doc = docFor(ctx, org, storage, 'accounts.pdf');
  const entered = svc.createFact(ctx, org.id, {
    fact_key: 'financials.revenue.ttm', label: 'Revenue', value_numeric: 3_600_000, unit: 'USD',
    source: 'USER_ENTERED',
  }).body.fact;
  svc.createFact(ctx, org.id, {
    fact_key: 'company.name', label: 'Registered name', value_text: 'N', source: 'USER_ENTERED',
  });
  const artifact = artifacts.generate(ctx, org.id, 'FINANCIAL_SUMMARY').body.artifact;

  svc.supersedeFact(ctx, org.id, entered.id, {
    source: 'USER_CONFIRMED', source_doc_id: doc, source_page: 4,
  });

  const row = api.artifactHealth(ctx, org.id).body.artifacts.find((a) => a.id === artifact.id);
  assert.equal(row.severity, 'MINOR');
  assert.equal(row.wrong, false);
  assert.ok(row.reasons.some((r) => r.reason === 'PROVENANCE_IMPROVED'));
  assert.match(row.advice, /Nothing in this document is wrong/);
});

test('a figure this document does not use is not new material for it', () => {
  // The rule: "new material" means material THIS artifact could have used — the
  // keys its own catalogue entry declares — not every fact the company holds.
  //
  // Scoped to the organisation instead, a financial summary was permanently
  // flagged as incomplete because somebody had recorded the registered name.
  // That is the crying-wolf failure this phase exists to avoid, and it had no
  // test: the mutation that widens the scope survived until the mutation's
  // anchor was repaired, at which point it turned out nothing was protecting
  // the rule at all.
  const { ctx, org, storage } = world();
  const { artifact } = withArtifact(ctx, org, storage);
  const doc = docFor(ctx, org, storage, 'headcount.pdf');

  // Confirmed, usable, and recorded after the document was generated — so the
  // only thing keeping it out of the staleness check is that a financial
  // summary does not declare this key.
  svc.createFact(ctx, org.id, {
    fact_key: 'people.headcount', label: 'Headcount', value_numeric: 38,
    source: 'USER_CONFIRMED', source_doc_id: doc, source_page: 1,
  });

  const row = api.artifactHealth(ctx, org.id).body.artifacts.find((a) => a.id === artifact.id);
  assert.equal(row.severity, 'CURRENT',
    'a figure the document never declared made it stale');
  assert.deepEqual(row.reasons, []);

  // And the control: a key this document DOES declare, added afterwards, is
  // material — otherwise the test above would pass on a check that never fires.
  svc.createFact(ctx, org.id, {
    fact_key: 'financials.reported_profit', label: 'Reported profit', value_numeric: 410_000,
    unit: 'USD', source: 'USER_CONFIRMED', source_doc_id: doc, source_page: 2,
  });
  const after = api.artifactHealth(ctx, org.id).body.artifacts.find((a) => a.id === artifact.id);
  assert.ok(after.reasons.some((r) => r.reason === 'NEW_MATERIAL'),
    'a figure the document declares and could now use was not reported');
});

test('a figure read from a document but not confirmed is not new material', () => {
  // An unconfirmed extraction is a proposal. Treating it as material would both
  // cry wolf and imply the product counts a machine reading as a fact — which
  // is the one thing it exists not to do.
  const { ctx, org, storage, db } = world();
  const { artifact } = withArtifact(ctx, org, storage);
  const doc = docFor(ctx, org, storage, 'later-accounts.pdf');

  // Written straight to the table: `createFact` will not accept
  // DOCUMENT_EXTRACTED, which is itself the rule, tested in facts.test.js.
  // What is under test here is that freshness agrees with it.
  db.insert('fact', {
    org_id: org.id,
    fact_key: 'financials.reported_profit', label: 'Reported profit',
    value_numeric: 410_000, value_text: null, value_date: null, unit: 'USD',
    period_start: null, period_end: null,
    source: 'DOCUMENT_EXTRACTED', source_doc_id: doc, source_page: 2,
    formula: null, input_fact_ids: null,
    confirmed_at: null, confirmed_by: null, superseded_by: null,
    created_by: 'u-owner', created_at: ctx.now(),
  });

  const row = api.artifactHealth(ctx, org.id).body.artifacts.find((a) => a.id === artifact.id);
  assert.equal(row.severity, 'CURRENT',
    'an unconfirmed extraction was counted as material the document is missing');
  assert.ok(!row.reasons.some((r) => r.reason === 'NEW_MATERIAL'));
});

test('an artifact nothing has touched stays current', () => {
  const { ctx, org, storage } = world();
  const { artifact } = withArtifact(ctx, org, storage);
  const row = api.artifactHealth(ctx, org.id).body.artifacts.find((a) => a.id === artifact.id);

  assert.equal(row.severity, 'CURRENT');
  assert.deepEqual(row.reasons, []);
  assert.equal(row.advice, null);
});

test('severity needs both a wrong figure and a released document to be urgent', () => {
  const changed = [{ reason: 'VALUE_CHANGED' }];
  const cosmetic = [{ reason: 'PROVENANCE_IMPROVED' }];

  assert.equal(severityOf({ reasons: changed, released: true }), 'URGENT');
  assert.equal(severityOf({ reasons: changed, released: false }), 'REVIEW');
  assert.equal(severityOf({ reasons: cosmetic, released: true }), 'MINOR',
    'a sent document whose evidence improved is not an emergency');
  assert.equal(severityOf({ reasons: [], released: true }), 'CURRENT');
});

test('new material makes a document incomplete, not wrong', () => {
  const { ctx, org, storage } = world();
  const { artifact } = withArtifact(ctx, org, storage);

  svc.createFact(ctx, org.id, {
    fact_key: 'financials.reported_profit', label: 'Reported profit', value_numeric: 420_000,
    unit: 'USD', source: 'USER_ENTERED',
  });

  const row = api.artifactHealth(ctx, org.id).body.artifacts.find((a) => a.id === artifact.id);
  assert.equal(row.severity, 'MINOR');
  assert.equal(row.wrong, false);
  const reason = row.reasons.find((r) => r.reason === 'NEW_MATERIAL');
  assert.ok(reason.keys.includes('financials.reported_profit'));
});

test('an unconfirmed extraction is not material a document is missing', () => {
  const { db, ctx, org, storage } = world();
  const { artifact } = withArtifact(ctx, org, storage);

  // Planted under a key this artifact DOES declare, so the only thing that can
  // exclude it is the unconfirmed source. Under an unrelated key the scoping
  // rule would exclude it anyway and the test would pass for the wrong reason.
  db.insert('fact', {
    org_id: org.id, fact_key: 'financials.reported_profit', label: 'Reported profit', value_numeric: 9_999_999,
    value_text: null, value_date: null, unit: 'USD', period_start: null, period_end: null,
    source: 'DOCUMENT_EXTRACTED', source_doc_id: 'd1', source_page: 1,
    formula: null, input_fact_ids: null, confirmed_at: null, confirmed_by: null,
    superseded_by: null, created_by: 'u-owner', created_at: '2026-01-01T00:00:00.000Z',
  });

  const row = api.artifactHealth(ctx, org.id).body.artifacts.find((a) => a.id === artifact.id);
  const material = row.reasons.find((r) => r.reason === 'NEW_MATERIAL');
  assert.ok(!material || !material.keys.includes('financials.reported_profit'),
    'a proposal nobody has confirmed is not something the document should have used');
});

test('a figure that becomes disputed makes the artifact wrong', () => {
  const { db, ctx, org, storage } = world();
  const { artifact, revenue } = withArtifact(ctx, org, storage);

  db.insert('conflict', {
    org_id: org.id, rule_ref: 'SK-1', kind: 'VALUE_MISMATCH', severity: 'HIGH',
    left_ref: `fact:${revenue.id}`, left_summary: 'Revenue: USD 3,600,000',
    right_ref: 'candidate:c1', right_summary: 'Revenue: USD 3,400,000',
    detail: 'Revenue does not agree across sources',
    resolved_at: null, resolved_by: null, resolution: null, resolution_note: null,
    created_at: '2026-01-01T00:00:00.000Z',
  });

  const row = api.artifactHealth(ctx, org.id).body.artifacts.find((a) => a.id === artifact.id);
  assert.equal(row.wrong, true);
  assert.ok(row.reasons.some((r) => r.reason === 'DISPUTED'));
});

// ───────────────────────────────── the document somebody else is holding ──

test('a released document resting on a changed figure is urgent, and says what to do', () => {
  const { ctx, org, storage } = world();
  const { artifact, revenue } = withArtifact(ctx, org, storage);

  api.markReleased(ctx, org.id, artifact.id, { note: 'Sent to Harbour Ventures, first meeting' });
  svc.supersedeFact(ctx, org.id, revenue.id, { value_numeric: 3_400_000 });

  const health = api.artifactHealth(ctx, org.id).body;
  const row = health.artifacts.find((a) => a.id === artifact.id);

  assert.equal(row.severity, 'URGENT');
  assert.match(row.advice, /tell whoever is holding the old copy/);
  assert.match(health.headline, /already sent out/);
});

test('releasing without saying who is refused', () => {
  const { ctx, org, storage } = world();
  const { artifact } = withArtifact(ctx, org, storage);

  const err = expectRefusal(() => api.markReleased(ctx, org.id, artifact.id, {}), 'note_required', 400);
  assert.match(err.message, /bad moment to be reconstructing it from memory/);

  api.markReleased(ctx, org.id, artifact.id, { note: 'Sent to Harbour Ventures' });
  expectRefusal(() => api.markReleased(ctx, org.id, artifact.id, { note: 'again' }),
    'already_released', 409);
});

test('urgent documents sort to the top', () => {
  const { ctx, org, storage } = world();
  const { artifact, revenue } = withArtifact(ctx, org, storage);
  api.markReleased(ctx, org.id, artifact.id, { note: 'Sent to an investor' });
  artifacts.generate(ctx, org.id, 'ONE_PAGER');
  svc.supersedeFact(ctx, org.id, revenue.id, { value_numeric: 3_400_000 });

  const rows = api.artifactHealth(ctx, org.id).body.artifacts;
  assert.equal(rows[0].severity, 'URGENT');
});

test('stale_since records when it stopped being true, not when you last looked', () => {
  const { db, ctx, org, storage } = world();
  const { artifact, revenue } = withArtifact(ctx, org, storage);
  svc.supersedeFact(ctx, org.id, revenue.id, { value_numeric: 3_400_000 });

  // Read the PERSISTED value, not the one in the response — the response
  // reports the row as it was before the update, so it would look stable even
  // while the stored date marched forward every time anyone opened the screen.
  api.artifactHealth(ctx, org.id);
  const first = db.get('artifact', artifact.id).stale_since;
  api.artifactHealth(ctx, org.id);
  const second = db.get('artifact', artifact.id).stale_since;
  api.artifactHealth(ctx, org.id);
  const third = db.get('artifact', artifact.id).stale_since;

  assert.ok(first);
  assert.equal(first, second,
    're-running the check must not keep moving the date, or "how long has this been wrong" is lost');
  assert.equal(second, third);
});

test('a resolved problem clears the flag', () => {
  const { db, ctx, org, storage } = world();
  const { artifact, revenue } = withArtifact(ctx, org, storage);
  svc.supersedeFact(ctx, org.id, revenue.id, { value_numeric: 3_400_000 });
  api.artifactHealth(ctx, org.id);
  assert.equal(db.get('artifact', artifact.id).state, 'STALE');

  api.regenerate(ctx, org.id, artifact.id);
  const rows = api.artifactHealth(ctx, org.id).body.artifacts;
  assert.ok(rows.every((a) => a.severity === 'CURRENT' || a.id !== artifact.id));
});

// ────────────────────────────────────────────────────── regeneration ──

test('a preview names every figure that will move, and changes nothing', () => {
  const { db, ctx, org, storage } = world();
  const { artifact, revenue } = withArtifact(ctx, org, storage);
  svc.supersedeFact(ctx, org.id, revenue.id, { value_numeric: 3_400_000 });

  const before = db.get('artifact', artifact.id).state;
  const preview = api.previewRegeneration(ctx, org.id, artifact.id).body;

  assert.equal(preview.figures_moving, 1);
  assert.equal(preview.changes[0].was, 3_600_000);
  assert.equal(preview.changes[0].now, 3_400_000);
  assert.match(preview.note, /does not rewrite a document somebody else is holding/);
  assert.equal(db.get('artifact', artifact.id).state, before, 'a preview previews');
});

test('regenerating supersedes the old version rather than overwriting it', () => {
  const { db, ctx, org, storage } = world();
  const { artifact, revenue } = withArtifact(ctx, org, storage);
  api.markReleased(ctx, org.id, artifact.id, { note: 'Sent to Harbour Ventures' });
  svc.supersedeFact(ctx, org.id, revenue.id, { value_numeric: 3_400_000 });

  const res = api.regenerate(ctx, org.id, artifact.id);
  const old = db.get('artifact', artifact.id);

  assert.equal(old.state, 'SUPERSEDED');
  assert.equal(old.superseded_by, res.body.artifact.id);
  assert.equal(old.released_at !== null, true,
    'the released record is what somebody outside the company is actually holding');
  assert.match(res.body.outstanding, /Harbour Ventures/);
  assert.match(res.body.outstanding, /1 figure moved/);
});

test('a blocked regeneration leaves the previous version untouched', () => {
  const { db, ctx, org, storage } = world();
  const { artifact } = withArtifact(ctx, org, storage);

  db.insert('conflict', {
    org_id: org.id, rule_ref: 'SK-1', kind: 'VALUE_MISMATCH', severity: 'HIGH',
    left_ref: 'fact:a', left_summary: 'a', right_ref: 'fact:b', right_summary: 'b',
    detail: 'disagreement', resolved_at: null, resolved_by: null,
    resolution: null, resolution_note: null, created_at: '2026-01-01T00:00:00.000Z',
  });

  const res = api.regenerate(ctx, org.id, artifact.id);
  assert.equal(res.body.blocked, true);
  assert.equal(db.get('artifact', artifact.id).state, 'GENERATED', 'nothing was lost by trying');
  assert.match(res.body.note, /still available/);
});

test('a regeneration with nothing to change is still allowed, and says so', () => {
  const { ctx, org, storage } = world();
  const { artifact } = withArtifact(ctx, org, storage);
  const preview = api.previewRegeneration(ctx, org.id, artifact.id).body;
  assert.equal(preview.figures_moving, 0);
  assert.deepEqual(preview.changes, []);
});

// ──────────────────────────────────────────── supersession chains ──

test('a chain is followed to the end', () => {
  const facts = new Map([
    ['a', { id: 'a', superseded_by: 'b', value_numeric: 1 }],
    ['b', { id: 'b', superseded_by: 'c', value_numeric: 2 }],
    ['c', { id: 'c', superseded_by: null, value_numeric: 3 }],
  ]);
  const r = resolveChain('a', facts);
  assert.equal(r.current.id, 'c');
  assert.equal(r.hops, 2);
  assert.equal(r.broken, false);
});

test('a cycle or a dangling link is reported, not followed forever', () => {
  // A supersession loop would hang the request that asked whether a deck was
  // current, which is a poor way to discover a data problem.
  const cyclic = new Map([
    ['a', { id: 'a', superseded_by: 'b' }],
    ['b', { id: 'b', superseded_by: 'a' }],
  ]);
  const r = resolveChain('a', cyclic);
  assert.equal(r.broken, true);
  assert.equal(r.reason, 'cycle');

  const dangling = new Map([['a', { id: 'a', superseded_by: 'gone' }]]);
  const d = resolveChain('a', dangling);
  assert.equal(d.broken, true);
  assert.equal(d.reason, 'dangling');
  assert.equal(d.current.id, 'a', 'the last good fact is better than nothing');
});

test('a reference to a fact that no longer exists is counted, not ignored', () => {
  const result = artifactStaleness({ id: 'x', fact_refs: ['missing'] }, new Map());
  assert.equal(result.broken_chains, 1);
});

// ──────────────────────────────────────────── document freshness ──

test('a constitution does not go out of date on a clock', () => {
  // The lazy version of this feature flags the articles of association every
  // quarter and trains people to dismiss the whole screen.
  const old = { kind: 'OTHER', uploaded_at: '2019-01-01T00:00:00.000Z' };
  const result = documentFreshness(old, '2026-10-13T00:00:00.000Z', { folderKey: '02' });

  assert.equal(result.state, 'TIMELESS');
  assert.equal(result.days, null);
  assert.match(result.policy.why, /do not go out of date with time/);
});

test('management accounts age in weeks and a contract does not age at all', () => {
  const asOf = '2026-10-13T00:00:00.000Z';
  const accounts = documentFreshness(
    { kind: 'ACCOUNTS', uploaded_at: '2026-06-01T00:00:00.000Z' }, asOf);
  assert.equal(accounts.state, 'STALE');
  assert.ok(accounts.days > 45);

  const contract = documentFreshness(
    { kind: 'CONTRACT', uploaded_at: '2019-01-01T00:00:00.000Z' }, asOf);
  assert.equal(contract.state, 'TIMELESS');
  assert.match(contract.policy.why, /changes status when its term/);
});

test('freshness has three states before stale, so nothing jumps straight to red', () => {
  const asOf = '2026-10-13T00:00:00.000Z';
  const fresh = documentFreshness({ kind: 'ACCOUNTS', uploaded_at: '2026-10-01T00:00:00.000Z' }, asOf);
  const ageing = documentFreshness({ kind: 'ACCOUNTS', uploaded_at: '2026-09-05T00:00:00.000Z' }, asOf);
  assert.equal(fresh.state, 'FRESH');
  assert.equal(ageing.state, 'AGEING');
});

test('every policy says why, because a nag with no reason gets dismissed', () => {
  for (const [kind, policy] of Object.entries(FRESHNESS_POLICY)) {
    assert.ok(policy.why, `${kind} has no stated reason`);
    assert.ok(policy.staleAfterDays === null || policy.staleAfterDays > 0);
  }
  assert.equal(policyFor({ kind: 'ACCOUNTS' }).kind, 'ACCOUNTS');
  assert.equal(policyFor({ kind: 'NOT_A_KIND' }).kind, 'OTHER');
});

test('the room freshness view explains itself', () => {
  const { ctx, org, storage } = world();
  docFor(ctx, org, storage, 'accounts.pdf', 'ACCOUNTS');
  docFor(ctx, org, storage, 'msa.pdf', 'CONTRACT');

  const body = api.roomFreshness(ctx, org.id).body;
  assert.equal(body.summary.total, 2);
  assert.equal(body.summary.timeless, 1);
  assert.match(body.note, /A constitution does not go out of date on a clock/);
});

// ──────────────────────────────────────────────── change digest ──

test('what changed is derived from the records, not kept as a second copy', () => {
  const { ctx, org, storage } = world();
  const { revenue } = withArtifact(ctx, org, storage);
  const mark = ctx.now();

  svc.supersedeFact(ctx, org.id, revenue.id, { value_numeric: 3_400_000 });
  svc.createFact(ctx, org.id, {
    fact_key: 'people.headcount', label: 'Headcount', value_numeric: 38, unit: 'count',
    source: 'USER_ENTERED',
  });

  const body = api.changesSince(ctx, org.id, mark).body;
  assert.equal(body.corrections.length, 1);
  assert.equal(body.corrections[0].was, 3_600_000);
  assert.equal(body.corrections[0].now, 3_400_000);
  assert.ok(body.facts_added.some((f) => f.fact_key === 'people.headcount'));
  assert.equal(body.material, true);
  assert.match(body.summary, /1 figure corrected/);
});

test('a correction is reported as a correction, not as a new figure', () => {
  const { ctx, org, storage } = world();
  const { revenue } = withArtifact(ctx, org, storage);
  const mark = ctx.now();
  svc.supersedeFact(ctx, org.id, revenue.id, { value_numeric: 3_400_000 });

  const body = api.changesSince(ctx, org.id, mark).body;
  assert.equal(body.facts_added.length, 0, 'a corrected figure is not a new one');
  assert.equal(body.corrections.length, 1);
});

test('a quiet period reports as quiet', () => {
  const { ctx, org, storage } = world();
  withArtifact(ctx, org, storage);
  const body = api.changesSince(ctx, org.id, ctx.now()).body;
  assert.equal(body.material, false);
  assert.equal(body.corrections.length, 0);
});

test('an unreadable start date is refused', () => {
  const { ctx, org } = world();
  expectRefusal(() => api.changesSince(ctx, org.id, 'last tuesday'), 'invalid_since', 400);
});

// ───────────────────────────────────────────────────────── access ──

test('a viewer cannot release or regenerate, and another organisation gets 404', () => {
  const { db, ctx, org, storage } = world();
  const { artifact } = withArtifact(ctx, org, storage);

  db.insert('membership', {
    org_id: org.id, user_id: 'u-viewer', email: 'v@example.com', role: 'VIEWER', created_at: '2026-01-01',
  });
  expectRefusal(() => api.markReleased(ctxFor(db, 'u-viewer'), org.id, artifact.id, { note: 'x' }),
    'forbidden', 403);

  const other = ctxFor(db, 'u-other');
  const otherOrg = svc.createOrganisation(other, { name: 'Other Co' }).body.organisation;
  db.update('membership', db.findOne('membership', { org_id: otherOrg.id, user_id: 'u-other' }).id,
    { role: 'EDITOR' });
  expectRefusal(() => api.regenerate(other, otherOrg.id, artifact.id), 'not_found', 404);
});

test('every staleness reason says what it means', () => {
  for (const reason of STALENESS_REASONS) {
    assert.ok(reason.means, `${reason.id} has no plain-English meaning`);
    assert.equal(typeof reason.wrong, 'boolean');
  }
  assert.equal(STALENESS_REASONS.filter((r) => r.wrong).length, 2,
    'only a changed figure and a disputed one make a document actually wrong');
});
