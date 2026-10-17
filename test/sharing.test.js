/**
 * Phase 8 — live sharing.
 *
 * This is the largest security surface in the product: a path into a company's
 * data room that does not go through membership at all. Most of these tests are
 * about what a token cannot do.
 *
 * The other half is a trust property rather than a security one — that a
 * document never changes under a reader who was not told. An investor who finds
 * a figure moved on their own does not weigh the figure; they weigh what else
 * might have moved quietly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, ctxFor, expectRefusal, fakeStorage } from './helpers.js';
import * as svc from '../src/api/service.js';
import * as artifacts from '../src/api/artifacts.js';
import * as dataroom from '../src/api/dataroom.js';
import * as freshness from '../src/api/freshness.js';
import * as api from '../src/api/sharing.js';
import {
  mintToken, hashToken, looksLikeToken, accessDecision, resolveExpiry,
  similarQuestions, consistencyWarning, downloadPosture, notificationDraft,
  normaliseTokens, SHARE_MODES, DEFAULT_EXPIRY_DAYS, MAX_EXPIRY_DAYS,
} from '../src/domain/sharing.js';

function world() {
  const db = freshDb();
  const ctx = ctxFor(db, 'u-owner');
  const storage = fakeStorage();
  const org = svc.createOrganisation(ctx, { name: 'Northwind Systems', path: 'RAISE' }).body.organisation;
  return { db, ctx, org, storage };
}

/** An org with a generated artifact to share. */
function withArtifact(ctx, org, storage) {
  const d = svc.createUploadTicket(ctx, org.id, {
    filename: 'accounts.pdf', size_bytes: 1_000, mime_type: 'application/pdf', kind: 'ACCOUNTS',
  }, storage).body.document;
  svc.confirmUpload(ctx, org.id, d.id);

  const revenue = svc.createFact(ctx, org.id, {
    fact_key: 'financials.revenue.ttm', label: 'Revenue', value_numeric: 3_600_000, unit: 'USD',
    source: 'USER_CONFIRMED', source_doc_id: d.id, source_page: 4,
  }).body.fact;
  svc.createFact(ctx, org.id, {
    fact_key: 'company.name', label: 'Registered name',
    value_text: 'Northwind Systems Inc.', source: 'USER_ENTERED',
  });

  const artifact = artifacts.generate(ctx, org.id, 'FINANCIAL_SUMMARY').body.artifact;
  return { artifact, revenue };
}

const shareArtifact = (ctx, orgId, artifactId, extra = {}) =>
  api.createShare(ctx, orgId, {
    subject_kind: 'ARTIFACT', artifact_id: artifactId,
    recipient_name: 'J. Ellery', recipient_org: 'Harbour Ventures', ...extra,
  }).body;

/** A recipient context: a database and a clock, and deliberately no auth. */
const recipientCtx = (db) => ({ db, now: ctxFor(db, 'x').now });

// ───────────────────────────────────────────────────────── tokens ──

test('the raw token is never stored anywhere', () => {
  const { db, ctx, org, storage } = world();
  const { artifact } = withArtifact(ctx, org, storage);
  const { token, share } = shareArtifact(ctx, org.id, artifact.id);

  const row = db.get('share', share.id);
  const everything = JSON.stringify(row);

  assert.ok(token.length >= 40, 'a short token is a guessable token');
  assert.ok(!everything.includes(token),
    'a leaked database must not hand anyone a working link into a data room');
  assert.equal(row.token_hash, hashToken(token));
  assert.equal(row.token_prefix.length, 8, 'the prefix is for telling links apart, not for access');
  assert.ok(!token.startsWith(row.token_hash));
});

test('the token is not returned again after it is minted', () => {
  const { ctx, org, storage } = world();
  const { artifact } = withArtifact(ctx, org, storage);
  shareArtifact(ctx, org.id, artifact.id);

  const listed = api.listShares(ctx, org.id).body.shares[0];
  assert.equal(listed.token, undefined);
  assert.equal(listed.token_hash, undefined, 'the hash has no reason to leave the database');
  assert.ok(listed.token_prefix);
});

test('two tokens are never the same', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(mintToken().token);
  assert.equal(seen.size, 200);
});

