/**
 * Phase 4 — the advisor.
 *
 * WHAT THESE TESTS COVER
 *
 * That an adversarial model cannot get an uncited claim, a fabricated citation,
 * an invented number, a valuation, a readiness verdict or a benchmark past the
 * validator — and that when it tries, the answer is withheld rather than shown
 * with a warning.
 *
 * WHAT THEY DO NOT COVER
 *
 * Whether a real model gives good advice. The advisor here is a deterministic
 * fake. The claim this phase supports is that nothing reaches a user that is
 * not traceable to a dated record or to their own documents — which is testable,
 * and is the claim worth making.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, ctxFor, expectRefusal } from './helpers.js';
import * as svc from '../src/api/service.js';
import * as api from '../src/api/advisor.js';
import * as domain from '../src/domain/advisor.js';
import { fakeAdvisor, groundedDraft, BAD_DRAFTS } from '../src/advisor/fake.js';
import { ALL_REFS } from '../src/domain/criteria.js';
import * as assessments from '../src/api/assessments.js';

function world() {
  const db = freshDb();
  const ctx = ctxFor(db, 'u-owner');
  const org = svc.createOrganisation(ctx, { name: 'Test Co', path: 'RAISE' }).body.organisation;
  const thread = api.createThread(ctx, org.id, { title: 'Preparing' }).body.thread;
  return { db, ctx, org, thread };
}

/** An advisor that always returns the same draft, whatever it is asked. */
const always = (draft) => fakeAdvisor({ default: draft });

const NORMALISATION_Q = 'how do I build a normalisation bridge for criterion 2.3?';

/** Give the org a confirmed fact so number rules can be exercised against a real one. */
function withFact(ctx, orgId, { value = 4_200_000, key = 'financials.arr', label = 'ARR' } = {}) {
  return svc.createFact(ctx, orgId, {
    fact_key: key, label, value_numeric: value, unit: 'USD',
    source: 'USER_CONFIRMED', source_doc_id: 'accounts-2025', source_page: 3,
  }).body.fact;
}

// ───────────────────────────────────────────────── the grounded happy path ──

test('a well-formed answer is rendered with its citations and its source', async () => {
  const { ctx, org, thread } = world();
  const res = await api.ask(ctx, org.id, thread.id, NORMALISATION_Q, always(groundedDraft()));

  assert.equal(res.status, 201);
  assert.equal(res.body.message.refused, false);
  assert.ok(res.body.answer.includes('[1]'), 'claims carry citation markers');
  assert.match(res.body.answer, /Where this comes from/);
  assert.match(res.body.answer, /The normalisation bridge \(K-2\.3-normalisation\)/);
  assert.match(res.body.answer, /TekAIDA Consulting LLC, version 1\.0, last reviewed/);
  assert.ok(res.body.citations.includes('knowledge:K-2.3-normalisation'));
});

test('the answer keeps its workings — model, corpus edition and every citation', async () => {
  const { db, ctx, org, thread } = world();
  await api.ask(ctx, org.id, thread.id, NORMALISATION_Q,
    fakeAdvisor({ default: groundedDraft() }, { id: 'anthropic-advisor-v1', version: '2026-10-01' }));

  const row = db.find('advisor_message', { org_id: org.id })[0];
  assert.equal(row.advisor_id, 'anthropic-advisor-v1');
  assert.equal(row.advisor_version, '2026-10-01');
  assert.equal(row.knowledge_version, '1.0');
  assert.ok(JSON.parse(row.draft).sections.length, 'the structured draft is kept, not just the prose');
  assert.ok(JSON.parse(row.citations).length);
});

// ──────────────────────────────────────── the four rules, against a model ──

test('an uncited claim is rejected and the answer is withheld entirely', async () => {
  const { ctx, org, thread } = world();
  const res = await api.ask(ctx, org.id, thread.id, NORMALISATION_Q, always(BAD_DRAFTS.uncited));

  assert.equal(res.body.refused, true);
  assert.equal(res.body.code, 'failed_validation');
  assert.ok(res.body.problems.some((p) => p.code === 'uncited_claim'));

  // The whole answer goes, including the claim that WAS cited. A partly
  // verified answer is not a verified answer.
  assert.doesNotMatch(res.body.message.answer, /normalisation bridge\./);
  assert.match(res.body.message.answer, /has not been shown/);
});

