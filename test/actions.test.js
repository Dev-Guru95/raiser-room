/**
 * Phase 10 — the advisor acts.
 *
 * Most of these tests are about what the advisor cannot do, and the single most
 * important one is the least obvious: that applying a proposal goes through the
 * ordinary service functions. An advisor path that writes rows directly would
 * pass every test about catalogues and preconditions while quietly bypassing
 * every rule that protects the same change made by hand.
 *
 * The second theme is that a proposal is a statement about the world at the
 * moment it was written, and confirming one three days later is agreeing to a
 * summary that may no longer be true.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, ctxFor, expectRefusal, fakeStorage } from './helpers.js';
import * as svc from '../src/api/service.js';
import * as dataroom from '../src/api/dataroom.js';
import * as assessments from '../src/api/assessments.js';
import * as artifacts from '../src/api/artifacts.js';
import * as prose from '../src/api/prose.js';
import * as api from '../src/api/actions.js';
import {
  ACTIONS, ACTION_KINDS, FORBIDDEN_TARGETS, validateAction, snapshot, drift,
  describeChange, inverseOf, expiryFrom, hasExpired, PROPOSAL_TTL_DAYS,
} from '../src/domain/actions.js';
import { ALL_REFS } from '../src/domain/criteria.js';

const ADVISOR = { id: 'fake-advisor', version: 'test-1', answer: async () => ({}) };

function world() {
  const db = freshDb();
  const ctx = ctxFor(db, 'u-owner');
  const storage = fakeStorage();
  const org = svc.createOrganisation(ctx, { name: 'Northwind Systems', path: 'RAISE' }).body.organisation;
  dataroom.buildRoom(ctx, org.id);
  return { db, ctx, org, storage };
}

/** An org with a scored assessment, so there are real gaps to act on. */
function withGaps(ctx, org) {
  const a = assessments.createAssessment(ctx, org.id, { scorer_role: 'FOUNDER' }).body.assessment;
  assessments.scoreAssessment(ctx, org.id, a.id,
    Object.fromEntries(ALL_REFS.map((ref) => [ref, 2])));
  assessments.completeAssessment(ctx, org.id, a.id);
  return assessments.listGaps(ctx, org.id).body.gaps;
}

const anItem = (ctx, org) => ctx.db.find('data_room_item', { org_id: org.id })[0];
const aFolder = (ctx, org) => ctx.db.find('data_room_node', { org_id: org.id })[0];

const proposeOne = (ctx, org, action) =>
  api.propose(ctx, org.id, { advisor: ADVISOR, actions: [action] });

// ───────────────────────────────────────────── the boundary, structurally ──

test('no action in the catalogue targets a fact', () => {
  // The line the whole architecture rests on. `fact.source` has no AI_GENERATED
  // value; this is the same guarantee for the table itself.
  for (const kind of ACTION_KINDS) {
    assert.notEqual(ACTIONS[kind].target, 'fact',
      `${kind} targets the fact table, which no action may ever do`);
  }
});

test('no action targets anything on the forbidden list', () => {
  // Audit rows, generated artifacts, share tokens, forecasts. An audit trail the
  // actor can edit is not an audit trail.
  for (const kind of ACTION_KINDS) {
    assert.ok(!FORBIDDEN_TARGETS.includes(ACTIONS[kind].target),
      `${kind} targets ${ACTIONS[kind].target}, which is on the forbidden list`);
  }
});

test('an action not in the catalogue cannot be proposed', () => {
  const { ctx, org } = world();
  const res = proposeOne(ctx, org, {
    action_kind: 'SET_FACT_VALUE', target_id: 'f-1',
    rationale: 'Revenue looks out of date and should be corrected.',
    payload: { value_numeric: 9_999_999 },
  });
  assert.equal(res.body.proposals.length, 0);
  assert.equal(res.body.rejected[0].problems[0].code, 'unknown_action');
  assert.ok(res.body.rejected[0].problems[0].allowed.length);
});

test('a payload field outside the action\'s declared writes is refused', () => {
  // How an action quietly grows: the kind stays the same, the payload does not.
  const problems = validateAction({
    action_kind: 'ASSIGN_GAP_OWNER', target_id: 'g-1',
    rationale: 'This gap has nobody on it and it is the longest lead item.',
    payload: { owner_user_id: 'u-owner', category: 'BLOCKER', closed_at: '2026-01-01' },
  });
  const fields = problems.filter((p) => p.code === 'field_not_writable');
  assert.equal(fields.length, 2);
});

test('an action with no stated reason is refused', () => {
  const problems = validateAction({
    action_kind: 'SET_GAP_CATEGORY', target_id: 'g-1', rationale: 'because',
    payload: { category: 'BLOCKER' },
  });
  assert.ok(problems.some((p) => p.code === 'no_rationale'));
});

test('the catalogue is published, including what it will never touch', () => {
  const { ctx, org } = world();
  const res = api.catalogue(ctx, org.id);
  assert.ok(res.body.actions.length >= 8);
  assert.ok(res.body.never_touches.includes('fact'));
  assert.ok(res.body.never_touches.includes('audit_log'));
  assert.match(res.body.rule, /cannot write or change a figure/);
});

// ─────────────────────────────────────── proposing changes nothing at all ──

test('proposing does not change anything', () => {
  const { ctx, org } = world();
  const item = anItem(ctx, org);

  proposeOne(ctx, org, {
    action_kind: 'MARK_ITEM_NOT_APPLICABLE', target_id: item.id,
    rationale: 'The company has no overseas subsidiaries, so this one cannot apply.',
    payload: { reason: 'No overseas subsidiaries have ever been incorporated.' },
  });

  const after = ctx.db.get('data_room_item', item.id);
  assert.equal(after.not_applicable, 0, 'proposing applied the change');
  assert.equal(after.na_reason, null);
});