test('rubbish is rejected before it reaches the database', () => {
  assert.equal(looksLikeToken('short'), false);
  assert.equal(looksLikeToken(null), false);
  assert.equal(looksLikeToken("' OR 1=1 --"), false);
  assert.equal(looksLikeToken(mintToken().token), true);
});

test('a token that resolves to nothing says nothing', () => {
  const { db, ctx, org, storage } = world();
  const { artifact } = withArtifact(ctx, org, storage);
  shareArtifact(ctx, org.id, artifact.id);

  const res = api.openShare(recipientCtx(db), mintToken().token);
  assert.equal(res.status, 404);
  assert.equal(res.body.allowed, false);
  assert.equal(res.body.says, 'This link is not valid.');
  assert.equal(res.body.company, undefined, 'a wrong token must not confirm a company exists');
});

// ────────────────────────────────────────── revocation and expiry ──

test('revocation kills the link immediately', () => {
  const { db, ctx, org, storage } = world();
  const { artifact } = withArtifact(ctx, org, storage);
  const { token, share } = shareArtifact(ctx, org.id, artifact.id);

  assert.equal(api.openShare(recipientCtx(db), token).body.allowed, true);

  api.revokeShare(ctx, org.id, share.id, { reason: 'Process closed' });
  const after = api.openShare(recipientCtx(db), token);

  assert.equal(after.status, 403);
  assert.equal(after.body.code, 'revoked');
  assert.match(after.body.says, /withdrawn by the company/);
});

test('the reason a link was withdrawn is not shown to the person it was withdrawn from', () => {
  // ───────────────────────────────────────────────────────────────────────────
  // THIS TEST REVERSES AN EARLIER DECISION, DELIBERATELY
  //
  // The first version of `accessDecision` appended `Reason given: …` to what the
  // recipient sees, on the reasoning that a withdrawal is more courteous with an
  // explanation, and this test asserted it.
  //
  // It is the wrong call, because of who writes that field and when. It is a
  // free-text box next to a Revoke button, filled in by somebody inside the
  // company at the moment they cut off a counterparty, and it goes into their
  // own audit trail. What gets typed there is "going with the other bidder",
  // "forwarded our deck to a competitor", or the name of whoever asked for the
  // link to be pulled. A company that found out the product had been showing
  // that to the counterparty would be right to be angry, and nothing in the
  // interface ever suggested it would be.
  //
  // Courtesy is still available: the recipient is told access was withdrawn and
  // to ask the company. What they are not given is the company's note to itself.
  const { db, ctx, org, storage } = world();
  const { artifact } = withArtifact(ctx, org, storage);
  const { token, share } = shareArtifact(ctx, org.id, artifact.id);

  api.revokeShare(ctx, org.id, share.id, {
    reason: 'They forwarded the deck to a competitor',
  });

  const after = api.openShare(recipientCtx(db), token);
  assert.ok(!after.body.says.includes('forwarded'), 'the internal reason reached the recipient');
  assert.ok(!after.body.says.includes('competitor'), 'the internal reason reached the recipient');
  assert.match(after.body.says, /ask them for a new link/, 'the recipient was left with nothing to do');

  // And it is still on the company's own record, which is what it was for.
  assert.equal(
    db.get('share', share.id).revoke_reason,
    'They forwarded the deck to a competitor',
  );
  const entry = db.find('audit_log', { org_id: org.id })
    .find((a) => a.action === 'share.revoked');
  assert.match(entry.metadata, /forwarded the deck/);
});

test('revoking says what it does and does not do', () => {
  const { ctx, org, storage } = world();
  const { artifact } = withArtifact(ctx, org, storage);
  const { share } = shareArtifact(ctx, org.id, artifact.id);

  const res = api.revokeShare(ctx, org.id, share.id, { reason: 'x' });
  assert.match(res.body.note, /does not recall a copy/);
  expectRefusal(() => api.revokeShare(ctx, org.id, share.id, {}), 'already_revoked', 409);
});

test('an expired link stops working and says when it expired', () => {
  const share = { expires_at: '2026-01-01T00:00:00.000Z', revoked_at: null };
  const decision = accessDecision(share, { now: '2026-06-01T00:00:00.000Z' });

  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'expired');
  assert.match(decision.says, /expired on 2026-01-01/);
});