test('a fabricated citation is caught — a plausible id that was never retrieved', async () => {
  const { ctx, org, thread } = world();
  const res = await api.ask(ctx, org.id, thread.id, NORMALISATION_Q, always(BAD_DRAFTS.fabricatedCitation));

  assert.equal(res.body.code, 'failed_validation');
  const problem = res.body.problems.find((p) => p.code === 'citation_not_in_context');
  assert.ok(problem, 'a citation that looks right and does not exist is worse than none');
  assert.match(problem.problem, /K-2\.3-normalization-guidance/);
});

test('a plausible round number that came from the model is caught', async () => {
  const { ctx, org, thread } = world();
  const res = await api.ask(ctx, org.id, thread.id, NORMALISATION_Q, always(BAD_DRAFTS.inventedNumber));

  const problem = res.body.problems.find((p) => p.code === 'unaccounted_number');
  assert.ok(problem);
  assert.match(problem.problem, /"12"/, 'the specific numeral is named, so a retry can fix it');
});

test('a near-miss figure about the company is caught, not rounded into acceptance', async () => {
  const { ctx, org, thread } = world();
  withFact(ctx, org.id, { value: 4_200_000 });

  // $4.5m against a real $4.2m. The dangerous case: close enough to look right
  // in a sentence, wrong enough to matter in a deck.
  const res = await api.ask(ctx, org.id, thread.id, NORMALISATION_Q, always(BAD_DRAFTS.nearMissNumber));
  assert.ok(res.body.problems.some((p) => p.code === 'unaccounted_number'));
});

test('a figure that legitimately renders a fact at the precision written is accepted', async () => {
  const { ctx, org, thread } = world();
  const fact = withFact(ctx, org.id, { value: 4_200_000 });

  const res = await api.ask(ctx, org.id, thread.id, NORMALISATION_Q, always({
    sections: [{
      claims: [{
        text: 'Your ARR of $4.2m is the figure the bridge has to reconcile to.',
        cites: [`fact:${fact.id}`, 'knowledge:K-2.3-normalisation'],
      }],
    }],
  }));

  assert.equal(res.status, 201, '$4.2m and $4,200,000 are one number written two ways');
  assert.match(res.body.answer, /confirmed by you from a document, page 3/);
});

test('rounding is allowed only to the precision actually written', () => {
  const written = domain.parseNumeral('$4.2m');
  assert.equal(written.value, 4_200_000);
  assert.equal(written.quantum, 100_000);

  assert.equal(domain.rendersValue(written, 4_199_614), true, '4,199,614 does round to 4.2m');
  assert.equal(domain.rendersValue(written, 4_250_001), false, 'and 4,250,001 does not');

  const exact = domain.parseNumeral('4,200,000');
  assert.equal(exact.quantum, 1);
  assert.equal(domain.rendersValue(exact, 4_199_614), false,
    'a figure written in full claims a precision it must then have');
});

test('spelled-out numbers are free; digits must be accounted for', () => {
  const cited = { facts: [], records: [], criteria: [], figures: [], gaps: [] };
  assert.deepEqual(domain.unaccountedNumerals('There are three things to do.', cited), []);
  assert.deepEqual(domain.unaccountedNumerals('There are 3 things to do.', cited), ['3']);
});

test('a number quoted from a cited record is not an invented number', () => {
  const cited = {
    facts: [], criteria: [], figures: [], gaps: [],
    records: [{ title: 'T', body: 'the bridge carries 3 columns', pitfalls: [] }],
  };
  assert.deepEqual(domain.unaccountedNumerals('The bridge carries 3 columns.', cited), []);
});

test('a criterion reference is a citable number, but only when the criterion is cited', () => {
  const base = { facts: [], records: [], figures: [], gaps: [] };
  assert.deepEqual(domain.unaccountedNumerals('Criterion 2.3 covers this.', { ...base, criteria: ['2.3'] }), []);
  assert.deepEqual(domain.unaccountedNumerals('Criterion 2.3 covers this.', { ...base, criteria: [] }), ['2.3']);
});

// ───────────────────────────────────────────────── the refusal boundary ──

test('a valuation question is refused before any model is called', async () => {
  const { ctx, org, thread } = world();
  let called = false;
  const advisor = fakeAdvisor({ default: groundedDraft() });
  const spy = { ...advisor, answer: async (...a) => { called = true; return advisor.answer(...a); } };

  const res = await api.ask(ctx, org.id, thread.id, 'what is my company worth?', spy);

  assert.equal(res.body.code, 'valuation');
  assert.equal(called, false, 'a deterministic refusal costs no model call, so it cannot be softened later');
  assert.match(res.body.message.answer, /does not originate numbers about your business/);
});

