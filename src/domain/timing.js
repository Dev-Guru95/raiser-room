/**
 * Timing instrumentation.
 *
 * WHY THIS EXISTS
 *
 * The honest answer to "how long does this take?" today is that nobody knows,
 * because nobody has measured it. The temptation is to answer anyway — "get
 * investor-ready in 7 days" — and that number would be invented. It would also
 * be the first thing a customer tests, and the first thing they catch us on.
 *
 * So instead of a claim, an instrument. Milestones are recorded as they happen,
 * and `cohortClaim()` refuses to return a figure until there is enough measured
 * data behind it. When there is, the claim comes with its sample size attached
 * and can be put in front of anybody.
 *
 * TWO CLOCKS, NEVER MIXED
 *
 * Clock A is work: scoring the audit, building the room, reviewing extractions,
 * closing the gaps that are within the company's own control. It is bounded by
 * effort and it is the honest subject of a product claim.
 *
 * Clock B is calendar time: an IP assignment chased from a contractor who left
 * two years ago, a landlord's consent, an accountant's restatement, a trade mark
 * registration. These are the LONG_LEAD gaps, and they take months because they
 * depend on third parties who do not care about anyone's timeline.
 *
 * Averaging the two produces a figure that is true of nothing and that
 * overpromises on the half the customer can control. `cohortClaim()` therefore
 * refuses a sample that mixes clocks, rather than quietly averaging it.
 */

export class TimingError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * The milestones, in the order they normally occur.
 *
 * `clock` is on every one. Adding a milestone without deciding which clock it
 * belongs to is how the two get mixed, so it is not optional.
 */
export const MILESTONES = Object.freeze([
  { key: 'ORG_CREATED', clock: 'A', means: 'The organisation was created' },
  { key: 'WORKBOOK_REDEEMED', clock: 'A', means: 'A completed workbook was carried across' },
  { key: 'FIRST_ASSESSMENT_COMPLETE', clock: 'A', means: 'All 32 criteria scored for the first time' },
  { key: 'ROOM_BUILT', clock: 'A', means: 'The data room structure was created' },
  { key: 'FIRST_DOCUMENT_CONFIRMED', clock: 'A', means: 'The first upload completed' },
  { key: 'FIRST_EXTRACTION_REVIEWED', clock: 'A', means: 'The first extraction was reviewed end to end' },
  { key: 'FIRST_CONFLICT_RESOLVED', clock: 'A', means: 'The first contradiction was settled' },
  { key: 'FIRST_FORECAST_LOCKED', clock: 'A', means: 'The first forecast was locked' },
  { key: 'FIRST_PERIOD_CLOSED', clock: 'A', means: 'The first period was closed against a forecast' },
  { key: 'THREE_CYCLES_COMPLETE', clock: 'B', means: 'Three forecast cycles set against actuals — criterion 2.4 by record' },
  { key: 'ROOM_REQUIRED_HALF', clock: 'A', means: 'Half the required items are satisfied' },
  { key: 'ROOM_REQUIRED_COMPLETE', clock: 'B', means: 'Every required item is satisfied or reasoned away' },
  { key: 'FIRST_GAP_CLOSED', clock: 'A', means: 'The first gap was closed' },
  { key: 'ALL_CHEAP_GAPS_CLOSED', clock: 'A', means: 'Every quick-win gap is closed' },
  { key: 'ALL_BLOCKERS_CLOSED', clock: 'B', means: 'Every blocking gap is closed' },
  { key: 'BAND_NOT_YET', clock: 'B', means: 'Reached the NOT_YET band' },
  { key: 'BAND_NEARLY', clock: 'B', means: 'Reached the NEARLY band' },
  { key: 'BAND_READY', clock: 'B', means: 'Reached the READY band' },
]);

const byKey = new Map(MILESTONES.map((m) => [m.key, m]));
export const MILESTONE_KEYS = Object.freeze(MILESTONES.map((m) => m.key));
export const milestone = (key) => byKey.get(key) ?? null;

/** Where an interval starts and ends, and which clock it is measured on. */
export const INTERVALS = Object.freeze([
  {
    ref: 'T1', from: 'ORG_CREATED', to: 'FIRST_ASSESSMENT_COMPLETE', clock: 'A',
    means: 'Time to a complete first self-assessment',
  },
  {
    ref: 'T2', from: 'ORG_CREATED', to: 'ROOM_REQUIRED_HALF', clock: 'A',
    means: 'Time to half the required room',
  },
  {
    ref: 'T3', from: 'FIRST_ASSESSMENT_COMPLETE', to: 'ALL_CHEAP_GAPS_CLOSED', clock: 'A',
    means: 'Time to clear the gaps that are purely within your own control',
  },
  {
    ref: 'T4', from: 'ORG_CREATED', to: 'ROOM_REQUIRED_COMPLETE', clock: 'B',
    means: 'Time to a complete required room — depends on third parties',
  },
  {
    ref: 'T5', from: 'FIRST_ASSESSMENT_COMPLETE', to: 'ALL_BLOCKERS_CLOSED', clock: 'B',
    means: 'Time to clear every blocking gap — depends on third parties',
  },
  {
    ref: 'T6', from: 'ORG_CREATED', to: 'BAND_READY', clock: 'B',
    means: 'Time from starting to reaching READY',
  },
  {
    // The interval the whole subscription argument rests on. It cannot be
    // compressed by effort — three cycles take three periods — which is
    // precisely why the record is worth something.
    ref: 'T7', from: 'FIRST_FORECAST_LOCKED', to: 'THREE_CYCLES_COMPLETE', clock: 'B',
    means: 'Time to a forecast credibility record that cannot be produced retrospectively',
  },
]);

