/**
 * Phase 3 — conflict detection.
 *
 * The product's commercial argument is that it finds the contradiction before a
 * counterparty does. These tests are what make that true rather than asserted,
 * and they also pin the two ways the feature could fail commercially: missing a
 * real contradiction, and crying wolf over rounding until the list is ignored.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, ctxFor, expectRefusal, fakeStorage } from './helpers.js';
import * as svc from '../src/api/service.js';
import * as ext from '../src/api/extraction.js';
import * as conflicts from '../src/domain/conflicts.js';
import { fakeExtractor, DECK_CANDIDATES, ACCOUNTS_CANDIDATES, MODEL_CANDIDATES } from '../src/extract/fake.js';

const PDF = 'application/pdf';

function world() {
  const db = freshDb();
  const ctx = ctxFor(db, 'u-owner');
  const storage = fakeStorage();
  const org = svc.createOrganisation(ctx, { name: 'Test Co', path: 'RAISE' }).body.organisation;
  return { db, ctx, org, storage };
}

function upload(ctx, org, storage, filename, kind) {
  const issued = svc.createUploadTicket(ctx, org.id, {
    filename, size_bytes: 10_000, mime_type: PDF, kind,
  }, storage).body.document;
  svc.confirmUpload(ctx, org.id, issued.id);
  return ctx.db.get('document', issued.id);
}

/** Upload a document, extract from it, and confirm everything it found. */
async function ingest(ctx, org, storage, filename, kind, candidates) {
  const doc = upload(ctx, org, storage, filename, kind);
  const res = await ext.runExtraction(ctx, org.id, doc.id,
    fakeExtractor({ candidates: { [doc.storage_key]: candidates } }));
  const run = ctx.db.findOne('extraction', { document_id: doc.id });
  ext.getExtraction(ctx, org.id, run.id);
  ext.bulkConfirm(ctx, org.id, run.id);
  return { doc, run, conflicts: res.body.conflicts };
}

// ──────────────────────────────────────────── the deck against the accounts ──

test('the deck and the accounts disagreeing on ARR raises a HIGH conflict', async () => {
  const { ctx, org, storage } = world();
  await ingest(ctx, org, storage, 'pitch-deck.pdf', 'DECK', [...DECK_CANDIDATES]);
  const second = await ingest(ctx, org, storage, 'accounts-2025.pdf', 'ACCOUNTS', [...ACCOUNTS_CANDIDATES]);

  const arr = second.conflicts.find((c) => c.kind === 'VALUE_MISMATCH' && c.detail.includes('ARR'));
  assert.ok(arr, '$4.2m against $3.8m is the contradiction this product exists to find');
  assert.equal(arr.severity, 'HIGH');
  assert.match(arr.detail, /difference of USD 400,000/);
  assert.match(arr.left_summary, /pitch-deck\.pdf/);
  assert.match(arr.right_summary, /accounts-2025\.pdf/);
  assert.match(arr.detail, /neither has been changed/);
});

test('a conflict names where each side came from, including the page', async () => {
  const { ctx, org, storage } = world();
  await ingest(ctx, org, storage, 'pitch-deck.pdf', 'DECK', [DECK_CANDIDATES[0]]);
  const second = await ingest(ctx, org, storage, 'accounts.pdf', 'ACCOUNTS', [ACCOUNTS_CANDIDATES[0]]);

  const c = second.conflicts[0];
  assert.match(c.left_summary, /page 7/);
  assert.match(c.right_summary, /Sheet 'Summary', cell D14/);
});

test('the narrative and the model disagreeing on retention is caught across keys', async () => {
  const { ctx, org, storage } = world();
  await ingest(ctx, org, storage, 'deck.pdf', 'DECK', [...DECK_CANDIDATES]);
  const second = await ingest(ctx, org, storage, 'model.xlsx', 'MODEL', [...MODEL_CANDIDATES]);

  const xk = second.conflicts.find((c) => c.rule_ref === 'XK-2');
  assert.ok(xk, '140% claimed against 118% assumed is two statements of one quantity');
  assert.equal(xk.kind, 'CROSS_KEY');
  assert.match(xk.right_summary, /two statements of the same quantity/i);
});

