/**
 * Phase 1 — scoring, the three hard rules, and the gap register.
 *
 * The hard rules are the reason this is a product rather than a spreadsheet.
 * Each is tested alone AND in combination, because a rule that only works in
 * isolation is not a rule.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, ctxFor, expectRefusal } from './helpers.js';
import * as svc from '../src/api/service.js';
import * as a from '../src/api/assessments.js';
import { score, BANDS } from '../src/domain/assessment.js';
import { DOMAINS, ALL_REFS, MAX_WEIGHTED } from '../src/domain/criteria.js';
import { deriveGaps, overCapacityOwners, OWNER_CAPACITY } from '../src/domain/gaps.js';

/** Build a full score sheet where every criterion has the same value. */
const flat = (v) => Object.fromEntries(ALL_REFS.map((r) => [r, v]));

function org() {
  const db = freshDb();
  const ctx = ctxFor(db, 'u-owner');
  const o = svc.createOrganisation(ctx, { name: 'Test Co' }).body.organisation;
  return { db, ctx, org: o };
}

// ───────────────────────────────────────────────────────────── the catalogue ──

test('the catalogue is 8 domains, 32 criteria, weights summing to 10', () => {
  assert.equal(DOMAINS.length, 8);
  assert.equal(ALL_REFS.length, 32);
  assert.equal(DOMAINS.reduce((s, d) => s + d.weight, 0), 10);
  assert.equal(MAX_WEIGHTED, 200);
  for (const d of DOMAINS) assert.equal(d.criteria.length, 4, `domain ${d.n} must have 4 criteria`);
});

test('guidance is served with its provenance — never recalled by a model', () => {
  const cat = a.getCatalogue().body;
  assert.ok(cat.source.version, 'the knowledge record is versioned');
  assert.ok(cat.source.reviewed, 'and dated');
  assert.ok(cat.source.publisher);
  assert.ok(/not legal, financial/i.test(cat.source.note));
});

// ────────────────────────────────────────────────────────────────── scoring ──

test('a perfect score is 200 and READY', () => {
  const r = score(flat(5));
  assert.equal(r.total_weighted, 200);
  assert.equal(r.band, 'READY');
  assert.equal(r.capped, false);
});

test('all zeros is BLOCKED, not EARLY — the cap-table gate fires first', () => {
  // Worth asserting explicitly: a company that scores zero on everything has
  // also scored zero on 1.1, so no band is issued at all. The gate outranks
  // the total, which is the whole point of it.
  const r = score(flat(0));
  assert.equal(r.total_weighted, 0);
  assert.equal(r.band, 'BLOCKED');
});

test('EARLY is reachable once the cap table clears the gate', () => {
  const r = score({ ...flat(0), '1.1': 3 });
  assert.equal(r.band, 'EARLY');
  assert.equal(r.total_weighted, 4.5);   // 3 raw x 1.5
});

test('weights are applied — domain 2 counts double, domain 8 counts half', () => {
  const s = flat(0);
  for (const c of DOMAINS[1].criteria) s[c.ref] = 5;   // domain 2, weight 2.0
  assert.equal(score(s).total_weighted, 40);           // 20 raw × 2.0

  const s8 = flat(0);
  for (const c of DOMAINS[7].criteria) s8[c.ref] = 5;  // domain 8, weight 0.5
  assert.equal(score(s8).total_weighted, 10);          // 20 raw × 0.5
});

test('the band boundaries match the published table exactly', () => {
  for (const b of BANDS) {
    assert.ok(b.min <= b.max);
    assert.ok(b.means.length > 20, `band ${b.band} needs a meaning a user can act on`);
  }
  const sorted = [...BANDS].sort((x, y) => x.min - y.min);
  for (let i = 1; i < sorted.length; i++) {
    assert.equal(sorted[i].min, sorted[i - 1].max + 1, 'bands must be contiguous with no gap');
  }
});