test('a proposal shows the change computed from the row, not the advisor\'s words', () => {
  const { ctx, org } = world();
  const gaps = withGaps(ctx, org);

  const res = proposeOne(ctx, org, {
    action_kind: 'SET_GAP_CATEGORY', target_id: gaps[0].id,
    rationale: 'This needs a third party to act, which puts it on a different clock entirely.',
    payload: { category: 'THIRD_PARTY' },
  });
  const change = res.body.proposals[0].change;
  assert.deepEqual(change.changes, [{ field: 'category', from: gaps[0].category, to: 'THIRD_PARTY' }]);
});

test('a batch nobody would read is refused', () => {
  const { ctx, org } = world();
  const item = anItem(ctx, org);
  const many = Array.from({ length: api.MAX_BATCH + 1 }, () => ({
    action_kind: 'MARK_ITEM_NOT_APPLICABLE', target_id: item.id,
    rationale: 'A plausible reason, long enough to pass the floor.',
    payload: { reason: 'A plausible written reason.' },
  }));
  expectRefusal(() => api.propose(ctx, org.id, { advisor: ADVISOR, actions: many }),
    'batch_too_large', 400);
});

test('a bad action in a batch does not take the good ones with it', () => {
  const { ctx, org } = world();
  const item = anItem(ctx, org);
  const res = api.propose(ctx, org.id, {
    advisor: ADVISOR,
    actions: [
      {
        action_kind: 'MARK_ITEM_NOT_APPLICABLE', target_id: item.id,
        rationale: 'The company has no overseas subsidiaries, so this cannot apply to it.',
        payload: { reason: 'No overseas subsidiaries have ever been incorporated.' },
      },
      { action_kind: 'DELETE_EVERYTHING', target_id: item.id, rationale: 'tidy up', payload: {} },
    ],
  });
  assert.equal(res.body.proposals.length, 1);
  assert.equal(res.body.rejected.length, 1);
});

test('every proposal records which model produced it', () => {
  // An advisor's suggestion has to stay explicable after the model behind it has
  // been replaced, exactly as a stored answer does.
  const { ctx, org } = world();
  const item = anItem(ctx, org);
  const res = proposeOne(ctx, org, {
    action_kind: 'MARK_ITEM_NOT_APPLICABLE', target_id: item.id,
    rationale: 'The company has no overseas subsidiaries, so this cannot apply to it.',
    payload: { reason: 'No overseas subsidiaries have ever been incorporated.' },
  });
  assert.equal(res.body.proposals[0].advisor_id, 'fake-advisor');
  assert.equal(res.body.proposals[0].advisor_version, 'test-1');
  assert.equal(res.body.proposals[0].proposed_by, 'u-owner');
});

test('an advisor with no identity cannot propose at all', () => {
  const { ctx, org } = world();
  expectRefusal(
    () => api.propose(ctx, org.id, { advisor: { answer: async () => ({}) }, actions: [] }),
    'advisor_unidentified',
  );
});

// ───────────────────────────────── confirming goes through the service layer ──

test('REGRESSION: a rule the advisor path skipped would be a rule nobody enforces', () => {
  // The whole design in one test. The reason floor lives in `markNotApplicable`.
  // If confirm wrote the row itself, this proposal — which passed catalogue
  // validation because its reason is long enough — would still be applied with
  // whatever the payload said.
  const { ctx, org, db } = world();
  const item = anItem(ctx, org);

  const res = proposeOne(ctx, org, {
    action_kind: 'MARK_ITEM_NOT_APPLICABLE', target_id: item.id,
    rationale: 'The company has no overseas subsidiaries, so this one cannot apply.',
    payload: { reason: 'No overseas subsidiaries have ever been incorporated.' },
  });
  const proposal = res.body.proposals[0];

  // Reach in and shorten the stored reason below the service layer's floor,
  // standing in for a payload that got past the catalogue some other way.
  db.update('action_proposal', proposal.id, { payload: JSON.stringify({ reason: 'no' }) });

  expectRefusal(() => api.confirm(ctx, org.id, proposal.id), 'reason_required', 400);
  assert.equal(ctx.db.get('data_room_item', item.id).not_applicable, 0,
    'the item changed despite the service layer refusing');
});

test('a gap owner who is not a member is refused at confirm time', () => {
  // Catalogue validation cannot check membership — it has no database. The
  // service layer does, and it is the one that decides.
  const { ctx, org } = world();
  const gaps = withGaps(ctx, org);

  const res = proposeOne(ctx, org, {
    action_kind: 'ASSIGN_GAP_OWNER', target_id: gaps[0].id,
    rationale: 'This one needs a named owner and the finance lead is the obvious person.',
    payload: { owner_user_id: 'u-not-a-member' },
  });
  expectRefusal(() => api.confirm(ctx, org.id, res.body.proposals[0].id), 'owner_not_a_member', 400);
});

test('confirming applies the change and records who did it', () => {
  const { ctx, org } = world();
  const item = anItem(ctx, org);

  const res = proposeOne(ctx, org, {
    action_kind: 'MARK_ITEM_NOT_APPLICABLE', target_id: item.id,
    rationale: 'The company has no overseas subsidiaries, so this one cannot apply.',
    payload: { reason: 'No overseas subsidiaries have ever been incorporated.' },
  });
  const applied = api.confirm(ctx, org.id, res.body.proposals[0].id);

  assert.equal(applied.body.proposal.state, 'APPLIED');
  assert.equal(applied.body.proposal.applied_by, 'u-owner');
  const after = ctx.db.get('data_room_item', item.id);
  assert.equal(after.not_applicable, 1);
  assert.match(after.na_reason, /No overseas subsidiaries/);
});