test('a stated gross margin that does not follow from revenue and cost is caught', () => {
  // 3.6m revenue, 1.3m cost → 63.9%, against 78% stated.
  const found = conflicts.detectConflicts([], [
    { id: 'c1', fact_key: 'financials.revenue.ttm', label: 'Revenue', value_numeric: 3_600_000, unit: 'USD' },
    { id: 'c2', fact_key: 'financials.cogs.ttm', label: 'Cost of sales', value_numeric: 1_300_000, unit: 'USD' },
    { id: 'c3', fact_key: 'financials.gross_margin', label: 'Gross margin', value_numeric: 78, unit: 'percent' },
  ]);
  const identity = found.find((c) => c.rule_ref === 'XK-4');
  assert.ok(identity);
  assert.match(identity.detail, /63\.89%, against 78% stated/);
  assert.equal(identity.severity, 'HIGH');
});

test('concentration that cannot be true is caught by arithmetic alone', () => {
  const found = conflicts.detectConflicts([], [
    { id: 'a', fact_key: 'commercial.concentration.top1', label: 'Top 1', value_numeric: 68, unit: 'percent' },
    { id: 'b', fact_key: 'commercial.concentration.top3', label: 'Top 3', value_numeric: 54, unit: 'percent' },
    { id: 'c', fact_key: 'commercial.concentration.top5', label: 'Top 5', value_numeric: 88, unit: 'percent' },
  ]);
  const mono = found.find((c) => c.rule_ref === 'XK-1');
  assert.ok(mono, 'the top 3 includes the top 1, so 54 cannot sit under 68');
  assert.match(mono.right_summary, /Set containment/);
});

// ─────────────────────────────────────────────────────────── crying wolf ──

test('rounding in a deck is not reported as a contradiction', () => {
  const found = conflicts.detectConflicts(
    [{ id: 'f1', fact_key: 'financials.arr', label: 'ARR', value_numeric: 4_199_614, unit: 'USD', source: 'USER_CONFIRMED' }],
    [{ id: 'c1', fact_key: 'financials.arr', label: 'ARR', value_numeric: 4_200_000, unit: 'USD' }],
  );
  assert.equal(found.length, 0,
    'one number presented two ways. Flagging it trains people to ignore the list');
});

test('percentages are tested both ways, so neither end of the scale is missed', () => {
  // Quiet at the top: 0.4 of a point on a retention figure is rounding.
  assert.equal(conflicts.withinTolerance(118, 118.4, 'percent'), true);

  // Loud at the bottom: the same 0.4 of a point on churn is a 40% difference in
  // the thing being measured. An absolute-only test waved this through, which
  // is the bug this assertion caught.
  assert.equal(conflicts.withinTolerance(1.0, 1.4, 'percent'), false);

  // And a large absolute gap is caught even when relatively small.
  assert.equal(conflicts.withinTolerance(1000, 1000.9, 'percent'), false);
  assert.equal(conflicts.withinTolerance(1.0, 1.4, 'USD'), false);
});

test('headcount is not approximately anything', () => {
  assert.equal(conflicts.withinTolerance(38, 39, 'count'), false);
  assert.equal(conflicts.withinTolerance(38, 38, 'count'), true);
});

test('two facts already confirmed do not re-raise on every later run', () => {
  const found = conflicts.detectConflicts([
    { id: 'f1', fact_key: 'financials.arr', label: 'ARR', value_numeric: 4_200_000, unit: 'USD', source: 'USER_CONFIRMED' },
    { id: 'f2', fact_key: 'financials.arr', label: 'ARR', value_numeric: 3_800_000, unit: 'USD', source: 'USER_CONFIRMED' },
  ], []);
  assert.equal(found.length, 0, 'that was raised when the second one arrived');
});

test('an unconfirmed extraction is never used as the baseline for a conflict', async () => {
  const { ctx, org, storage } = world();
  const doc = upload(ctx, org, storage, 'deck.pdf', 'DECK');
  await ext.runExtraction(ctx, org.id, doc.id,
    fakeExtractor({ candidates: { [doc.storage_key]: [DECK_CANDIDATES[0]] } }));

  // Nothing confirmed yet. A second document must not be compared against a guess.
  const doc2 = upload(ctx, org, storage, 'accounts.pdf', 'ACCOUNTS');
  const res = await ext.runExtraction(ctx, org.id, doc2.id,
    fakeExtractor({ candidates: { [doc2.storage_key]: [ACCOUNTS_CANDIDATES[0]] } }));

  assert.equal(res.body.conflicts.length, 0,
    'two unverified guesses disagreeing is not a finding about the company');
});

