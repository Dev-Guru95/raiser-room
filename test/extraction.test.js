/**
 * Phase 3 — extraction and the confirmation step.
 *
 * WHAT THESE TESTS COVER, AND WHAT THEY DO NOT
 *
 * They cover the rules: that nothing reaches the fact store without a human
 * decision, that provenance survives that decision, that an unreadable document
 * is declared unreadable, and that bulk confirm cannot be used on figures nobody
 * has seen.
 *
 * They do NOT cover whether a real extractor finds the right number in a real
 * pitch deck. The extractor here is a deterministic fake. Extraction accuracy is
 * unmeasured and is not claimed anywhere in this repository.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, ctxFor, expectRefusal, fakeStorage } from './helpers.js';
import * as svc from '../src/api/service.js';
import * as ext from '../src/api/extraction.js';
import * as domain from '../src/domain/extraction.js';
import {
  fakeExtractor, DECK_CANDIDATES, ACCOUNTS_CANDIDATES, MODEL_CANDIDATES,
  SCANNED_PROBE, MALFORMED_CANDIDATES,
} from '../src/extract/fake.js';

const PDF = 'application/pdf';

function world() {
  const db = freshDb();
  const ctx = ctxFor(db, 'u-owner');
  const storage = fakeStorage();
  const org = svc.createOrganisation(ctx, { name: 'Test Co', path: 'RAISE' }).body.organisation;
  return { db, ctx, org, storage };
}

/**
 * Upload and confirm a document, returning the stored ROW.
 *
 * The API response deliberately returns only { id, filename, kind } — the
 * storage key is not the client's business — so the row has to be read back
 * for a test that needs it.
 */
function upload(ctx, org, storage, filename, kind = 'OTHER') {
  const issued = svc.createUploadTicket(ctx, org.id, {
    filename, size_bytes: 10_000, mime_type: PDF, kind,
  }, storage).body.document;
  svc.confirmUpload(ctx, org.id, issued.id);
  return ctx.db.get('document', issued.id);
}

const extractorFor = (docs) => fakeExtractor({ candidates: docs });

// ─────────────────────────────────────────────────────── the central claim ──

test('extraction writes NOTHING to the fact store until a human confirms it', async () => {
  const { db, ctx, org, storage } = world();
  const doc = upload(ctx, org, storage, 'pitch-deck-v4.pdf', 'DECK');

  const res = await ext.runExtraction(ctx, org.id, doc.id,
    extractorFor({ [doc.storage_key]: [...DECK_CANDIDATES] }));

  assert.equal(res.body.candidates.length, 3);
  assert.equal(db.count('fact', { org_id: org.id }), 0,
    'three figures were read and none of them is a fact yet');
  assert.equal(res.body.extraction.state, 'NEEDS_REVIEW');
});

test('no code path writes a fact with source DOCUMENT_EXTRACTED', async () => {
  const { db, ctx, org, storage } = world();
  const doc = upload(ctx, org, storage, 'deck.pdf', 'DECK');
  await ext.runExtraction(ctx, org.id, doc.id, extractorFor({ [doc.storage_key]: [...DECK_CANDIDATES] }));

  const run = db.findOne('extraction', { document_id: doc.id });
  ext.getExtraction(ctx, org.id, run.id);
  ext.bulkConfirm(ctx, org.id, run.id);

  const facts = db.find('fact', { org_id: org.id });
  assert.equal(facts.length, 3);
  assert.equal(facts.filter((f) => f.source === 'DOCUMENT_EXTRACTED').length, 0,
    'an unconfirmed extraction never becomes a fact — candidates live in their own table');
  assert.ok(facts.every((f) => f.source === 'USER_CONFIRMED'));
});

test('confirming stamps the human, the time, and keeps the page it came from', async () => {
  const { db, ctx, org, storage } = world();
  const doc = upload(ctx, org, storage, 'deck.pdf', 'DECK');
  await ext.runExtraction(ctx, org.id, doc.id, extractorFor({ [doc.storage_key]: [DECK_CANDIDATES[0]] }));

  const candidate = db.find('extraction_candidate', { org_id: org.id })[0];
  const { fact } = ext.decideCandidate(ctx, org.id, candidate.id, { decision: 'CONFIRM' }).body;

  assert.equal(fact.source, 'USER_CONFIRMED');
  assert.equal(fact.confirmed_by, 'u-owner');
  assert.ok(fact.confirmed_at);
  assert.equal(fact.source_doc_id, doc.id, 'the fact still points at the document');
  assert.equal(fact.source_page, 7, 'and at the page');
});

