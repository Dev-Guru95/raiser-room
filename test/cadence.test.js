/**
 * Phase 6 — the operating cadence.
 *
 * The thing being protected here is a record, not a feature. Eighteen months of
 * locked forecasts set against actuals, with the variances explained at the
 * time, is an asset no competitor can hand a company retrospectively — and the
 * only way to lose it is to let the forecasts move.
 *
 * So most of these tests are about what cannot be done.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, ctxFor, expectRefusal , onPlan } from './helpers.js';
import * as svc from '../src/api/service.js';
import * as api from '../src/api/cadence.js';
import {
  materialityOf, needsExplanation, credibility, computeVariances,
  explanationTimeliness, trajectoryInputs, runwayInput, MATERIALITY_BANDS,
  PROMPT_EXPLANATION_DAYS, CYCLES_NEEDED,
} from '../src/domain/cadence.js';

function world() {
  const db = freshDb();
  const ctx = ctxFor(db, 'u-founder');
  const org = svc.createOrganisation(ctx, { name: 'Northwind Systems', path: 'RAISE' }).body.organisation;
  onPlan(db, org.id, 'RAISEROOM');
  return { db, ctx, org };
}

/** A locked forecast for one metric over one period. */
function lockedForecast(ctx, orgId, {
  label = 'FY2026 budget', value = 1_000_000,
  start = '2026-01-01', end = '2026-01-31', key = 'financials.revenue.mrr',
} = {}) {
  const f = api.createForecast(ctx, orgId, {
    label, basis: 'Built bottom-up from pipeline and current run rate.',
  }).body.forecast;
  api.addForecastLine(ctx, orgId, f.id, {
    fact_key: key, label: 'Monthly revenue', value_numeric: value,
    period_start: start, period_end: end, unit: 'USD',
  });
  return api.lockForecast(ctx, orgId, f.id).body.forecast;
}

const actual = (ctx, orgId, value, { key = 'financials.revenue.mrr', start = '2026-01-01', end = '2026-01-31' } = {}) =>
  svc.createFact(ctx, orgId, {
    fact_key: key, label: 'Monthly revenue', value_numeric: value, unit: 'USD',
    period_start: start, period_end: end, source: 'USER_ENTERED',
  }).body.fact;

// ──────────────────────────────── the rule the phase rests on ──

test('a locked forecast cannot be changed', () => {
  const { ctx, org } = world();
  const f = lockedForecast(ctx, org.id);

  expectRefusal(() => api.addForecastLine(ctx, org.id, f.id, {
    fact_key: 'financials.revenue.mrr', label: 'Revenue', value_numeric: 2_000_000,
    period_start: '2026-02-01', period_end: '2026-02-28',
  }), 'forecast_locked', 409);

  expectRefusal(() => api.removeForecastLine(ctx, org.id, f.lines[0].id), 'forecast_locked', 409);
});

test('the refusal explains why, because it is the whole product argument', () => {
  const { ctx, org } = world();
  const f = lockedForecast(ctx, org.id);
  const err = expectRefusal(() => api.addForecastLine(ctx, org.id, f.id, {
    fact_key: 'x', label: 'x', value_numeric: 1, period_start: '2026-01-01', period_end: '2026-01-31',
  }), 'forecast_locked');

  assert.match(err.message, /not evidence of anything/);
  assert.match(err.message, /what you believed at the time/);
});

test('REGRESSION: actuals arriving do not move the forecast', () => {
  // The tempting behaviour, and the one that would destroy the asset: slide the
  // forecast to match the outcome and every company appears to hit plan.
  const { db, ctx, org } = world();
  const f = lockedForecast(ctx, org.id, { value: 1_000_000 });

  actual(ctx, org.id, 620_000);
  api.closePeriod(ctx, org.id, { period_start: '2026-01-01', period_end: '2026-01-31' });

  const line = db.find('forecast_line', { forecast_id: f.id })[0];
  assert.equal(line.value_numeric, 1_000_000, 'the forecast still says what it said');

  const v = db.find('variance', { org_id: org.id })[0];
  assert.equal(v.forecast_value, 1_000_000);
  assert.equal(v.actual_value, 620_000);
  assert.equal(v.materiality, 'SEVERE');
});

