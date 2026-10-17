/**
 * Phase 6 — the operating cadence.
 *
 * Lock a forecast. Close a month. Explain what moved. Repeat.
 *
 * The product value is entirely in the repetition: eighteen months of this
 * produces a record of forecast credibility that cannot be assembled later, by
 * anyone, at any price. The code's job is to make the rhythm easy and to make
 * the record impossible to fake.
 */

import { authorise, assertBelongsToOrg, AccessError } from '../domain/access.js';
import { usableFacts } from '../domain/facts.js';
import {
  assertMutable, assertLockable, buildForecastLine, computeVariances,
  credibility, materialityBand, needsExplanation, explanationTimeliness,
  trajectoryInputs, runwayInput, MATERIALITY_BANDS, CadenceError,
} from '../domain/cadence.js';
import { createFact } from './service.js';
import { recordMilestone } from './timing.js';
import { requireEntitlement } from './billing.js';
import * as usage from './usage.js';

const ok = (body, status = 200) => ({ status, body });

function audit(ctx, orgId, action, targetType, targetId, metadata) {
  ctx.db.insert('audit_log', {
    org_id: orgId, actor_id: ctx.auth.userId, action,
    target_type: targetType, target_id: targetId,
    metadata: metadata ? JSON.stringify(metadata) : null, created_at: ctx.now(),
  });
}

const membershipOf = (ctx, orgId) => ctx.db.findOne('membership', { org_id: orgId, user_id: ctx.auth.userId });

// ─────────────────────────────────────────────────────────── forecasts ──

export function createForecast(ctx, orgId, input = {}) {
  authorise(membershipOf(ctx, orgId), 'write');

  const label = String(input.label ?? '').trim();
  if (!label) throw new CadenceError('label_required', 'a forecast needs a name you will recognise later');

  const existing = ctx.db.find('forecast', { org_id: orgId })
    .filter((f) => f.label === label);
  const version = existing.length ? Math.max(...existing.map((f) => f.version)) + 1 : 1;

  const row = ctx.db.insert('forecast', {
    org_id: orgId, label, version,
    basis: String(input.basis ?? '').trim(),
    horizon_from: input.horizon_from ?? null,
    horizon_to: input.horizon_to ?? null,
    state: 'DRAFT', locked_at: null, locked_by: null,
    superseded_by: null, supersede_reason: null,
    created_by: ctx.auth.userId, created_at: ctx.now(),
  });

  audit(ctx, orgId, 'forecast.created', 'forecast', row.id, { label, version });
  return ok({ forecast: present(row, []) }, 201);
}

/** Add a line. Refused once the forecast is locked. */
export function addForecastLine(ctx, orgId, forecastId, input = {}) {
  authorise(membershipOf(ctx, orgId), 'write');
  const forecast = assertMutable(assertBelongsToOrg(ctx.db.get('forecast', forecastId), orgId));

  const line = buildForecastLine(input);
  const row = ctx.db.insert('forecast_line', {
    org_id: orgId, forecast_id: forecast.id, ...line, created_at: ctx.now(),
  });
  return ok({ line: row }, 201);
}

export function removeForecastLine(ctx, orgId, lineId) {
  authorise(membershipOf(ctx, orgId), 'write');
  const line = assertBelongsToOrg(ctx.db.get('forecast_line', lineId), orgId);
  assertMutable(ctx.db.get('forecast', line.forecast_id));
  ctx.db.remove('forecast_line', lineId);
  return ok({ success: true });
}

/**
 * Lock a forecast.
 *
 * The point of no return, and deliberately so. After this the numbers are what
 * the company believed at this date, and nothing can quietly change them.
 */
export function lockForecast(ctx, orgId, forecastId) {
  return usage.around(ctx, orgId, 'FORECAST_LOCKED', () => doLockForecast(ctx, orgId, forecastId));
}

function doLockForecast(ctx, orgId, forecastId) {
  authorise(membershipOf(ctx, orgId), 'write');
  // Locking a forecast is the act that creates the record. Every forecast
  // already locked stays readable and exportable for ever.
  requireEntitlement(ctx, orgId, 'OPERATING_CADENCE');
  const forecast = assertBelongsToOrg(ctx.db.get('forecast', forecastId), orgId);
  const lines = ctx.db.find('forecast_line', { forecast_id: forecastId });

  assertLockable(forecast, lines);

  const now = ctx.now();
  const updated = ctx.db.update('forecast', forecastId, {
    state: 'LOCKED', locked_at: now, locked_by: ctx.auth.userId,
    horizon_from: forecast.horizon_from ?? lines.map((l) => l.period_start).sort()[0],
    horizon_to: forecast.horizon_to ?? lines.map((l) => l.period_end).sort().at(-1),
  });

  audit(ctx, orgId, 'forecast.locked', 'forecast', forecastId,
    { label: forecast.label, version: forecast.version, lines: lines.length });
  recordMilestone(ctx, orgId, 'FIRST_FORECAST_LOCKED', now);

  return ok({
    forecast: present(updated, lines),
    note: 'Locked. These numbers are now what you believed on this date, and they will not change. '
        + 'That is what makes them evidence later — and it is the reason a competitor cannot give a '
        + 'company this record retrospectively.',
  });
}