test('an extractor cannot mark its own output as confirmed', async () => {
  const { db, ctx, org, storage } = world();
  const doc = upload(ctx, org, storage, 'deck.pdf', 'DECK');

  await ext.runExtraction(ctx, org.id, doc.id,
    extractorFor({ [doc.storage_key]: [MALFORMED_CANDIDATES.claimsConfirmed] }));

  assert.equal(db.count('fact', { org_id: org.id }), 0,
    'a candidate claiming to be confirmed is still just a candidate');
  const candidate = db.find('extraction_candidate', { org_id: org.id })[0];
  assert.equal(candidate.state, 'AWAITING_REVIEW');
  assert.equal(candidate.decided_by, null);
  assert.equal(candidate.fact_id, null);
});

test('a high confidence score does not shortcut review', async () => {
  const { db, ctx, org, storage } = world();
  const doc = upload(ctx, org, storage, 'deck.pdf', 'DECK');

  await ext.runExtraction(ctx, org.id, doc.id, extractorFor({
    [doc.storage_key]: [{ ...DECK_CANDIDATES[0], confidence: 1 }],
  }));

  assert.equal(db.count('fact', { org_id: org.id }), 0);
  assert.equal(db.find('extraction_candidate', { org_id: org.id })[0].confidence, 1,
    'confidence is stored and shown; it gates nothing');
});

test('REGRESSION: perfect confidence does not exempt a figure from being seen', async () => {
  const { db, ctx, org, storage } = world();
  const doc = upload(ctx, org, storage, 'deck.pdf', 'DECK');

  // The obvious "optimisation" is to let anything the extractor is sure about
  // through without review. Mutation testing found that the earlier version of
  // this file would not have noticed, because every fixture sat below the
  // threshold somebody might pick.
  await ext.runExtraction(ctx, org.id, doc.id, extractorFor({
    [doc.storage_key]: [
      { ...DECK_CANDIDATES[0], confidence: 1 },
      { ...DECK_CANDIDATES[1], confidence: 0.99 },
    ],
  }));
  const run = db.findOne('extraction', { document_id: doc.id });

  expectRefusal(() => ext.bulkConfirm(ctx, org.id, run.id), 'unreviewed_candidates', 409);
  assert.equal(db.count('fact', { org_id: org.id }), 0);
});

test('a candidate that tries to describe its own provenance is refused outright', () => {
  // The candidate table has no `source` column today, so this cannot happen —
  // which is exactly why it is guarded explicitly rather than left to the
  // schema, where a future migration could quietly remove the protection.
  assert.throws(
    () => domain.candidateToFactInput({
      fact_key: 'financials.arr', label: 'ARR', value_numeric: 1, document_id: 'd1',
      source: 'USER_CONFIRMED',
    }),
    (err) => err.code === 'candidate_claims_provenance',
  );
  assert.throws(
    () => domain.candidateToFactInput({
      fact_key: 'financials.arr', label: 'ARR', value_numeric: 1, document_id: 'd1',
      confirmed_by: 'the-model',
    }),
    (err) => err.code === 'candidate_claims_provenance',
  );
});

// ──────────────────────────────────────────────────────────── bulk confirm ──

test('bulk confirm refuses candidates that have never been displayed', async () => {
  const { db, ctx, org, storage } = world();
  const doc = upload(ctx, org, storage, 'deck.pdf', 'DECK');
  await ext.runExtraction(ctx, org.id, doc.id, extractorFor({ [doc.storage_key]: [...DECK_CANDIDATES] }));
  const run = db.findOne('extraction', { document_id: doc.id });

  // No getExtraction() call, so viewed_at is unset on every row.
  expectRefusal(() => ext.bulkConfirm(ctx, org.id, run.id), 'unreviewed_candidates', 409);
  assert.equal(db.count('fact', { org_id: org.id }), 0);
});

