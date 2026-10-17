/**
 * The worked example.
 *
 * This is the broadest test in the suite. It loads the example through the real
 * service functions and then asks the product to do its actual job with it —
 * score, register gaps, generate eight documents, resolve every figure in them
 * to a source. A unit test can tell you a function works; this tells you the
 * system does.
 *
 * It is also the guard on a claim the product makes in public: that a generated
 * document contains no figure that was typed. If that ever stops being true, it
 * stops being true here first.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, ctxFor, expectRefusal, onPlan } from './helpers.js';
import { memoryStorageDriver } from '../src/storage/local.js';
import * as svc from '../src/api/service.js';
import * as dataroom from '../src/api/dataroom.js';
import * as artifacts from '../src/api/artifacts.js';
import * as assessments from '../src/api/assessments.js';
import * as billing from '../src/api/billing.js';
import {
  seedWorkedExample, isSeeded, ILLUSTRATIVE_NOTICE, SEED_MARKER_KEY, GENERATED_KINDS,
  EXAMPLE_PROSE,
} from '../src/api/seed.js';

function seeded({ entitle = true, storage = true, trialOver = false } = {}) {
  const db = freshDb();
  const ctx = ctxFor(db, 'u-founder', 'founder@example.com');
  if (storage) ctx.storage = memoryStorageDriver({ secret: 'a-secret-long-enough-for-tests' });
  const org = svc.createOrganisation(ctx, {
    name: 'Northwind Systems', path: 'RAISE', currency: 'USD', target_amount: 6_000_000,
  }).body.organisation;
  // The trial is computed from when the organisation was created, so backdating
  // that is how a test gets an organisation genuinely on the free plan.
  if (trialOver) db.update('organisation', org.id, { created_at: '2020-01-01T00:00:00.000Z' });
  dataroom.buildRoom(ctx, org.id);
  const result = seedWorkedExample(ctx, org.id, { entitle });
  return { db, ctx, org, result: result.body };
}

test('the example loads and the product can work with it', () => {
  const { result } = seeded();
  assert.ok(result.figures > 30, `only ${result.figures} figures`);
  assert.ok(result.documents >= 4);
  assert.ok(result.produced.some((pr) => pr.kind === "VALUATION_READINESS"));
  assert.ok(result.gaps > 0, 'the assessment produced no gaps');
  assert.deepEqual(result.skipped, []);
});

test('every document the example claims to produce actually generates', () => {
  const { result } = seeded();
  const blocked = result.produced.filter((p) => p.blocked);
  assert.deepEqual(blocked, [], `blocked: ${blocked.map((b) => `${b.kind} (${b.blockers})`).join('; ')}`);
  assert.equal(result.produced.length, GENERATED_KINDS.length);
});

test('every figure in every generated document resolves to a recorded fact', () => {
  // The product's central claim, checked against the whole example rather than a
  // fixture: a document is a rendering of referenced facts, and a reference that
  // does not resolve is a number that was typed.
  const { ctx, org } = seeded();
  const rows = ctx.db.find('artifact', { org_id: org.id }).filter((a) => a.state === 'GENERATED');
  assert.ok(rows.length >= 8);

  let checked = 0;
  for (const row of rows) {
    const refs = JSON.parse(row.fact_refs ?? '[]');
    for (const ref of refs) {
      const id = typeof ref === 'string' ? ref : ref.fact_id ?? ref.id;
      const fact = ctx.db.get('fact', id);
      assert.ok(fact, `${row.artifact_kind} references a fact that is not there: ${id}`);
      assert.equal(fact.org_id, org.id, 'a document referenced another organisation\'s figure');
      checked += 1;
    }
  }
  assert.ok(checked > 40, `only ${checked} references checked`);
});

test('no figure in the example is sourced as extracted-but-unconfirmed', () => {
  // `DOCUMENT_EXTRACTED` is excluded from `USABLE_SOURCES`, so a document built
  // on one would be built on a figure nobody had confirmed.
  const { ctx, org } = seeded();
  const extracted = ctx.db.find('fact', { org_id: org.id })
    .filter((f) => f.source === 'DOCUMENT_EXTRACTED');
  assert.deepEqual(extracted, []);
});

test('the prose in the example types no figures of its own', () => {
  // The product refuses to let a user write a number into a sentence without
  // recording it first. The example obeys the same rule, which it would be
  // dishonest to exempt itself from.
  for (const passages of Object.values(EXAMPLE_PROSE)) {
    for (const text of passages) {
      const withoutRefs = text.replace(/\{\{fact:[^}]+\}\}/g, '');
      const numerals = withoutRefs.match(/\d[\d,.]*/g) ?? [];
      assert.deepEqual(numerals, [], `a figure is typed into the prose: ${numerals.join(', ')}`);
    }
  }
});