test('scores are validated', () => {
  for (const bad of [6, -1, 2.5, 'three', true, {}]) {
    assert.throws(() => score({ ...flat(3), '1.1': bad }), (e) => e.code === 'invalid_score',
      `score ${JSON.stringify(bad)} should be refused`);
  }
  assert.throws(() => score({ ...flat(3), '9.9': 3 }), (e) => e.code === 'unknown_criterion');
});

test('a null score means UNANSWERED, not zero', () => {
  // Number(null) is 0, and 0 means "does not exist, or exists and is wrong".
  // Silently scoring an unanswered criterion as 0 would drag the band down and
  // raise a gap for work the user simply had not reached yet.
  const r = score({ ...flat(3), '1.1': null }, { partial: true });
  assert.equal(r.complete, false);
  assert.equal(r.unscored, 1);
  assert.equal(r.domains[0].criteria['1.1'], null);
  assert.notEqual(r.band, 'BLOCKED', 'an unanswered 1.1 must not trip the cap-table gate');

  // And clearing an answer is how a user un-scores something.
  const cleared = score({ '1.1': 5, '1.2': null }, { partial: true });
  assert.equal(cleared.domains[0].criteria['1.2'], null);
});

test('an incomplete sheet is refused unless partial is requested', () => {
  const partialSheet = { '1.1': 4, '1.2': 4 };
  assert.throws(() => score(partialSheet), (e) => e.code === 'incomplete');
  const r = score(partialSheet, { partial: true });
  assert.equal(r.complete, false);
  assert.equal(r.unscored, 30);
});

// ─────────────────────────────────────────────────────────── the hard rules ──

test('HARD RULE 1 — one domain below 8/20 caps the band at NOT_YET', () => {
  const s = flat(5);                                   // would be 200, READY
  for (const c of DOMAINS[4].criteria) s[c.ref] = 1;   // domain 5 → 4/20
  const r = score(s);

  assert.ok(r.total_weighted > 160, 'the raw total still looks like READY');
  assert.equal(r.band, 'NOT_YET', 'but one hole caps it');
  assert.equal(r.capped, true);
  assert.equal(r.band_before_rules, 'READY');
  assert.ok(r.hard_rule_findings.some((f) => f.rule === 'floor'));
});

test('HARD RULE 2 — criterion 1.1 at 2 or below issues no band at all', () => {
  for (const bad of [0, 1, 2]) {
    const r = score({ ...flat(5), '1.1': bad });
    assert.equal(r.band, 'BLOCKED', `1.1 = ${bad} must block`);
    const f = r.hard_rule_findings.find((x) => x.rule === 'cap_table_gate');
    assert.ok(f, 'the finding explains why');
    assert.match(f.action, /re-score/i);
  }
  assert.notEqual(score({ ...flat(5), '1.1': 3 }).band, 'BLOCKED', '3 is above the gate');
});

test('HARD RULE 2 overrides everything, including a perfect remainder', () => {
  const r = score({ ...flat(5), '1.1': 0 });
  assert.equal(r.band, 'BLOCKED');
  assert.equal(r.hard_rule_findings.length, 1, 'no point listing other findings — nothing else counts yet');
});

test('HARD RULE 3 — domain 2 below 10/20 caps at NOT_YET', () => {
  const s = flat(5);
  for (const c of DOMAINS[1].criteria) s[c.ref] = 2;   // domain 2 → 8/20
  const r = score(s);
  assert.equal(r.band, 'NOT_YET');
  assert.ok(r.hard_rule_findings.some((f) => f.rule === 'financial_gate'));
});

test('domain 2 at exactly 10 passes the gate; at 9 it does not', () => {
  const at = (raw) => {
    const s = flat(5);
    const per = [Math.ceil(raw / 4), Math.floor(raw / 4), Math.floor(raw / 4), raw - Math.ceil(raw / 4) - 2 * Math.floor(raw / 4)];
    DOMAINS[1].criteria.forEach((c, i) => { s[c.ref] = per[i]; });
    return score(s);
  };
  assert.equal(at(10).hard_rule_findings.some((f) => f.rule === 'financial_gate'), false);
  assert.equal(at(9).hard_rule_findings.some((f) => f.rule === 'financial_gate'), true);
});

