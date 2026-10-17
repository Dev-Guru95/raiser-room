/**
 * The operating cadence — forecasts, actuals, variance.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS THE MOST VALUABLE THING IN THE PRODUCT
 *
 * Criterion 2.4 asks whether forecast credibility is demonstrable: the last
 * three forecasts set against actuals, with the variances explained. The
 * knowledge corpus says the uncomfortable part out loud — this is impossible to
 * produce retrospectively. A company that did not keep its forecasts cannot
 * manufacture that history when a process starts. No adviser can supply it and
 * no amount of preparation in the final eight weeks recovers it.
 *
 * A company that has run this cadence for eighteen months arrives holding it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE RULE THE WHOLE PHASE RESTS ON
 *
 * **A locked forecast is immutable, and actuals never re-baseline it.**
 *
 * The tempting behaviour — quietly sliding the forecast to match the outcome,
 * or letting a founder "tidy up" last quarter's numbers — destroys the only
 * asset being accumulated. There would be no fixed forecast left to compare
 * against, and the variance history would show a company that always hits plan,
 * which is both false and immediately recognisable as false.
 *
 * So a revision is a new version, the old version stays visible, and the reason
 * for revising is recorded. Missing a forecast and explaining why is worth more
 * than appearing to hit every one.
 */

export class CadenceError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

export const FORECAST_STATES = Object.freeze(['DRAFT', 'LOCKED', 'SUPERSEDED']);
export const CLOSE_STATES = Object.freeze(['OPEN', 'CLOSED']);

/**
 * How far off is far enough to need explaining.
 *
 * Bands rather than a single threshold, because the question a reader asks
 * changes with the size of the miss. Five per cent is noise and explaining it
 * wastes everyone's attention; forty per cent is a different business from the
 * one that was forecast, and an unexplained forty is worse than a missed forty.
 *
 * Expressed as data so the bands can be argued with rather than reverse
 * engineered from a conditional.
 */
export const MATERIALITY_BANDS = Object.freeze([
  { id: 'ON_PLAN', upTo: 0.05, label: 'On plan', explain: false,
    means: 'Within five per cent. Noise, and not worth the reader’s attention.' },
  { id: 'MINOR', upTo: 0.15, label: 'Minor variance', explain: false,
    means: 'Worth noting in passing. An explanation is welcome but not expected.' },
  { id: 'MATERIAL', upTo: 0.30, label: 'Material variance', explain: true,
    means: 'A reader will ask about this one. Explain it while you remember why.' },
  { id: 'SEVERE', upTo: Infinity, label: 'Severe variance', explain: true,
    means: 'This is a different outcome from the one forecast. An unexplained '
         + 'severe variance reads worse than the variance itself.' },
]);

export function materialityOf(forecastValue, actualValue) {
  const f = Number(forecastValue);
  const a = Number(actualValue);
  if (!Number.isFinite(f) || !Number.isFinite(a)) return null;

  // Proportion of the FORECAST, not of the actual. The question is how wrong
  // the plan was, and dividing by the outcome changes the answer whenever the
  // outcome is the small number — a forecast of 100 against an actual of 10 is
  // a 90% miss of the plan, not a 900% one.
  const base = Math.abs(f);
  if (base === 0) return a === 0 ? 'ON_PLAN' : 'SEVERE';

  const ratio = Math.abs(a - f) / base;
  return MATERIALITY_BANDS.find((b) => ratio <= b.upTo).id;
}

export const materialityBand = (id) => MATERIALITY_BANDS.find((b) => b.id === id) ?? null;

/** Does this variance need an explanation before it is presentable? */
export const needsExplanation = (materiality) => !!materialityBand(materiality)?.explain;

// ─────────────────────────────────────────────────────────── forecasts ──