test('a revision is a new version, and the old one stays on the record', () => {
  const { ctx, org } = world();
  const first = lockedForecast(ctx, org.id);

  expectRefusal(() => api.reviseForecast(ctx, org.id, first.id, { reason: 'changed' }),
    'reason_required', 400);

  const res = api.reviseForecast(ctx, org.id, first.id, {
    reason: 'Procurement freeze at two enterprise accounts pushed the H1 plan out by a quarter.',
  });

  assert.equal(res.body.forecast.version, 2);
  assert.equal(res.body.forecast.state, 'DRAFT', 'a new version starts editable');
  assert.equal(res.body.forecast.lines.length, 1, 'it starts from the old one rather than from nothing');

  const old = api.listForecasts(ctx, org.id).body.forecasts.find((f) => f.id === first.id);
  assert.equal(old.state, 'SUPERSEDED');
  assert.match(old.supersede_reason, /Procurement freeze/);
});

test('a superseded forecast is still measured — you cannot revise your way to a clean record', () => {
  const { db, ctx, org } = world();
  const first = lockedForecast(ctx, org.id, { value: 1_000_000 });
  api.reviseForecast(ctx, org.id, first.id, {
    reason: 'Rebasing after a slower start than planned.',
  });

  actual(ctx, org.id, 600_000);
  api.closePeriod(ctx, org.id, { period_start: '2026-01-01', period_end: '2026-01-31' });

  const variances = db.find('variance', { org_id: org.id });
  assert.ok(variances.some((v) => v.forecast_id === first.id),
    'the superseded forecast was still what the company believed at the time');
});

test('a forecast with no lines, or no stated basis, cannot be locked', () => {
  const { ctx, org } = world();

  const empty = api.createForecast(ctx, org.id, { label: 'Empty', basis: 'x' }).body.forecast;
  expectRefusal(() => api.lockForecast(ctx, org.id, empty.id), 'nothing_to_lock', 400);

  const noBasis = api.createForecast(ctx, org.id, { label: 'No basis' }).body.forecast;
  api.addForecastLine(ctx, org.id, noBasis.id, {
    fact_key: 'financials.revenue.mrr', label: 'Revenue', value_numeric: 1,
    period_start: '2026-01-01', period_end: '2026-01-31',
  });
  const err = expectRefusal(() => api.lockForecast(ctx, org.id, noBasis.id), 'basis_required', 400);
  assert.match(err.message, /the reasoning is what a reader is actually assessing/);
});

test('a forecast line with no period is refused', () => {
  const { ctx, org } = world();
  const f = api.createForecast(ctx, org.id, { label: 'F', basis: 'b' }).body.forecast;
  expectRefusal(() => api.addForecastLine(ctx, org.id, f.id, {
    fact_key: 'x', label: 'Revenue', value_numeric: 100,
  }), 'line_missing_period', 400);
});

// ───────────────────────────────────────── variance and materiality ──

test('materiality is measured against the forecast, not the outcome', () => {
  // A forecast of 100 against an actual of 10 is a 90% miss of the plan, not a
  // 900% one. Dividing by the outcome changes the answer whenever the outcome
  // is the small number.
  assert.equal(materialityOf(100, 10), 'SEVERE');
  assert.equal(materialityOf(100, 103), 'ON_PLAN');
  assert.equal(materialityOf(100, 112), 'MINOR');
  assert.equal(materialityOf(100, 125), 'MATERIAL');
  assert.equal(materialityOf(100, 60), 'SEVERE');

  // The case that actually distinguishes the two rules, which the examples
  // above do not: forecast 100 against actual 140 is a 40% miss of the plan
  // (SEVERE) but only 29% of the outcome (MATERIAL). Measuring against the
  // outcome quietly downgrades every overshoot.
  assert.equal(materialityOf(100, 140), 'SEVERE');
});