/**
 * Supersede a locked forecast with a new version.
 *
 * The only way to "change" a locked forecast, and it leaves both visible. The
 * reason is required: a reader comparing version 1 to version 3 will want to
 * know what happened in between, and "we revised it" answers nothing.
 */
export function reviseForecast(ctx, orgId, forecastId, { reason, basis } = {}) {
  authorise(membershipOf(ctx, orgId), 'write');
  const previous = assertBelongsToOrg(ctx.db.get('forecast', forecastId), orgId);

  if (previous.state !== 'LOCKED') {
    throw new CadenceError('not_locked', 'only a locked forecast is revised; an unlocked one is edited', 409);
  }

  const text = String(reason ?? '').trim();
  if (text.length < 10) {
    throw new CadenceError('reason_required',
      'Say why this forecast is being revised. Someone comparing version '
      + `${previous.version} with version ${previous.version + 1} will want to know what changed and `
      + 'why, and that is a better conversation to have on your own terms.');
  }

  const next = createForecast(ctx, orgId, {
    label: previous.label,
    basis: basis ?? previous.basis,
  }).body.forecast;

  // The lines are copied so the new version starts from the old rather than
  // from nothing. They are editable until it is locked.
  for (const line of ctx.db.find('forecast_line', { forecast_id: forecastId })) {
    ctx.db.insert('forecast_line', {
      org_id: orgId, forecast_id: next.id,
      fact_key: line.fact_key, label: line.label,
      period_start: line.period_start, period_end: line.period_end,
      value_numeric: line.value_numeric, unit: line.unit,
      created_at: ctx.now(),
    });
  }

  ctx.db.update('forecast', forecastId, {
    state: 'SUPERSEDED', superseded_by: next.id, supersede_reason: text,
  });
  audit(ctx, orgId, 'forecast.revised', 'forecast', next.id,
    { from: forecastId, reason: text, version: next.version });

  // Re-read: the object from createForecast was built before the lines were
  // copied across, so it would report a new version with nothing in it.
  const withLines = present(
    ctx.db.get('forecast', next.id),
    ctx.db.find('forecast_line', { forecast_id: next.id }),
  );

  return ok({
    forecast: withLines,
    superseded: forecastId,
    note: `Version ${previous.version} stays on the record, with your reason for revising it. `
        + 'Both versions will appear in the credibility report.',
  }, 201);
}

export function listForecasts(ctx, orgId) {
  authorise(membershipOf(ctx, orgId), 'read');
  const rows = ctx.db.find('forecast', { org_id: orgId })
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return ok({
    forecasts: rows.map((f) => present(f, ctx.db.find('forecast_line', { forecast_id: f.id }))),
  });
}

function present(row, lines) {
  return {
    id: row.id, label: row.label, version: row.version, basis: row.basis,
    state: row.state, locked_at: row.locked_at,
    horizon_from: row.horizon_from, horizon_to: row.horizon_to,
    superseded_by: row.superseded_by, supersede_reason: row.supersede_reason,
    lines: lines.map((l) => ({
      id: l.id, fact_key: l.fact_key, label: l.label, unit: l.unit,
      period_start: l.period_start, period_end: l.period_end, value_numeric: l.value_numeric,
    })),
    created_at: row.created_at,
  };
}

// ────────────────────────────────────────────────────── the monthly close ──

/**
 * Close a period.
 *
 * Closing is what turns entered figures into actuals a variance can be measured
 * against. It is a deliberate act with a date on it, because "these are this
 * month's numbers" and "these are this month's numbers and we stand behind
 * them" are different statements.
 *
 * Closing also computes the variances and leaves them waiting for explanation,
 * which is the moment the explanation is worth most.
 */
export function closePeriod(ctx, orgId, input = {}) {
  return usage.around(ctx, orgId, 'PERIOD_CLOSED', () => doClosePeriod(ctx, orgId, input));
}