test('rules combine — the weakest outcome wins and every finding is reported', () => {
  const s = flat(5);
  for (const c of DOMAINS[1].criteria) s[c.ref] = 1;   // domain 2 → 4: floor AND financial gate
  for (const c of DOMAINS[4].criteria) s[c.ref] = 1;   // domain 5 → 4: floor
  const r = score(s);

  assert.equal(r.band, 'NOT_YET');
  const rules = r.hard_rule_findings.map((f) => f.rule);
  assert.ok(rules.includes('floor'));
  assert.ok(rules.includes('financial_gate'));
  assert.equal(rules.filter((x) => x === 'floor').length, 2, 'both failing domains are named');
});

test('a partially scored domain is not punished by the floor rule', () => {
  // Scoring 1.1 only would give domain 1 a raw of 4 — below the floor — but it
  // is low because it is unanswered, not because it is weak. Penalising that
  // would train people to guess rather than go and find out.
  const r = score({ '1.1': 4 }, { partial: true });
  assert.equal(r.hard_rule_findings.some((f) => f.rule === 'floor'), false);
  assert.ok(r.hard_rule_findings.some((f) => f.rule === 'incomplete'));
});

// ──────────────────────────────────────────────────────────── the gap register ──

test('gaps are generated for every criterion scoring 3 or below', () => {
  const r = score({ ...flat(5), '2.1': 1, '4.3': 3, '7.2': 4 });
  const gaps = deriveGaps(r);
  const refs = gaps.map((g) => g.criterion_ref);
  assert.ok(refs.includes('2.1'));
  assert.ok(refs.includes('4.3'), '3 is at the threshold and generates a gap');
  assert.equal(refs.includes('7.2'), false, '4 is above the threshold');
});

test('gaps are returned in FIX order, not score order', () => {
  // 1.1 is a BLOCKER scoring 3; 2.1 is LONG_LEAD scoring 0.
  // Score order would put 2.1 first. Fix order must not.
  const r = score({ ...flat(5), '1.1': 3, '2.1': 0, '8.1': 0 });
  const gaps = deriveGaps(r);
  assert.equal(gaps[0].criterion_ref, '1.1', 'a blocker goes first whatever it scored');
  assert.equal(gaps.at(-1).criterion_ref, '8.1', 'the room is built last, however badly it scored');
  assert.ok(gaps.every((g) => g.rationale.length > 10), 'every gap explains its sequencing');
});

test('every gap has an observable finish line', () => {
  const gaps = deriveGaps(score(flat(1)));
  assert.equal(gaps.length, 32, 'all 32 criteria are below the threshold');
  for (const g of gaps) {
    assert.ok(g.done_when && g.done_when.length > 20, `${g.criterion_ref} needs a real "done when"`);
  }
});

test('owner capacity is enforced as a warning at four open gaps', () => {
  const mk = (n, owner) => Array.from({ length: n }, (_, i) => ({ criterion_ref: `x${i}`, owner_user_id: owner }));
  assert.deepEqual(overCapacityOwners(mk(OWNER_CAPACITY, 'u1')), [], 'three is within capacity');

  const over = overCapacityOwners(mk(OWNER_CAPACITY + 1, 'u1'));
  assert.equal(over.length, 1);
  assert.equal(over[0].open, 4);
  assert.match(over[0].detail, /queue, not a plan/);
});

// ────────────────────────────────────────────────────────── the service flow ──