test('applying writes the ordinary audit row as well as its own', () => {
  // Because it went through the service function. An advisor-applied change
  // should be indistinguishable in the audit trail from a hand-made one, except
  // that it additionally says it came from a proposal.
  const { ctx, org } = world();
  const item = anItem(ctx, org);
  const res = proposeOne(ctx, org, {
    action_kind: 'MARK_ITEM_NOT_APPLICABLE', target_id: item.id,
    rationale: 'The company has no overseas subsidiaries, so this one cannot apply.',
    payload: { reason: 'No overseas subsidiaries have ever been incorporated.' },
  });
  api.confirm(ctx, org.id, res.body.proposals[0].id);

  const entries = ctx.db.find('audit_log', { org_id: org.id }).map((e) => e.action);
  assert.ok(entries.includes('dataroom.item_not_applicable'), 'the ordinary audit row is missing');
  assert.ok(entries.includes('actions.applied'));
});

test('a proposal cannot be confirmed twice', () => {
  const { ctx, org } = world();
  const gaps = withGaps(ctx, org);
  const res = proposeOne(ctx, org, {
    action_kind: 'SET_GAP_CATEGORY', target_id: gaps[0].id,
    rationale: 'This needs a third party to act, which puts it on a different clock entirely.',
    payload: { category: 'THIRD_PARTY' },
  });
  api.confirm(ctx, org.id, res.body.proposals[0].id);
  expectRefusal(() => api.confirm(ctx, org.id, res.body.proposals[0].id), 'not_confirmable', 409);
});

// ────────────────────────────────────── a proposal is about a moment in time ──

test('a proposal whose world has moved refuses rather than overwriting', () => {
  const { ctx, org } = world();
  const gaps = withGaps(ctx, org);

  const res = proposeOne(ctx, org, {
    action_kind: 'ASSIGN_GAP_OWNER', target_id: gaps[0].id,
    rationale: 'Nobody owns this and it is the longest lead item on the register.',
    payload: { owner_user_id: 'u-owner' },
  });

  // Someone else assigns it in the meantime.
  ctx.db.insert('membership', {
    org_id: org.id, user_id: 'u-other', email: 'o@example.com', role: 'EDITOR', created_at: ctx.now(),
  });
  assessments.updateGap(ctx, org.id, gaps[0].id, { owner_user_id: 'u-other' });

  const err = expectRefusal(() => api.confirm(ctx, org.id, res.body.proposals[0].id), 'world_moved', 409);
  assert.equal(err.drift[0].field, 'owner_user_id');
  assert.equal(ctx.db.get('gap', gaps[0].id).owner_user_id, 'u-other',
    'the other person\'s assignment was overwritten');
});

test('CRYING WOLF: an unrelated edit does not invalidate a proposal', () => {
  // The precondition covers only what the action reads or writes. Hashing the
  // whole row would make every proposal stale whenever anything on it changed,
  // and a product that cries stale constantly teaches people to confirm without
  // reading — the exact failure the precondition exists to prevent.
  const { ctx, org } = world();
  const gaps = withGaps(ctx, org);

  const res = proposeOne(ctx, org, {
    action_kind: 'ASSIGN_GAP_OWNER', target_id: gaps[0].id,
    rationale: 'Nobody owns this and it is the longest lead item on the register.',
    payload: { owner_user_id: 'u-owner' },
  });

  // A field the action neither reads nor writes.
  assessments.updateGap(ctx, org.id, gaps[0].id, { done_when: 'The signed agreement is in the room.' });

  const applied = api.confirm(ctx, org.id, res.body.proposals[0].id);
  assert.equal(applied.body.proposal.state, 'APPLIED');
});

test('a proposal expires, and says why', () => {
  const { ctx, org, db } = world();
  const gaps = withGaps(ctx, org);
  const res = proposeOne(ctx, org, {
    action_kind: 'SET_GAP_CATEGORY', target_id: gaps[0].id,
    rationale: 'This needs a third party to act, which puts it on a different clock entirely.',
    payload: { category: 'THIRD_PARTY' },
  });

  db.update('action_proposal', res.body.proposals[0].id, { expires_at: '2020-01-01T00:00:00.000Z' });
  const err = expectRefusal(() => api.confirm(ctx, org.id, res.body.proposals[0].id),
    'proposal_expired', 409);
  assert.match(err.message, /statements about how things were/);
  assert.equal(db.get('action_proposal', res.body.proposals[0].id).state, 'EXPIRED');
});

test('expiry is evaluated on read, not by something that has to be running', () => {
  const { ctx, org, db } = world();
  const gaps = withGaps(ctx, org);
  const res = proposeOne(ctx, org, {
    action_kind: 'SET_GAP_CATEGORY', target_id: gaps[0].id,
    rationale: 'This needs a third party to act, which puts it on a different clock entirely.',
    payload: { category: 'THIRD_PARTY' },
  });
  db.update('action_proposal', res.body.proposals[0].id, { expires_at: '2020-01-01T00:00:00.000Z' });

  assert.equal(api.listProposals(ctx, org.id).body.open, 0);
  assert.equal(db.get('action_proposal', res.body.proposals[0].id).state, 'EXPIRED');
});

test('expiryFrom and hasExpired agree about the window', () => {
  const at = '2026-01-01T00:00:00.000Z';
  const expires = expiryFrom(at);
  assert.equal(expires, new Date(Date.UTC(2026, 0, 1 + PROPOSAL_TTL_DAYS)).toISOString());
  assert.equal(hasExpired({ expires_at: expires }, at), false);
  assert.equal(hasExpired({ expires_at: expires }, '2026-02-01T00:00:00.000Z'), true);
});