test('only material and severe variances demand an explanation', () => {
  assert.equal(needsExplanation('ON_PLAN'), false, 'explaining noise wastes the reader');
  assert.equal(needsExplanation('MINOR'), false);
  assert.equal(needsExplanation('MATERIAL'), true);
  assert.equal(needsExplanation('SEVERE'), true);
  assert.equal(MATERIALITY_BANDS.length, 4);
});

test('a period with no actual yet is awaiting, never a hundred per cent miss', () => {
  const lines = [{
    id: 'l1', fact_key: 'financials.revenue.mrr', label: 'Revenue',
    period_start: '2026-03-01', period_end: '2026-03-31', value_numeric: 1_000_000,
  }];
  const [v] = computeVariances(lines, []);
  assert.equal(v.materiality, 'AWAITING');
  assert.equal(v.delta, null, 'scoring an unclosed month as a total shortfall would be alarming and wrong');
});

test('closing a period computes variances and asks for the explanations', () => {
  const { ctx, org } = world();
  lockedForecast(ctx, org.id, { value: 1_000_000 });
  actual(ctx, org.id, 1_300_000);

  const res = api.closePeriod(ctx, org.id, { period_start: '2026-01-01', period_end: '2026-01-31' });
  assert.equal(res.status, 201);
  assert.equal(res.body.variances.length, 1);
  assert.equal(res.body.variances[0].materiality, 'MATERIAL');
  assert.equal(res.body.needing_explanation, 1);
  assert.match(res.body.prompt, /worth more than doing it next year/);
});

test('a period cannot be closed twice', () => {
  const { ctx, org } = world();
  api.closePeriod(ctx, org.id, { period_start: '2026-01-01', period_end: '2026-01-31' });
  expectRefusal(() => api.closePeriod(ctx, org.id, {
    period_start: '2026-01-01', period_end: '2026-01-31',
  }), 'already_closed', 409);
});

test('an explanation has to say what happened', () => {
  const { db, ctx, org } = world();
  lockedForecast(ctx, org.id, { value: 1_000_000 });
  actual(ctx, org.id, 600_000);
  api.closePeriod(ctx, org.id, { period_start: '2026-01-01', period_end: '2026-01-31' });
  const v = db.find('variance', { org_id: org.id })[0];

  const err = expectRefusal(() => api.explainVariance(ctx, org.id, v.id, { explanation: 'timing' }),
    'explanation_too_short', 400);
  assert.match(err.message, /says what happened, not that something happened/);

  const res = api.explainVariance(ctx, org.id, v.id, {
    explanation: 'Two enterprise deals slipped into Q2 after a procurement freeze at both accounts.',
  });
  assert.match(res.body.variance.explanation, /procurement freeze/);
  assert.ok(res.body.variance.explained_at);
});

test('when an explanation was written is recorded, and visible', () => {
  // An explanation written in the week is evidence that the business
  // understands its drivers. The same words eight months later are a
  // reconstruction, and a reader comparing the dates will see it.
  assert.equal(explanationTimeliness('2026-01-31', '2026-02-10').state, 'PROMPT');
  assert.equal(explanationTimeliness('2026-01-31', '2026-05-10').state, 'LATE');

  const old = explanationTimeliness('2026-01-31', '2026-11-10');
  assert.equal(old.state, 'RECONSTRUCTED');
  assert.match(old.note, /a reader will see the date/);

  assert.equal(explanationTimeliness('2026-01-31', null).state, 'UNEXPLAINED');
  assert.ok(PROMPT_EXPLANATION_DAYS >= 30, 'a month-end close needs room to happen');
});

// ─────────────────────────────────────────────────── credibility ──