test('the documents are stored as bytes, under keys that are not shared between versions', () => {
  const { ctx, org } = seeded();
  const rows = ctx.db.find('artifact', { org_id: org.id }).filter((a) => a.html_key);
  assert.ok(rows.length >= 8);

  const keys = new Set();
  for (const row of rows) {
    assert.ok(ctx.storage.has(row.html_key), `nothing stored at ${row.html_key}`);
    assert.ok(!keys.has(row.html_key), 'two artifacts share one storage key');
    keys.add(row.html_key);
    assert.ok(row.html_key.includes(row.id), 'the key does not name the artifact version');
  }
});

test('regenerating a document leaves the earlier version exactly as it was', () => {
  // The promise is that nothing is changed under a reader. Keyed by kind rather
  // than by version, regenerating would overwrite the bytes somebody is holding.
  const { ctx, org } = seeded();
  const first = ctx.db.find('artifact', { org_id: org.id })
    .find((a) => a.artifact_kind === 'CUSTOMER_CONCENTRATION');
  const before = ctx.storage.get(first.html_key).toString('utf8');

  // Move a figure the document rests on, then regenerate.
  const fact = ctx.db.find('fact', { org_id: org.id, fact_key: 'commercial.concentration.top1' })
    .find((f) => !f.superseded_by);
  svc.supersedeFact(ctx, org.id, fact.id, {
    value_numeric: 51.2, unit: 'percent', source: 'USER_CONFIRMED',
    source_doc_id: fact.source_doc_id, source_page: 14,
    reason: 'The year-end figure, from the same schedule.',
  });
  const second = artifacts.generate(ctx, org.id, 'CUSTOMER_CONCENTRATION', { prose: EXAMPLE_PROSE });

  assert.notEqual(second.body.artifact.id, first.id);
  assert.equal(ctx.storage.get(first.html_key).toString('utf8'), before,
    'regenerating changed the bytes of the version already sent');
  assert.notEqual(ctx.storage.get(ctx.db.get('artifact', second.body.artifact.id).html_key)
    .toString('utf8'), before);
});

test('a stored document can be read back as it was generated, not re-rendered', () => {
  const { ctx, org } = seeded();
  const row = ctx.db.find('artifact', { org_id: org.id }).find((a) => a.state === 'GENERATED');
  const read = artifacts.readGenerated(ctx, org.id, row.id).body;
  assert.ok(read.html.includes('<!DOCTYPE html>') || read.html.includes('<!doctype html>'));
  assert.equal(read.superseded, false);
  assert.equal(read.html, ctx.storage.get(row.html_key).toString('utf8'));
});

test('reading a document with no bytes behind it says so rather than failing', () => {
  const { ctx, org } = seeded();
  const row = ctx.db.find('artifact', { org_id: org.id }).find((a) => a.state === 'GENERATED');
  ctx.storage.remove(row.html_key);
  const read = artifacts.readGenerated(ctx, org.id, row.id).body;
  assert.equal(read.html, null);
});

