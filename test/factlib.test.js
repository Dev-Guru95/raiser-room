/**
 * The fact library, and the repair path out of a refused sentence.
 *
 * The rule under test is not "a figure must come from a fact" — that is tested
 * elsewhere and is not negotiable. What is tested here is the half that was
 * missing: that being refused leaves the writer one click from carrying on,
 * rather than one explanation from giving up.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, ctxFor, expectRefusal, fakeStorage } from './helpers.js';
import * as svc from '../src/api/service.js';
import * as prose from '../src/api/prose.js';
import * as lib from '../src/api/factlib.js';
import {
  suggestKey, suggestGroup, groupOf, groupNameOf, slugSegment,
  labelFromContext, unitFromNotation, labelFromKey, KEY_GROUPS,
} from '../src/domain/factkeys.js';

function world() {
  const db = freshDb();
  const ctx = ctxFor(db, 'u-owner');
  const storage = fakeStorage();
  const org = svc.createOrganisation(ctx, { name: 'Northwind Systems', path: 'RAISE' }).body.organisation;
  return { db, ctx, org, storage };
}

function withRevenue(ctx, org, storage, { value = 4_200_000 } = {}) {
  const doc = svc.createUploadTicket(ctx, org.id, {
    filename: 'accounts.pdf', size_bytes: 1_000, mime_type: 'application/pdf', kind: 'ACCOUNTS',
  }, storage).body.document;
  svc.confirmUpload(ctx, org.id, doc.id);
  return svc.createFact(ctx, org.id, {
    fact_key: 'financials.revenue.ttm', label: 'Revenue, trailing twelve months',
    value_numeric: value, unit: 'USD',
    source: 'USER_CONFIRMED', source_doc_id: doc.id, source_page: 4,
  }).body.fact;
}

// ──────────────────────────────────────────────────────────── naming a fact ──

test('a key is suggested from the words, in the right group', () => {
  assert.equal(suggestKey('Revenue'), 'financials.revenue');
  assert.equal(suggestKey('Gross margin'), 'financials.gross_margin');
  assert.equal(suggestKey('Top customer'), 'commercial.top_customer');
  assert.equal(suggestKey('Headcount'), 'people.headcount');
});

test('the more specific group wins when a label mentions two', () => {
  // "Net revenue retention" is a customer metric that happens to say revenue.
  assert.equal(suggestGroup('Net revenue retention'), 'commercial');
  assert.equal(suggestGroup('Revenue'), 'financials');
});

test('a suggested key is deterministic, so two people land on the same one', () => {
  // Otherwise a fact store quietly grows two of everything, a week apart.
  assert.equal(suggestKey('Gross margin'), suggestKey('Gross margin'));
  assert.equal(suggestKey('gross MARGIN'), suggestKey('Gross margin'));
});

test('noise words are dropped so a key is not a sentence', () => {
  assert.equal(suggestKey('The total amount of revenue for the last year'), 'financials.revenue_year');
  assert.equal(slugSegment("Founders' equity"), 'founders_equity');
});

test('a key already in use gets a suffix rather than being reused', () => {
  // A key in use belongs to a fact that exists, and a new figure under it would
  // read as a correction of that fact rather than a different thing.
  const taken = ['financials.revenue'];
  assert.equal(suggestKey('Revenue', { existing: taken }), 'financials.revenue_2');
  assert.equal(suggestKey('Revenue', { existing: [...taken, 'financials.revenue_2'] }),
    'financials.revenue_3');
});

test('groups and labels round-trip', () => {
  assert.equal(groupOf('financials.revenue.ttm'), 'financials');
  assert.equal(groupOf('nonsense.key'), null);
  assert.equal(groupNameOf('nonsense.key'), 'Other');
  assert.match(labelFromKey('financials.revenue.ttm'), /Financials/);
  assert.ok(KEY_GROUPS.every((g) => g.key && g.name && g.hint));
});

// ───────────────────────────────────────────── reading a figure off the page ──

test('a unit is taken only from how the figure was written', () => {
  assert.equal(unitFromNotation('$4.2m'), 'USD');
  assert.equal(unitFromNotation('63.9%'), 'percent');
  assert.equal(unitFromNotation('£40k'), 'GBP');
  // No guessing. Putting a currency on a bare number would be inventing a
  // property of the fact that the user never stated.
  assert.equal(unitFromNotation('34'), null);
});

test('a label is taken from the words that name the figure, not the ones leading to it', () => {
  assert.equal(labelFromContext('Revenue grew to $4.2m last year.', '$4.2m'), 'Revenue');
  assert.equal(labelFromContext('Last year the team reached 34 people.', '34'), 'Team');
  assert.equal(labelFromContext('Gross margin came in at 63.9%.', '63.9%'), 'Gross margin');
  assert.equal(labelFromContext('Our top customer is 44.3% of revenue.', '44.3%'), 'Top customer');
});

test('a figure with nothing in front of it gets no invented label', () => {
  assert.equal(labelFromContext('34 people.', '34'), '');
  assert.equal(labelFromContext('something else entirely', '$4.2m'), '');
});

// ─────────────────────────────────────────────────────────── the repair path ──

test('a figure the company already holds is offered, not demanded', () => {
  // The commonest case, and the one that makes the rule feel like help. The
  // answer is not "record a fact" — it is "that is your revenue, insert it?".
  const { ctx, org, storage } = world();
  withRevenue(ctx, org, storage);

  const res = lib.checkAndRepair(ctx, org.id, 'Revenue reached $4.2m last year.');
  assert.equal(res.body.ok, false);
  assert.equal(res.body.repairs.length, 1);

  const [repair] = res.body.repairs;
  assert.equal(repair.matches.length, 1);
  assert.equal(repair.matches[0].fact_key, 'financials.revenue.ttm');
  assert.equal(repair.matches[0].replace_with, '{{fact:financials.revenue.ttm}}');
  assert.match(res.body.summary, /already exist/);
});

test('a figure nobody has recorded comes back filled in, ready to save', () => {
  const { ctx, org } = world();
  const res = lib.checkAndRepair(ctx, org.id, 'Gross margin came in at 63.9% for the year.');

  const [repair] = res.body.repairs;
  assert.equal(repair.matches.length, 0);
  assert.equal(repair.draft.label, 'Gross margin');
  assert.equal(repair.draft.fact_key, 'financials.gross_margin');
  assert.equal(repair.draft.value_numeric, 63.9);
  assert.equal(repair.draft.unit, 'percent');
  // USER_ENTERED, never confirmed: a figure typed in a sentence is something the
  // writer asserts, and recording it as confirmed would manufacture provenance.
  assert.equal(repair.draft.source, 'USER_ENTERED');
});

test('a draft says when it still needs a unit rather than guessing one', () => {
  const { ctx, org } = world();
  const res = lib.checkAndRepair(ctx, org.id, 'The team reached 34 people.');
  assert.deepEqual(res.body.repairs[0].draft.needs, ['unit']);
  assert.equal(res.body.repairs[0].draft.unit, null);
});

test('a percentage does not match a dollar figure that happens to share its number', () => {
  const { ctx, org, storage } = world();
  withRevenue(ctx, org, storage, { value: 40 });

  const res = lib.checkAndRepair(ctx, org.id, 'Cost of sales is 40% of revenue.');
  assert.equal(res.body.repairs[0].matches.length, 0,
    'a percentage was matched to a figure in dollars');
});

test('prose with only references passes and offers nothing to repair', () => {
  const { ctx, org, storage } = world();
  withRevenue(ctx, org, storage);
  const res = lib.checkAndRepair(ctx, org.id,
    'Revenue reached {{fact:financials.revenue.ttm}} last year.');
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.repairs, []);
  assert.match(res.body.summary, /resolves from a confirmed fact/);
});

// ──────────────────────────────────────────────────── record and insert, once ──

test('recording a fact and repairing the sentence happens in one call', () => {
  // A writer who must save a fact, find their sentence again and edit the
  // reference in by hand has been given a worse version of typing the number.
  const { ctx, org } = world();
  const body = 'Gross margin came in at 63.9% for the year.';
  const draft = lib.checkAndRepair(ctx, org.id, body).body.repairs[0].draft;

  const res = lib.recordAndInsert(ctx, org.id, { body, numeral: '63.9%', fact: draft });
  assert.equal(res.status, 201);
  assert.equal(res.body.body, 'Gross margin came in at {{fact:financials.gross_margin}} for the year.');
  assert.equal(res.body.ok, true);
  assert.equal(res.body.fact.fact_key, 'financials.gross_margin');

  // And the repaired sentence is now writable, which is the whole point.
  assert.equal(prose.writeProse(ctx, org.id, 'default', res.body.body).status, 201);
});

test('inserting an existing fact creates nothing', () => {
  const { ctx, org, storage } = world();
  withRevenue(ctx, org, storage);
  const before = ctx.db.count('fact', { org_id: org.id });

  const res = lib.recordAndInsert(ctx, org.id, {
    body: 'Revenue reached $4.2m last year.',
    numeral: '$4.2m',
    use_existing: true,
    fact_key: 'financials.revenue.ttm',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.body, 'Revenue reached {{fact:financials.revenue.ttm}} last year.');
  assert.equal(ctx.db.count('fact', { org_id: org.id }), before, 'a duplicate fact was created');
});

test('a passage with more than one figure says what is left', () => {
  const { ctx, org } = world();
  const body = 'Gross margin came in at 63.9% and the team reached 34 people.';
  const draft = lib.checkAndRepair(ctx, org.id, body).body.repairs[0].draft;

  const res = lib.recordAndInsert(ctx, org.id, { body, numeral: '63.9%', fact: draft });
  assert.equal(res.body.ok, false);
  assert.match(res.body.note, /others in this passage/);
  assert.ok(res.body.problems[0].numerals.includes('34'));
});

test('only the first occurrence is replaced', () => {
  // Replacing every instance would silently rewrite a second, unrelated use of
  // the same figure elsewhere in the passage.
  const { ctx, org } = world();
  const body = 'We grew 40% last year, and 40% of customers renewed.';
  const draft = lib.checkAndRepair(ctx, org.id, body).body.repairs[0].draft;

  const res = lib.recordAndInsert(ctx, org.id, { body, numeral: '40%', fact: draft });
  assert.equal((res.body.body.match(/\{\{fact:/g) ?? []).length, 1);
  assert.ok(res.body.body.includes('40% of customers'), 'the second use was rewritten too');
});

test('repairing text that does not contain the figure is refused', () => {
  const { ctx, org } = world();
  expectRefusal(
    () => lib.recordAndInsert(ctx, org.id, { body: 'Nothing numeric here.', numeral: '40%', fact: {} }),
    'numeral_not_in_text', 400,
  );
});

test('a fact created this way goes through the ordinary fact service', () => {
  // No shortcut path writes a fact row, so every rule on a fact applies here.
  const { ctx, org } = world();
  expectRefusal(
    () => lib.recordAndInsert(ctx, org.id, {
      body: 'Margin was 63.9%.', numeral: '63.9%',
      fact: { fact_key: 'financials.gross_margin', label: '', value_numeric: 63.9 },
    }),
    'missing_label',
  );
});

// ───────────────────────────────────────────────────────────────── the library ──

test('the library groups facts under headings a person recognises', () => {
  const { ctx, org, storage } = world();
  withRevenue(ctx, org, storage);
  svc.createFact(ctx, org.id, {
    fact_key: 'people.headcount', label: 'Headcount', value_numeric: 34, source: 'USER_ENTERED',
  });

  const res = lib.factLibrary(ctx, org.id);
  const names = res.body.groups.map((g) => g.name);
  assert.ok(names.includes('Financials'));
  assert.ok(names.includes('People'));
  assert.equal(res.body.total, 2);
  // Every fact carries the text to paste into a sentence.
  assert.equal(res.body.facts[0].reference, `{{fact:${res.body.facts[0].fact_key}}}`);
});

test('search matches the key and the label, and needs every word', () => {
  const { ctx, org, storage } = world();
  withRevenue(ctx, org, storage);
  svc.createFact(ctx, org.id, {
    fact_key: 'financials.gross_margin', label: 'Gross margin', value_numeric: 63.9,
    unit: 'percent', source: 'USER_ENTERED',
  });

  assert.equal(lib.factLibrary(ctx, org.id, { query: 'margin' }).body.total, 1);
  assert.equal(lib.factLibrary(ctx, org.id, { query: 'trailing twelve' }).body.total, 1);
  // Both words must appear, so this matches neither.
  assert.equal(lib.factLibrary(ctx, org.id, { query: 'margin trailing' }).body.total, 0);
});

test('an unconfirmed extraction is surfaced, with why it cannot be used', () => {
  // The commonest reason a writer is told a figure they can see on screen is
  // unusable. Burying it is how that becomes a support ticket.
  const { ctx, org, storage } = world();
  const doc = svc.createUploadTicket(ctx, org.id, {
    filename: 'accounts.pdf', size_bytes: 1_000, mime_type: 'application/pdf', kind: 'ACCOUNTS',
  }, storage).body.document;
  svc.confirmUpload(ctx, org.id, doc.id);
  svc.createFact(ctx, org.id, {
    fact_key: 'financials.arr', label: 'ARR', value_numeric: 4_100_000, unit: 'USD',
    source: 'DOCUMENT_EXTRACTED', source_doc_id: doc.id, source_page: 2,
  });

  const res = lib.factLibrary(ctx, org.id);
  assert.equal(res.body.awaiting_count, 1);
  assert.match(res.body.awaiting_confirmation[0].why_not_usable, /nobody has confirmed it yet/);
});

test('usage counts show which facts documents actually lean on', () => {
  const { ctx, org, storage } = world();
  withRevenue(ctx, org, storage);
  prose.writeProse(ctx, org.id, 'default', 'Revenue reached {{fact:financials.revenue.ttm}}.');
  prose.writeProse(ctx, org.id, 'market', 'Against {{fact:financials.revenue.ttm}} of revenue.');

  const fact = lib.factLibrary(ctx, org.id).body.facts.find((f) => f.fact_key === 'financials.revenue.ttm');
  assert.equal(fact.uses, 2);
});

test('autocomplete finds a fact by its label, not only by its key', () => {
  // A writer thinks "gross margin"; the key is financials.gross_margin.
  // Requiring them to know the key makes the syntax something to memorise.
  const { ctx, org } = world();
  svc.createFact(ctx, org.id, {
    fact_key: 'financials.gross_margin', label: 'Gross margin', value_numeric: 63.9,
    unit: 'percent', source: 'USER_ENTERED',
  });

  const res = lib.suggestFacts(ctx, org.id, 'gross');
  assert.equal(res.body.suggestions.length, 1);
  assert.equal(res.body.suggestions[0].insert, '{{fact:financials.gross_margin}}');
  assert.equal(res.body.suggestions[0].preview, '63.9%');

  // And a fact whose LABEL is the only thing that matches. Keys and labels
  // diverge all the time — this one is filed under people, and nobody searching
  // for it will type that.
  svc.createFact(ctx, org.id, {
    fact_key: 'people.staff_total', label: 'Headcount', value_numeric: 34, source: 'USER_ENTERED',
  });
  const byLabel = lib.suggestFacts(ctx, org.id, 'headcount').body.suggestions;
  assert.equal(byLabel.length, 1, 'a fact findable only by its label was not offered');
  assert.equal(byLabel[0].insert, '{{fact:people.staff_total}}');
});

test('a fact whose label starts with what you typed is offered first', () => {
  // Ranking, not presence — both of these are findable either way. In an
  // autocomplete the first suggestion is the one people take, so a fact whose
  // NAME begins with the query belongs above one that merely mentions it
  // somewhere in a key.
  const { ctx, org } = world();
  svc.createFact(ctx, org.id, {
    fact_key: 'financials.gross_margin', label: 'Gross margin', value_numeric: 63.9,
    unit: 'percent', source: 'USER_ENTERED',
  });
  svc.createFact(ctx, org.id, {
    fact_key: 'commercial.pricing', label: 'Margin policy', value_numeric: 40,
    unit: 'percent', source: 'USER_ENTERED',
  });

  const suggestions = lib.suggestFacts(ctx, org.id, 'margin').body.suggestions;
  assert.equal(suggestions.length, 2);
  assert.equal(suggestions[0].label, 'Margin policy',
    'a label-prefix match did not outrank a key-substring match');
});

test('autocomplete never offers a fact that cannot be used', () => {
  const { ctx, org, storage } = world();
  const doc = svc.createUploadTicket(ctx, org.id, {
    filename: 'a.pdf', size_bytes: 1_000, mime_type: 'application/pdf', kind: 'ACCOUNTS',
  }, storage).body.document;
  svc.confirmUpload(ctx, org.id, doc.id);
  svc.createFact(ctx, org.id, {
    fact_key: 'financials.arr', label: 'ARR', value_numeric: 4_100_000, unit: 'USD',
    source: 'DOCUMENT_EXTRACTED', source_doc_id: doc.id, source_page: 2,
  });

  // Offering it would put a reference in a sentence that renders as a blank.
  assert.equal(lib.suggestFacts(ctx, org.id, 'arr').body.suggestions.length, 0);
});

test('the writing guide explains the rule before anyone breaks it, and handles the empty case', () => {
  const { ctx, org, storage } = world();
  const empty = lib.writingGuide(ctx, org.id).body;
  assert.equal(empty.facts_available, 0);
  assert.ok(empty.empty_state, 'a writer with no facts was given no way forward');

  withRevenue(ctx, org, storage);
  const stocked = lib.writingGuide(ctx, org.id).body;
  assert.equal(stocked.facts_available, 1);
  assert.equal(stocked.empty_state, null);
});

// ───────────────────────────────────────────────────────────── access control ──

test('a non-member gets 404 from every library call', () => {
  const { ctx, org, db, storage } = world();
  withRevenue(ctx, org, storage);
  const stranger = ctxFor(db, 'u-stranger');

  for (const call of [
    () => lib.factLibrary(stranger, org.id),
    () => lib.suggestFacts(stranger, org.id, 'rev'),
    () => lib.checkAndRepair(stranger, org.id, 'Revenue was $4.2m.'),
    () => lib.writingGuide(stranger, org.id),
    () => lib.recordAndInsert(stranger, org.id, {
      body: 'Revenue was $4.2m.', numeral: '$4.2m', use_existing: true,
      fact_key: 'financials.revenue.ttm',
    }),
  ]) {
    expectRefusal(call, 'not_found', 404);
  }
});

test('a viewer can browse and check but cannot record', () => {
  const { ctx, org, db } = world();
  db.insert('membership', {
    org_id: org.id, user_id: 'u-viewer', email: 'v@example.com', role: 'VIEWER', created_at: ctx.now(),
  });
  const viewer = ctxFor(db, 'u-viewer');

  assert.equal(lib.factLibrary(viewer, org.id).status, 200);
  assert.equal(lib.checkAndRepair(viewer, org.id, 'Margin was 63.9%.').status, 200);
  expectRefusal(() => lib.recordAndInsert(viewer, org.id, {
    body: 'Margin was 63.9%.', numeral: '63.9%',
    fact: { fact_key: 'financials.gross_margin', label: 'Gross margin', value_numeric: 63.9 },
  }), 'forbidden', 403);
});

test('the library never reaches another organisation', () => {
  const { ctx, org, db, storage } = world();
  withRevenue(ctx, org, storage);
  const otherCtx = ctxFor(db, 'u-other');
  const other = svc.createOrganisation(otherCtx, { name: 'Elsewhere', path: 'RAISE' }).body.organisation;
  svc.createFact(otherCtx, other.id, {
    fact_key: 'financials.revenue.ttm', label: 'Their revenue', value_numeric: 4_200_000,
    unit: 'USD', source: 'USER_ENTERED',
  });

  const res = lib.factLibrary(ctx, org.id);
  assert.equal(res.body.total, 1);
  assert.ok(res.body.facts.every((f) => f.label !== 'Their revenue'));

  // And a match is never offered from another company's figures.
  const repair = lib.checkAndRepair(ctx, org.id, 'Revenue reached $4.2m.').body.repairs[0];
  assert.ok(repair.matches.every((m) => m.label !== 'Their revenue'));
});