test('credibility needs three cycles and cannot be asserted', () => {
  const none = credibility([]);
  assert.equal(none.cycles_complete, 0);
  assert.equal(none.meets_criterion, false);
  assert.match(none.statement, /cannot be produced retrospectively/);

  const cycle = (explained) => ({
    complete: true,
    variances: [{
      materiality: 'MATERIAL', period_end: '2026-01-31',
      explanation: explained ? 'Deals slipped' : null,
      explained_at: explained ? '2026-02-05' : null,
    }],
  });

  assert.equal(credibility([cycle(true), cycle(true)]).meets_criterion, false, 'two is not three');
  assert.equal(credibility([cycle(true), cycle(true), cycle(true)]).meets_criterion, true);

  // The reported requirement and the enforced one must be the same number.
  // They were not: the threshold appeared twice and only one of them mattered.
  assert.equal(credibility([]).cycles_needed, CYCLES_NEEDED);
  assert.equal(CYCLES_NEEDED, 3);
  const twoOfThree = credibility([cycle(true), cycle(true)]);
  assert.equal(twoOfThree.meets_criterion, twoOfThree.cycles_complete >= twoOfThree.cycles_needed);
});

test('an unexplained material variance fails the criterion even with three cycles', () => {
  const cycle = (explained) => ({
    complete: true,
    variances: [{
      materiality: 'SEVERE', period_end: '2026-01-31',
      explanation: explained ? 'Reason given' : null,
      explained_at: explained ? '2026-02-05' : null,
    }],
  });

  const result = credibility([cycle(true), cycle(true), cycle(false)]);
  assert.equal(result.meets_criterion, false);
  assert.equal(result.unexplained.length, 1);
  assert.match(result.statement, /reads worse than the variance itself/);
});

test('missing and explaining beats hitting and saying nothing', () => {
  // The criterion tests whether a business understands itself, not whether it
  // is lucky. A company that missed and explained has demonstrated the thing.
  const missed = credibility([1, 2, 3].map(() => ({
    complete: true,
    variances: [{
      materiality: 'SEVERE', period_end: '2026-01-31',
      explanation: 'Procurement freeze at two accounts', explained_at: '2026-02-05',
    }],
  })));

  assert.equal(missed.meets_criterion, true);
  assert.equal(missed.explanation_rate, 100);
  assert.equal(missed.accuracy_rate, 0, 'accuracy was nil, and the criterion is still satisfied');
});

test('a locked forecast nobody measured is not a cycle', () => {
  const result = credibility([{ complete: false, variances: [] }]);
  assert.equal(result.cycles_complete, 0, 'a forecast never compared to anything proves nothing');
});

test('a forecast locked but never measured does not count as a cycle', () => {
  // Locking a forecast and never closing a period against it would otherwise
  // let a company accumulate "cycles" without ever being measured — three
  // locked forecasts and no actuals is not a track record.
  const { ctx, org } = world();
  lockedForecast(ctx, org.id);

  const body = api.credibilityReport(ctx, org.id).body;
  assert.equal(body.cycles.length, 1, 'the forecast is on the record');
  assert.equal(body.cycles[0].complete, false, 'but it has not been measured against anything');
  assert.equal(body.credibility.cycles_complete, 0);
  assert.equal(body.credibility.meets_criterion, false);
});

test('the credibility report says why the record cannot be backfilled', () => {
  const { ctx, org } = world();
  lockedForecast(ctx, org.id, { value: 1_000_000 });
  actual(ctx, org.id, 980_000);
  api.closePeriod(ctx, org.id, { period_start: '2026-01-01', period_end: '2026-01-31' });

  const body = api.credibilityReport(ctx, org.id).body;
  assert.equal(body.criterion, '2.4');
  assert.equal(body.cycles.length, 1);
  assert.equal(body.cycles[0].complete, true);
  assert.match(body.why_it_matters, /cannot be produced retrospectively/);
});

// ───────────────────────────────────────────────────── trajectory ──

test('derived figures carry their formula and their inputs', () => {
  const { ctx, org } = world();
  actual(ctx, org.id, 300_000, { start: '2025-12-01', end: '2025-12-31' });
  actual(ctx, org.id, 330_000, { start: '2026-01-01', end: '2026-01-31' });

  const created = api.recomputeTrajectory(ctx, org.id, 'financials.revenue.mrr').body.created;
  assert.ok(created.length >= 2);

  for (const fact of created) {
    assert.equal(fact.source, 'CALCULATED');
    assert.ok(fact.formula, 'a derived figure with no formula is an assertion');
    assert.ok(JSON.parse(fact.input_fact_ids).length);
  }

  const runRate = created.find((f) => f.fact_key.endsWith('.run_rate'));
  assert.equal(runRate.value_numeric, 3_960_000, '330,000 over one month, annualised');

  const growth = created.find((f) => f.fact_key.endsWith('.growth'));
  assert.equal(growth.value_numeric, 10);
  assert.equal(growth.unit, 'percent');
});