function doClosePeriod(ctx, orgId, { period_start, period_end, note = null } = {}) {
  authorise(membershipOf(ctx, orgId), 'write');

  if (!Number.isFinite(Date.parse(period_start)) || !Number.isFinite(Date.parse(period_end))) {
    throw new CadenceError('invalid_period', 'a close needs a start and an end date');
  }
  if (ctx.db.findOne('period_close', { org_id: orgId, period_end })) {
    throw new CadenceError('already_closed', `the period ending ${period_end} is already closed`, 409);
  }

  const now = ctx.now();
  const close = ctx.db.insert('period_close', {
    org_id: orgId, period_start, period_end, state: 'CLOSED',
    closed_at: now, closed_by: ctx.auth.userId, note, created_at: now,
  });

  // Measure against every locked forecast covering this period, including
  // superseded ones — a superseded forecast was still what the company believed
  // at the time, and dropping it would let a company revise its way to a clean
  // record.
  const forecasts = ctx.db.find('forecast', { org_id: orgId })
    .filter((f) => f.state === 'LOCKED' || f.state === 'SUPERSEDED');

  const actuals = usableFacts(ctx.db.find('fact', { org_id: orgId }));
  const created = [];

  for (const forecast of forecasts) {
    const lines = ctx.db.find('forecast_line', { forecast_id: forecast.id })
      .filter((l) => l.period_end === period_end);
    if (!lines.length) continue;

    for (const v of computeVariances(lines, actuals)) {
      if (v.materiality === 'AWAITING') continue;
      if (ctx.db.findOne('variance', { forecast_line_id: v.forecast_line_id })) continue;

      created.push(ctx.db.insert('variance', {
        org_id: orgId, forecast_id: forecast.id, forecast_line_id: v.forecast_line_id,
        fact_id: v.fact_id ?? null, fact_key: v.fact_key,
        period_start: v.period_start, period_end: v.period_end,
        forecast_value: v.forecast_value, actual_value: v.actual_value,
        delta: v.delta, delta_percent: v.delta_percent, materiality: v.materiality,
        explanation: null, explained_at: null, explained_by: null, created_at: now,
      }));
    }
  }

  const needing = created.filter((v) => needsExplanation(v.materiality));

  audit(ctx, orgId, 'period.closed', 'period_close', close.id,
    { period_end, variances: created.length, needing_explanation: needing.length });
  recordMilestone(ctx, orgId, 'FIRST_PERIOD_CLOSED', now);

  return ok({
    close,
    variances: created.map(decorate),
    needing_explanation: needing.length,
    // The nudge that makes the whole thing work. An explanation written now is
    // evidence; the same words in eight months are a reconstruction.
    prompt: needing.length
      ? `${needing.length} material ${needing.length === 1 ? 'variance' : 'variances'} to explain. `
        + 'Doing it this week takes ten minutes and is worth more than doing it next year, because a '
        + 'reader can see the date you wrote it.'
      : 'Nothing material to explain this period.',
  }, 201);
}

/** Record why a variance happened. */
export function explainVariance(ctx, orgId, varianceId, input = {}) {
  return usage.around(ctx, orgId, 'VARIANCE_EXPLAINED', () => doExplainVariance(ctx, orgId, varianceId, input));
}

function doExplainVariance(ctx, orgId, varianceId, { explanation } = {}) {
  authorise(membershipOf(ctx, orgId), 'write');
  const variance = assertBelongsToOrg(ctx.db.get('variance', varianceId), orgId);

  const text = String(explanation ?? '').trim();
  if (text.length < 15) {
    throw new CadenceError('explanation_too_short',
      'An explanation a reader can use says what happened, not that something happened. '
      + '"Two enterprise deals slipped into Q3 after a procurement freeze" is useful; '
      + '"timing" is not.');
  }

  const now = ctx.now();
  const updated = ctx.db.update('variance', varianceId, {
    explanation: text, explained_at: now, explained_by: ctx.auth.userId,
  });

  audit(ctx, orgId, 'variance.explained', 'variance', varianceId,
    { fact_key: variance.fact_key, period_end: variance.period_end, materiality: variance.materiality });

  return ok({
    variance: decorate(updated),
    timeliness: explanationTimeliness(variance.period_end, now),
  });
}

function decorate(row) {
  const band = materialityBand(row.materiality);
  return {
    ...row,
    materiality_means: band?.means ?? null,
    needs_explanation: needsExplanation(row.materiality),
    timeliness: explanationTimeliness(row.period_end, row.explained_at),
  };
}