test('every link has an expiry, and it cannot be set beyond a year', () => {
  const now = '2026-01-01T00:00:00.000Z';
  const fallback = resolveExpiry(null, now);
  const days = (Date.parse(fallback) - Date.parse(now)) / 86_400_000;
  assert.equal(days, DEFAULT_EXPIRY_DAYS, 'a link with no expiry outlives the process that justified it');

  assert.throws(() => resolveExpiry('2025-01-01', now), (e) => e.code === 'expiry_in_past');
  assert.throws(() => resolveExpiry('2030-01-01', now), (e) => e.code === 'expiry_too_far');
  assert.ok(MAX_EXPIRY_DAYS <= 365);
});

test('a revoked link is refused before an expired one is considered', () => {
  // Both true at once. Revocation is the more deliberate act and the more
  // useful thing to tell someone.
  const decision = accessDecision(
    { revoked_at: '2026-02-01', expires_at: '2026-01-01', revoke_reason: 'Process closed' },
    { now: '2026-06-01' },
  );
  assert.equal(decision.code, 'revoked');
});

// ──────────────────────────────── the document does not move under you ──

test('a pinned share keeps showing what was sent, even after regeneration', () => {
  // The trust property. A reader who finds a figure changed without being told
  // does not weigh the figure; they weigh what else moved quietly.
  const { db, ctx, org, storage } = world();
  const { artifact, revenue } = withArtifact(ctx, org, storage);
  const { token } = shareArtifact(ctx, org.id, artifact.id);

  const before = api.openShare(recipientCtx(db), token).body;
  assert.equal(before.document.id, artifact.id);

  svc.supersedeFact(ctx, org.id, revenue.id, { value_numeric: 3_400_000 });
  freshness.regenerate(ctx, org.id, artifact.id);

  const after = api.openShare(recipientCtx(db), token).body;
  assert.equal(after.document.id, artifact.id,
    'the recipient keeps seeing what they were sent until it is published to them');
  assert.equal(after.mode.id, 'PINNED');
});

test('follow-latest moves, and the page says that it does', () => {
  const { db, ctx, org, storage } = world();
  const { artifact, revenue } = withArtifact(ctx, org, storage);
  const { token } = shareArtifact(ctx, org.id, artifact.id, { share_mode: 'FOLLOW_LATEST' });

  svc.supersedeFact(ctx, org.id, revenue.id, { value_numeric: 3_400_000 });
  const next = freshness.regenerate(ctx, org.id, artifact.id).body.artifact;

  const opened = api.openShare(recipientCtx(db), token).body;
  assert.equal(opened.document.id, next.id);
  assert.match(opened.mode.means, /always sees the current version, and the page says so/,
    'a reader must always know which of the two modes they are holding');
});

test('every view carries an "as at" date and the mode', () => {
  const { db, ctx, org, storage } = world();
  const { artifact } = withArtifact(ctx, org, storage);
  const { token } = shareArtifact(ctx, org.id, artifact.id);

  const body = api.openShare(recipientCtx(db), token).body;
  assert.ok(body.as_at, 'a reader is entitled to know how old what they are reading is');
  assert.ok(SHARE_MODES.some((m) => m.id === body.mode.id));
  assert.ok(body.expires_at);
});

test('a superseded pinned share appears in pending updates, with the message written', () => {
  const { ctx, org, storage } = world();
  const { artifact, revenue } = withArtifact(ctx, org, storage);
  shareArtifact(ctx, org.id, artifact.id);

  svc.supersedeFact(ctx, org.id, revenue.id, { value_numeric: 3_400_000 });
  freshness.regenerate(ctx, org.id, artifact.id);

  const body = api.pendingUpdates(ctx, org.id).body;
  assert.equal(body.count, 1);
  assert.equal(body.pending[0].figures_moving, 1);
  assert.match(body.pending[0].draft.body, /Revenue: 3600000 → 3400000/);
  assert.match(body.pending[0].draft.why, /weigh what else might have moved/);
  assert.match(body.headline, /holding a version that has since been superseded/);
});