test('REGRESSION: a DOCUMENT_EXTRACTED fact is never used as a conflict baseline', async () => {
  const { db, ctx, org, storage } = world();

  // No Phase 3 path writes one of these, so this row is planted by hand. It
  // stands in for a future bulk-import feature, or a migration that backfills
  // the fact table — either of which would otherwise turn an unreviewed
  // extraction into the thing every later document is measured against.
  db.insert('fact', {
    org_id: org.id, fact_key: 'financials.arr', label: 'ARR',
    value_numeric: 9_999_999, value_text: null, value_date: null, unit: 'USD',
    period_start: null, period_end: null,
    source: 'DOCUMENT_EXTRACTED', source_doc_id: 'planted', source_page: 1,
    formula: null, input_fact_ids: null, confirmed_at: null, confirmed_by: null,
    superseded_by: null, created_by: 'u-owner', created_at: '2026-01-01T00:00:00.000Z',
  });

  const doc = upload(ctx, org, storage, 'accounts.pdf', 'ACCOUNTS');
  const res = await ext.runExtraction(ctx, org.id, doc.id,
    fakeExtractor({ candidates: { [doc.storage_key]: [ACCOUNTS_CANDIDATES[0]] } }));

  assert.equal(res.body.conflicts.length, 0,
    'an unconfirmed extraction is a proposal; it does not get to contradict anything');
});

// ───────────────────────────────────────────────────────── units and periods ──

test('a currency mismatch is HIGH and is never softened by tolerance', () => {
  const found = conflicts.detectConflicts(
    [{ id: 'f1', fact_key: 'financials.arr', label: 'ARR', value_numeric: 3_800_000, unit: 'GBP', source: 'USER_CONFIRMED' }],
    [{ id: 'c1', fact_key: 'financials.arr', label: 'ARR', value_numeric: 3_800_000, unit: 'USD' }],
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'UNIT_MISMATCH');
  assert.equal(found[0].severity, 'HIGH');
  assert.match(found[0].detail, /cannot be compared at all/);
});

test('overlapping but different periods are flagged as such, not as a contradiction', () => {
  const found = conflicts.detectConflicts(
    [{
      id: 'f1', fact_key: 'financials.arr', label: 'ARR', value_numeric: 4_200_000, unit: 'USD',
      source: 'USER_CONFIRMED', period_start: '2025-01-01', period_end: '2025-12-31',
    }],
    [{
      id: 'c1', fact_key: 'financials.arr', label: 'ARR', value_numeric: 3_800_000, unit: 'USD',
      period_start: '2025-07-01', period_end: '2026-06-30',
    }],
  );
  assert.equal(found[0].kind, 'PERIOD_CLASH');
  assert.match(found[0].detail, /may be two different windows/);
});

// ───────────────────────────────────────────────────────────── resolution ──

test('resolving requires a choice and a written reason', async () => {
  const { ctx, org, storage } = world();
  await ingest(ctx, org, storage, 'deck.pdf', 'DECK', [DECK_CANDIDATES[0]]);
  const second = await ingest(ctx, org, storage, 'accounts.pdf', 'ACCOUNTS', [ACCOUNTS_CANDIDATES[0]]);
  const id = second.conflicts[0].id;

  expectRefusal(() => ext.resolveConflict(ctx, org.id, id, { resolution: 'LEFT' }),
    'resolution_note_required', 400);
  expectRefusal(() => ext.resolveConflict(ctx, org.id, id, { resolution: 'LEFT', note: 'higher' }),
    'resolution_note_required', 400);
  expectRefusal(() => ext.resolveConflict(ctx, org.id, id, { resolution: 'BEST', note: 'a proper sentence here' }),
    'invalid_resolution', 400);

  const { body } = ext.resolveConflict(ctx, org.id, id, {
    resolution: 'RIGHT', note: 'The accounts are the audited source; the deck was not updated after year end.',
  });
  assert.equal(body.conflict.resolution, 'RIGHT');
  assert.equal(body.conflict.resolved_by, 'u-owner');
  assert.ok(body.conflict.resolved_at);
});

test('resolving a conflict does not change either figure', async () => {
  const { db, ctx, org, storage } = world();
  await ingest(ctx, org, storage, 'deck.pdf', 'DECK', [DECK_CANDIDATES[0]]);
  const second = await ingest(ctx, org, storage, 'accounts.pdf', 'ACCOUNTS', [ACCOUNTS_CANDIDATES[0]]);

  const before = db.find('fact', { org_id: org.id }).map((f) => f.value_numeric).sort();
  ext.resolveConflict(ctx, org.id, second.conflicts[0].id, {
    resolution: 'RIGHT', note: 'The audited accounts are the source of record for this figure.',
  });
  const after = db.find('fact', { org_id: org.id }).map((f) => f.value_numeric).sort();

  assert.deepEqual(after, before,
    '"we decided the accounts were right" and "we changed the deck" are different acts');
});