export function listVariances(ctx, orgId, { unexplainedOnly = false } = {}) {
  authorise(membershipOf(ctx, orgId), 'read');
  let rows = ctx.db.find('variance', { org_id: orgId });
  if (unexplainedOnly) rows = rows.filter((v) => !v.explanation && needsExplanation(v.materiality));
  rows.sort((a, b) => String(b.period_end).localeCompare(String(a.period_end)));
  return ok({ variances: rows.map(decorate), bands: MATERIALITY_BANDS });
}

// ────────────────────────────────────────────────────────── credibility ──

/**
 * The forecast credibility record — criterion 2.4, computed rather than
 * self-assessed.
 */
export function credibilityReport(ctx, orgId) {
  authorise(membershipOf(ctx, orgId), 'read');

  const forecasts = ctx.db.find('forecast', { org_id: orgId })
    .filter((f) => f.state === 'LOCKED' || f.state === 'SUPERSEDED')
    .sort((a, b) => String(a.locked_at).localeCompare(String(b.locked_at)));

  const allVariances = ctx.db.find('variance', { org_id: orgId });

  const cycles = forecasts.map((f) => {
    const variances = allVariances.filter((v) => v.forecast_id === f.id);
    const lines = ctx.db.count('forecast_line', { forecast_id: f.id });
    return {
      forecast: {
        id: f.id, label: f.label, version: f.version, basis: f.basis,
        locked_at: f.locked_at, state: f.state, supersede_reason: f.supersede_reason,
      },
      lines,
      variances: variances.map(decorate),
      // A cycle counts only when the forecast was locked AND measured. A locked
      // forecast nobody ever closed a period against proves nothing.
      complete: variances.length > 0,
    };
  });

  return ok({
    credibility: credibility(cycles, { asOf: ctx.now() }),
    cycles,
    criterion: '2.4',
    // Said plainly, because this is the one place the product can tell a user
    // something genuinely useful about timing.
    why_it_matters: 'This record cannot be produced retrospectively. A company that did not keep its '
      + 'forecasts cannot assemble this when a process starts, which is exactly why it is worth '
      + 'something when you have it.',
  });
}

// ────────────────────────────────────────────────────────── trajectory ──

/**
 * Derive run rate and growth as CALCULATED facts.
 *
 * Written into the fact store rather than returned as loose numbers, so a run
 * rate on a slide carries its formula and its inputs like any other figure.
 */
export function recomputeTrajectory(ctx, orgId, factKey, { unit = 'USD' } = {}) {
  authorise(membershipOf(ctx, orgId), 'write');

  const series = usableFacts(ctx.db.find('fact', { org_id: orgId }))
    .filter((f) => f.fact_key === factKey);

  const inputs = trajectoryInputs(series, { unit });
  if (!inputs.length) {
    return ok({
      created: [],
      note: 'At least two periods of confirmed figures are needed before a trajectory means anything.',
    });
  }

  const created = [];
  for (const input of inputs) {
    // Supersede rather than duplicate: a run rate from three months ago is not
    // a second opinion, it is an old one.
    const existing = ctx.db.find('fact', { org_id: orgId, fact_key: input.fact_key })
      .find((f) => !f.superseded_by);

    const fact = createFact(ctx, orgId, input).body.fact;
    if (existing) ctx.db.update('fact', existing.id, { superseded_by: fact.id });
    created.push(fact);
  }

  audit(ctx, orgId, 'trajectory.recomputed', 'organisation', orgId,
    { fact_key: factKey, created: created.length });
  return ok({ created, note: 'Each figure carries its formula and the facts it was derived from.' }, 201);
}

/** Runway, only when cash and burn have both been confirmed. */
export function recomputeRunway(ctx, orgId) {
  authorise(membershipOf(ctx, orgId), 'write');
  const facts = usableFacts(ctx.db.find('fact', { org_id: orgId }));
  const latest = (key) => facts.filter((f) => f.fact_key === key).at(-1) ?? null;

  const input = runwayInput({
    cashFact: latest('financials.cash_balance'),
    burnFact: latest('financials.net_burn_monthly'),
  });

  if (!input) {
    return ok({
      created: null,
      // Stated rather than guessed. Projecting a burn forward and announcing a
      // date produces a figure that gets repeated in a board meeting as though
      // it were known.
      note: 'Runway needs a confirmed cash balance and a confirmed monthly net burn. Neither is '
          + 'estimated from a trend — a runway date that came from a projection would be the software '
          + 'originating a number about your business.',
    });
  }

  const fact = createFact(ctx, orgId, input).body.fact;
  audit(ctx, orgId, 'runway.recomputed', 'fact', fact.id, { months: fact.value_numeric });
  return ok({ created: fact }, 201);
}

export { CadenceError };
