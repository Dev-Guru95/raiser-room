/**
 * The compliance core: §3.1 — the AI never originates a number — plus fact
 * immutability and provenance.
 *
 * These are the tests that make the product's central claim true rather than
 * merely asserted on a marketing page.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, ctxFor, expectRefusal } from './helpers.js';
import * as svc from '../src/api/service.js';
import { FACT_SOURCES, buildFact } from '../src/domain/facts.js';
import * as facts from '../src/domain/facts.js';

function orgWithOwner() {
  const db = freshDb();
  const ctx = ctxFor(db, 'u-owner');
  const org = svc.createOrganisation(ctx, { name: 'Test Co' }).body.organisation;
  return { db, ctx, org };
}

test('there is no AI_GENERATED source, and there must never be one', () => {
  assert.equal(FACT_SOURCES.includes('AI_GENERATED'), false);
  assert.deepEqual([...FACT_SOURCES].sort(),
    ['CALCULATED', 'DOCUMENT_EXTRACTED', 'USER_CONFIRMED', 'USER_ENTERED']);
  assert.ok(Object.isFrozen(FACT_SOURCES), 'the enum cannot be extended at runtime');
});

test('a fact with an unrecognised source is refused', () => {
  const { ctx, org } = orgWithOwner();
  for (const source of ['AI_GENERATED', 'AI_ESTIMATED', 'GENERATED', '', undefined, 'user_entered']) {
    expectRefusal(
      () => svc.createFact(ctx, org.id, { fact_key: 'arr', label: 'ARR', value_numeric: 1, source }),
      'invalid_source', 400,
    );
  }
});

test('a fact must carry a value', () => {
  const { ctx, org } = orgWithOwner();
  expectRefusal(
    () => svc.createFact(ctx, org.id, { fact_key: 'arr', label: 'ARR', source: 'USER_ENTERED' }),
    'missing_value', 400,
  );
});

test('CALCULATED facts must carry a formula and their inputs', () => {
  const { ctx, org } = orgWithOwner();
  const base = { fact_key: 'margin', label: 'Gross margin', value_numeric: 0.7, source: 'CALCULATED' };

  expectRefusal(() => svc.createFact(ctx, org.id, base), 'calculated_needs_provenance', 400);
  expectRefusal(() => svc.createFact(ctx, org.id, { ...base, formula: 'gp / rev' }), 'calculated_needs_provenance', 400);
  expectRefusal(() => svc.createFact(ctx, org.id, { ...base, input_fact_ids: ['f1'] }), 'calculated_needs_provenance', 400);

  const ok = svc.createFact(ctx, org.id, { ...base, formula: 'gp / rev', input_fact_ids: ['f1', 'f2'] });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.fact.formula, 'gp / rev');
  assert.deepEqual(JSON.parse(ok.body.fact.input_fact_ids), ['f1', 'f2']);
});

test('confirmation is stamped by the server, never accepted from the caller', () => {
  const { ctx, org } = orgWithOwner();
  const f = svc.createFact(ctx, org.id, {
    fact_key: 'headcount', label: 'Headcount', value_numeric: 14, source: 'USER_CONFIRMED',
    source_doc_id: 'doc-1', source_page: 2,
    confirmed_by: 'somebody-else', confirmed_at: '1999-01-01T00:00:00.000Z',
  }).body.fact;

  assert.equal(f.confirmed_by, 'u-owner', 'the caller cannot claim someone else confirmed it');
  assert.notEqual(f.confirmed_at, '1999-01-01T00:00:00.000Z');
});

test('REGRESSION: confirming a figure does not sever the link to its document', () => {
  const { ctx, org } = orgWithOwner();
  const f = svc.createFact(ctx, org.id, {
    fact_key: 'arr', label: 'ARR', value_numeric: 4_200_000,
    source: 'USER_CONFIRMED', source_doc_id: 'accounts-2025', source_page: 11,
  }).body.fact;

  // source_doc_id used to be kept only for DOCUMENT_EXTRACTED, so the moment a
  // human confirmed a figure the provenance was nulled — on the very row that
  // then gets relied on.
  assert.equal(f.source_doc_id, 'accounts-2025');
  assert.equal(f.source_page, 11);
});

test('REGRESSION: a hand-typed figure cannot claim a page it did not come from', () => {
  const { ctx, org } = orgWithOwner();
  const f = svc.createFact(ctx, org.id, {
    fact_key: 'headcount', label: 'Headcount', value_numeric: 14,
    source: 'USER_ENTERED', source_doc_id: 'deck-v4', source_page: 7,
  }).body.fact;

  assert.equal(f.source_doc_id, null);
  assert.equal(f.source_page, null, 'a page number with no document behind it is a false citation');
});

test('a confirmation with no document behind it is refused', () => {
  const { ctx, org } = orgWithOwner();
  expectRefusal(() => svc.createFact(ctx, org.id, {
    fact_key: 'arr', label: 'ARR', value_numeric: 1, source: 'USER_CONFIRMED',
  }), 'document_required', 400);
});

test('only confirmed, entered and calculated facts may be relied on', () => {
  assert.deepEqual([...facts.USABLE_SOURCES].sort(),
    ['CALCULATED', 'USER_CONFIRMED', 'USER_ENTERED']);
  assert.equal(facts.USABLE_SOURCES.includes('DOCUMENT_EXTRACTED'), false,
    'an unconfirmed extraction is a proposal, not a fact');

  assert.equal(facts.isUsable({ source: 'USER_CONFIRMED', superseded_by: null }), true);
  assert.equal(facts.isUsable({ source: 'DOCUMENT_EXTRACTED', superseded_by: null }), false);
  assert.equal(facts.isUsable({ source: 'USER_ENTERED', superseded_by: 'f-9' }), false,
    'a superseded fact is not current');

  assert.deepEqual(
    facts.usableFacts([
      { id: 'a', source: 'USER_ENTERED', superseded_by: null },
      { id: 'b', source: 'DOCUMENT_EXTRACTED', superseded_by: null },
      { id: 'c', source: 'CALCULATED', superseded_by: null },
    ]).map((f) => f.id),
    ['a', 'c'],
  );
});

test('an extracted fact is not confirmed until a human confirms it', () => {
  const { ctx, org } = orgWithOwner();
  const f = svc.createFact(ctx, org.id, {
    fact_key: 'arr', label: 'ARR', value_numeric: 4_200_000, source: 'DOCUMENT_EXTRACTED',
    source_doc_id: 'doc-1', source_page: 7,
  }).body.fact;

  assert.equal(f.confirmed_at, null);
  assert.equal(f.source_doc_id, 'doc-1');
  assert.equal(f.source_page, 7, 'provenance points at the page it came from');
});

test('facts are immutable — a correction writes a new row and links the old one', () => {
  const { db, ctx, org } = orgWithOwner();
  const first = svc.createFact(ctx, org.id,
    { fact_key: 'arr', label: 'ARR', value_numeric: 4_200_000, source: 'USER_ENTERED' }).body.fact;

  const second = svc.supersedeFact(ctx, org.id, first.id,
    { value_numeric: 3_800_000, source: 'USER_ENTERED' }).body.fact;

  assert.notEqual(second.id, first.id);
  assert.equal(db.get('fact', first.id).value_numeric, 4_200_000, 'the original value is untouched');
  assert.equal(db.get('fact', first.id).superseded_by, second.id);
  assert.equal(db.count('fact', { org_id: org.id }), 2, 'history is preserved');

  const listed = svc.listFacts(ctx, org.id).body;
  assert.equal(listed.facts.length, 1, 'only the current value is current');
  assert.equal(listed.facts[0].value_numeric, 3_800_000);
  assert.equal(listed.superseded.length, 1);
});

test('a fact cannot be superseded twice', () => {
  const { ctx, org } = orgWithOwner();
  const first = svc.createFact(ctx, org.id,
    { fact_key: 'arr', label: 'ARR', value_numeric: 1, source: 'USER_ENTERED' }).body.fact;
  svc.supersedeFact(ctx, org.id, first.id, { value_numeric: 2, source: 'USER_ENTERED' });
  expectRefusal(() => svc.supersedeFact(ctx, org.id, first.id, { value_numeric: 3, source: 'USER_ENTERED' }),
    'already_superseded', 409);
});

test('REGRESSION: superseding a CALCULATED fact does not carry its formula forward', () => {
  // The first implementation initialised `formula` from the previous row and
  // only reassigned it inside the CALCULATED branch. Correcting a calculated
  // figure with a hand-entered one therefore left a stale formula attached to
  // a number that was never calculated — provenance that lies.
  const { ctx, org } = orgWithOwner();

  const calc = svc.createFact(ctx, org.id, {
    fact_key: 'margin', label: 'Gross margin', value_numeric: 0.7, source: 'CALCULATED',
    formula: 'gross_profit / revenue', input_fact_ids: ['f1', 'f2'],
  }).body.fact;
  assert.equal(calc.formula, 'gross_profit / revenue');

  const corrected = svc.supersedeFact(ctx, org.id, calc.id, {
    value_numeric: 0.64, source: 'USER_ENTERED',
  }).body.fact;

  assert.equal(corrected.source, 'USER_ENTERED');
  assert.equal(corrected.formula, null, 'a hand-entered figure must not claim a formula');
  assert.equal(corrected.input_fact_ids, null, 'nor inputs it was never derived from');
});

test('REGRESSION: an extracted fact corrected by hand drops its document provenance', () => {
  const { ctx, org } = orgWithOwner();
  const extracted = svc.createFact(ctx, org.id, {
    fact_key: 'arr', label: 'ARR', value_numeric: 4_200_000,
    source: 'DOCUMENT_EXTRACTED', source_doc_id: 'deck-v4', source_page: 3,
  }).body.fact;
  assert.equal(extracted.source_doc_id, 'deck-v4');

  const corrected = svc.supersedeFact(ctx, org.id, extracted.id,
    { value_numeric: 3_800_000, source: 'USER_ENTERED' }).body.fact;

  assert.equal(corrected.source_doc_id, null,
    'a typed correction must not claim it came from a document');
});

test('values and units are validated', () => {
  const { ctx, org } = orgWithOwner();
  expectRefusal(() => svc.createFact(ctx, org.id,
    { fact_key: 'arr', label: 'ARR', value_numeric: 'not-a-number', source: 'USER_ENTERED' }), 'bad_number', 400);

  const f = svc.createFact(ctx, org.id,
    { fact_key: 'arr', label: 'ARR', value_numeric: 1, unit: 'FURLONGS', source: 'USER_ENTERED' }).body.fact;
  assert.equal(f.unit, null, 'an unrecognised unit is dropped rather than stored');
});

test('buildFact is pure — it never mutates its input', () => {
  const input = Object.freeze({ fact_key: 'a', label: 'A', value_numeric: 1, source: 'USER_ENTERED' });
  assert.doesNotThrow(() => buildFact(input));
});