/** Validate a forecast line before it is stored. */
export function buildForecastLine(input = {}) {
  const factKey = String(input.fact_key ?? '').trim();
  const label = String(input.label ?? '').trim();
  if (!factKey) throw new CadenceError('line_missing_key', 'a forecast line needs a fact_key');
  if (!label) throw new CadenceError('line_missing_label', 'a forecast line needs a label');

  const value = Number(input.value_numeric);
  if (!Number.isFinite(value)) {
    throw new CadenceError('line_missing_value',
      `a forecast line needs a number, got ${JSON.stringify(input.value_numeric)}`);
  }

  const start = String(input.period_start ?? '');
  const end = String(input.period_end ?? '');
  if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end))) {
    throw new CadenceError('line_missing_period',
      'a forecast line must say which period it forecasts. A number with no period cannot be '
      + 'compared to anything.');
  }
  if (Date.parse(end) < Date.parse(start)) {
    throw new CadenceError('line_period_reversed', 'the period ends before it starts');
  }

  return {
    fact_key: factKey,
    label,
    period_start: start,
    period_end: end,
    value_numeric: value,
    unit: input.unit ?? null,
  };
}

/**
 * Guard every write against a locked forecast.
 *
 * The single most important function in this file. Everything that could edit a
 * forecast passes through here first.
 */
export function assertMutable(forecast) {
  if (!forecast) throw new CadenceError('forecast_not_found', 'no such forecast', 404);

  if (forecast.state === 'LOCKED' || forecast.state === 'SUPERSEDED') {
    throw new CadenceError('forecast_locked',
      'This forecast was locked on ' + (forecast.locked_at ?? 'an earlier date')
      + ' and cannot be changed. That is deliberate: a forecast you can edit after the fact is not '
      + 'evidence of anything, and the whole value of keeping it is that it says what you believed '
      + 'at the time. Create a new version instead — the reason for revising is worth recording.',
      409, { forecast_id: forecast.id, state: forecast.state });
  }
  return forecast;
}

/** A forecast must cover something before it can be locked. */
export function assertLockable(forecast, lines) {
  if (!forecast) throw new CadenceError('forecast_not_found', 'no such forecast', 404);
  if (forecast.state !== 'DRAFT') {
    throw new CadenceError('already_locked', `this forecast is already ${forecast.state.toLowerCase()}`, 409);
  }
  if (!lines.length) {
    throw new CadenceError('nothing_to_lock', 'a forecast with no lines forecasts nothing');
  }
  if (!String(forecast.basis ?? '').trim()) {
    throw new CadenceError('basis_required',
      'Say what this forecast is built on, in a sentence. In a year the number will be obvious and '
      + 'the reasoning will not, and the reasoning is what a reader is actually assessing.');
  }
  return true;
}

// ─────────────────────────────────────────────────────────── variance ──

/**
 * Compare a locked forecast's lines against the actuals recorded for the same
 * periods.
 *
 * @param {object[]} lines   forecast lines
 * @param {object[]} actuals usable facts, with periods
 * @returns {object[]} one row per line, with the actual where one exists
 */
export function computeVariances(lines = [], actuals = []) {
  const byKeyPeriod = new Map();
  for (const f of actuals) {
    if (!f.period_end) continue;
    byKeyPeriod.set(`${f.fact_key}|${f.period_end}`, f);
  }

  return lines.map((line) => {
    const actual = byKeyPeriod.get(`${line.fact_key}|${line.period_end}`) ?? null;

    // An actual that has not arrived is NOT a miss. A period still open shows as
    // awaiting, because scoring an unclosed month as a hundred per cent shortfall
    // would be both wrong and alarming.
    if (!actual || actual.value_numeric === null || actual.value_numeric === undefined) {
      return {
        forecast_line_id: line.id,
        fact_key: line.fact_key,
        label: line.label,
        period_start: line.period_start,
        period_end: line.period_end,
        forecast_value: line.value_numeric,
        actual_value: null,
        delta: null,
        delta_percent: null,
        materiality: 'AWAITING',
        unit: line.unit,
      };
    }

    const actualValue = Number(actual.value_numeric);
    const delta = actualValue - Number(line.value_numeric);
    const base = Math.abs(Number(line.value_numeric));

    return {
      forecast_line_id: line.id,
      fact_id: actual.id,
      fact_key: line.fact_key,
      label: line.label,
      period_start: line.period_start,
      period_end: line.period_end,
      forecast_value: Number(line.value_numeric),
      actual_value: actualValue,
      delta: round2(delta),
      delta_percent: base === 0 ? null : round2((delta / base) * 100),
      materiality: materialityOf(line.value_numeric, actualValue),
      unit: line.unit,
    };
  });
}