test('publishing an update moves the pinned version and reminds you to say so', () => {
  const { db, ctx, org, storage } = world();
  const { artifact, revenue } = withArtifact(ctx, org, storage);
  const { token, share } = shareArtifact(ctx, org.id, artifact.id);

  svc.supersedeFact(ctx, org.id, revenue.id, { value_numeric: 3_400_000 });
  const next = freshness.regenerate(ctx, org.id, artifact.id).body.artifact;

  const res = api.publishUpdate(ctx, org.id, share.id);
  assert.match(res.body.reminder, /the link will not do it for you/);

  assert.equal(api.openShare(recipientCtx(db), token).body.document.id, next.id);
});

test('there is nothing to publish when nothing has changed', () => {
  const { ctx, org, storage } = world();
  const { artifact } = withArtifact(ctx, org, storage);
  const { share } = shareArtifact(ctx, org.id, artifact.id);
  expectRefusal(() => api.publishUpdate(ctx, org.id, share.id), 'nothing_to_publish', 409);
});

test('sharing marks the artifact released, so Phase 7 grades it as urgent', () => {
  const { ctx, org, storage } = world();
  const { artifact, revenue } = withArtifact(ctx, org, storage);
  shareArtifact(ctx, org.id, artifact.id);

  svc.supersedeFact(ctx, org.id, revenue.id, { value_numeric: 3_400_000 });
  const health = freshness.artifactHealth(ctx, org.id).body;
  const row = health.artifacts.find((a) => a.id === artifact.id);

  assert.equal(row.released, true, 'sharing is releasing');
  assert.equal(row.severity, 'URGENT');
});

// ────────────────────────────────────────────────── staged visibility ──

test('a room link shows only what the recipient’s stage allows', () => {
  const { db, ctx, org, storage } = world();
  dataroom.buildRoom(ctx, org.id);

  const early = api.createShare(ctx, org.id, {
    subject_kind: 'ROOM', stage: 'PRE_MEETING', recipient_name: 'J. Ellery',
  }).body;
  const late = api.createShare(ctx, org.id, {
    subject_kind: 'ROOM', stage: 'CONFIRMATORY', recipient_name: 'K. Moss',
  }).body;

  const earlyRoom = api.openShare(recipientCtx(db), early.token).body.room;
  const lateRoom = api.openShare(recipientCtx(db), late.token).body.room;

  assert.ok(earlyRoom.folders.length < lateRoom.folders.length,
    'an early-stage counterparty sees less than a confirmatory one');
  assert.ok(earlyRoom.withheld_count > 0);
  assert.match(earlyRoom.note, /open at later stages/);
});

test('a room link must say which stage, decided up front', () => {
  const { ctx, org } = world();
  const err = expectRefusal(() => api.createShare(ctx, org.id, {
    subject_kind: 'ROOM', recipient_name: 'J. Ellery',
  }), 'invalid_stage', 400);
  assert.match(err.message, /Deciding that at the point of a request produces inconsistent disclosure/);
});

test('a room link never exposes an item with no document behind it', () => {
  const { db, ctx, org } = world();
  dataroom.buildRoom(ctx, org.id);
  const { token } = api.createShare(ctx, org.id, {
    subject_kind: 'ROOM', stage: 'CONFIRMATORY', recipient_name: 'J. Ellery',
  }).body;

  const room = api.openShare(recipientCtx(db), token).body.room;
  for (const folder of room.folders) {
    for (const item of folder.items) {
      assert.ok(item.document_id, 'a missing item must not be listed to a counterparty');
    }
  }
});

test('a link must name its recipient', () => {
  const { ctx, org, storage } = world();
  const { artifact } = withArtifact(ctx, org, storage);
  const err = expectRefusal(() => api.createShare(ctx, org.id, {
    subject_kind: 'ARTIFACT', artifact_id: artifact.id, recipient_name: '',
  }), 'recipient_required', 400);
  assert.match(err.message, /cannot be withdrawn from anybody in particular/);
});

// ───────────────────────────────────── access log and watermarking ──

