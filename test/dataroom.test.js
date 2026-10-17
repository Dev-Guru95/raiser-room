/**
 * Phase 2 — the data room, the diligence tracker, and the workbook onramp.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, ctxFor, expectRefusal, fakeStorage } from './helpers.js';
import * as svc from '../src/api/service.js';
import * as room from '../src/api/dataroom.js';
import * as onramp from '../src/api/onramp.js';
import { checkFilename, itemsForPath, visibleAtStage, staleDocuments, FOLDERS } from '../src/domain/dataroom.js';
import { ALL_REFS } from '../src/domain/criteria.js';

const flat = (v) => Object.fromEntries(ALL_REFS.map((r) => [r, v]));

function org(path = 'RAISE') {
  const db = freshDb();
  const ctx = ctxFor(db, 'u-owner');
  const o = svc.createOrganisation(ctx, { name: 'Test Co', path }).body.organisation;
  return { db, ctx, org: o, storage: fakeStorage() };
}

/** Upload and confirm a document in one step. */
function upload(ctx, orgId, storage, filename, kind = 'OTHER') {
  const d = svc.createUploadTicket(ctx, orgId, { filename, size_bytes: 1024, kind }, storage).body.document;
  svc.confirmUpload(ctx, orgId, d.id);
  return d;
}

// ──────────────────────────────────────────────────────────── the structure ──