/**
 * Score forecast credibility.
 *
 * This is what criterion 2.4 is actually asking for, computed rather than
 * self-assessed. Three things count, and accuracy is deliberately not the most
 * important of them:
 *
 *   · how many complete forecast cycles exist (the criterion says three);
 *   · whether the material variances were explained;
 *   · and how promptly — an explanation written in the week is evidence that the
 *     business understands its own drivers; one written eight months later is
 *     evidence that somebody went back and filled in the boxes.
 *
 * A company that missed and explained scores better than one that hit and said
 * nothing, because the criterion tests whether the business understands itself,
 * not whether it is lucky.
 */
export const PROMPT_EXPLANATION_DAYS = 45;

/**
 * How many complete cycles the criterion asks for.
 *
 * Declared once. It used to appear both as reported data and as a literal in
 * the comparison, so changing the stated requirement left the actual rule
 * untouched — the kind of divergence nobody notices until the number on screen
 * and the number being enforced disagree. Mutation testing found it.
 */
export const CYCLES_NEEDED = 3;

export function credibility(cycles = [], { asOf = null } = {}) {
  const complete = cycles.filter((c) => c.complete);
  const allVariances = complete.flatMap((c) => c.variances);
  const scored = allVariances.filter((v) => v.materiality && v.materiality !== 'AWAITING');
  const needing = scored.filter((v) => needsExplanation(v.materiality));
  const explained = needing.filter((v) => v.explanation);

  const prompt = explained.filter((v) => {
    if (!v.explained_at || !v.period_end) return false;
    const days = (Date.parse(v.explained_at) - Date.parse(v.period_end)) / 86_400_000;
    return days <= PROMPT_EXPLANATION_DAYS;
  });

  const onPlan = scored.filter((v) => v.materiality === 'ON_PLAN' || v.materiality === 'MINOR');

  return {
    cycles_complete: complete.length,
    cycles_needed: CYCLES_NEEDED,
    meets_criterion: complete.length >= CYCLES_NEEDED && needing.length === explained.length,
    variances_scored: scored.length,
    variances_needing_explanation: needing.length,
    variances_explained: explained.length,
    explained_promptly: prompt.length,
    within_plan: onPlan.length,
    accuracy_rate: scored.length ? round2((onPlan.length / scored.length) * 100) : null,
    explanation_rate: needing.length ? round2((explained.length / needing.length) * 100) : 100,
    unexplained: needing.filter((v) => !v.explanation).map((v) => ({
      fact_key: v.fact_key, period_end: v.period_end, materiality: v.materiality,
    })),
    // The sentence that goes in front of a reader. It states what is there,
    // never that the company is good at forecasting.
    statement: statementFor(complete.length, needing.length, explained.length),
    asOf,
  };
}

function statementFor(cycles, needing, explained) {
  if (cycles === 0) {
    return 'No forecast has yet been set against actuals. This is the record that cannot be produced '
         + 'retrospectively, so the useful time to start keeping it is now.';
  }
  if (cycles < CYCLES_NEEDED) {
    const left = CYCLES_NEEDED - cycles;
    return `${cycles} forecast ${cycles === 1 ? 'cycle has' : 'cycles have'} been set against actuals. `
         + `${left} more and this criterion is satisfied by record rather than by assertion.`;
  }
  if (needing > explained) {
    return `${cycles} forecast cycles are on record, but ${needing - explained} material `
         + `${needing - explained === 1 ? 'variance has' : 'variances have'} no explanation. `
         + 'An unexplained material variance reads worse than the variance itself.';
  }
  return `${cycles} forecast cycles are on record, each set against actuals, with every material `
       + 'variance explained. This is the evidence criterion 2.4 asks for, and it cannot be assembled '
       + 'after the fact.';
}