test('end to end: create, score across sessions, complete, get gaps', () => {
  const { ctx, org: o } = org();
  const id = a.createAssessment(ctx, o.id, { label: 'Baseline' }).body.assessment.id;

  // Session one: domains 1 and 2 only.
  const s1 = {};
  for (const d of DOMAINS.slice(0, 2)) for (const c of d.criteria) s1[c.ref] = 4;
  const partial = a.scoreAssessment(ctx, o.id, id, s1).body;
  assert.equal(partial.result.complete, false);
  assert.equal(partial.result.unscored, 24);

  // Cannot complete while unscored.
  expectRefusal(() => a.completeAssessment(ctx, o.id, id), 'incomplete');

  // Remaining sessions.
  const rest = {};
  for (const d of DOMAINS.slice(2)) for (const c of d.criteria) rest[c.ref] = 3;
  a.scoreAssessment(ctx, o.id, id, rest);

  const done = a.completeAssessment(ctx, o.id, id).body;
  assert.equal(done.assessment.complete, true);
  assert.ok(done.assessment.completed_at);
  assert.ok(done.result.band_means.length > 20, 'the band comes with what it means');
  assert.equal(done.gaps_created, 24, 'the 24 criteria scored 3 generate gaps; the 4s do not');

  const reg = a.listGaps(ctx, o.id).body;
  assert.equal(reg.open, 24);
  assert.equal(reg.warnings.unowned.length, 24, 'nothing is owned yet, and that is flagged');
});

test('a completed assessment cannot be re-scored — take a new one', () => {
  const { ctx, org: o } = org();
  const id = a.createAssessment(ctx, o.id).body.assessment.id;
  a.scoreAssessment(ctx, o.id, id, flat(4));
  a.completeAssessment(ctx, o.id, id);

  expectRefusal(() => a.scoreAssessment(ctx, o.id, id, { '1.1': 5 }), 'already_completed', 409);
  expectRefusal(() => a.completeAssessment(ctx, o.id, id), 'already_completed', 409);
});

test('re-scoring produces a trajectory — movement over time is the point', () => {
  const { ctx, org: o } = org();
  const first = a.createAssessment(ctx, o.id, { label: 'Baseline' }).body.assessment.id;
  a.scoreAssessment(ctx, o.id, first, flat(2));
  a.completeAssessment(ctx, o.id, first);

  const second = a.createAssessment(ctx, o.id, { label: '30-day re-score' }).body.assessment.id;
  a.scoreAssessment(ctx, o.id, second, flat(4));
  a.completeAssessment(ctx, o.id, second);

  const t = a.listAssessments(ctx, o.id).body.trajectory;
  assert.equal(t.length, 2);
  assert.ok(t[1].total > t[0].total, 'the trajectory shows improvement');
});

test('blind second scoring surfaces divergence of two or more points', () => {
  const { db, ctx, org: o } = org();
  const second = ctxFor(db, 'u-second');
  svc.createInvite(ctx, o.id, { email: 'u-second@example.com', role: 'EDITOR' });
  svc.listOrganisations(second);

  const mine = a.createAssessment(ctx, o.id, { label: 'Mine' }).body.assessment.id;
  a.scoreAssessment(ctx, o.id, mine, { '1.1': 5, '2.1': 4, '3.1': 3 });

  const theirs = a.createAssessment(second, o.id, { label: 'Theirs' }).body.assessment.id;
  a.scoreAssessment(second, o.id, theirs, { '1.1': 2, '2.1': 4, '3.1': 1 });

  const cmp = a.compareScorers(ctx, o.id, mine, theirs).body;
  assert.equal(cmp.divergences.length, 2, '1.1 and 3.1 diverge by 3 and 2; 2.1 agrees');
  assert.equal(cmp.divergences[0].criterion_ref, '1.1', 'largest divergence first');
  assert.match(cmp.note, /intention.*evidence/);
});

test('a gap owner must be a member of the organisation', () => {
  const { ctx, org: o } = org();
  const id = a.createAssessment(ctx, o.id).body.assessment.id;
  a.scoreAssessment(ctx, o.id, id, flat(1));
  a.completeAssessment(ctx, o.id, id);
  const gap = a.listGaps(ctx, o.id).body.gaps[0];

  expectRefusal(() => a.updateGap(ctx, o.id, gap.id, { owner_user_id: 'u-stranger' }), 'owner_not_a_member', 400);
  assert.equal(a.updateGap(ctx, o.id, gap.id, { owner_user_id: 'u-owner' }).status, 200);
});