test('each refused topic is caught, and says why rather than just declining', async () => {
  const { ctx, org, thread } = world();
  const advisor = always(groundedDraft());

  const cases = [
    ['how much should we raise?', 'valuation'],
    ['can you introduce me to investors who might fund us?', 'introductions'],
    ['is this clause legal?', 'professional_advice'],
    ['are we investor-ready?', 'readiness_verdict'],
    ['how do we compare to other companies?', 'other_organisations'],
  ];

  for (const [question, code] of cases) {
    const res = await api.ask(ctx, org.id, thread.id, question, advisor);
    assert.equal(res.body.code, code, `"${question}" should be refused as ${code}`);
    assert.ok(res.body.message.answer.length > 120, 'a bare refusal reads as unhelpfulness, not as a line drawn');
  }
});

test('introductions are refused as permanently out of scope, not as not-yet-built', async () => {
  const { ctx, org, thread } = world();
  const res = await api.ask(ctx, org.id, thread.id,
    'which investors should we approach?', always(groundedDraft()));

  assert.equal(res.body.code, 'introductions');
  assert.match(res.body.message.answer, /not going to be built/);
});

test('a valuation volunteered in answer to an innocent question is still caught', async () => {
  const { ctx, org, thread } = world();
  // The question is legitimate; the answer wanders. Screening the question is
  // not enough on its own.
  const res = await api.ask(ctx, org.id, thread.id, NORMALISATION_Q, always(BAD_DRAFTS.valuation));
  assert.ok(res.body.problems.some((p) => p.code === 'claims_valuation'));
});

test('a readiness verdict, an outcome prediction and a guarantee are all refused', () => {
  const context = { records: [{ id: 'K-2.3-normalisation', title: 'x', body: 'y' }], facts: [], figures: [], gaps: [] };
  const cases = [
    [BAD_DRAFTS.readinessVerdict, 'claims_readiness'],
    [BAD_DRAFTS.speaksForInvestors, 'claims_about_counterparties'],
    [BAD_DRAFTS.benchmark, 'claims_benchmark'],
  ];
  for (const [draft, code] of cases) {
    const v = domain.validateDraft(draft, context);
    assert.equal(v.ok, false);
    assert.ok(v.problems.some((p) => p.code === code), `expected ${code}`);
  }
});

test('the product does not speak for investors it has not met', () => {
  const context = { records: [{ id: 'K-2.3-normalisation', title: 'x', body: 'y' }], facts: [], figures: [], gaps: [] };
  const v = domain.validateDraft(BAD_DRAFTS.speaksForInvestors, context);
  const p = v.problems.find((x) => x.code === 'claims_about_counterparties');
  assert.match(p.problem, /speaks for counterparties/);
});

// ─────────────────────────────────────────────────────── retry and reporting ──

test('every problem is reported at once, so a retry can fix all of them', async () => {
  const { ctx, org, thread } = world();
  const res = await api.ask(ctx, org.id, thread.id, NORMALISATION_Q, always(BAD_DRAFTS.multipleProblems));

  const codes = new Set(res.body.problems.map((p) => p.code));
  assert.ok(codes.has('uncited_claim'));
  assert.ok(codes.has('unaccounted_number'));
  assert.ok(codes.has('citation_not_in_context'));
  assert.ok(res.body.problems.length >= 3,
    'reporting one at a time means discovering the next one each retry');
});

test('a bad first draft is retried once, and a good second one is accepted', async () => {
  const { ctx, org, thread } = world();
  let call = 0;
  const advisor = {
    id: 'retrying', version: '1',
    async answer() { call++; return call === 1 ? BAD_DRAFTS.uncited : groundedDraft(); },
  };

  const res = await api.ask(ctx, org.id, thread.id, NORMALISATION_Q, advisor);
  assert.equal(res.status, 201);
  assert.equal(res.body.attempts, 2);
});

test('the problems from a failed attempt are handed back on the retry', async () => {
  const { ctx, org, thread } = world();
  let seen = null;
  const advisor = {
    id: 'a', version: '1',
    async answer({ problems }) {
      if (problems) { seen = problems; return groundedDraft(); }
      return BAD_DRAFTS.uncited;
    },
  };

  await api.ask(ctx, org.id, thread.id, NORMALISATION_Q, advisor);
  assert.ok(seen?.some((p) => p.code === 'uncited_claim'), 'a retry told nothing will fail the same way');
});

test('"I cannot answer that" is a successful turn, not a failure', async () => {
  const { ctx, org, thread } = world();
  const res = await api.ask(ctx, org.id, thread.id, NORMALISATION_Q,
    always({ cannot_answer: { why: 'the records do not cover a company at this stage' } }));

  assert.equal(res.body.code, 'cannot_answer');
  assert.match(res.body.message.answer, /the records do not cover/);
});