test('a trajectory needs two periods before it means anything', () => {
  const { ctx, org } = world();
  actual(ctx, org.id, 300_000);
  const res = api.recomputeTrajectory(ctx, org.id, 'financials.revenue.mrr');
  assert.deepEqual(res.body.created, []);
  assert.match(res.body.note, /At least two periods/);
});

test('recomputing supersedes the old figure rather than leaving two', () => {
  const { db, ctx, org } = world();
  actual(ctx, org.id, 300_000, { start: '2025-12-01', end: '2025-12-31' });
  actual(ctx, org.id, 330_000, { start: '2026-01-01', end: '2026-01-31' });
  api.recomputeTrajectory(ctx, org.id, 'financials.revenue.mrr');
  api.recomputeTrajectory(ctx, org.id, 'financials.revenue.mrr');

  const current = db.find('fact', { org_id: org.id })
    .filter((f) => f.fact_key === 'financials.revenue.mrr.run_rate' && !f.superseded_by);
  assert.equal(current.length, 1, 'a run rate from last month is an old opinion, not a second one');
});

test('runway is never extrapolated — it needs both figures confirmed', () => {
  const { ctx, org } = world();
  const res = api.recomputeRunway(ctx, org.id);
  assert.equal(res.body.created, null);
  assert.match(res.body.note, /originating a number about your business/);

  assert.equal(runwayInput({ cashFact: { id: 'a', value_numeric: 1_200_000 }, burnFact: null }), null);
  assert.equal(runwayInput({
    cashFact: { id: 'a', value_numeric: 1_200_000 },
    burnFact: { id: 'b', value_numeric: 0 },
  }), null, 'a zero burn would divide to infinity and print a runway of forever');

  const good = runwayInput({
    cashFact: { id: 'a', value_numeric: 1_200_000 },
    burnFact: { id: 'b', value_numeric: 100_000 },
  });
  assert.equal(good.value_numeric, 12);
  assert.equal(good.source, 'CALCULATED');
  assert.deepEqual(good.input_fact_ids, ['a', 'b']);
});

// ──────────────────────────────────────────────────────── access ──

test('a viewer cannot lock a forecast, and another organisation gets 404', () => {
  const { db, ctx, org } = world();
  const f = lockedForecast(ctx, org.id);

  db.insert('membership', {
    org_id: org.id, user_id: 'u-viewer', email: 'v@example.com', role: 'VIEWER', created_at: '2026-01-01',
  });
  expectRefusal(() => api.createForecast(ctxFor(db, 'u-viewer'), org.id, { label: 'x' }), 'forbidden', 403);

  const other = ctxFor(db, 'u-other');
  const otherOrg = svc.createOrganisation(other, { name: 'Other Co' }).body.organisation;
  db.update('membership', db.findOne('membership', { org_id: otherOrg.id, user_id: 'u-other' }).id,
    { role: 'EDITOR' });
  expectRefusal(() => api.reviseForecast(other, otherOrg.id, f.id, { reason: 'x'.repeat(20) }),
    'not_found', 404);
});

test('every step of the cadence is audited', () => {
  const { db, ctx, org } = world();
  lockedForecast(ctx, org.id);
  actual(ctx, org.id, 900_000);
  api.closePeriod(ctx, org.id, { period_start: '2026-01-01', period_end: '2026-01-31' });
  const v = db.find('variance', { org_id: org.id })[0];
  api.explainVariance(ctx, org.id, v.id, { explanation: 'Two deals slipped into the next quarter.' });

  const actions = db.find('audit_log', { org_id: org.id }).map((a) => a.action);
  for (const expected of ['forecast.created', 'forecast.locked', 'period.closed', 'variance.explained']) {
    assert.ok(actions.includes(expected), `${expected} must be audited`);
  }
});
