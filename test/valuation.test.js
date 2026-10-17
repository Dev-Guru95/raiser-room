/**
 * Valuation readiness.
 *
 * Nearly every test here asserts an ABSENCE. That is unusual and it is the
 * point: the risk in this feature is not that it computes something wrongly, it
 * is that it quietly starts expressing a view — a score, a range, a "typical"
 * multiple, a sentence about what buyers look for — and in doing so makes the
 * advisor's standing refusal into a lie.
 *
 * So: no estimate, no overall score, no figure that was not supplied, no claim
 * about what any third party will do, and no vendor named anywhere.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, ctxFor, expectRefusal, fakeStorage } from './helpers.js';
import * as svc from '../src/api/service.js';
import * as api from '../src/api/valuation.js';
import * as artifacts from '../src/api/artifacts.js';
import * as advisorApi from '../src/api/advisor.js';
import {
  EVIDENCE_AREAS, AREA_KEYS, VALUATION_KINDS, WHY_THEY_DIFFER, NEXT_STEPS,
  valuationReadiness, areaReadiness, applyAssumption, checkAssumption, MAX_MULTIPLE,
} from '../src/domain/valuation.js';

function world() {
  const db = freshDb();
  const ctx = ctxFor(db, 'u-owner');
  const storage = fakeStorage();
  const org = svc.createOrganisation(ctx, { name: 'Northwind Systems', path: 'RAISE' }).body.organisation;
  return { db, ctx, org, storage };
}

function confirmedDoc(ctx, org, storage) {
  const d = svc.createUploadTicket(ctx, org.id, {
    filename: 'accounts.pdf', size_bytes: 1_000, mime_type: 'application/pdf', kind: 'ACCOUNTS',
  }, storage).body.document;
  svc.confirmUpload(ctx, org.id, d.id);
  return d.id;
}

const confirm = (ctx, org, docId, key, label, value, unit = 'USD') =>
  svc.createFact(ctx, org.id, {
    fact_key: key, label, value_numeric: value, unit,
    source: 'USER_CONFIRMED', source_doc_id: docId, source_page: 4,
  }).body.fact;

// ───────────────────────────────── what this feature must never produce ──

test('the pack contains no estimate of what the company is worth', () => {
  const { ctx, org, storage } = world();
  const doc = confirmedDoc(ctx, org, storage);
  confirm(ctx, org, doc, 'financials.reported_profit', 'Reported profit', 420_000);
  confirm(ctx, org, doc, 'financials.normalised_earnings', 'Normalised earnings', 488_000);

  const body = api.readinessPack(ctx, org.id).body;

  // Structural, not a search for suspicious words: the copy uses "worth" and
  // "estimate" precisely in order to say there isn't one, and a grep would fail
  // on the sentence making the promise. The real risk is a FIGURE presented as a
  // value, so that is what is asserted — no number anywhere in the response
  // except the counts the areas carry.
  const numbers = [];
  (function walk(node, path) {
    if (typeof node === 'number') numbers.push(path);
    else if (Array.isArray(node)) node.forEach((v, i) => walk(v, `${path}[${i}]`));
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
    }
  }(body, ''));

  const allowed = /(grouped_count|document_backed)$/;
  const unexpected = numbers.filter((p) => !allowed.test(p));
  assert.deepEqual(unexpected, [],
    `the pack carries figures it should not: ${unexpected.join(', ')}`);
  assert.match(body.no_estimate, /contains no estimate/);
});

test('the pack carries no overall score, grade or percentage', () => {
  // A single number summarising how ready a company is to be valued would be
  // read as a view about the valuation itself.
  const { ctx, org } = world();
  const body = api.readinessPack(ctx, org.id).body;

  assert.ok(!('score' in body));
  assert.ok(!('grade' in body));
  assert.ok(!('percentage' in body));
  assert.ok(!('readiness_score' in body));
  for (const area of body.areas) {
    assert.ok(!('score' in area), `${area.key} carries a score`);
    assert.ok(['EVIDENCED', 'PARTIAL', 'NOT_STARTED'].includes(area.state));
  }
});

test('nothing in the feature contains a figure about the world', () => {
  // No typical multiple, no range, no discount, no benchmark. Every numeral in
  // the static copy would have to be a measurement of something, and nothing
  // here is measured.
  const copy = JSON.stringify({ EVIDENCE_AREAS, VALUATION_KINDS, WHY_THEY_DIFFER, NEXT_STEPS });
  const numerals = copy.match(/\d[\d.,]*\s*(%|x|×|times)/gi) ?? [];
  assert.deepEqual(numerals, [], `the copy contains measurements: ${numerals.join(', ')}`);
});

test('no vendor, product or firm is named anywhere in the feature', () => {
  // The product names none anywhere, and this is the feature where naming one
  // would matter most — a recommendation from software sold by a party
  // connected to a firm that advises on transactions is worth less than none.
  const copy = JSON.stringify({ EVIDENCE_AREAS, VALUATION_KINDS, WHY_THEY_DIFFER, NEXT_STEPS });
  for (const name of ['Pulley', 'Carta', 'Burkland', 'Eqvista', 'Equidam', 'Post Oak', 'TekAIDA']) {
    assert.ok(!copy.includes(name), `the feature names "${name}"`);
  }
});

test('the feature makes no claim about what a valuer or buyer will conclude', () => {
  // The knowledge corpus forbids speaking for counterparties the product has not
  // met, and that rule is not suspended because the subject is valuation.
  const copy = JSON.stringify({ EVIDENCE_AREAS, WHY_THEY_DIFFER }).toLowerCase();
  for (const phrase of ['investors expect', 'buyers look for', 'valuers require',
    'investors require', 'will increase your valuation', 'will reduce your valuation']) {
    assert.ok(!copy.includes(phrase), `the feature claims "${phrase}"`);
  }
});

test('no tax or regulatory rule is stated', () => {
  // Jurisdiction-specific and changing. A summary that is subtly out of date is
  // worse than none: a founder relies on it and then has a tax problem.
  const copy = JSON.stringify({ VALUATION_KINDS, NEXT_STEPS, WHY_THEY_DIFFER }).toLowerCase();
  for (const phrase of ['every 12 months', 'safe harbor', 'safe harbour', '20% penalty',
    'you must obtain', 'irs requires', 'required by law']) {
    assert.ok(!copy.includes(phrase), `the feature states a rule: "${phrase}"`);
  }
  // And it says plainly that it will not.
  assert.ok(NEXT_STEPS.some((s) => /does not give tax or legal advice/.test(s.detail)));
});

test('the advisor still refuses to value a company', () => {
  // The sentence this whole feature is built around not contradicting.
  const { ctx, org } = world();
  const thread = advisorApi.createThread(ctx, org.id, { title: 'Valuation' }).body.thread;
  void thread;
  const screened = advisorApi.explainRetrieval(ctx, org.id, 'what is my company worth?').body;
  assert.ok(screened.refused || screened.refusal || screened.records?.length === 0,
    'the advisor engaged with a valuation question');
});

// ──────────────────────────────────────────────── the pack, from real records ──

test('each area reports what is present and what is missing', () => {
  const { ctx, org, storage } = world();
  const doc = confirmedDoc(ctx, org, storage);
  confirm(ctx, org, doc, 'financials.reported_profit', 'Reported profit', 420_000);
  confirm(ctx, org, doc, 'financials.normalised_earnings', 'Normalised earnings', 488_000);

  const body = api.readinessPack(ctx, org.id).body;
  const earnings = body.areas.find((a) => a.key === 'NORMALISED_EARNINGS');

  assert.equal(earnings.state, 'EVIDENCED');
  assert.deepEqual(earnings.missing_required, []);
  assert.ok(earnings.present.includes('financials.reported_profit'));
  assert.ok(body.not_started.includes('TRANSFERABILITY'));
});

test('an area with half its evidence is PARTIAL, not EVIDENCED', () => {
  const { ctx, org, storage } = world();
  const doc = confirmedDoc(ctx, org, storage);
  confirm(ctx, org, doc, 'financials.reported_profit', 'Reported profit', 420_000);

  const earnings = api.readinessPack(ctx, org.id).body.areas
    .find((a) => a.key === 'NORMALISED_EARNINGS');
  assert.equal(earnings.state, 'PARTIAL');
  assert.deepEqual(earnings.missing_required, ['financials.normalised_earnings']);
});

test('evidence that came from a document is counted separately from evidence that was typed', () => {
  // A figure somebody typed is worth less here than the same figure confirmed
  // from the accounts, and saying so is the product's whole argument.
  const { ctx, org, storage } = world();
  const doc = confirmedDoc(ctx, org, storage);
  confirm(ctx, org, doc, 'financials.reported_profit', 'Reported profit', 420_000);
  svc.createFact(ctx, org.id, {
    fact_key: 'financials.normalised_earnings', label: 'Normalised earnings',
    value_numeric: 488_000, unit: 'USD', source: 'USER_ENTERED',
  });

  const earnings = api.readinessPack(ctx, org.id).body.areas
    .find((a) => a.key === 'NORMALISED_EARNINGS');
  assert.equal(earnings.present.length, 2);
  assert.equal(earnings.document_backed, 1);
});

test('an unconfirmed extraction does not count as evidence', () => {
  const { ctx, org, storage } = world();
  const doc = confirmedDoc(ctx, org, storage);
  svc.createFact(ctx, org.id, {
    fact_key: 'financials.reported_profit', label: 'Reported profit', value_numeric: 420_000,
    unit: 'USD', source: 'DOCUMENT_EXTRACTED', source_doc_id: doc, source_page: 9,
  });

  const earnings = api.readinessPack(ctx, org.id).body.areas
    .find((a) => a.key === 'NORMALISED_EARNINGS');
  assert.equal(earnings.state, 'NOT_STARTED');
});

test('every area states a test two people could agree on', () => {
  // The same bar the gap register's done-when uses.
  for (const area of EVIDENCE_AREAS) {
    assert.ok(area.reproducible_when.length > 40, `${area.key} has no usable test`);
    assert.ok(area.demonstrates.length > 40);
    assert.ok(area.usual_weakness.length > 20);
  }
  assert.equal(AREA_KEYS.length, 5);
});

test('an unknown area is a 404 that names the ones that exist', () => {
  const { ctx, org } = world();
  const err = expectRefusal(() => api.area(ctx, org.id, 'VIBES'), 'unknown_area', 404);
  assert.deepEqual(err.known, AREA_KEYS);
});

test('every area has at least one required fact, so it can actually be evidenced', () => {
  // An area with nothing required would be vacuously evidenced by an empty file,
  // or could never be evidenced at all. Both are worse than naming the one
  // figure that demonstrates it.
  for (const area of EVIDENCE_AREAS) {
    assert.ok(area.requires.length >= 1, `${area.key} has nothing required`);
    assert.equal(areaReadiness(area, []).state, 'NOT_STARTED');
  }
});

// ───────────────────────────────────────────── the own-assumption calculator ──

test('the user supplies the multiple; the product multiplies', () => {
  const { ctx, org, storage } = world();
  const doc = confirmedDoc(ctx, org, storage);
  confirm(ctx, org, doc, 'financials.normalised_earnings', 'Normalised earnings', 488_000);

  const res = api.calculateOnAssumption(ctx, org.id, {
    base_fact_key: 'financials.normalised_earnings', multiple: 4,
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.value_numeric, 1_952_000);
  assert.equal(res.body.fact.source, 'CALCULATED');
  assert.equal(res.body.fact.formula, 'financials.normalised_earnings × 4');
  assert.equal(JSON.parse(res.body.fact.input_fact_ids).length, 1);
});

test('the result is labelled as an assumption, with the multiple in the name', () => {
  // A figure labelled "Valuation" in somebody's data room, produced by software,
  // is the thing this whole design exists to avoid.
  const { ctx, org, storage } = world();
  const doc = confirmedDoc(ctx, org, storage);
  confirm(ctx, org, doc, 'financials.normalised_earnings', 'Normalised earnings', 488_000);

  const res = api.calculateOnAssumption(ctx, org.id, {
    base_fact_key: 'financials.normalised_earnings', multiple: 4,
  });

  assert.match(res.body.fact.label, /your assumption/);
  assert.match(res.body.fact.label, /4×/);
  assert.ok(!/valuation/i.test(res.body.fact.label), 'the result is labelled a valuation');
  assert.match(res.body.disclosure, /not a valuation/);
  assert.match(res.body.disclosure, /which you supplied/);
});

test('the result is filed under assumptions, never beside the audited figures', () => {
  // A figure filed next to the accounts will eventually be read as one of them.
  const { ctx, org, storage } = world();
  const doc = confirmedDoc(ctx, org, storage);
  confirm(ctx, org, doc, 'financials.normalised_earnings', 'Normalised earnings', 488_000);

  const res = api.calculateOnAssumption(ctx, org.id, {
    base_fact_key: 'financials.normalised_earnings', multiple: 4,
  });
  assert.ok(res.body.fact.fact_key.startsWith('assumption.'),
    `filed as ${res.body.fact.fact_key}`);
  assert.ok(!res.body.fact.fact_key.startsWith('financials.'));
});

test('the product suggests no multiple of its own', () => {
  const { ctx, org, storage } = world();
  const doc = confirmedDoc(ctx, org, storage);
  confirm(ctx, org, doc, 'financials.normalised_earnings', 'Normalised earnings', 488_000);

  const bases = api.assumptionBases(ctx, org.id).body;
  const serialised = JSON.stringify(bases);
  assert.ok(!/suggested|recommended|typical|default_multiple/i.test(serialised),
    'the product suggested a multiple');
  assert.match(bases.note, /no view on it/);
});

test('a multiple cannot be applied to an unconfirmed figure', () => {
  // A calculation built on an unconfirmed figure inherits the doubt.
  const { ctx, org, storage } = world();
  const doc = confirmedDoc(ctx, org, storage);
  svc.createFact(ctx, org.id, {
    fact_key: 'financials.normalised_earnings', label: 'Normalised earnings',
    value_numeric: 488_000, unit: 'USD', source: 'DOCUMENT_EXTRACTED',
    source_doc_id: doc, source_page: 9,
  });

  const err = expectRefusal(() => api.calculateOnAssumption(ctx, org.id, {
    base_fact_key: 'financials.normalised_earnings', multiple: 4,
  }), 'assumption_rejected', 400);
  assert.equal(err.problems[0].code, 'base_not_confirmed');
});

test('every way an assumption can be malformed is refused by name', () => {
  const base = { id: 'f1', fact_key: 'x', label: 'X', value_numeric: 100, unit: 'USD', source: 'USER_CONFIRMED' };
  assert.equal(checkAssumption({ multiple: null, base })[0].code, 'multiple_required');
  assert.equal(checkAssumption({ multiple: 0, base })[0].code, 'multiple_not_positive');
  assert.equal(checkAssumption({ multiple: -4, base })[0].code, 'multiple_not_positive');
  assert.equal(checkAssumption({ multiple: MAX_MULTIPLE + 1, base })[0].code, 'multiple_implausible');
  assert.equal(checkAssumption({ multiple: 4, base: null })[0].code, 'no_base_figure');
  assert.equal(checkAssumption({ multiple: 4, base: { ...base, value_numeric: null } })[0].code,
    'base_not_numeric');
  assert.deepEqual(checkAssumption({ multiple: 4, base }), []);
});

test('an implausible multiple is refused as a typo, not as a judgement', () => {
  // Not a view about whether a multiple is reasonable — a guard against a figure
  // with three extra digits reaching a document.
  const base = { id: 'f1', fact_key: 'x', label: 'X', value_numeric: 100, unit: 'USD', source: 'USER_CONFIRMED' };
  const problem = checkAssumption({ multiple: 4000, base })[0];
  assert.match(problem.problem, /typo/);
  assert.ok(!/unrealistic|too high|unreasonable/i.test(problem.problem));
});

test('a fractional multiple survives into the label without noise', () => {
  const base = { id: 'f1', fact_key: 'x', label: 'Earnings', value_numeric: 100, unit: 'USD', source: 'USER_CONFIRMED' };
  assert.match(applyAssumption({ multiple: 4.5, base }).label, /4\.5×/);
  assert.match(applyAssumption({ multiple: 4.0, base }).label, /^4×/);
});

test('previewing an assumption stores nothing', () => {
  const { ctx, org, storage, db } = world();
  const doc = confirmedDoc(ctx, org, storage);
  confirm(ctx, org, doc, 'financials.normalised_earnings', 'Normalised earnings', 488_000);
  const before = db.count('fact', { org_id: org.id });

  const res = api.previewAssumption(ctx, org.id, {
    base_fact_key: 'financials.normalised_earnings', multiple: 4,
  });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.stored, false);
  assert.equal(db.count('fact', { org_id: org.id }), before);
});

test('the calculated fact can be recomputed from what was stored', () => {
  // The whole reason it is CALCULATED rather than typed: the arithmetic is
  // auditable and can be redone by somebody else.
  const { ctx, org, storage } = world();
  const doc = confirmedDoc(ctx, org, storage);
  const base = confirm(ctx, org, doc, 'financials.normalised_earnings', 'Normalised earnings', 488_000);

  const fact = api.calculateOnAssumption(ctx, org.id, {
    base_fact_key: 'financials.normalised_earnings', multiple: 4,
  }).body.fact;

  const inputs = JSON.parse(fact.input_fact_ids);
  assert.deepEqual(inputs, [base.id]);
  const [key, times] = fact.formula.split(' × ');
  assert.equal(key, 'financials.normalised_earnings');
  assert.equal(ctx.db.get('fact', inputs[0]).value_numeric * Number(times), fact.value_numeric);
});

// ───────────────────────────────────────────────────── the generated pack ──

test('the pack generates as a document and shows what is missing', () => {
  const { ctx, org, storage } = world();
  const doc = confirmedDoc(ctx, org, storage);
  svc.createFact(ctx, org.id, {
    fact_key: 'company.name', label: 'Registered name',
    value_text: 'Northwind Systems Inc.', source: 'USER_ENTERED',
  });
  confirm(ctx, org, doc, 'financials.reported_profit', 'Reported profit', 420_000);
  confirm(ctx, org, doc, 'financials.normalised_earnings', 'Normalised earnings', 488_000);

  const res = artifacts.generate(ctx, org.id, 'VALUATION_READINESS');
  assert.equal(res.status, 201);
  const html = res.body.html;
  assert.ok(html.includes('What a valuer will ask you to evidence'));
  assert.ok(html.includes('Not started'), 'the document hides what is missing');
  assert.ok(html.includes('contains no estimate'));
});

test('the generated pack contains no estimate either', () => {
  const { ctx, org, storage } = world();
  const doc = confirmedDoc(ctx, org, storage);
  svc.createFact(ctx, org.id, {
    fact_key: 'company.name', label: 'Registered name',
    value_text: 'Northwind Systems Inc.', source: 'USER_ENTERED',
  });
  confirm(ctx, org, doc, 'financials.normalised_earnings', 'Normalised earnings', 488_000);

  const res = artifacts.generate(ctx, org.id, 'VALUATION_READINESS').body;
  // The document rests only on facts the company confirmed. Anything else would
  // be a figure the product originated, and the binder is what proves it did
  // not: every number on the page is a reference it recorded.
  for (const id of res.fact_refs) {
    const fact = ctx.db.get('fact', id);
    assert.ok(['USER_CONFIRMED', 'USER_ENTERED', 'CALCULATED'].includes(fact.source),
      `the pack rests on a ${fact.source} fact`);
  }
  assert.ok(res.html.includes('contains no estimate'));
  assert.ok(!/estimated (value|valuation)/i.test(res.html));
});

// ──────────────────────────────────────────────────────────── access control ──

test('a non-member gets 404 from every valuation call', () => {
  const { org, db } = world();
  const stranger = ctxFor(db, 'u-stranger');
  for (const call of [
    () => api.readinessPack(stranger, org.id),
    () => api.area(stranger, org.id, 'CONCENTRATION'),
    () => api.assumptionBases(stranger, org.id),
    () => api.previewAssumption(stranger, org.id, { base_fact_key: 'x', multiple: 4 }),
    () => api.calculateOnAssumption(stranger, org.id, { base_fact_key: 'x', multiple: 4 }),
  ]) {
    expectRefusal(call, 'not_found', 404);
  }
});

test('a viewer can read the pack but cannot store an assumption', () => {
  const { ctx, org, db, storage } = world();
  const doc = confirmedDoc(ctx, org, storage);
  confirm(ctx, org, doc, 'financials.normalised_earnings', 'Normalised earnings', 488_000);
  db.insert('membership', {
    org_id: org.id, user_id: 'u-viewer', email: 'v@example.com', role: 'VIEWER', created_at: ctx.now(),
  });
  const viewer = ctxFor(db, 'u-viewer');

  assert.equal(api.readinessPack(viewer, org.id).status, 200);
  expectRefusal(() => api.calculateOnAssumption(viewer, org.id, {
    base_fact_key: 'financials.normalised_earnings', multiple: 4,
  }), 'forbidden', 403);
});