/**
 * Whether an explanation is being written now or reconstructed later.
 *
 * Both are recorded; only one is evidence of anything. The gap is reported
 * rather than hidden, because a reader comparing an explanation date to a
 * period end will draw their own conclusion and should be able to.
 */
export function explanationTimeliness(periodEnd, explainedAt) {
  if (!periodEnd || !explainedAt) return { days: null, state: 'UNEXPLAINED' };
  const days = Math.round((Date.parse(explainedAt) - Date.parse(periodEnd)) / 86_400_000);
  if (!Number.isFinite(days)) return { days: null, state: 'UNKNOWN' };
  if (days <= PROMPT_EXPLANATION_DAYS) return { days, state: 'PROMPT' };
  if (days <= 180) return { days, state: 'LATE' };
  return {
    days,
    state: 'RECONSTRUCTED',
    note: 'Written more than six months after the period closed. Recorded, but a reader will see the '
        + 'date and weigh it accordingly.',
  };
}

// ───────────────────────────────────────────────────────── trajectory ──

/**
 * Derived figures, each with the formula that produced it and the facts it came
 * from.
 *
 * Returned as CALCULATED fact inputs rather than as loose numbers, so a run rate
 * on a slide is as traceable as a figure read off an invoice. The fact store
 * refuses a CALCULATED fact without a formula and input ids, which is what stops
 * these quietly becoming assertions.
 */
export function trajectoryInputs(series = [], { unit = 'USD', runwayMonths = null } = {}) {
  const points = series
    .filter((p) => Number.isFinite(Number(p.value_numeric)) && p.period_end)
    .sort((a, b) => String(a.period_end).localeCompare(String(b.period_end)));

  if (points.length < 2) return [];

  const latest = points.at(-1);
  const previous = points.at(-2);
  const out = [];

  const monthsCovered = monthsBetween(latest.period_start ?? latest.period_end, latest.period_end) || 1;
  out.push({
    fact_key: `${latest.fact_key}.run_rate`,
    label: `Annualised run rate — ${latest.label}`,
    value_numeric: round2((Number(latest.value_numeric) / monthsCovered) * 12),
    unit,
    source: 'CALCULATED',
    formula: `(${latest.label} ÷ ${monthsCovered} months) × 12`,
    input_fact_ids: [latest.id],
    period_start: latest.period_start,
    period_end: latest.period_end,
  });

  const base = Math.abs(Number(previous.value_numeric));
  if (base > 0) {
    out.push({
      fact_key: `${latest.fact_key}.growth`,
      label: `Period-on-period growth — ${latest.label}`,
      value_numeric: round2(((Number(latest.value_numeric) - Number(previous.value_numeric)) / base) * 100),
      unit: 'percent',
      source: 'CALCULATED',
      formula: `(latest − previous) ÷ previous × 100`,
      input_fact_ids: [latest.id, previous.id],
      period_start: previous.period_end,
      period_end: latest.period_end,
    });
  }

  return out;
}

function monthsBetween(start, end) {
  const a = new Date(start);
  const b = new Date(end);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  const months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  return Math.max(months + 1, 1);
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

/**
 * Runway, which is deliberately NOT derived from a trend.
 *
 * Projecting a burn rate forward and announcing a date is the kind of figure
 * that gets repeated in a board meeting as though it were known. It depends on
 * a cash balance and a burn the product has not been given, and extrapolating
 * either would be the software originating a number about the business.
 *
 * So runway is computed only when both are supplied as confirmed facts, and it
 * carries its inputs.
 */
export function runwayInput({ cashFact = null, burnFact = null } = {}) {
  if (!cashFact || !burnFact) return null;
  const cash = Number(cashFact.value_numeric);
  const burn = Number(burnFact.value_numeric);
  if (!Number.isFinite(cash) || !Number.isFinite(burn) || burn <= 0) return null;

  return {
    fact_key: 'financials.runway_months',
    label: 'Runway at the current net burn',
    value_numeric: round2(cash / burn),
    unit: 'months',
    source: 'CALCULATED',
    formula: 'cash ÷ monthly net burn',
    input_fact_ids: [cashFact.id, burnFact.id],
    period_end: cashFact.period_end ?? null,
  };
}