test('bulk confirm works once the figures have actually been served', async () => {
  const { db, ctx, org, storage } = world();
  const doc = upload(ctx, org, storage, 'deck.pdf', 'DECK');
  await ext.runExtraction(ctx, org.id, doc.id, extractorFor({ [doc.storage_key]: [...DECK_CANDIDATES] }));
  const run = db.findOne('extraction', { document_id: doc.id });

  const view = ext.getExtraction(ctx, org.id, run.id).body;
  assert.ok(view.candidates.every((c) => c.viewed_at), 'the server stamps what it served');

  assert.equal(ext.bulkConfirm(ctx, org.id, run.id).body.confirmed, 3);
  assert.equal(db.count('fact', { org_id: org.id }), 3);
  assert.equal(db.get('extraction', run.id).state, 'REVIEWED');
});

// ───────────────────────────────────────────────────── editing and rejecting ──

test('a corrected figure records both what was read and what was confirmed', async () => {
  const { db, ctx, org, storage } = world();
  const doc = upload(ctx, org, storage, 'deck.pdf', 'DECK');
  await ext.runExtraction(ctx, org.id, doc.id, extractorFor({ [doc.storage_key]: [DECK_CANDIDATES[0]] }));
  const candidate = db.find('extraction_candidate', { org_id: org.id })[0];

  const { body } = ext.decideCandidate(ctx, org.id, candidate.id, {
    decision: 'CONFIRM', edits: { value_numeric: 4_050_000 },
  });

  assert.equal(body.candidate.state, 'EDITED_CONFIRMED');
  assert.equal(body.candidate.value_numeric, 4_200_000, 'the extraction is left on the record');
  assert.equal(body.fact.value_numeric, 4_050_000, 'the fact carries the human figure');

  const entry = db.find('audit_log', { org_id: org.id })
    .find((a) => a.action === 'extraction.candidate_confirmed');
  const meta = JSON.parse(entry.metadata);
  assert.equal(meta.edited, true);
  assert.equal(meta.extractor_value, 4_200_000);
  assert.equal(meta.confirmed_value, 4_050_000);
});

test('rejecting requires a reason and writes no fact', async () => {
  const { db, ctx, org, storage } = world();
  const doc = upload(ctx, org, storage, 'deck.pdf', 'DECK');
  await ext.runExtraction(ctx, org.id, doc.id, extractorFor({ [doc.storage_key]: [DECK_CANDIDATES[0]] }));
  const candidate = db.find('extraction_candidate', { org_id: org.id })[0];

  expectRefusal(() => ext.decideCandidate(ctx, org.id, candidate.id, { decision: 'REJECT' }),
    'reject_reason_required', 400);

  const { body } = ext.decideCandidate(ctx, org.id, candidate.id,
    { decision: 'REJECT', reason: 'superseded by the December accounts' });
  assert.equal(body.candidate.state, 'REJECTED');
  assert.equal(body.fact, null);
  assert.equal(db.count('fact', { org_id: org.id }), 0);
});

test('a decided candidate cannot be decided twice', async () => {
  const { db, ctx, org, storage } = world();
  const doc = upload(ctx, org, storage, 'deck.pdf', 'DECK');
  await ext.runExtraction(ctx, org.id, doc.id, extractorFor({ [doc.storage_key]: [DECK_CANDIDATES[0]] }));
  const candidate = db.find('extraction_candidate', { org_id: org.id })[0];

  ext.decideCandidate(ctx, org.id, candidate.id, { decision: 'CONFIRM' });
  expectRefusal(() => ext.decideCandidate(ctx, org.id, candidate.id, { decision: 'CONFIRM' }),
    'already_decided', 409);
  assert.equal(db.count('fact', { org_id: org.id }), 1);
});

// ──────────────────────────────────────────────────── honest unreadability ──