test('the room is ten numbered folders', () => {
  assert.equal(FOLDERS.length, 10);
  assert.deepEqual(FOLDERS.map((f) => f.key),
    ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10']);
});

test('the checklist differs by path — that is why Organisation.path exists', () => {
  const raise = itemsForPath('RAISE').map((i) => i.ref);
  const sale = itemsForPath('SALE').map((i) => i.ref);

  assert.ok(raise.includes('01.3'), 'a raise needs use of funds');
  assert.equal(sale.includes('01.3'), false);

  assert.ok(sale.includes('04.5'), 'a sale needs a normalisation bridge');
  assert.equal(raise.includes('04.5'), false);

  assert.ok(sale.includes('06.4'), 'a sale needs change-of-control provisions');
  assert.ok(raise.includes('06.5'), 'a raise needs market sizing');

  // The shared spine is most of it — about eighty per cent, per the workbook.
  const shared = raise.filter((r) => sale.includes(r));
  assert.ok(shared.length / raise.length > 0.75, 'most of the preparation is identical');
});

test('building the room creates folders and the path-appropriate checklist', () => {
  const { db, ctx, org: o } = org('SALE');
  const res = room.buildRoom(ctx, o.id).body;

  assert.equal(res.folders, 10);
  assert.equal(db.count('data_room_node', { org_id: o.id }), 10);
  assert.equal(db.count('data_room_item', { org_id: o.id }), res.items);

  const refs = db.find('data_room_item', { org_id: o.id }).map((i) => i.item_ref);
  assert.ok(refs.includes('04.5'), 'the sale-only normalisation bridge is there');
  assert.equal(refs.includes('01.3'), false, 'the raise-only use of funds is not');
});

test('the room is built once', () => {
  const { ctx, org: o } = org();
  room.buildRoom(ctx, o.id);
  expectRefusal(() => room.buildRoom(ctx, o.id), 'already_built', 409);
});

// ────────────────────────────────────────────────────────────── completeness ──

test('completeness counts required items only, and only once uploaded', () => {
  const { ctx, org: o, storage } = org();
  room.buildRoom(ctx, o.id);

  const before = room.getRoom(ctx, o.id).body;
  assert.equal(before.completeness, 0);
  assert.ok(before.required_total > 20);

  // A ticket alone does not satisfy anything — the bytes have to land.
  const item = before.folders[0].items.find((i) => i.required);
  const doc = svc.createUploadTicket(ctx, o.id, { filename: 'summary.pdf', size_bytes: 10 }, storage).body.document;
  expectRefusal(() => room.satisfyItem(ctx, o.id, item.id, doc.id), 'upload_incomplete', 409);

  svc.confirmUpload(ctx, o.id, doc.id);
  room.satisfyItem(ctx, o.id, item.id, doc.id);

  const after = room.getRoom(ctx, o.id).body;
  assert.equal(after.required_satisfied, 1);
  assert.ok(after.completeness > 0);
  assert.equal(after.folders[0].items.find((i) => i.id === item.id).state, 'PRESENT');
});

test('"not applicable" demands a written reason', () => {
  const { ctx, org: o } = org();
  room.buildRoom(ctx, o.id);
  const item = room.getRoom(ctx, o.id).body.folders[0].items[0];

  for (const bad of ['', 'n/a', '   ', 'no']) {
    expectRefusal(() => room.markNotApplicable(ctx, o.id, item.id, bad), 'reason_required', 400);
  }

  const res = room.markNotApplicable(ctx, o.id, item.id,
    'Pre-revenue; there is no customer contract base to summarise yet.');
  assert.equal(res.body.item.not_applicable, 1);
  assert.equal(room.getRoom(ctx, o.id).body.folders[0].items[0].state, 'NOT_APPLICABLE');
});

test('a reasoned N/A counts toward completeness; a missing item does not', () => {
  const { ctx, org: o } = org();
  room.buildRoom(ctx, o.id);
  const before = room.getRoom(ctx, o.id).body.required_satisfied;

  const item = room.getRoom(ctx, o.id).body.folders.flatMap((f) => f.items).find((i) => i.required);
  room.markNotApplicable(ctx, o.id, item.id, 'No option scheme has ever been created by this company.');

  assert.equal(room.getRoom(ctx, o.id).body.required_satisfied, before + 1);
});

// ───────────────────────────────────────────────────────────────── staging ──

test('staging controls what a counterparty sees', () => {
  assert.equal(visibleAtStage('PRE_MEETING', 'PRE_MEETING'), true);
  assert.equal(visibleAtStage('CONFIRMATORY', 'PRE_MEETING'), false);
  assert.equal(visibleAtStage('CONFIRMATORY', 'CONFIRMATORY'), true);
  assert.equal(visibleAtStage('QUALIFIED', 'TERM_SHEET'), true);
});

test('the stage preview shows what is visible and names what is withheld', () => {
  const { ctx, org: o, storage } = org();
  room.buildRoom(ctx, o.id);

  const early = room.stagePreview(ctx, o.id, 'PRE_MEETING').body;
  assert.equal(early.folders.length, 1, 'only the executive overview before a first meeting');
  assert.ok(early.withheld_folders.includes('Cap table and financing'));
  assert.ok(early.withheld_folders.includes('Customers and market'));
  assert.ok(early.means.length > 20);

  const full = room.stagePreview(ctx, o.id, 'CONFIRMATORY').body;
  assert.equal(full.folders.length, 10);
  assert.equal(full.withheld_folders.length, 0);
});

test('an unknown stage is refused', () => {
  const { ctx, org: o } = org();
  room.buildRoom(ctx, o.id);
  expectRefusal(() => room.stagePreview(ctx, o.id, 'WHENEVER'), 'invalid_stage', 400);
});

// ─────────────────────────────────────────────────────────────── file names ──

test('the naming checker catches the names that tell a reader too much', () => {
  const bad = checkFilename('deck_final_v4_updated_NEW.pdf');
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.length >= 1);
  assert.ok(bad.suggestion, 'and offers something better');

  for (const name of ['accounts (2).xlsx', 'Model latest.xlsx', 'cap table copy.xlsx']) {
    assert.equal(checkFilename(name).ok, false, `${name} should be flagged`);
  }
});

test('a conventional name passes', () => {
  const good = checkFilename('04-02_Management-Accounts_2025-01_to_2025-12_v3.xlsx', { folderKey: '04' });
  assert.deepEqual(good.problems, []);
  assert.equal(good.ok, true);
});

test('a name is flagged when it does not carry its folder reference', () => {
  const r = checkFilename('Management-Accounts_v2.xlsx', { folderKey: '04' });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /folder reference/.test(p)));
});

test('room health reports naming, staleness, unfiled and missing', () => {
  const { ctx, org: o, storage } = org();
  room.buildRoom(ctx, o.id);
  upload(ctx, o.id, storage, 'deck final NEW.pdf');

  const health = room.roomHealth(ctx, o.id).body;
  assert.equal(health.naming_problems.length, 1);
  assert.equal(health.unfiled.length, 1, 'uploaded but attached to no checklist item');
  assert.ok(health.missing_required.length > 20);
});