const intervalByRef = new Map(INTERVALS.map((i) => [i.ref, i]));
export const interval = (ref) => intervalByRef.get(ref) ?? null;

/**
 * Minimum sample before any figure is reported.
 *
 * Twenty is not a statistical ceremony; it is the point below which one unusual
 * customer moves the median enough to make the number misleading. Below it,
 * `cohortClaim` returns no figure at all rather than a figure with a caveat —
 * a caveat gets dropped the moment the number reaches a marketing page.
 */
export const MIN_SAMPLE = 20;

/** Validate a milestone before it is recorded. */
export function assertMilestone(key) {
  const m = byKey.get(key);
  if (!m) throw new TimingError('unknown_milestone', `not a milestone: ${key}`);
  return m;
}

/**
 * Elapsed days, as a real number.
 * Exported so the arithmetic is tested directly rather than through a cohort.
 */
export function daysBetween(fromIso, toIso) {
  const a = Date.parse(fromIso); const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / 86_400_000;
}

/**
 * The intervals one organisation has actually completed.
 *
 * An interval with a missing endpoint is reported as `in_progress`, never as
 * zero and never dropped silently — "not finished yet" and "finished instantly"
 * are opposite facts and a chart that conflates them is worse than no chart.
 */
export function intervalsFor(events = []) {
  const at = new Map(events.map((e) => [e.milestone, e.occurred_at]));
  return INTERVALS.map((i) => {
    const from = at.get(i.from); const to = at.get(i.to);
    if (!from) return { ...i, state: 'NOT_STARTED', days: null };
    if (!to) return { ...i, state: 'IN_PROGRESS', days: null, started_at: from };
    return { ...i, state: 'COMPLETE', days: round1(daysBetween(from, to)), started_at: from, ended_at: to };
  });
}

/**
 * A measured claim about one interval, across many organisations — or nothing.
 *
 * @param {string} intervalRef   which interval, e.g. 'T1'
 * @param {number[]} daySamples  completed durations in days, one per organisation
 * @param {object} [opts]        { minSample }
 * @returns {object} either { claim: null, why, n, needed } or a measured claim
 *
 * The shape is the same either way, so a caller cannot accidentally read a
 * figure that is not there: `claim` is null, or it is a measurement.
 */
export function cohortClaim(intervalRef, daySamples = [], { minSample = MIN_SAMPLE } = {}) {
  const spec = intervalByRef.get(intervalRef);
  if (!spec) throw new TimingError('unknown_interval', `not an interval: ${intervalRef}`);

  // Number(null) is 0 and Number('') is 0, and a zero-day duration is the most
  // flattering possible lie: it would drag the median down and let the product
  // claim some companies finished the moment they started. A missing sample is
  // missing, not instant.
  const clean = daySamples
    .filter((v) => v !== null && v !== undefined && v !== '')
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0);

  if (clean.length < minSample) {
    return {
      interval: spec,
      claim: null,
      n: clean.length,
      needed: minSample,
      why: `Not enough measured data to state a figure. ${clean.length} of ${minSample} organisations `
         + 'have completed this interval. No number is reported until they have.',
    };
  }

  const sorted = [...clean].sort((a, b) => a - b);
  return {
    interval: spec,
    claim: {
      median_days: round1(quantile(sorted, 0.5)),
      p25_days: round1(quantile(sorted, 0.25)),
      p75_days: round1(quantile(sorted, 0.75)),
      clock: spec.clock,
      // Wording a claim may be published in. It states the measurement and
      // never generalises past it.
      wording: `Measured across ${clean.length} organisations: a median of `
             + `${round1(quantile(sorted, 0.5))} days, with half falling between `
             + `${round1(quantile(sorted, 0.25))} and ${round1(quantile(sorted, 0.75))} days.`
             + (spec.clock === 'B'
               ? ' This interval depends on third parties, so it is calendar time rather than working time.'
               : ''),
    },
    n: clean.length,
    needed: minSample,
    why: null,
  };
}

/**
 * Refuse a sample that spans both clocks.
 *
 * Called before any aggregate is built from more than one interval. Mixing
 * four days of scoring with four months of waiting for a landlord produces an
 * average that describes neither, and it is the overpromise half that a
 * customer remembers.
 */
export function assertSingleClock(intervalRefs = []) {
  const clocks = new Set(intervalRefs.map((r) => {
    const spec = intervalByRef.get(r);
    if (!spec) throw new TimingError('unknown_interval', `not an interval: ${r}`);
    return spec.clock;
  }));
  if (clocks.size > 1) {
    throw new TimingError('mixed_clocks',
      'These intervals are measured on different clocks. Clock A is work inside the product; '
      + 'clock B includes waiting on third parties. An average across both describes neither.');
  }
  return [...clocks][0] ?? null;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos); const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const round1 = (n) => (n === null ? null : Math.round(n * 10) / 10);