test('a member of another organisation cannot read a document from this one', () => {
  const { ctx, org, db } = seeded();
  const row = ctx.db.find('artifact', { org_id: org.id }).find((a) => a.state === 'GENERATED');
  const stranger = ctxFor(db, 'u-stranger', 'stranger@example.com');
  stranger.storage = ctx.storage;
  // 404, never 403: a 403 confirms the document exists.
  expectRefusal(() => artifacts.readGenerated(stranger, org.id, row.id), 'not_found', 404);
});

test('the example is marked, and every page can tell', () => {
  const { ctx, org } = seeded();
  assert.equal(isSeeded(ctx, org.id), true);
  const marker = ctx.db.findOne('fact', { org_id: org.id, fact_key: SEED_MARKER_KEY });
  assert.equal(marker.value_text, ILLUSTRATIVE_NOTICE);
});

test('the notice names it an invented company in those words', () => {
  // The wording is fixed, not a paraphrase. It is the sentence that stops an
  // invented figure being quoted as a real one.
  for (const phrase of [
    'Illustrative example.', 'Not a real company', 'client, engagement, or performance result',
    'All names, figures, workflows, and outcomes are invented for teaching purposes.',
  ]) {
    assert.ok(ILLUSTRATIVE_NOTICE.includes(phrase), `the notice no longer says "${phrase}"`);
  }
});

test('loading it twice is refused, with the reason', () => {
  const { ctx, org } = seeded();
  const err = expectRefusal(() => seedWorkedExample(ctx, org.id), 'already_seeded', 409);
  assert.match(err.detail, /already holds/);
});

test('it is refused on an organisation that has figures of its own', () => {
  // The one unrecoverable mistake this function could make. Afterwards nobody
  // can tell which figures were the company's.
  const db = freshDb();
  const ctx = ctxFor(db, 'u-founder', 'founder@example.com');
  const org = svc.createOrganisation(ctx, { name: 'Real Company', path: 'RAISE' }).body.organisation;
  svc.createFact(ctx, org.id, {
    fact_key: 'financials.revenue.ttm', label: 'Revenue', value_numeric: 1, unit: 'USD',
    source: 'USER_ENTERED',
  });
  const err = expectRefusal(() => seedWorkedExample(ctx, org.id), 'already_seeded', 409);
  assert.match(err.detail, /nobody can tell them apart/);
});

test('a member who is not an owner cannot load it', () => {
  const db = freshDb();
  const owner = ctxFor(db, 'u-owner', 'owner@example.com');
  const org = svc.createOrganisation(owner, { name: 'Northwind Systems', path: 'RAISE' }).body.organisation;
  db.insert('membership', {
    org_id: org.id, user_id: 'u-editor', email: 'editor@example.com', role: 'EDITOR',
    created_at: '2026-01-01T00:00:00.000Z',
  });
  const editor = ctxFor(db, 'u-editor', 'editor@example.com');
  expectRefusal(() => seedWorkedExample(editor, org.id), 'forbidden', 403);
});

test('a non-member gets 404, not 403', () => {
  const db = freshDb();
  const owner = ctxFor(db, 'u-owner', 'owner@example.com');
  const org = svc.createOrganisation(owner, { name: 'Northwind Systems', path: 'RAISE' }).body.organisation;
  const stranger = ctxFor(db, 'u-stranger', 'stranger@example.com');
  expectRefusal(() => seedWorkedExample(stranger, org.id), 'not_found', 404);
});

// ─────────────────────────────────────────────── the demonstration grant ──

test('without the grant, the gated parts are skipped and said to be skipped', () => {
  // A seed that quietly granted itself a paid tier would be a hole in the gate
  // nobody could see. This shows the gate working instead.
  //
  // The organisation is backdated past its trial first. A new one is inside the
  // seven-day trial of the full single-company plan, which includes the forecast
  // ledger — so without backdating, this test would pass for the wrong reason
  // and then fail the day the trial length changed.
  const { result } = seeded({ entitle: false, trialOver: true });
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].what, /forecast cycles/);
  assert.ok(result.skipped[0].available_in.includes('RAISEROOM'));
  // And the rest of the example still loaded.
  assert.ok(result.figures > 25);
});