test('stale documents are detected by age', () => {
  const docs = [
    { id: 'a', filename: 'old.pdf', uploaded_at: '2025-01-01T00:00:00.000Z' },
    { id: 'b', filename: 'new.pdf', uploaded_at: '2026-10-01T00:00:00.000Z' },
  ];
  const stale = staleDocuments(docs, { asOf: '2026-10-12T00:00:00.000Z', staleDays: 180 });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].document_id, 'a');
  assert.ok(stale[0].age_days > 600);
});

// ──────────────────────────────────────────────────── request-list mapping ──

test('a counterparty request list maps to the room with honest confidence', () => {
  const { ctx, org: o, storage } = org();
  room.buildRoom(ctx, o.id);

  const res = room.mapRequestList(ctx, o.id, [
    'Monthly management accounts for the last 24 months',
    'Fully diluted capitalisation table reconciled to the register',
    'Please provide the colour of the office carpet',
    '',
  ]).body;

  assert.equal(res.mapped.length, 3, 'blank lines are dropped');
  assert.ok(res.mapped[0].matched_item_ref, 'management accounts match');
  assert.ok(res.mapped[1].matched_item_ref, 'cap table matches');
  assert.ok(res.mapped[2].needs_review, 'nonsense is flagged for review rather than guessed at');
  assert.match(res.note, /heuristic/, 'the limitation is stated, not hidden');
});

// ────────────────────────────────────────────────────── the workbook onramp ──

const WORKBOOK = Object.freeze({
  receipt_ref: 'whop_ABC123',
  scores: flat(3),
  normalisation: { reported_profit: 620_000, normalised_earnings: 390_000, period: 'FY2025' },
  concentration: { top_1_pct: 26, top_3_pct: 51, top_5_pct: 64, top_1_pct_two_years_ago: 38, direction: 'Falling' },
  key_people: [
    { person: 'Founder', holds: 'All enterprise customer relationships', deputy: null },
    { person: 'Lead engineer', holds: 'The deployment pipeline', deputy: 'Second engineer, since March' },
  ],
  assumptions: { one: 'Enterprise deals close in under 90 days', two: 'Churn stays below 8%', three: 'We can hire two engineers by Q2' },
});

test('redeeming the workbook carries the work across, not just the money', () => {
  const { db, ctx, org: o } = org();
  const res = onramp.redeemWorkbook(ctx, o.id, WORKBOOK).body;

  assert.equal(res.redemption.credit.display, '$147.00');
  assert.match(res.redemption.credit_label, /Credit for Before They Ask/);
  assert.equal(/\d+%/.test(res.redemption.credit_label), false, 'a labelled credit, never a percentage');

  assert.ok(res.seeded.facts >= 12, 'the worksheets become facts');
  assert.ok(res.seeded.assessment_id, 'the score sheet becomes an assessment');
  assert.equal(res.seeded.gaps, 32, 'everything scored 3 becomes a gap');
  assert.ok(res.carried_over.length >= 4, 'and the user is told what came with them');

  assert.equal(db.count('fact', { org_id: o.id }), res.seeded.facts);
  assert.equal(db.count('gap', { org_id: o.id }), 32);
});

test('imported facts are USER_ENTERED — nothing was parsed, nothing is confirmed', () => {
  const { db, ctx, org: o } = org();
  onramp.redeemWorkbook(ctx, o.id, WORKBOOK);

  for (const f of db.find('fact', { org_id: o.id })) {
    assert.equal(f.source, 'USER_ENTERED', `${f.fact_key} must not claim a provenance it does not have`);
    assert.equal(f.confirmed_at, null, 'transcription is not confirmation');
    assert.equal(f.source_doc_id, null, 'no document was read');
  }
});

test('the concentration trend survives the import', () => {
  const { db, ctx, org: o } = org();
  onramp.redeemWorkbook(ctx, o.id, WORKBOOK);
  const facts = Object.fromEntries(db.find('fact', { org_id: o.id }).map((f) => [f.fact_key, f]));

  assert.equal(facts['commercial.concentration.top1'].value_numeric, 26);
  assert.equal(facts['commercial.concentration.top1.prior'].value_numeric, 38);
  assert.equal(facts['commercial.concentration.top1'].unit, 'percent');
  assert.equal(facts['commercial.concentration.direction'].value_text, 'Falling');
});