test('a dependent action cannot land before the one it depends on', () => {
  const { ctx, org } = world();
  const res = api.propose(ctx, org.id, {
    advisor: ADVISOR,
    actions: [
      {
        action_kind: 'CREATE_FOLDER', target_id: org.id,
        rationale: 'The lender pack has nowhere to live and will otherwise be filed under Other.',
        payload: { name: 'Lender pack', stage: 'QUALIFIED' },
      },
    ],
  });
  const first = res.body.proposals[0];

  const second = proposeOne(ctx, org, {
    action_kind: 'REORDER_FOLDER', target_id: aFolder(ctx, org).id,
    rationale: 'Once the lender pack exists the ordering needs to put it after the accounts.',
    payload: { sort_key: '11' },
  }).body.proposals[0];
  ctx.db.update('action_proposal', second.id, { depends_on: first.id });

  expectRefusal(() => api.confirm(ctx, org.id, second.id), 'dependency_not_applied', 409);
  api.confirm(ctx, org.id, first.id);
  assert.equal(api.confirm(ctx, org.id, second.id).body.proposal.state, 'APPLIED');
});

// ───────────────────────────────────────────────────────── rejecting, undoing ──

test('a rejected proposal is kept, not deleted', () => {
  // "The advisor suggested this and we said no" is worth being able to show, and
  // it is the only signal that would tell anyone the suggestions are poor.
  const { ctx, org } = world();
  const gaps = withGaps(ctx, org);
  const res = proposeOne(ctx, org, {
    action_kind: 'SET_GAP_CATEGORY', target_id: gaps[0].id,
    rationale: 'This needs a third party to act, which puts it on a different clock entirely.',
    payload: { category: 'THIRD_PARTY' },
  });

  const rejected = api.reject(ctx, org.id, res.body.proposals[0].id, { reason: 'We can do this inhouse.' });
  assert.equal(rejected.body.proposal.state, 'REJECTED');
  assert.equal(rejected.body.proposal.reject_reason, 'We can do this inhouse.');
  assert.equal(api.listProposals(ctx, org.id, { state: 'REJECTED' }).body.total, 1);
});

test('undo restores what was actually there', () => {
  const { ctx, org } = world();
  const gaps = withGaps(ctx, org);
  const was = gaps[0].category;

  const res = proposeOne(ctx, org, {
    action_kind: 'SET_GAP_CATEGORY', target_id: gaps[0].id,
    rationale: 'This needs a third party to act, which puts it on a different clock entirely.',
    payload: { category: 'THIRD_PARTY' },
  });
  api.confirm(ctx, org.id, res.body.proposals[0].id);
  assert.equal(ctx.db.get('gap', gaps[0].id).category, 'THIRD_PARTY');

  const undone = api.undo(ctx, org.id, res.body.proposals[0].id);
  assert.equal(undone.body.proposal.state, 'UNDONE');
  assert.equal(ctx.db.get('gap', gaps[0].id).category, was);
});

test('undo refuses when somebody has changed it since', () => {
  // Undoing on top of someone else's edit is the same silent overwrite the
  // precondition prevents, in the other direction.
  const { ctx, org } = world();
  const gaps = withGaps(ctx, org);

  const res = proposeOne(ctx, org, {
    action_kind: 'SET_GAP_CATEGORY', target_id: gaps[0].id,
    rationale: 'This needs a third party to act, which puts it on a different clock entirely.',
    payload: { category: 'THIRD_PARTY' },
  });
  api.confirm(ctx, org.id, res.body.proposals[0].id);
  assessments.updateGap(ctx, org.id, gaps[0].id, { category: 'BLOCKER' });

  const err = expectRefusal(() => api.undo(ctx, org.id, res.body.proposals[0].id),
    'changed_since_applied', 409);
  assert.equal(err.changed[0].field, 'category');
  assert.equal(ctx.db.get('gap', gaps[0].id).category, 'BLOCKER', 'the later edit was overwritten');
});

test('undo restores a cleared document, not just the flag', () => {
  // Marking an item not applicable nulls its document. An undo that put the flag
  // back without the document would quietly lose the filing.
  const { ctx, org, storage } = world();
  const item = anItem(ctx, org);
  const doc = svc.createUploadTicket(ctx, org.id, {
    filename: 'certificate.pdf', size_bytes: 1_000, mime_type: 'application/pdf', kind: 'OTHER',
  }, storage).body.document;
  svc.confirmUpload(ctx, org.id, doc.id);
  dataroom.satisfyItem(ctx, org.id, item.id, doc.id);

  const res = proposeOne(ctx, org, {
    action_kind: 'MARK_ITEM_NOT_APPLICABLE', target_id: item.id,
    rationale: 'On reflection this item does not apply to a company of this structure at all.',
    payload: { reason: 'Not applicable to a company with this structure.' },
  });
  api.confirm(ctx, org.id, res.body.proposals[0].id);
  assert.equal(ctx.db.get('data_room_item', item.id).document_id, null);

  api.undo(ctx, org.id, res.body.proposals[0].id);
  const after = ctx.db.get('data_room_item', item.id);
  assert.equal(after.document_id, doc.id, 'the document was not put back');
  assert.equal(after.not_applicable, 0);
});