test('inside the trial, the whole example loads — including the forecast ledger', () => {
  // The other half of the decision above. A seven-day trial that withheld the
  // one thing nobody else can offer would be a trial of the wrong product.
  const { result } = seeded({ entitle: false });
  assert.deepEqual(result.skipped, []);
});

test('the grant is a real subscription row, marked as a grant', () => {
  const { ctx, org } = seeded();
  const status = billing.status(ctx, org.id).body;
  assert.equal(status.demonstration, true);
  assert.equal(status.plan.key, 'FIRM');
  const row = ctx.db.findOne('subscription', { org_id: org.id });
  assert.equal(row.provider, billing.DEMONSTRATION_PROVIDER);
});

test('a paid subscription is never overwritten by a grant', () => {
  // Overwriting a billing row with a free grant loses the record of what the
  // customer bought.
  const db = freshDb();
  const ctx = ctxFor(db, 'u-founder', 'founder@example.com');
  const org = svc.createOrganisation(ctx, { name: 'Northwind Systems', path: 'RAISE' }).body.organisation;
  onPlan(db, org.id, 'RAISEROOM');

  assert.throws(() => billing.grantDemonstration(ctx, org.id), (err) => {
    assert.equal(err.code, 'already_subscribed');
    assert.equal(err.status, 409);
    return true;
  });
  assert.equal(ctx.db.findOne('subscription', { org_id: org.id }).plan_key, 'RAISEROOM');
});

test('granting twice is the same grant, not two rows', () => {
  const db = freshDb();
  const ctx = ctxFor(db, 'u-founder', 'founder@example.com');
  const org = svc.createOrganisation(ctx, { name: 'Northwind Systems', path: 'RAISE' }).body.organisation;
  billing.grantDemonstration(ctx, org.id);
  const again = billing.grantDemonstration(ctx, org.id);
  assert.equal(again.body.already, true);
  assert.equal(db.find('subscription', { org_id: org.id }).length, 1);
});

test('an ordinary subscription is not reported as a demonstration', () => {
  const db = freshDb();
  const ctx = ctxFor(db, 'u-founder', 'founder@example.com');
  const org = svc.createOrganisation(ctx, { name: 'Real Company', path: 'RAISE' }).body.organisation;
  onPlan(db, org.id, 'RAISEROOM');
  assert.equal(billing.status(ctx, org.id).body.demonstration, false);
});

// ──────────────────────────────────────────────────── what it demonstrates ──

test('the example company has the problem it is meant to demonstrate', () => {
  // A demonstration company that scored well everywhere would show none of the
  // product's actual work. The concentration is rising, and the gap register has
  // something in it.
  const { ctx, org } = seeded();
  const factFor = (key) => ctx.db.find('fact', { org_id: org.id, fact_key: key })
    .find((f) => !f.superseded_by);

  const now = factFor('commercial.concentration.top1');
  const then = factFor('commercial.concentration.top1.prior');
  assert.ok(now.value_numeric > then.value_numeric, 'the concentration is not rising');

  const gaps = assessments.listGaps(ctx, org.id).body.gaps;
  assert.ok(gaps.length >= 3, 'the assessment found almost nothing to fix');
  assert.ok(gaps.some((g) => g.owner_user_id), 'no gap has an owner');
  assert.ok(gaps.some((g) => g.due_date), 'no gap has a date');
});