test('NEITHER is a legitimate resolution', () => {
  const r = conflicts.validateResolution({
    resolution: 'NEITHER', note: 'Both predate the restatement. Rebuilding from the ledger.',
  });
  assert.equal(r.resolution, 'NEITHER');
});

test('a conflict cannot be resolved twice', async () => {
  const { ctx, org, storage } = world();
  await ingest(ctx, org, storage, 'deck.pdf', 'DECK', [DECK_CANDIDATES[0]]);
  const second = await ingest(ctx, org, storage, 'accounts.pdf', 'ACCOUNTS', [ACCOUNTS_CANDIDATES[0]]);
  const id = second.conflicts[0].id;

  const note = 'The accounts are the audited source of record for this figure.';
  ext.resolveConflict(ctx, org.id, id, { resolution: 'RIGHT', note });
  expectRefusal(() => ext.resolveConflict(ctx, org.id, id, { resolution: 'LEFT', note }),
    'already_resolved', 409);
});

// ──────────────────────────────────────────────────── blocking generation ──

test('an unresolved HIGH conflict blocks document generation', async () => {
  const { ctx, org, storage } = world();
  await ingest(ctx, org, storage, 'deck.pdf', 'DECK', [DECK_CANDIDATES[0]]);
  const second = await ingest(ctx, org, storage, 'accounts.pdf', 'ACCOUNTS', [ACCOUNTS_CANDIDATES[0]]);

  let readiness = ext.generationReadiness(ctx, org.id).body;
  assert.equal(readiness.can_generate, false);
  assert.match(readiness.reason, /Two of your own records disagree/);

  ext.resolveConflict(ctx, org.id, second.conflicts[0].id, {
    resolution: 'RIGHT', note: 'The audited accounts are the source of record for this figure.',
  });

  readiness = ext.generationReadiness(ctx, org.id).body;
  assert.equal(readiness.can_generate, true, 'rendering a deck from facts known to contradict would '
    + 'put the product’s name on the contradiction');
});

test('a LOW conflict is shown but does not block', () => {
  const summary = conflicts.conflictSummary([
    { severity: 'LOW', resolved_at: null }, { severity: 'MEDIUM', resolved_at: null },
  ]);
  assert.equal(summary.open, 2);
  assert.equal(summary.blocks_generation, false);
});

test('conflicts are listed worst first', async () => {
  const { ctx, org, storage } = world();
  await ingest(ctx, org, storage, 'deck.pdf', 'DECK', [...DECK_CANDIDATES]);
  await ingest(ctx, org, storage, 'accounts.pdf', 'ACCOUNTS', [...ACCOUNTS_CANDIDATES]);
  await ingest(ctx, org, storage, 'model.xlsx', 'MODEL', [...MODEL_CANDIDATES]);

  const listed = ext.listConflicts(ctx, org.id).body.conflicts;
  const ranks = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  const order = listed.map((c) => ranks[c.severity]);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.ok(listed.length >= 2);
});

test('the detection rules carry a publisher, a version and a review date', () => {
  const s = conflicts.CONFLICT_SOURCE;
  assert.equal(s.publisher, 'TekAIDA Consulting LLC');
  assert.ok(s.version && s.reviewed && s.reviewIntervalMonths);
  assert.match(s.note, /not a finding about which record is right/);

  for (const rule of conflicts.CROSS_KEY_RULES) {
    assert.ok(rule.basis, `${rule.ref} must say why two figures cannot both be true`);
    assert.ok(rule.detail && rule.ref && rule.relation);
  }
});

test('the same conflict is not stored twice across runs', async () => {
  const { db, ctx, org, storage } = world();
  await ingest(ctx, org, storage, 'deck.pdf', 'DECK', [DECK_CANDIDATES[0]]);
  await ingest(ctx, org, storage, 'accounts.pdf', 'ACCOUNTS', [ACCOUNTS_CANDIDATES[0]]);
  const first = db.count('conflict', { org_id: org.id });

  await ingest(ctx, org, storage, 'model.xlsx', 'MODEL', [...MODEL_CANDIDATES]);
  const seen = new Set(db.find('conflict', { org_id: org.id })
    .map((c) => [c.left_ref, c.right_ref].sort().join('|')));

  assert.equal(seen.size, db.count('conflict', { org_id: org.id }), 'no duplicate pairs');
  assert.ok(db.count('conflict', { org_id: org.id }) >= first);
});
