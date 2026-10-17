/**
 * Phase 3 — the Transfer Sheet.
 *
 * The reader is deterministic: an AcroForm field holds the characters the user
 * typed, so reading it back is lossless. What is tested here is everything that
 * decides what a value MEANS — the coercion rules, the refusal to guess, and the
 * provenance the imported facts end up with.
 *
 * `tools/transfer_sheet.py` generates the PDF and `tools/read_transfer_sheet.py`
 * pulls the field values out. Their round trip is verified separately by
 * `test/transfer-sheet-fixture.json`, which was produced by generating a sheet,
 * filling it, and reading it back.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { freshDb, ctxFor, expectRefusal } from './helpers.js';
import * as svc from '../src/api/service.js';
import * as ext from '../src/api/extraction.js';
import { redeemWorkbook } from '../src/api/onramp.js';
import * as sheet from '../src/domain/transfer-sheet.js';
import { WORKSHEET_FACT_MAP, parseTransferSheet, coerceNumber, coerceScore } from '../src/domain/transfer-sheet.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(here, 'transfer-sheet-fixture.json'), 'utf8'));

function world() {
  const db = freshDb();
  const ctx = ctxFor(db, 'u-owner');
  const org = svc.createOrganisation(ctx, { name: 'Test Co', path: 'RAISE' }).body.organisation;
  return { db, ctx, org };
}

// ─────────────────────────────────────────────── one source of truth ──

test('the onramp mapping is derived from the sheet, not written twice', () => {
  // These used to be two hand-maintained tables. A divergence would not have
  // failed — it would have filed one figure under another figure's key.
  assert.deepEqual(Object.keys(WORKSHEET_FACT_MAP).sort(),
    ['assumptions', 'concentration', 'normalisation']);

  for (const f of sheet.FACT_FIELDS) {
    const entry = WORKSHEET_FACT_MAP[f.group].find((m) => m.field === f.member);
    assert.ok(entry, `${f.field} is missing from the derived mapping`);
    assert.equal(entry.key, f.fact_key);
    assert.equal(entry.numeric, f.type === 'number');
  }
});

test('every criterion has exactly one score field, and no field name repeats', () => {
  assert.equal(sheet.SCORE_FIELDS.length, 32);
  assert.equal(new Set(sheet.ALL_FIELD_NAMES).size, sheet.ALL_FIELD_NAMES.length);
  assert.equal(sheet.SCORE_FIELD_OF('8.4'), 's_8_4');
});

// ─────────────────────────────────────────────────────── coercion ──

test('the ways people actually type numbers into a form are accepted', () => {
  assert.deepEqual(coerceNumber('$420,000'), { present: true, value: 420_000 });
  assert.deepEqual(coerceNumber('  1.2m '), { present: true, value: 1_200_000 });
  assert.deepEqual(coerceNumber('68%', { unit: 'percent' }), { present: true, value: 68 });
  assert.deepEqual(coerceNumber('£3,800,000'), { present: true, value: 3_800_000 });
  assert.deepEqual(coerceNumber('(4,000)'), { present: true, value: -4_000 },
    'accountants write negatives in brackets');
});

test('an ambiguous answer is refused rather than interpreted', () => {
  // 60-70 is not 65. Picking a midpoint would put a figure nobody wrote into
  // the fact store, wearing a label saying the user entered it.
  const range = coerceNumber('60-70');
  assert.equal(range.present, false);
  assert.match(range.problem, /looks like a range/);

  assert.equal(coerceNumber('about half').present, false);
  assert.equal(coerceNumber('3 or 4').present, false);
});

test('blank means unanswered, never zero', () => {
  for (const blank of ['', '  ', 'n/a', 'N/A', 'TBC', '-', 'none']) {
    assert.deepEqual(coerceNumber(blank), { present: false, value: null },
      `"${blank}" must not become 0 — a silent zero drags the band down for something not yet done`);
    assert.deepEqual(coerceScore(blank), { present: false, value: null });
  }
});

test('a percentage outside 0 to 100 is refused', () => {
  const r = coerceNumber('680', { unit: 'percent' });
  assert.equal(r.present, false);
  assert.match(r.problem, /outside 0–100/);
  assert.equal(coerceNumber('680', { unit: 'USD' }).present, true, 'only percentages are bounded');
});

test('scores are whole numbers from 0 to 5 and nothing else', () => {
  assert.deepEqual(coerceScore('3'), { present: true, value: 3 });
  assert.deepEqual(coerceScore('0'), { present: true, value: 0 }, 'zero is a real score');
  for (const bad of ['6', '-1', '3.5', 'three', '3-4']) {
    assert.equal(coerceScore(bad).present, false, `"${bad}" is not a score`);
  }
});

// ─────────────────────────────────────────────────────── parsing ──

test('a filled sheet parses into exactly the shape the onramp expects', () => {
  const parsed = parseTransferSheet(FIXTURE.values);
  assert.equal(parsed.version, sheet.TRANSFER_SHEET_VERSION);
  assert.deepEqual(parsed.problems, []);

  assert.equal(parsed.input.receipt_ref, 'WHOP-ABC-123');
  assert.equal(parsed.input.normalisation.reported_profit, 420_000, '"$420,000" read from the PDF');
  assert.equal(parsed.input.concentration.top_1_pct, 68, '"68%" read from the PDF');
  assert.equal(parsed.input.concentration.direction, 'INCREASING');
  assert.deepEqual(parsed.input.scores, { '1.1': 2, '1.2': 3, '2.1': 1, '8.4': 5 });
  assert.equal(parsed.input.key_people.length, 2);
});

test('an unreadable box is named, and the rest of the sheet still imports', () => {
  const parsed = parseTransferSheet({
    ...FIXTURE.values, conc_top3: '60-70', s_2_1: 'nine',
  });

  assert.equal(parsed.problems.length, 2);
  assert.deepEqual(parsed.problems.map((p) => p.field).sort(), ['conc_top3', 's_2_1']);
  assert.equal(parsed.input.concentration.top_3_pct, undefined, 'the bad box is not guessed at');
  assert.equal(parsed.input.concentration.top_1_pct, 68, 'the good boxes still come through');
  assert.equal(parsed.input.scores['2.1'], undefined);
  assert.equal(parsed.input.scores['1.1'], 2);
});

test('a key-person row with a name but nothing beside it is refused', () => {
  const parsed = parseTransferSheet({
    sheet_version: '1.0', kp1_person: 'A. Founder', kp1_holds: '',
  });
  assert.equal(parsed.input.key_people, undefined);
  assert.match(parsed.problems[0].problem, /a name on its own records nothing/);
});

test('an unversioned or older sheet is identified, never silently guessed at', () => {
  const none = parseTransferSheet({ s_1_1: '3' });
  assert.equal(none.version, null);
  assert.match(none.problems[0].problem, /does not identify itself/);
  assert.equal(none.problems[0].severity, 'WARNING');
  assert.equal(none.input.scores['1.1'], 3, 'a warning does not discard what could be read');

  const old = parseTransferSheet({ sheet_version: '0.9', s_1_1: '3' });
  assert.match(old.problems[0].problem, /edition 0\.9/);
});

test('an unknown field name is ignored rather than mapped to a near match', () => {
  const parsed = parseTransferSheet({
    sheet_version: '1.0', conc_top_1: '68', revenue: '4200000', s_1_1: '4',
  });
  assert.equal(parsed.input.concentration, undefined,
    'conc_top_1 is not conc_top1, and a reader that guesses puts revenue in the headcount column');
  assert.equal(parsed.filled, 1);
});

// ──────────────────────────────────────────────────── the import ──

test('imported figures are USER_ENTERED — the user typed them, nothing was parsed', () => {
  const { db, ctx, org } = world();
  ext.importTransferSheet(ctx, org.id, FIXTURE.values, { redeem: redeemWorkbook });

  const facts = db.find('fact', { org_id: org.id });
  assert.ok(facts.length > 0);
  assert.ok(facts.every((f) => f.source === 'USER_ENTERED'),
    'reading an AcroForm field is transcription, not extraction');
  assert.ok(facts.every((f) => f.source_doc_id === null && f.confirmed_at === null),
    'nothing was read from a document, so nothing claims to have been');
});

test('the sheet and the hand-typed onramp follow one code path', () => {
  const { db, ctx, org } = world();
  const { body } = ext.importTransferSheet(ctx, org.id, FIXTURE.values, { redeem: redeemWorkbook });

  assert.equal(body.redemption.credit.minor, 14_700);
  assert.match(body.redemption.credit_label, /Credit for Before They Ask/);
  assert.equal(db.count('workbook_redemption', { org_id: org.id }), 1);
  assert.equal(body.sheet.fields_read, 17);
  assert.equal(body.sheet.needs_attention, 0);
});

test('a scanned or flattened sheet is refused with an explanation, not an empty import', () => {
  const { ctx, org } = world();
  expectRefusal(() => ext.importTransferSheet(ctx, org.id, {}, { redeem: redeemWorkbook }),
    'empty_transfer_sheet', 400);
  expectRefusal(() => ext.importTransferSheet(ctx, org.id, { sheet_version: '1.0' }, { redeem: redeemWorkbook }),
    'empty_transfer_sheet', 400);
});

test('problems survive the import and are handed back with the result', () => {
  const { ctx, org } = world();
  const { body } = ext.importTransferSheet(ctx, org.id,
    { ...FIXTURE.values, conc_top3: '60-70' }, { redeem: redeemWorkbook });

  assert.equal(body.sheet.needs_attention, 1);
  assert.equal(body.sheet.problems[0].field, 'conc_top3');
  assert.ok(body.seeded.facts > 0, 'the other boxes imported');
});

test('the PDF the generator produces carries every field the parser looks for', () => {
  // Captured from a real generated file by tools/read_transfer_sheet.py.
  assert.equal(FIXTURE.field_count, sheet.ALL_FIELD_NAMES.length);
  assert.deepEqual(
    [...FIXTURE.field_names].sort(),
    [...sheet.ALL_FIELD_NAMES].sort(),
    'the generated PDF and the parser agree on every field name',
  );
});