test('a scan is declared unreadable rather than guessed at', async () => {
  const { db, ctx, org, storage } = world();
  const doc = upload(ctx, org, storage, 'scanned-accounts.pdf', 'ACCOUNTS');

  const extractor = fakeExtractor({
    probe: { [doc.storage_key]: SCANNED_PROBE },
    // The extractor would happily return figures. It is never asked.
    candidates: { [doc.storage_key]: [...ACCOUNTS_CANDIDATES] },
  });

  const { body } = await ext.runExtraction(ctx, org.id, doc.id, extractor);

  assert.equal(body.supported, false);
  assert.equal(body.reason, 'SCANNED_OR_IMAGE_ONLY');
  assert.match(body.message, /scan or an image-only PDF/);
  assert.equal(body.candidates.length, 0);
  assert.equal(db.count('extraction_candidate', { org_id: org.id }), 0,
    'the extractor is not run over a file we cannot honestly read');
  assert.equal(db.get('document', doc.id).extract_state, 'UNSUPPORTED');
});

test('an encrypted file says so instead of failing vaguely', async () => {
  const { ctx, org, storage } = world();
  const doc = upload(ctx, org, storage, 'locked.pdf');
  const extractor = fakeExtractor({
    probe: { [doc.storage_key]: { pages: 4, textCharacters: 9_000, encrypted: true } },
  });

  const { body } = await ext.runExtraction(ctx, org.id, doc.id, extractor);
  assert.equal(body.reason, 'PASSWORD_PROTECTED');
});

test('a text page on the front of a scan does not rescue the other 59', () => {
  // Measured per page, not in total: 4,000 characters across 60 pages is a
  // cover sheet and a scan, and a total-characters check would wave it through.
  assert.equal(
    domain.extractabilityOf({ mimeType: PDF, pages: 60, textCharacters: 4_000 }).reason,
    'SCANNED_OR_IMAGE_ONLY',
  );
  assert.equal(domain.extractabilityOf({ mimeType: PDF, pages: 60, textCharacters: 40_000 }).supported, true);
});

// ────────────────────────────────────────────── malformed extractor output ──

test('a candidate with no locator is refused and reported, never stored', async () => {
  const { db, ctx, org, storage } = world();
  const doc = upload(ctx, org, storage, 'deck.pdf', 'DECK');

  const { body } = await ext.runExtraction(ctx, org.id, doc.id, extractorFor({
    [doc.storage_key]: [MALFORMED_CANDIDATES.noLocator, DECK_CANDIDATES[0]],
  }));

  assert.equal(body.candidates.length, 1, 'the good one is kept');
  assert.equal(body.rejected_candidates.length, 1);
  assert.equal(body.rejected_candidates[0].code, 'candidate_missing_locator');
  assert.equal(db.count('extraction_candidate', { org_id: org.id }), 1);
});

test('malformed candidates are reported rather than dropped silently', async () => {
  const { ctx, org, storage } = world();
  const doc = upload(ctx, org, storage, 'deck.pdf', 'DECK');

  const { body } = await ext.runExtraction(ctx, org.id, doc.id, extractorFor({
    [doc.storage_key]: [
      MALFORMED_CANDIDATES.noValue, MALFORMED_CANDIDATES.noKey, MALFORMED_CANDIDATES.noLocator,
    ],
  }));

  assert.equal(body.candidates.length, 0);
  assert.deepEqual(body.rejected_candidates.map((r) => r.code).sort(), [
    'candidate_missing_key', 'candidate_missing_locator', 'candidate_missing_value',
  ]);
});

test('an extractor that will not identify itself is not trusted with a document', async () => {
  const { ctx, org, storage } = world();
  const doc = upload(ctx, org, storage, 'deck.pdf', 'DECK');
  await assert.rejects(
    () => ext.runExtraction(ctx, org.id, doc.id, { version: '1', probe: () => {}, extract: () => {} }),
    (err) => err.code === 'extractor_unidentified',
  );
});

test('the extractor identity is stored on the run', async () => {
  const { db, ctx, org, storage } = world();
  const doc = upload(ctx, org, storage, 'deck.pdf', 'DECK');
  await ext.runExtraction(ctx, org.id, doc.id,
    fakeExtractor({ candidates: { [doc.storage_key]: [DECK_CANDIDATES[0]] } },
      { id: 'anthropic-doc-v1', version: '2026-10-01' }));

  const run = db.findOne('extraction', { document_id: doc.id });
  assert.equal(run.extractor_id, 'anthropic-doc-v1');
  assert.equal(run.extractor_version, '2026-10-01',
    'which reader produced this is part of the provenance of everything it returned');
});

// ──────────────────────────────────────────────────────────── housekeeping ──