test('REGRESSION: undo compares against what the row became, not against the payload', () => {
  // A payload field need not be a column. `reason` becomes `na_reason`, and
  // marking an item not applicable also clears `document_id` — an effect no
  // payload mentions. Comparing the payload against the row reported every
  // applied action as having been changed by somebody else, so no action of
  // this shape could ever be undone.
  const { ctx, org, db } = world();
  const item = anItem(ctx, org);

  const res = proposeOne(ctx, org, {
    action_kind: 'MARK_ITEM_NOT_APPLICABLE', target_id: item.id,
    rationale: 'The company has no overseas subsidiaries, so this one cannot apply.',
    payload: { reason: 'No overseas subsidiaries have ever been incorporated.' },
  });
  api.confirm(ctx, org.id, res.body.proposals[0].id);

  const stored = db.get('action_proposal', res.body.proposals[0].id);
  const after = JSON.parse(stored.after_state);
  assert.equal(after.not_applicable, '1', 'the after state did not record what the row became');
  assert.equal(after.document_id, null);
  // And it undoes cleanly, which it could not before.
  assert.equal(api.undo(ctx, org.id, res.body.proposals[0].id).body.proposal.state, 'UNDONE');
});

test('an action that wrote nothing says it cannot be undone rather than pretending', () => {
  const { ctx, org } = world();
  const item = anItem(ctx, org);
  const res = proposeOne(ctx, org, {
    action_kind: 'REQUEST_DOCUMENT', target_id: item.id,
    rationale: 'Nobody has chased the landlord for this and it is a long lead item.',
    payload: { note: 'Please send the signed lease for the Sheridan office.' },
  });
  api.confirm(ctx, org.id, res.body.proposals[0].id);
  expectRefusal(() => api.undo(ctx, org.id, res.body.proposals[0].id), 'not_reversible', 409);
});

test('a proposal that was never applied cannot be undone', () => {
  const { ctx, org } = world();
  const gaps = withGaps(ctx, org);
  const res = proposeOne(ctx, org, {
    action_kind: 'SET_GAP_CATEGORY', target_id: gaps[0].id,
    rationale: 'This needs a third party to act, which puts it on a different clock entirely.',
    payload: { category: 'THIRD_PARTY' },
  });
  expectRefusal(() => api.undo(ctx, org.id, res.body.proposals[0].id), 'not_undoable', 409);
});

// ──────────────────────────────────────────────────── prose, and the number rule ──

test('the advisor cannot write a figure into prose', () => {
  // The hole in the fence. Everything else on the catalogue is a structural
  // field with a closed set of values; prose is free text, and free text can
  // carry a number.
  const { ctx, org } = world();
  const res = proposeOne(ctx, org, {
    action_kind: 'DRAFT_PROSE', target_id: org.id,
    rationale: 'The deck has no narrative section and this is the obvious place to start.',
    payload: { slot: 'default', text: 'Revenue grew to $4.2m in the last financial year.' },
    cites: [],
  });
  assert.equal(res.body.proposals.length, 0);
  assert.equal(res.body.rejected[0].problems[0].code, 'unaccounted_numerals');
  assert.ok(res.body.rejected[0].problems[0].numerals.includes('$4.2m'));
});

test('REGRESSION: a typed figure is refused even when a fact holds that exact value', () => {
  // Stricter than the advisor's rule for chat answers, deliberately. A reply is
  // a snapshot of a conversation; a document regenerates. A literal "$4.2m" that
  // matches today's revenue is still typed — correct the fact to 4.3m and the
  // charts move while the sentence does not, which is the contradiction the
  // architecture exists to prevent, in the one place a reader is most likely to
  // believe without checking.
  const { ctx, org, storage } = world();
  const doc = svc.createUploadTicket(ctx, org.id, {
    filename: 'accounts.pdf', size_bytes: 1_000, mime_type: 'application/pdf', kind: 'ACCOUNTS',
  }, storage).body.document;
  svc.confirmUpload(ctx, org.id, doc.id);
  const fact = svc.createFact(ctx, org.id, {
    fact_key: 'financials.revenue.ttm', label: 'Revenue', value_numeric: 4_200_000, unit: 'USD',
    source: 'USER_CONFIRMED', source_doc_id: doc.id, source_page: 4,
  }).body.fact;

  const res = proposeOne(ctx, org, {
    action_kind: 'DRAFT_PROSE', target_id: org.id,
    rationale: 'The deck has no narrative section and this is the obvious place to start.',
    payload: { slot: 'default', text: 'Revenue reached $4.2m in the last full financial year.' },
    cites: [`fact:${fact.id}`],
  });
  assert.equal(res.body.proposals.length, 0, 'a typed figure was accepted because a fact matched it');
  const problem = res.body.rejected[0].problems.find((p) => p.code === 'unaccounted_numerals');
  assert.ok(problem.typed_but_known.includes('$4.2m'),
    'the figure was not reported as one the company already holds');
});

test('a figure the advisor did not cite is reported as unknown, not as one you hold', () => {
  // Both are refused — the union is every numeral either way — but the two
  // halves drive different repairs. "You already have this, insert it" is a
  // click; "this is not recorded" is a form. Reporting a figure the advisor
  // never looked at as one the company holds would offer the wrong one.
  const { ctx, org, storage } = world();
  const doc = svc.createUploadTicket(ctx, org.id, {
    filename: 'accounts.pdf', size_bytes: 1_000, mime_type: 'application/pdf', kind: 'ACCOUNTS',
  }, storage).body.document;
  svc.confirmUpload(ctx, org.id, doc.id);
  svc.createFact(ctx, org.id, {
    fact_key: 'financials.revenue.ttm', label: 'Revenue', value_numeric: 4_200_000, unit: 'USD',
    source: 'USER_CONFIRMED', source_doc_id: doc.id, source_page: 4,
  });

  const res = proposeOne(ctx, org, {
    action_kind: 'DRAFT_PROSE', target_id: org.id,
    rationale: 'The deck has no narrative section and this is the obvious place to start.',
    payload: { slot: 'default', text: 'Revenue reached $4.2m in the last full financial year.' },
    cites: [],
  });
  const problem = res.body.rejected[0].problems.find((p) => p.code === 'unaccounted_numerals');
  assert.ok(problem.unknown.includes('$4.2m'),
    'a figure the advisor never looked at was reported as one it had');
  assert.deepEqual(problem.typed_but_known, []);
});