test('every opening is logged against the recipient', () => {
  const { db, ctx, org, storage } = world();
  const { artifact } = withArtifact(ctx, org, storage);
  const { token } = shareArtifact(ctx, org.id, artifact.id);

  api.openShare(recipientCtx(db), token, { clientFamily: 'desktop browser' });
  api.openShare(recipientCtx(db), token);

  const record = api.accessRecord(ctx, org.id).body;
  assert.equal(record.access[0].recipient, 'J. Ellery');
  assert.equal(record.access[0].opens, 2);
  assert.ok(record.access[0].first_opened_at);
  assert.equal(record.criterion, '8.3');

  // Which version they saw is the part that matters six weeks later, when a
  // figure has moved and the question is what this person was actually shown.
  assert.equal(record.access[0].versions_seen, 1);
  const view = db.find('share_view', { org_id: org.id })[0];
  assert.equal(view.artifact_id, artifact.id);
});

test('no IP address is recorded anywhere', () => {
  const { db, ctx, org, storage } = world();
  const { artifact } = withArtifact(ctx, org, storage);
  const { token } = shareArtifact(ctx, org.id, artifact.id);
  api.openShare(recipientCtx(db), token, { clientFamily: 'desktop browser' });

  const view = db.find('share_view', { org_id: org.id })[0];
  assert.equal(view.client_family, 'desktop browser');
  assert.equal(Object.keys(view).some((k) => /ip|address/i.test(k)), false);
  assert.match(api.accessRecord(ctx, org.id).body.privacy_note, /No IP addresses are recorded/);
});

test('a view can be closed to give the log a duration', () => {
  const { db, ctx, org, storage } = world();
  const { artifact } = withArtifact(ctx, org, storage);
  const { token } = shareArtifact(ctx, org.id, artifact.id);

  const rctx = recipientCtx(db);
  const viewId = api.openShare(rctx, token).body.view_id;
  const closed = api.closeShareView(rctx, token, viewId).body.view;

  assert.ok(closed.closed_at);
  assert.ok(closed.duration_seconds >= 0);
});

test('the copy carries the recipient’s name, and the product does not overclaim', () => {
  const { db, ctx, org, storage } = world();
  const { artifact } = withArtifact(ctx, org, storage);
  const { token } = shareArtifact(ctx, org.id, artifact.id, { allow_download: false });

  const body = api.openShare(recipientCtx(db), token).body;
  assert.equal(body.watermark.line1, 'J. Ellery');
  assert.match(body.watermark.footer, /Harbour Ventures|J\. Ellery/);

  assert.equal(body.download.download, false);
  assert.match(body.download.note, /not protection/,
    'claiming a download toggle prevents copying is worse than not having it');
  assert.match(downloadPosture(true).note, /watermarked copy/);
});

test('a refused attempt is logged against the organisation', () => {
  const { db, ctx, org, storage } = world();
  const { artifact } = withArtifact(ctx, org, storage);
  const { token, share } = shareArtifact(ctx, org.id, artifact.id);
  api.revokeShare(ctx, org.id, share.id, { reason: 'closed' });
  api.openShare(recipientCtx(db), token);

  const refusals = db.find('audit_log', { org_id: org.id })
    .filter((a) => a.action === 'share.access_refused');
  assert.equal(refusals.length, 1);
});

// ───────────────────────────────────────────────── the question log ──

test('a question asked through a link lands in the log', () => {
  const { db, ctx, org, storage } = world();
  const { artifact } = withArtifact(ctx, org, storage);
  const { token } = shareArtifact(ctx, org.id, artifact.id);

  api.askThroughShare(recipientCtx(db), token, {
    question: 'How is net revenue retention calculated?',
  });

  const log = api.questionLog(ctx, org.id).body;
  assert.equal(log.questions.length, 1);
  assert.equal(log.questions[0].asked_by, 'J. Ellery');
  assert.equal(log.unanswered, 1);
  assert.match(log.basis, /inconsistency between two answers is more damaging/);
});

test('answering surfaces what was already told to somebody else', () => {
  const { db, ctx, org, storage } = world();
  const { artifact } = withArtifact(ctx, org, storage);
  const first = shareArtifact(ctx, org.id, artifact.id);
  const second = shareArtifact(ctx, org.id, artifact.id, { recipient_name: 'K. Moss' });

  const q1 = api.askThroughShare(recipientCtx(db), first.token, {
    question: 'How is net revenue retention calculated?',
  }).body.question;
  api.answerQuestion(ctx, org.id, q1.id, {
    answer: 'Revenue retention is measured on a trailing twelve month basis excluding new logos.',
  });

  const q2 = api.askThroughShare(recipientCtx(db), second.token, {
    question: 'What basis is used to calculate revenue retention?',
  }).body.question;

  const draft = api.draftAnswer(ctx, org.id, q2.id, {}).body;
  assert.equal(draft.similar.length, 1);
  assert.match(draft.similar[0].answer, /trailing twelve month/);
});