test('a question the corpus does not cover gets no answer rather than an unsourced one', async () => {
  const { ctx, org, thread } = world();
  let called = false;
  const advisor = { id: 'a', version: '1', async answer() { called = true; return groundedDraft(); } };

  const res = await api.ask(ctx, org.id, thread.id,
    'what does the weather look like in Sheridan tomorrow?', advisor);

  assert.equal(res.body.code, 'not_covered');
  assert.equal(called, false, 'with nothing retrieved there is nothing to ground an answer in');
  assert.match(res.body.message.answer, /does not fall back on what a model happens to remember/);
});

// ───────────────────────────────────────────────── grounded in their own data ──

test('an unconfirmed extraction cannot be quoted back as established', () => {
  const { db, ctx, org } = world();

  // A candidate awaiting review, planted as a fact row the way a future bulk
  // import might. The advisor must not be able to repeat a figure the user has
  // not yet looked at.
  db.insert('fact', {
    org_id: org.id, fact_key: 'financials.arr', label: 'ARR',
    value_numeric: 9_999_999, value_text: null, value_date: null, unit: 'USD',
    period_start: null, period_end: null, source: 'DOCUMENT_EXTRACTED',
    source_doc_id: 'd1', source_page: 1, formula: null, input_fact_ids: null,
    confirmed_at: null, confirmed_by: null, superseded_by: null,
    created_by: 'u-owner', created_at: '2026-01-01T00:00:00.000Z',
  });

  const context = api.buildContext(ctx, org.id, NORMALISATION_Q);
  assert.equal(context.facts.length, 0, 'it is a proposal, not something to advise on');
});

test('the advisor can cite a score the app calculated from the user\'s own answers', async () => {
  const { ctx, org, thread } = world();
  const a = assessments.createAssessment(ctx, org.id, { label: 'Baseline' }).body.assessment;
  assessments.scoreAssessment(ctx, org.id, a.id, Object.fromEntries(ALL_REFS.map((r) => [r, 3])));
  assessments.completeAssessment(ctx, org.id, a.id);

  const context = api.buildContext(ctx, org.id, NORMALISATION_Q);
  const total = context.figures.find((f) => f.ref.endsWith('.total'));
  assert.ok(total, 'the band total is citable');
  assert.equal(total.value, 120);

  const res = await api.ask(ctx, org.id, thread.id, NORMALISATION_Q, always({
    sections: [{
      claims: [{
        // "domain two" spelled out, because a bare "2" is not in anything this
        // claim cites and the validator is right to say so. The rule nudges the
        // prose towards words for counts and digits only for measured
        // quantities, which reads better anyway.
        text: 'Your weighted total is 120, and domain two is where the bridge sits.',
        cites: [`figure:${total.ref}`, 'knowledge:K-2.3-normalisation'],
      }],
    }],
  }));

  assert.equal(res.status, 201);
  assert.match(res.body.answer, /calculated by RaiseRoom from your own scores/);
});

test('retrieval is steered by the gaps the organisation actually has open', () => {
  const { ctx, org } = world();
  const before = api.explainRetrieval(ctx, org.id, 'what should I work on next?').body;

  const a = assessments.createAssessment(ctx, org.id, {}).body.assessment;
  assessments.scoreAssessment(ctx, org.id, a.id,
    Object.fromEntries(ALL_REFS.map((r) => [r, r === '5.1' ? 1 : 4])));
  assessments.completeAssessment(ctx, org.id, a.id);

  const after = api.explainRetrieval(ctx, org.id, 'what should I work on next?').body;
  const ip = after.records.find((r) => r.id === 'K-5.1-ip-assignment');

  assert.ok(ip, 'their open gap on 5.1 pulls in the record behind it');
  assert.ok(ip.why.some((w) => w.includes('open in your gap register')));
  assert.ok(after.records.length > before.records.length);
});

test('retrieval can be inspected before an answer is asked for', () => {
  const { ctx, org } = world();
  const body = api.explainRetrieval(ctx, org.id, 'customer concentration and the trend').body;

  const hit = body.records.find((r) => r.id === 'K-3.1-concentration');
  assert.ok(hit);
  assert.ok(hit.why.length, 'a user can tell retrieval from improvisation');
  assert.equal(body.corpus_version, '1.0');
});

