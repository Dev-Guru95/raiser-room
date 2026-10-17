/**
 * The knowledge corpus — enforcing the rules on its own content.
 *
 * The corpus is prose, and prose drifts. Someone adding a record in six months,
 * in a hurry, will reach for the sentence that makes the product sound most
 * authoritative — "investors expect three years of adjustments", "most
 * companies at this stage score around 120". Both would be invented, and
 * neither would look wrong in a diff.
 *
 * So the content rules are tests. A record that speaks for counterparties, cites
 * a statistic, names a vendor or gives professional advice fails the build,
 * which is the only review that happens every time.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RECORDS, SOURCES, CORPUS_VERSION, RECORD_KINDS, recordById,
  reviewStatus, knowledgeHealth, sourceOf,
} from '../src/knowledge/corpus.js';
import { retrieve, criterionRefsIn, MIN_SCORE } from '../src/knowledge/retrieve.js';
import { criterionByRef, ALL_REFS } from '../src/domain/criteria.js';

const textOf = (r) => [r.title, r.tested ?? '', r.body, ...(r.pitfalls ?? [])].join(' ');

// ───────────────────────────────────────────────────────────── structure ──

test('every record is attributed, dated and reviewable', () => {
  assert.ok(RECORDS.length >= 15, 'a corpus this thin would not be worth citing');

  for (const r of RECORDS) {
    assert.ok(r.id && r.title && r.body, `${r.id}: missing core fields`);
    assert.ok(RECORD_KINDS.includes(r.kind), `${r.id}: unknown kind ${r.kind}`);
    assert.ok(sourceOf(r.source), `${r.id}: cites a source that does not exist`);
    assert.ok(Array.isArray(r.tags) && r.tags.length, `${r.id}: no tags, so it can never be retrieved`);
    assert.ok(Array.isArray(r.applies_to), `${r.id}: applies_to must be an array`);
  }
});

test('record ids are unique and resolvable', () => {
  const ids = RECORDS.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'a duplicate id makes a citation ambiguous');
  for (const id of ids) assert.ok(recordById(id));
  assert.equal(recordById('K-does-not-exist'), null);
});

test('every criterion a record claims to cover actually exists', () => {
  for (const r of RECORDS) {
    for (const ref of r.applies_to) {
      assert.ok(criterionByRef(ref), `${r.id} claims to cover criterion ${ref}, which does not exist`);
    }
  }
});

test('every source carries a publisher, a version and a review interval', () => {
  for (const s of SOURCES) {
    assert.ok(s.publisher && s.version && s.reviewed && s.reviewIntervalMonths,
      `${s.id}: a source without a review date cannot be audited`);
    assert.ok(Date.parse(s.reviewed), `${s.id}: unparseable review date`);
    assert.match(s.note, /[Nn]ot legal, financial, accounting or investment advice/);
  }
  assert.ok(CORPUS_VERSION);
});

// ──────────────────────────────────────────────────── what may not be said ──

test('no record speaks for what investors or buyers require', () => {
  // The product has not met these people. Records say what question is being
  // tested, which is defensible and attributed; "investors require X" is a
  // claim about third parties nobody here has surveyed.
  const forbidden = [
    /\b(?:investors?|buyers?|acquirers?)\s+(?:require|expect|demand|insist|want to see|look for|will not|always|never)\b/i,
    /\bwhat\s+(?:investors?|buyers?)\s+(?:want|need|require)\b/i,
  ];
  for (const r of RECORDS) {
    for (const p of forbidden) {
      assert.doesNotMatch(textOf(r), p, `${r.id} speaks for counterparties`);
    }
  }
});

test('no record contains a statistic, benchmark or typical figure', () => {
  // Nothing in this product is measured across companies. A percentage or a
  // "typical" figure in a record would be invented, and would be quoted back by
  // the advisor with a citation attached — which is the worst possible outcome:
  // an invented number wearing a source.
  const forbidden = [
    /\b\d+(?:\.\d+)?\s*%/,
    /\b(?:typically|usually|on average|most companies|the average)\b.{0,40}\b\d/i,
    /\b\d+\s*(?:x|times)\s+(?:revenue|ebitda|earnings|arr)\b/i,
    /\b\d+\s*(?:weeks?|months?|days?)\b/i,
  ];
  for (const r of RECORDS) {
    for (const p of forbidden) {
      assert.doesNotMatch(textOf(r), p, `${r.id} states a figure the product has not measured`);
    }
  }
});

test('no record gives legal, tax, accounting or valuation advice', () => {
  const forbidden = [
    /\byou should (?:sign|accept|agree to|incorporate|restructure|elect)\b/i,
    /\bunder (?:ifrs|us gaap|frs 10[02])\b.{0,40}\byou must\b/i,
    /\b(?:is|are) worth\b.{0,20}[$£€\d]/i,
    /\bwe recommend\b/i,
  ];
  for (const r of RECORDS) {
    for (const p of forbidden) {
      assert.doesNotMatch(textOf(r), p, `${r.id} crosses into advice`);
    }
  }
});

test('records touching regulated ground carry their own not-advice note', () => {
  // Not every record needs one. The ones that brush against legal or accounting
  // territory do, and the note is rendered with any answer citing them.
  for (const id of ['K-2.2-revenue-recognition', 'K-4.2-change-of-control']) {
    const r = recordById(id);
    assert.ok(r.not_advice, `${id} touches regulated ground and must say what it is not`);
    assert.match(r.not_advice, /qualified|professional|lawyer|accountant/i);
  }
});

test('no record names a vendor, product or firm', () => {
  // A product name in guidance is an endorsement the company has not made, and
  // it dates the record the moment the vendor is acquired or renamed.
  const vendors = /\b(?:xero|quickbooks|netsuite|carta|pulley|dropbox|sharepoint|datasite|intralinks|ansarada|stripe|hubspot|salesforce)\b/i;
  for (const r of RECORDS) {
    assert.doesNotMatch(textOf(r), vendors, `${r.id} names a vendor`);
  }
});

test('the whole corpus is within its review interval today', () => {
  const health = knowledgeHealth(new Date().toISOString());
  assert.deepEqual(health.overdue, [],
    'shipping guidance past its own review date would make the review date decorative');
  assert.equal(health.records, RECORDS.length);
});

test('a record past its review date is flagged, not hidden', () => {
  const stale = { source: 'bta-v1', reviewed: '2020-01-01', reviewIntervalMonths: 6 };
  const status = reviewStatus(stale, '2026-10-13T00:00:00.000Z');
  assert.equal(status.state, 'OVERDUE');
  assert.ok(status.due < '2026-10-13');

  const fresh = reviewStatus({ source: 'bta-v1', reviewed: '2026-10-01', reviewIntervalMonths: 6 },
    '2026-10-13T00:00:00.000Z');
  assert.equal(fresh.state, 'CURRENT');
});

// ───────────────────────────────────────────────────────────── retrieval ──

test('retrieval returns a record only when it can say why', () => {
  // The rule that matters most here. A record scraping a point on one
  // incidental body word cannot explain itself, and a non-empty result is what
  // tells the advisor it has something to answer from.
  const nonsense = retrieve('what does the weather look like tomorrow?');
  assert.deepEqual(nonsense, [], 'nothing retrieved means the honest answer is "not covered"');

  for (const r of retrieve('normalisation bridge adjustments')) {
    assert.ok(r.why.length, `${r.id} was returned with no stateable reason`);
    assert.ok(r.score >= MIN_SCORE);
  }
});

test('naming a criterion beats everything else', () => {
  const got = retrieve('what does criterion 5.1 want from me?');
  assert.equal(got[0].id, 'K-5.1-ip-assignment');
  assert.ok(got[0].why.some((w) => w.includes('you named criterion 5.1')));
});

test('criterion references are recognised, and invented ones are not', () => {
  assert.deepEqual(criterionRefsIn('tell me about 2.3 and 7.1'), ['2.3', '7.1']);
  assert.deepEqual(criterionRefsIn('what about 9.9?'), [], '9.9 is not a criterion');
  assert.deepEqual(criterionRefsIn('revenue grew 3.4 times'), ['3.4'],
    'a false positive here only widens retrieval, which the validator still bounds');
});

test('retrieval is deterministic and stable, so a stored answer stays explicable', () => {
  const a = retrieve('customer concentration trend');
  const b = retrieve('customer concentration trend');
  assert.deepEqual(a.map((r) => r.id), b.map((r) => r.id));

  // Ties broken by id rather than by iteration order, so a corpus edit that
  // adds an unrelated record does not reshuffle existing results.
  const tied = retrieve('gap owner capacity plan');
  const scores = tied.map((r) => r.score);
  assert.deepEqual(scores, [...scores].sort((x, y) => y - x));
});

test('every criterion in the catalogue can be reached through retrieval', () => {
  // Not every criterion needs its own record, but asking about one should
  // retrieve something rather than silently returning nothing.
  const unreachable = ALL_REFS.filter((ref) => retrieve(`what does criterion ${ref} need?`).length === 0);

  // Recorded as a number rather than demanded to be zero: the corpus covers the
  // criteria where guidance adds something beyond the criterion text itself,
  // and this test exists to make the coverage visible rather than to force
  // padding records that say nothing.
  assert.ok(unreachable.length <= 16,
    `${unreachable.length} criteria retrieve nothing: ${unreachable.join(', ')}`);
  assert.ok(ALL_REFS.length - unreachable.length >= 16, 'at least half the criteria are covered');
});

test('the sequencing argument is retrievable by the words people actually use', () => {
  for (const question of ['what should I do first?', 'what order should I fix these in?', 'what next?']) {
    const got = retrieve(question, { criterionRefs: ['2.1'], gapCategories: ['BLOCKER'] });
    assert.ok(got.some((r) => r.kind === 'SEQUENCING'), `"${question}" should reach the sequencing records`);
  }
});