test('REGRESSION: propose and confirm apply the same prose rule', () => {
  // Two checkers meant two rules, and the advisor could propose a sentence that
  // was refused when a human pressed confirm — which wastes the one moment the
  // user was willing to act.
  const { ctx, org } = world();
  const res = proposeOne(ctx, org, {
    action_kind: 'DRAFT_PROSE', target_id: org.id,
    rationale: 'The deck has no narrative section and this is the obvious place to start.',
    payload: { slot: 'default', text: 'The team reached 34 people last year.' },
    cites: [],
  });
  assert.equal(res.body.proposals.length, 0,
    'propose accepted prose that confirm would have refused');
});

test('a reference the advisor writes is allowed', () => {
  const { ctx, org, storage } = world();
  const doc = svc.createUploadTicket(ctx, org.id, {
    filename: 'accounts.pdf', size_bytes: 1_000, mime_type: 'application/pdf', kind: 'ACCOUNTS',
  }, storage).body.document;
  svc.confirmUpload(ctx, org.id, doc.id);
  const fact = svc.createFact(ctx, org.id, {
    fact_key: 'financials.revenue.ttm', label: 'Revenue', value_numeric: 4_200_000, unit: 'USD',
    source: 'USER_CONFIRMED', source_doc_id: doc.id, source_page: 4,
  }).body.fact;

  const res = proposeOne(ctx, org, {
    action_kind: 'DRAFT_PROSE', target_id: org.id,
    rationale: 'The deck has no narrative section and this is the obvious place to start.',
    payload: {
      slot: 'default',
      text: 'Revenue reached {{fact:financials.revenue.ttm}} in the last full financial year.',
    },
    cites: [`fact:${fact.id}`],
  });
  assert.equal(res.body.proposals.length, 1, JSON.stringify(res.body.rejected));
});

test('REGRESSION: a figure the company holds but the advisor did not cite is still refused', () => {
  // Checking prose against everything the org holds would let an advisor write
  // any number the company happens to have, whether or not it looked at it.
  // That is originating a figure with extra steps.
  const { ctx, org, storage } = world();
  const doc = svc.createUploadTicket(ctx, org.id, {
    filename: 'accounts.pdf', size_bytes: 1_000, mime_type: 'application/pdf', kind: 'ACCOUNTS',
  }, storage).body.document;
  svc.confirmUpload(ctx, org.id, doc.id);
  svc.createFact(ctx, org.id, {
    fact_key: 'financials.revenue.ttm', label: 'Revenue', value_numeric: 4_200_000, unit: 'USD',
    source: 'USER_CONFIRMED', source_doc_id: doc.id, source_page: 4,
  });

  const res = proposeOne(ctx, org, {
    action_kind: 'DRAFT_PROSE', target_id: org.id,
    rationale: 'The deck has no narrative section and this is the obvious place to start.',
    payload: { slot: 'default', text: 'Revenue reached $4.2m in the last full financial year.' },
    cites: [],
  });
  assert.equal(res.body.proposals.length, 0);
  assert.equal(res.body.rejected[0].problems[0].code, 'unaccounted_numerals');
});

test('a fact reference is not a figure, and resolves in the document', () => {
  const { ctx, org, storage } = world();
  const doc = svc.createUploadTicket(ctx, org.id, {
    filename: 'accounts.pdf', size_bytes: 1_000, mime_type: 'application/pdf', kind: 'ACCOUNTS',
  }, storage).body.document;
  svc.confirmUpload(ctx, org.id, doc.id);
  svc.createFact(ctx, org.id, {
    fact_key: 'financials.revenue.ttm', label: 'Revenue', value_numeric: 4_200_000, unit: 'USD',
    source: 'USER_CONFIRMED', source_doc_id: doc.id, source_page: 4,
  });
  svc.createFact(ctx, org.id, {
    fact_key: 'company.name', label: 'Registered name',
    value_text: 'Northwind Systems Inc.', source: 'USER_ENTERED',
  });

  const res = proposeOne(ctx, org, {
    action_kind: 'DRAFT_PROSE', target_id: org.id,
    rationale: 'The deck has no narrative section and this is the obvious place to start.',
    payload: {
      slot: 'default',
      text: 'Revenue reached {{fact:financials.revenue.ttm}} in the last full financial year.',
    },
    cites: [],
  });
  assert.equal(res.body.proposals.length, 1, JSON.stringify(res.body.rejected));
  api.confirm(ctx, org.id, res.body.proposals[0].id);

  const html = artifacts.generate(ctx, org.id, 'PITCH_DECK').body.html;
  assert.ok(html.includes('$4.2m'), 'the reference did not resolve into the document');
  assert.ok(!html.includes('{{fact:'), 'an unresolved reference reached the page');
});

test('approved advisor prose is attributed to the person who approved it', () => {
  // There is no ADVISOR_WRITTEN source, exactly as `fact.source` has no
  // AI_GENERATED. A human put it in the document, and the record says so.
  const { ctx, org } = world();
  const res = proposeOne(ctx, org, {
    action_kind: 'DRAFT_PROSE', target_id: org.id,
    rationale: 'The deck has no narrative section and this is the obvious place to start.',
    payload: { slot: 'market', text: 'The company sells to mid-market logistics operators.' },
    cites: [],
  });
  api.confirm(ctx, org.id, res.body.proposals[0].id);

  const written = prose.listProse(ctx, org.id).body.prose[0];
  assert.equal(written.source, 'ADVISOR_DRAFTED_USER_APPROVED');
  assert.equal(written.author_id, 'u-owner');
  assert.equal(written.proposal_id, res.body.proposals[0].id);
});