test('a different answer to a similar question is flagged, not blocked', () => {
  const { db, ctx, org, storage } = world();
  const { artifact } = withArtifact(ctx, org, storage);
  const first = shareArtifact(ctx, org.id, artifact.id);
  const second = shareArtifact(ctx, org.id, artifact.id, { recipient_name: 'K. Moss' });

  const q1 = api.askThroughShare(recipientCtx(db), first.token, {
    question: 'How is revenue retention calculated please?',
  }).body.question;
  api.answerQuestion(ctx, org.id, q1.id, {
    answer: 'Measured on a trailing twelve month basis excluding new logos entirely.',
  });

  const q2 = api.askThroughShare(recipientCtx(db), second.token, {
    question: 'How is revenue retention calculated exactly?',
  }).body.question;
  const res = api.answerQuestion(ctx, org.id, q2.id, {
    answer: 'Calculated quarterly from gross bookings including every customer signed.',
  });

  assert.ok(res.body.warning, 'two different answers to one question is the damaging outcome');
  assert.equal(res.body.warning.code, 'possible_inconsistency');
  assert.match(res.body.warning.says, /whether you can be relied on/);
  // Recorded anyway. Deciding whether two prose answers mean the same thing is
  // a judgement a product would get wrong often and confidently.
  assert.ok(res.body.question.answer);
});

test('a consistent answer raises nothing', () => {
  const similar = [{
    question: 'How is revenue retention calculated?',
    answer: 'Measured on a trailing twelve month basis excluding new logos.',
    answered_at: '2026-01-01', score: 0.8,
  }];
  const consistent = consistencyWarning(
    'Measured on a trailing twelve month basis excluding new logos.', similar);
  assert.equal(consistent, null);
  assert.equal(consistencyWarning('anything at all', []), null);
});

test('a rephrased question reduces to the same stem', () => {
  // The stemming is load-bearing and the end-to-end test did not prove it:
  // stopword removal alone kept the pair above the threshold, so the rule
  // could have been deleted without anything failing.
  const a = normaliseTokens('How is net revenue retention calculated?');
  const b = normaliseTokens('What basis is used to calculate revenue retention?');

  const shared = [...a].filter((t) => b.has(t));
  assert.ok(shared.includes('calculat'),
    '"calculate" and "calculated" are the same word asked twice');
  assert.ok(shared.includes('revenu'));
  assert.ok(shared.includes('retention'));
});

test('only answered questions are offered as precedent', () => {
  const previous = [
    { id: 'a', question: 'How is revenue retention calculated?', answer: null },
    { id: 'b', question: 'How is revenue retention calculated?', answer: 'On a trailing basis.' },
  ];
  const hits = similarQuestions('How is revenue retention calculated?', previous);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'b', 'an unanswered question is not a precedent');
});

test('a question cannot be answered twice', () => {
  const { db, ctx, org, storage } = world();
  const { artifact } = withArtifact(ctx, org, storage);
  const { token } = shareArtifact(ctx, org.id, artifact.id);
  const q = api.askThroughShare(recipientCtx(db), token, {
    question: 'What is the churn definition?',
  }).body.question;

  api.answerQuestion(ctx, org.id, q.id, { answer: 'Logo churn, measured monthly.' });
  expectRefusal(() => api.answerQuestion(ctx, org.id, q.id, { answer: 'Something else.' }),
    'already_answered', 409);
});

test('a revoked link cannot ask questions', () => {
  const { db, ctx, org, storage } = world();
  const { artifact } = withArtifact(ctx, org, storage);
  const { token, share } = shareArtifact(ctx, org.id, artifact.id);
  api.revokeShare(ctx, org.id, share.id, { reason: 'closed' });

  const res = api.askThroughShare(recipientCtx(db), token, { question: 'Still there?' });
  assert.equal(res.status, 403);
  assert.equal(res.body.allowed, false);
});