test('every figure in the example names the document and page it came from', () => {
  // Except the ones deliberately typed — a key-person note is a statement, not a
  // figure read off a schedule — and the marker. The split is explicit so that a
  // figure losing its provenance cannot hide among them.
  const { ctx, org } = seeded();
  const typed = ctx.db.find('fact', { org_id: org.id })
    .filter((f) => f.source === 'USER_ENTERED');
  const confirmed = ctx.db.find('fact', { org_id: org.id })
    .filter((f) => f.source === 'USER_CONFIRMED');

  for (const f of confirmed) {
    assert.ok(f.source_doc_id, `${f.fact_key} is confirmed from nothing`);
    assert.ok(ctx.db.get('document', f.source_doc_id), `${f.fact_key} cites a document that is not there`);
  }
  // Typed figures are numerics only where the thing genuinely has no document
  // behind it yet: the monthly actuals, which arrive before the month is filed.
  for (const f of typed.filter((x) => x.value_numeric !== null)) {
    assert.equal(f.fact_key, 'financials.revenue.mrr', `${f.fact_key} was typed with no source`);
  }
  assert.ok(confirmed.length > typed.length, 'most of the example is unsourced');
});

test('the three forecast cycles are closed, and the two that missed say why', () => {
  const { ctx, org } = seeded();
  const variances = ctx.db.find('variance', { org_id: org.id });
  assert.ok(variances.length >= 2, `only ${variances.length} variances`);
  for (const v of variances.filter((x) => x.needs_explanation)) {
    assert.ok(v.explanation, 'a variance that needed explaining has none');
    assert.ok(v.explanation.length > 40, 'the explanation is too short to be one');
  }
});

/**
 * ───────────────────────────────────────────────────────────────────────────
 * THE NOTICE ON THE DOCUMENTS, NOT JUST ON THE PAGES
 *
 * The web interface puts the notice on every page of a seeded organisation, and
 * that was taken as sufficient for a long time. It is not. The documents are
 * the part of this product that travels: they get printed, attached, forwarded
 * and screenshotted, and a reader three forwards from the person who generated
 * one has nothing else to tell them the figures are invented.
 *
 * A deck of invented figures that reads exactly like a real one is the single
 * most damaging artefact this codebase can produce, and for one build it was
 * producing nine of them.
 */
test('every page of every generated document carries the notice, verbatim', () => {
  const { ctx, org } = seeded();
  const generated = ctx.db.find('artifact', { org_id: org.id }).filter((a) => a.generated_at);
  assert.ok(generated.length >= 8, `only ${generated.length} documents were generated`);

  for (const row of generated) {
    const html = artifacts.readGenerated(ctx, org.id, row.id).body.html;
    assert.ok(html, `${row.title} has no stored file to check`);

    const pages = (html.match(/<section class="page/g) ?? []).length;
    const notices = html.split(ILLUSTRATIVE_NOTICE).length - 1;

    assert.ok(pages > 0, `${row.title} rendered no pages`);
    assert.equal(notices, pages,
      `${row.title} has ${pages} page(s) and ${notices} notice(s) — a page a reader lands on `
      + 'mid-document has to say so by itself');
  }
});

test('a document from an organisation that is not the example carries no notice', () => {
  // The other half of the rule. A notice on a real company's deck would be a
  // false disclaimer on a document it is relying on, which is its own kind of
  // damage — and it would train people to ignore the notice where it matters.
  const db = freshDb();
  const storage = memoryStorageDriver();
  const ctx = { ...ctxFor(db, 'u1'), storage };
  const org = svc.createOrganisation(ctx, { name: 'A Real Company', path: 'RAISE' }).body.organisation;
  dataroom.buildRoom(ctx, org.id);
  onPlan(db, org.id, 'FIRM');

  svc.createFact(ctx, org.id, {
    fact_key: 'company.name', label: 'Registered name',
    value_text: 'A Real Company', source: 'USER_ENTERED',
  });

  const made = artifacts.generate(ctx, org.id, 'DATA_ROOM_INDEX');
  if (made.body.blocked) return;   // nothing to check if it would not generate

  const html = artifacts.readGenerated(ctx, org.id, made.body.artifact.id).body.html;
  assert.ok(!html.includes(ILLUSTRATIVE_NOTICE),
    'a real company’s document carries the illustrative-example notice');
});