test('two extraction runs cannot be open on the same document at once', async () => {
  const { ctx, org, storage } = world();
  const doc = upload(ctx, org, storage, 'deck.pdf', 'DECK');
  const extractor = extractorFor({ [doc.storage_key]: [...DECK_CANDIDATES] });

  await ext.runExtraction(ctx, org.id, doc.id, extractor);
  await assert.rejects(() => ext.runExtraction(ctx, org.id, doc.id, extractor),
    (err) => err.code === 'extraction_in_progress' && err.status === 409);
});

test('a document that was never uploaded cannot be extracted', async () => {
  const { ctx, org, storage } = world();
  const doc = svc.createUploadTicket(ctx, org.id, {
    filename: 'abandoned.pdf', size_bytes: 1_000, mime_type: PDF,
  }, storage).body.document;

  await assert.rejects(() => ext.runExtraction(ctx, org.id, doc.id, extractorFor({})),
    (err) => err.code === 'upload_incomplete');
});

test('a viewer cannot confirm a figure', async () => {
  const { db, ctx, org, storage } = world();
  const doc = upload(ctx, org, storage, 'deck.pdf', 'DECK');
  await ext.runExtraction(ctx, org.id, doc.id, extractorFor({ [doc.storage_key]: [DECK_CANDIDATES[0]] }));
  const candidate = db.find('extraction_candidate', { org_id: org.id })[0];

  db.insert('membership', {
    org_id: org.id, user_id: 'u-viewer', email: 'v@example.com', role: 'VIEWER', created_at: '2026-01-01',
  });
  const viewer = ctxFor(db, 'u-viewer');

  expectRefusal(() => ext.decideCandidate(viewer, org.id, candidate.id, { decision: 'CONFIRM' }),
    'forbidden', 403);
});

test("a candidate from another organisation is a 404, not a 403", async () => {
  const { db, ctx, org, storage } = world();
  const doc = upload(ctx, org, storage, 'deck.pdf', 'DECK');
  await ext.runExtraction(ctx, org.id, doc.id, extractorFor({ [doc.storage_key]: [DECK_CANDIDATES[0]] }));
  const candidate = db.find('extraction_candidate', { org_id: org.id })[0];

  // An EDITOR elsewhere, so the role gate passes and the org check is the thing
  // actually being exercised.
  const other = ctxFor(db, 'u-other');
  const otherOrg = svc.createOrganisation(other, { name: 'Other Co' }).body.organisation;
  db.update('membership', db.findOne('membership', { org_id: otherOrg.id, user_id: 'u-other' }).id,
    { role: 'EDITOR' });

  expectRefusal(() => ext.decideCandidate(other, otherOrg.id, candidate.id, { decision: 'CONFIRM' }),
    'not_found', 404);
});

// ─────────────────────────────────────────────────────────── classification ──

test('classification is a suggestion with a stated basis, never applied silently', () => {
  const deck = domain.classifyDocument({ filename: 'Acme-pitch-deck-v4.pdf', mimeType: PDF });
  assert.equal(deck.kind, 'DECK');
  assert.equal(deck.needs_confirmation, true);
  assert.match(deck.basis, /filename contains/);

  const declared = domain.classifyDocument({ filename: 'anything.pdf', declaredKind: 'CAP_TABLE' });
  assert.equal(declared.kind, 'CAP_TABLE');
  assert.equal(declared.confidence, 1);
  assert.equal(declared.needs_confirmation, false, 'a user override is not second-guessed');

  const unknown = domain.classifyDocument({ filename: 'scan0001.pdf', mimeType: PDF });
  assert.equal(unknown.kind, 'OTHER');
  assert.equal(unknown.confidence, 0);
});

test('progress is only complete when every candidate has been decided', () => {
  const p = domain.reviewProgress([
    { state: 'CONFIRMED' }, { state: 'REJECTED' }, { state: 'AWAITING_REVIEW' },
  ]);
  assert.equal(p.awaiting, 1);
  assert.equal(p.complete, false, 'there is no "reviewed enough"');

  assert.equal(domain.reviewProgress([{ state: 'EDITED_CONFIRMED' }]).complete, true);
  assert.equal(domain.reviewProgress([]).complete, false, 'an empty run is not a review');
});