test('the number rule applies to a person typing prose too', () => {
  // The claim on every generated document does not say "except where the
  // founder typed it".
  const { ctx, org } = world();
  const err = expectRefusal(
    () => prose.writeProse(ctx, org.id, 'default', 'We grew 40% last year.'),
    'prose_rejected', 400,
  );
  assert.equal(err.problems[0].code, 'unaccounted_numerals');
  assert.match(err.problems[0].problem, /\{\{fact:your\.key\}\}/);
});

test('spelled-out numbers are free, as they are everywhere else', () => {
  const { ctx, org } = world();
  const res = prose.writeProse(ctx, org.id, 'assumptions',
    'Three assumptions carry the plan, and each is stated so it could be shown to be wrong.');
  assert.equal(res.status, 201);
});

test('a reference to a fact that does not exist is refused before it renders as a blank', () => {
  const { ctx, org } = world();
  const err = expectRefusal(
    () => prose.writeProse(ctx, org.id, 'default', 'Revenue reached {{fact:financials.nonexistent}}.'),
    'prose_rejected', 400,
  );
  assert.equal(err.problems[0].code, 'unknown_fact_reference');
});

test('prose is superseded rather than overwritten', () => {
  const { ctx, org } = world();
  const first = prose.writeProse(ctx, org.id, 'default', 'The company sells to logistics operators.')
    .body.prose;
  const second = prose.writeProse(ctx, org.id, 'default', 'The company sells to mid-market operators.')
    .body.prose;

  assert.equal(ctx.db.get('prose_block', first.id).superseded_by, second.id);
  assert.equal(prose.listProse(ctx, org.id).body.total, 1);
  assert.equal(prose.listProse(ctx, org.id, { includeSuperseded: true }).body.total, 2);
});

test('previewing prose checks it without writing it', () => {
  const { ctx, org } = world();
  const res = prose.previewProse(ctx, org.id, 'We grew 40% last year.');
  assert.equal(res.body.ok, false);
  assert.equal(res.body.problems[0].code, 'unaccounted_numerals');
  assert.equal(prose.listProse(ctx, org.id).body.total, 0);
});

// ───────────────────────────────────────────────────────────── access control ──

test('a non-member gets 404 from every action call', () => {
  const { ctx, org, db } = world();
  const stranger = ctxFor(db, 'u-stranger');
  const gaps = withGaps(ctx, org);
  const res = proposeOne(ctx, org, {
    action_kind: 'SET_GAP_CATEGORY', target_id: gaps[0].id,
    rationale: 'This needs a third party to act, which puts it on a different clock entirely.',
    payload: { category: 'THIRD_PARTY' },
  });
  const id = res.body.proposals[0].id;

  for (const call of [
    () => api.propose(stranger, org.id, { advisor: ADVISOR, actions: [] }),
    () => api.listProposals(stranger, org.id),
    () => api.getProposal(stranger, org.id, id),
    () => api.confirm(stranger, org.id, id),
    () => api.reject(stranger, org.id, id),
    () => api.undo(stranger, org.id, id),
    () => api.catalogue(stranger, org.id),
  ]) {
    expectRefusal(call, 'not_found', 404);
  }
});

test('a viewer can read proposals but cannot confirm one', () => {
  const { ctx, org, db } = world();
  const gaps = withGaps(ctx, org);
  const res = proposeOne(ctx, org, {
    action_kind: 'SET_GAP_CATEGORY', target_id: gaps[0].id,
    rationale: 'This needs a third party to act, which puts it on a different clock entirely.',
    payload: { category: 'THIRD_PARTY' },
  });
  db.insert('membership', {
    org_id: org.id, user_id: 'u-viewer', email: 'v@example.com', role: 'VIEWER', created_at: ctx.now(),
  });
  const viewer = ctxFor(db, 'u-viewer');

  assert.equal(api.listProposals(viewer, org.id).status, 200);
  expectRefusal(() => api.confirm(viewer, org.id, res.body.proposals[0].id), 'forbidden', 403);
});

test('a target in another organisation is not found, never forbidden', () => {
  const { ctx, org, db } = world();
  const otherCtx = ctxFor(db, 'u-other');
  const other = svc.createOrganisation(otherCtx, { name: 'Elsewhere', path: 'RAISE' }).body.organisation;
  dataroom.buildRoom(otherCtx, other.id);
  const theirItem = db.find('data_room_item', { org_id: other.id })[0];

  const res = proposeOne(ctx, org, {
    action_kind: 'MARK_ITEM_NOT_APPLICABLE', target_id: theirItem.id,
    rationale: 'This looks inapplicable given what the company actually does day to day.',
    payload: { reason: 'Not applicable to this company at all.' },
  });
  assert.equal(res.body.proposals.length, 0);
  assert.equal(res.body.rejected[0].problems[0].code, 'target_not_found');
  assert.equal(db.get('data_room_item', theirItem.id).not_applicable, 0);
});

// ─────────────────────────────────────────────────────── the domain helpers ──

test('a snapshot covers what the action touches and nothing else', () => {
  const action = ACTIONS.ASSIGN_GAP_OWNER;
  const snap = snapshot(action, {
    id: 'g-1', owner_user_id: 'u-1', closed_at: null,
    done_when: 'irrelevant', category: 'BLOCKER', criterion_ref: '2.3',
  });
  assert.deepEqual(Object.keys(snap).sort(), ['closed_at', 'owner_user_id']);
});