test('assigning a fourth gap to one owner raises the capacity warning', () => {
  const { ctx, org: o } = org();
  const id = a.createAssessment(ctx, o.id).body.assessment.id;
  a.scoreAssessment(ctx, o.id, id, flat(1));
  a.completeAssessment(ctx, o.id, id);

  const gaps = a.listGaps(ctx, o.id).body.gaps;
  let last;
  for (let i = 0; i < 4; i++) last = a.updateGap(ctx, o.id, gaps[i].id, { owner_user_id: 'u-owner' }).body;

  assert.equal(last.warnings.over_capacity.length, 1);
  assert.equal(last.warnings.over_capacity[0].open, 4);
});

test('closing a gap removes it from the open register but keeps the history', () => {
  const { ctx, org: o } = org();
  const id = a.createAssessment(ctx, o.id).body.assessment.id;
  a.scoreAssessment(ctx, o.id, id, flat(1));
  a.completeAssessment(ctx, o.id, id);

  const gap = a.listGaps(ctx, o.id).body.gaps[0];
  a.closeGap(ctx, o.id, gap.id, { evidence: 'Cap table reconciled by the accountant' });

  assert.equal(a.listGaps(ctx, o.id).body.open, 31);
  assert.equal(a.listGaps(ctx, o.id, { includeClosed: true }).body.gaps.length, 32);
  expectRefusal(() => a.closeGap(ctx, o.id, gap.id), 'gap_closed', 409);

  const actions = svc.listAudit(ctx, o.id).body.entries.map((e) => e.action);
  assert.ok(actions.includes('gap.closed'));
});

test('re-completing an assessment preserves closed gaps and refreshes open ones', () => {
  const { ctx, org: o } = org();
  const id = a.createAssessment(ctx, o.id).body.assessment.id;
  a.scoreAssessment(ctx, o.id, id, flat(1));
  a.completeAssessment(ctx, o.id, id);

  const gap = a.listGaps(ctx, o.id).body.gaps[0];
  a.closeGap(ctx, o.id, gap.id);

  // A fresh assessment generates its own register; closed history survives.
  const next = a.createAssessment(ctx, o.id, { label: 'Re-score' }).body.assessment.id;
  a.scoreAssessment(ctx, o.id, next, flat(1));
  a.completeAssessment(ctx, o.id, next);

  const all = a.listGaps(ctx, o.id, { includeClosed: true }).body;
  assert.equal(all.closed, 1, 'the closed gap is still on the record');
});

test('assessments are org-scoped like everything else', () => {
  const { db, ctx, org: o } = org();
  const outsider = ctxFor(db, 'u-outsider');
  const id = a.createAssessment(ctx, o.id).body.assessment.id;

  expectRefusal(() => a.listAssessments(outsider, o.id), 'not_found', 404);
  expectRefusal(() => a.getAssessment(outsider, o.id, id), 'not_found', 404);
  expectRefusal(() => a.listGaps(outsider, o.id), 'not_found', 404);
});

test('a VIEWER can read the assessment but not score it', () => {
  const { db, ctx, org: o } = org();
  const viewer = ctxFor(db, 'u-viewer');
  svc.createInvite(ctx, o.id, { email: 'u-viewer@example.com', role: 'VIEWER' });
  svc.listOrganisations(viewer);

  const id = a.createAssessment(ctx, o.id).body.assessment.id;
  assert.ok(a.getAssessment(viewer, o.id, id).body);
  expectRefusal(() => a.scoreAssessment(viewer, o.id, id, { '1.1': 5 }), 'forbidden', 403);
  expectRefusal(() => a.createAssessment(viewer, o.id), 'forbidden', 403);
});