// ────────────────────────────────────────── isolation and authority ──

test('a viewer cannot issue or revoke a link', () => {
  const { db, ctx, org, storage } = world();
  const { artifact } = withArtifact(ctx, org, storage);
  const { share } = shareArtifact(ctx, org.id, artifact.id);

  db.insert('membership', {
    org_id: org.id, user_id: 'u-viewer', email: 'v@example.com', role: 'VIEWER', created_at: '2026-01-01',
  });
  const viewer = ctxFor(db, 'u-viewer');

  expectRefusal(() => api.createShare(viewer, org.id, {
    subject_kind: 'ARTIFACT', artifact_id: artifact.id, recipient_name: 'X',
  }), 'forbidden', 403);
  expectRefusal(() => api.revokeShare(viewer, org.id, share.id, {}), 'forbidden', 403);
});

test("another organisation cannot touch a link, and gets 404", () => {
  const { db, ctx, org, storage } = world();
  const { artifact } = withArtifact(ctx, org, storage);
  const { share } = shareArtifact(ctx, org.id, artifact.id);

  const other = ctxFor(db, 'u-other');
  const otherOrg = svc.createOrganisation(other, { name: 'Other Co' }).body.organisation;
  db.update('membership', db.findOne('membership', { org_id: otherOrg.id, user_id: 'u-other' }).id,
    { role: 'EDITOR' });

  expectRefusal(() => api.revokeShare(other, otherOrg.id, share.id, {}), 'not_found', 404);
  expectRefusal(() => api.publishUpdate(other, otherOrg.id, share.id), 'not_found', 404);
});

test("a token cannot reach another organisation's room", () => {
  const { db, ctx, org } = world();
  dataroom.buildRoom(ctx, org.id);
  const { token } = api.createShare(ctx, org.id, {
    subject_kind: 'ROOM', stage: 'CONFIRMATORY', recipient_name: 'J. Ellery',
  }).body;

  const other = ctxFor(db, 'u-other');
  const otherOrg = svc.createOrganisation(other, { name: 'Other Co' }).body.organisation;
  dataroom.buildRoom(other, otherOrg.id);
  svc.createFact(other, otherOrg.id, {
    fact_key: 'secret', label: 'Other company secret', value_text: 'confidential',
    source: 'USER_ENTERED',
  });

  const body = api.openShare(recipientCtx(db), token).body;
  assert.equal(JSON.stringify(body).includes('Other Co'), false);
  assert.equal(JSON.stringify(body).includes('confidential'), false);
});

test('the recipient path never consults membership', () => {
  // The whole point of the recipient surface: a token grants exactly what the
  // share says and nothing that a member would get.
  const { db, ctx, org, storage } = world();
  const { artifact } = withArtifact(ctx, org, storage);
  const { token } = shareArtifact(ctx, org.id, artifact.id);

  const body = api.openShare({ db, now: ctx.now }, token).body;
  assert.equal(body.allowed, true, 'a context with no auth at all must still work');
  assert.equal(body.recipient, 'J. Ellery');
});

test('a blocked artifact cannot be shared', () => {
  const { ctx, org } = world();
  const blocked = artifacts.generate(ctx, org.id, 'NORMALISATION_BRIDGE').body.artifact;
  expectRefusal(() => api.createShare(ctx, org.id, {
    subject_kind: 'ARTIFACT', artifact_id: blocked.id, recipient_name: 'J. Ellery',
  }), 'not_generated', 409);
});

test('the notification draft names every figure that moved', () => {
  const draft = notificationDraft(
    { id: 's1', recipient_name: 'J. Ellery', last_published_at: null },
    {
      changes: [
        { label: 'Revenue', was: 3_600_000, now: 3_400_000, value_moved: true },
        { label: 'Gross margin', was: 63.9, now: 63.9, value_moved: false },
      ],
      company: 'Northwind Systems', artifactTitle: 'Financial summary',
    },
  );
  assert.match(draft.body, /Revenue: 3600000 → 3400000/);
  assert.doesNotMatch(draft.body, /Gross margin/, 'an unchanged figure is not news');
  assert.match(draft.body, /rather tell you than have you find it/);
});