test('a snapshot normalises so a round trip cannot look like a change', () => {
  // SQLite returns 0 and 1 where JSON stored false and true, and a precondition
  // that treated those as different would fire on every unchanged row.
  const action = ACTIONS.MARK_ITEM_NOT_APPLICABLE;
  const a = snapshot(action, { not_applicable: 0, na_reason: null, document_id: null });
  const b = snapshot(action, { not_applicable: '0', na_reason: null, document_id: undefined });
  assert.deepEqual(drift(a, b), []);
});

test('inverseOf restores from the before state, not from the payload', () => {
  // They differ whenever a domain rule adjusted the write on the way in, and an
  // undo built from the payload would restore a state that never existed.
  const action = ACTIONS.SET_GAP_CATEGORY;
  assert.deepEqual(inverseOf(action, { category: 'CHEAP', closed_at: null }), { category: 'CHEAP' });
});

test('describeChange omits fields the action would not actually move', () => {
  const action = ACTIONS.SET_GAP_CATEGORY;
  const same = describeChange(action, { category: 'CHEAP' }, { category: 'CHEAP' });
  assert.deepEqual(same.changes, []);
});


// ──────────────────────────────── what the mutation run found nothing guarding ──

test('the diff is recomputed from the current row, not from the stored before state', () => {
  // The proposal shows the user what will ACTUALLY happen. A diff built from the
  // snapshot taken at propose time describes a change that may no longer be the
  // change — and the user is agreeing to the diff, not to the advisor's sentence.
  const { ctx, org } = world();
  const gaps = withGaps(ctx, org);

  const res = proposeOne(ctx, org, {
    action_kind: 'SET_GAP_CATEGORY', target_id: gaps[0].id,
    rationale: 'This needs a third party to act, which puts it on a different clock entirely.',
    payload: { category: 'THIRD_PARTY' },
  });

  // Somebody moves it to the category the proposal was going to set.
  assessments.updateGap(ctx, org.id, gaps[0].id, { category: 'THIRD_PARTY' });

  const shown = api.getProposal(ctx, org.id, res.body.proposals[0].id).body.proposal;
  assert.deepEqual(shown.change.changes, [],
    'the diff still claims a change that would no longer happen');
  assert.ok(shown.drift.length, 'the drift against the proposal is not reported');
});

test('a rejected proposal keeps everything about itself', () => {
  const { ctx, org, db } = world();
  const gaps = withGaps(ctx, org);
  const res = proposeOne(ctx, org, {
    action_kind: 'SET_GAP_CATEGORY', target_id: gaps[0].id,
    rationale: 'This needs a third party to act, which puts it on a different clock entirely.',
    payload: { category: 'THIRD_PARTY' },
  });
  const before = db.get('action_proposal', res.body.proposals[0].id);

  api.reject(ctx, org.id, res.body.proposals[0].id, { reason: 'We can do this inhouse.' });
  const after = db.get('action_proposal', res.body.proposals[0].id);

  assert.ok(after, 'the proposal was deleted rather than marked rejected');
  assert.equal(after.id, before.id, 'the row was replaced rather than updated');
  assert.equal(after.created_at, before.created_at);
  assert.equal(after.rationale, before.rationale);
  assert.equal(after.advisor_id, before.advisor_id);
  assert.equal(db.count('action_proposal', { org_id: org.id }), 1);
});

// ─────────────────────────────────────────────────────── folders, by hand ──

test('two folders in one place cannot share a name', () => {
  // A counterparty reading the index cannot tell them apart, and whoever files
  // the next document will pick the wrong one.
  const { ctx, org } = world();
  dataroom.createFolder(ctx, org.id, { name: 'Lender pack' });
  expectRefusal(() => dataroom.createFolder(ctx, org.id, { name: 'lender PACK' }),
    'duplicate_folder', 409);
});

test('the same name under a different parent is fine', () => {
  const { ctx, org } = world();
  const parent = dataroom.createFolder(ctx, org.id, { name: 'Lender pack' }).body.folder;
  const nested = dataroom.createFolder(ctx, org.id, { name: 'Lender pack', parent_id: parent.id });
  assert.equal(nested.status, 201);
});

test('sort keys are padded, so folder ten does not sort before folder two', () => {
  // Sort keys are strings and sort as strings. Unpadded, a data room index reads
  // 1, 10, 11, 2 — which a counterparty notices before anything else.
  //
  // Built on an org with NO standard folders, because the standard ten already
  // occupy 01–10: starting from eleven, padding changes nothing and a test that
  // starts there proves nothing.
  const db = freshDb();
  const ctx = ctxFor(db, 'u-owner');
  const org = svc.createOrganisation(ctx, { name: 'Bare', path: 'RAISE' }).body.organisation;

  const made = [];
  for (let i = 1; i <= 10; i++) {
    made.push(dataroom.createFolder(ctx, org.id, { name: `Folder ${i}` }).body.folder);
  }
  assert.equal(made[0].sort_key, '01', `the first folder got "${made[0].sort_key}"`);
  assert.equal(made[9].sort_key, '10');

  const keys = made.map((f) => f.sort_key);
  assert.deepEqual([...keys].sort(), keys,
    `string order and creation order disagree: ${[...keys].sort().join(', ')}`);
});

test('a folder from another organisation cannot be used as a parent', () => {
  const { ctx, org, db } = world();
  const otherCtx = ctxFor(db, 'u-other');
  const other = svc.createOrganisation(otherCtx, { name: 'Elsewhere', path: 'RAISE' }).body.organisation;
  dataroom.buildRoom(otherCtx, other.id);
  const theirs = db.find('data_room_node', { org_id: other.id })[0];

  expectRefusal(() => dataroom.createFolder(ctx, org.id, { name: 'Nested', parent_id: theirs.id }),
    'not_found', 404);
});