test('key-person entries record whether a deputy exists', () => {
  const { db, ctx, org: o } = org();
  onramp.redeemWorkbook(ctx, o.id, WORKBOOK);
  const people = db.find('fact', { org_id: o.id }).filter((f) => f.fact_key.startsWith('people.key_person'));

  assert.equal(people.length, 2);
  assert.match(people[0].value_text, /No deputy named/);
  assert.match(people[1].value_text, /Deputy: Second engineer/);
});

test('a receipt can only be redeemed once, and an org only redeems once', () => {
  const { ctx, org: o } = org();
  onramp.redeemWorkbook(ctx, o.id, WORKBOOK);

  // Same receipt, same org — the receipt check is the more precise refusal.
  expectRefusal(() => onramp.redeemWorkbook(ctx, o.id, WORKBOOK), 'receipt_already_redeemed', 409);

  // Same receipt, a different org — one purchase cannot seed two companies.
  const other = svc.createOrganisation(ctx, { name: 'Second Co' }).body.organisation;
  expectRefusal(() => onramp.redeemWorkbook(ctx, other.id, WORKBOOK), 'receipt_already_redeemed', 409);

  // A *different* receipt into an org that already redeemed — one credit per org.
  expectRefusal(() => onramp.redeemWorkbook(ctx, o.id, { ...WORKBOOK, receipt_ref: 'whop_SECOND' }),
    'organisation_already_redeemed', 409);
});

test('a receipt reference is required', () => {
  const { ctx, org: o } = org();
  expectRefusal(() => onramp.redeemWorkbook(ctx, o.id, { ...WORKBOOK, receipt_ref: '  ' }), 'receipt_required', 400);
});

test('a bad worksheet number is refused rather than silently coerced', () => {
  const { ctx, org: o } = org();
  expectRefusal(() => onramp.redeemWorkbook(ctx, o.id, {
    ...WORKBOOK, normalisation: { reported_profit: 'about six hundred thousand' },
  }), 'invalid_worksheet_value', 400);
});

test('an unknown criterion in the score sheet is refused', () => {
  const { ctx, org: o } = org();
  expectRefusal(() => onramp.redeemWorkbook(ctx, o.id, {
    ...WORKBOOK, scores: { ...flat(3), '9.9': 2 },
  }), 'unknown_criterion', 400);
});

test('a partial workbook imports what it has', () => {
  const { db, ctx, org: o } = org();
  const res = onramp.redeemWorkbook(ctx, o.id, {
    receipt_ref: 'whop_PARTIAL', concentration: { top_1_pct: 40 },
  }).body;

  assert.equal(res.seeded.facts, 1);
  assert.equal(res.seeded.assessment_id, null, 'no scores, no assessment');
  assert.equal(res.seeded.gaps, 0);
  assert.equal(db.count('fact', { org_id: o.id }), 1);
});

test('credit status is reported before and after redemption', () => {
  const { ctx, org: o } = org();
  const before = onramp.creditStatus(ctx, o.id).body;
  assert.equal(before.credit, null);
  assert.equal(before.eligible, true);
  assert.match(before.note, /carry your work across/);

  onramp.redeemWorkbook(ctx, o.id, WORKBOOK);
  const after = onramp.creditStatus(ctx, o.id).body;
  assert.equal(after.credit.display, '$147.00');
  assert.equal(after.eligible, false);
});

test('only an OWNER may redeem — it carries money', () => {
  const { db, ctx, org: o } = org();
  const editor = ctxFor(db, 'u-editor');
  svc.createInvite(ctx, o.id, { email: 'u-editor@example.com', role: 'EDITOR' });
  svc.listOrganisations(editor);
  expectRefusal(() => onramp.redeemWorkbook(editor, o.id, WORKBOOK), 'forbidden', 403);
});

test('the room and the onramp are org-scoped like everything else', () => {
  const { db, ctx, org: o } = org();
  const outsider = ctxFor(db, 'u-outsider');
  room.buildRoom(ctx, o.id);

  expectRefusal(() => room.getRoom(outsider, o.id), 'not_found', 404);
  expectRefusal(() => room.roomHealth(outsider, o.id), 'not_found', 404);
  expectRefusal(() => onramp.creditStatus(outsider, o.id), 'not_found', 404);
});