test('"what next" is answered from their own register, with no model involved', () => {
  const { ctx, org } = world();
  const a = assessments.createAssessment(ctx, org.id, {}).body.assessment;
  assessments.scoreAssessment(ctx, org.id, a.id,
    Object.fromEntries(ALL_REFS.map((r) => [r, r === '1.1' ? 2 : 3])));
  assessments.completeAssessment(ctx, org.id, a.id);

  const body = api.nextActions(ctx, org.id).body;
  assert.equal(body.generated, false, 'their data, sorted by a published rule — nothing to hallucinate');
  assert.ok(body.actions.length);
  assert.ok(body.actions[0].criterion, 'each action carries the criterion behind it');
  assert.match(body.basis, /fix order/);
});

// ──────────────────────────────────────────────────────── access and isolation ──

test('a viewer cannot ask, and a non-member gets 404 rather than 403', async () => {
  const { db, ctx, org, thread } = world();
  db.insert('membership', {
    org_id: org.id, user_id: 'u-viewer', email: 'v@example.com', role: 'VIEWER', created_at: '2026-01-01',
  });

  await assert.rejects(
    () => api.ask(ctxFor(db, 'u-viewer'), org.id, thread.id, NORMALISATION_Q, always(groundedDraft())),
    (err) => err.code === 'forbidden' && err.status === 403,
  );

  expectRefusal(() => api.getThread(ctxFor(db, 'u-stranger'), org.id, thread.id), 'not_found', 404);
});

test("another organisation's thread is a 404", () => {
  const { db, ctx, org, thread } = world();
  const other = ctxFor(db, 'u-other');
  const otherOrg = svc.createOrganisation(other, { name: 'Other Co' }).body.organisation;

  expectRefusal(() => api.getThread(other, otherOrg.id, thread.id), 'not_found', 404);
});

test('an advisor that will not identify itself is not trusted with a question', async () => {
  const { ctx, org, thread } = world();
  await assert.rejects(
    () => api.ask(ctx, org.id, thread.id, NORMALISATION_Q, { version: '1', answer: async () => ({}) }),
    (err) => err.code === 'advisor_unidentified',
  );
});

test('an empty or malformed draft is rejected rather than rendered as nothing', () => {
  const v = domain.validateDraft(BAD_DRAFTS.empty, { records: [], facts: [], figures: [], gaps: [] });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'malformed_draft');
});

// ───────────────────────────────────────────────────────────────── staleness ──

test('citing a record past its review date without saying so is rejected', () => {
  const record = {
    id: 'K-2.3-normalisation', title: 'The normalisation bridge', body: 'x',
    source: 'bta-v1', reviewed: '2020-01-01', reviewIntervalMonths: 6,
  };
  const context = { records: [record], facts: [], figures: [], gaps: [], asOf: '2026-10-13T00:00:00.000Z' };
  const draft = { sections: [{ claims: [{ text: 'A bridge needs evidence.', cites: ['knowledge:K-2.3-normalisation'] }] }] };

  const bad = domain.validateDraft(draft, context);
  assert.equal(bad.ok, false);
  assert.equal(bad.problems[0].code, 'undisclosed_stale_source');

  const good = domain.validateDraft({ ...draft, staleness_acknowledged: true }, context);
  assert.equal(good.ok, true, 'it is shown because it is what we have, and flagged because it is old');
  assert.deepEqual(good.overdue, ['K-2.3-normalisation']);
});

test('an answer resting on an overdue record says so in the rendered text', () => {
  const record = {
    id: 'K-2.3-normalisation', title: 'The normalisation bridge', body: 'x',
    source: 'bta-v1', reviewed: '2020-01-01', reviewIntervalMonths: 6,
  };
  const context = { records: [record], facts: [], figures: [], gaps: [], asOf: '2026-10-13T00:00:00.000Z' };
  const draft = {
    staleness_acknowledged: true,
    sections: [{ claims: [{ text: 'A bridge needs evidence.', cites: ['knowledge:K-2.3-normalisation'] }] }],
  };

  const v = domain.validateDraft(draft, context);
  assert.match(domain.renderAnswer(draft, v), /past its review date/);
});

test('the knowledge base is readable, with its review state and its boundaries', () => {
  const { ctx, org } = world();
  const body = api.knowledgeBase(ctx, org.id).body;

  assert.equal(body.corpus_version, '1.0');
  assert.ok(body.records > 10);
  assert.deepEqual(body.overdue, [], 'the shipped corpus is within its review interval');
  assert.ok(body.boundaries.some((b) => b.code === 'introductions'),
    'an advisor that refuses things should say what, and why');
});
