/**
 * Conflict detection — the feature the subscription is actually for.
 *
 * A company preparing to raise or sell usually has the same number written down
 * in four places: the deck, the model, the management accounts, and whatever was
 * said in the last meeting. The numbers diverge quietly, and the divergence is
 * found by a counterparty rather than by the company. That is the moment a
 * process stops being about the business and starts being about whether the
 * figures can be trusted.
 *
 * This module finds the divergence first. It never resolves one. Picking a
 * winner would mean the software asserting which of the company's own records is
 * correct, which it has no basis to do — so both sides are shown, with where
 * each came from, and the resolution is a human act that is recorded.
 *
 * Every rule here is DATA with a reference and a basis, for the same reason the
 * readiness criteria are: a rule buried in a conditional cannot be cited, dated
 * or argued with.
 */

export class ConflictError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const CONFLICT_SOURCE = Object.freeze({
  id: 'conflict-rules-v1',
  title: 'RaiseRoom conflict detection rules',
  publisher: 'TekAIDA Consulting LLC',
  version: '1.0',
  reviewed: '2026-10-12',
  reviewIntervalMonths: 6,
  note: 'Detection rules only. A detected conflict is a prompt to check your own records, '
      + 'not a finding about which record is right.',
});

export const CONFLICT_KINDS = Object.freeze(['VALUE_MISMATCH', 'UNIT_MISMATCH', 'CROSS_KEY', 'PERIOD_CLASH']);
export const SEVERITIES = Object.freeze(['HIGH', 'MEDIUM', 'LOW']);
export const RESOLUTIONS = Object.freeze(['LEFT', 'RIGHT', 'NEITHER']);

/**
 * Tolerance, by unit. Every bound present must hold for two figures to count as
 * the same figure.
 *
 * Rounding in a deck is not a contradiction: $4,200,000 against $4,199,614 is
 * one number presented two ways, and flagging it would train people to dismiss
 * the conflict list — which is how a real contradiction gets missed.
 *
 * Percentages carry BOTH bounds, because neither works alone:
 *
 *   · Absolute alone is too loose at the bottom of the scale. Churn of 1.0%
 *     against 1.4% is 0.4 of a percentage point and would pass a half-point
 *     test — but it is a 40% difference in the thing being measured, and on a
 *     cohort model it is the difference between a good business and a bad one.
 *
 *   · Relative alone is too tight at the top. Retention of 118% against 118.4%
 *     is 0.34% apart relatively, which passes, but gross margin of 78% against
 *     78.3% would sit right on the boundary and flap.
 *
 * Requiring both means 118 vs 118.4 is quiet and 1.0 vs 1.4 is loud, which is
 * the behaviour a user would expect if asked.
 */
export const TOLERANCE = Object.freeze({
  currency: { relative: 0.005 },                    // 0.5%
  percent: { relative: 0.005, absolute: 0.5 },      // both must hold
  ratio: { relative: 0.005 },
  months: { absolute: 0 },
  count: { absolute: 0 },                           // headcount is not approximately 14
  default: { relative: 0.005 },
});

const CURRENCY_UNITS = new Set(['USD', 'EUR', 'GBP']);

/**
 * How much it matters, by what the figure is.
 *
 * Derived from the key rather than decided per conflict, so the same
 * disagreement always carries the same weight and nothing is being judged
 * case by case.
 */
const SEVERITY_BY_PREFIX = Object.freeze([
  ['HIGH', ['financials.', 'cap_table.', 'commercial.concentration.']],
  ['MEDIUM', ['commercial.', 'people.', 'plan.', 'metrics.']],
]);

export function severityFor(factKey) {
  const key = String(factKey ?? '');
  for (const [severity, prefixes] of SEVERITY_BY_PREFIX) {
    if (prefixes.some((p) => key.startsWith(p))) return severity;
  }
  return 'LOW';
}

/**
 * Cross-key rules: two DIFFERENT keys that must stand in a stated relation.
 *
 * Deliberately confined to relations that are arithmetically or definitionally
 * necessary. The product does not encode opinions about what a good business
 * looks like — a rule saying "churn above x is a problem" would be a judgement
 * dressed as a check, and it would be wrong for somebody.
 *
 * `basis` is on every rule because a user is entitled to ask why the software
 * says two of their numbers cannot both be true.
 */
export const CROSS_KEY_RULES = Object.freeze([
  {
    ref: 'XK-1', relation: 'MONOTONIC',
    keys: ['commercial.concentration.top1', 'commercial.concentration.top3', 'commercial.concentration.top5'],
    detail: 'The top 1 customer cannot be a larger share of revenue than the top 3, and the top 3 cannot '
          + 'be larger than the top 5.',
    basis: 'Set containment. The top 3 includes the top 1, so its share is greater than or equal by '
         + 'arithmetic, whatever the underlying data says.',
  },
  {
    ref: 'XK-2', relation: 'MUST_AGREE',
    keys: ['plan.nrr_claimed', 'model.nrr_assumed'],
    tolerance: { absolute: 2 },
    detail: 'The net revenue retention stated in the narrative and the figure the model is built on are '
          + 'different numbers.',
    basis: 'These are two statements of the same quantity. A counterparty who recalculates the model will '
         + 'see both, and the gap is the first question asked.',
  },
  {
    ref: 'XK-3', relation: 'MUST_AGREE',
    keys: ['plan.growth_rate_claimed', 'model.growth_rate_assumed'],
    tolerance: { absolute: 1 },
    detail: 'The growth rate in the narrative and the growth rate the model assumes do not match.',
    basis: 'Two statements of the same quantity.',
  },
  {
    ref: 'XK-4', relation: 'IDENTITY',
    keys: ['financials.revenue.ttm', 'financials.cogs.ttm', 'financials.gross_margin'],
    formula: 'gross_margin = (revenue − cogs) ÷ revenue × 100',
    tolerance: { absolute: 1 },
    detail: 'The gross margin stated does not follow from the revenue and cost of sales stated.',
    basis: 'Definition of gross margin. If all three figures are correct, the identity holds.',
  },
]);

const ruleByRef = new Map(CROSS_KEY_RULES.map((r) => [r.ref, r]));
export const crossKeyRule = (ref) => ruleByRef.get(ref) ?? null;

// ───────────────────────────────────────────────────────────── comparison ──

/** Tolerance for a pair of values, by their shared unit. */
export function toleranceFor(unit) {
  if (CURRENCY_UNITS.has(unit)) return TOLERANCE.currency;
  return TOLERANCE[unit] ?? TOLERANCE.default;
}

/**
 * Are two numbers the same figure, allowing for rounding?
 * Exported because the test suite checks the boundary directly.
 */
export function withinTolerance(a, b, unit) {
  const x = Number(a); const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (x === y) return true;

  const t = toleranceFor(unit);
  const diff = Math.abs(x - y);

  // Every bound present must hold. An earlier version returned on the absolute
  // bound alone, which meant percentages were only ever tested absolutely —
  // and 1.0% against 1.4% churn passed silently.
  if (t.absolute !== undefined && diff > t.absolute) return false;

  if (t.relative !== undefined) {
    const scale = Math.max(Math.abs(x), Math.abs(y));
    if (scale === 0) return diff === 0;
    if (diff / scale > t.relative) return false;
  }

  return true;
}

/** Do two periods overlap? Null periods are treated as "unspecified", not as matching. */
function periodsOverlap(a, b) {
  if (!a.period_start && !a.period_end) return false;
  if (!b.period_start && !b.period_end) return false;
  const aS = a.period_start ?? '0000'; const aE = a.period_end ?? '9999';
  const bS = b.period_start ?? '0000'; const bE = b.period_end ?? '9999';
  return aS <= bE && bS <= aE;
}

const samePeriod = (a, b) =>
  (a.period_start ?? null) === (b.period_start ?? null) && (a.period_end ?? null) === (b.period_end ?? null);

const money = (v, unit) => {
  if (v === null || v === undefined) return '—';
  if (CURRENCY_UNITS.has(unit)) return `${unit} ${Number(v).toLocaleString('en-US')}`;
  if (unit === 'percent') return `${v}%`;
  return unit ? `${v} ${unit}` : String(v);
};

/**
 * One side of a conflict, rendered for a human.
 *
 * The locator is included, because it is the whole point: a user settling a
 * contradiction between two of their own records needs to know it is cell D14
 * of the summary sheet, not merely "page 3". Without it they have to go and
 * find both figures again before they can think about either.
 */
export function describeSide(side) {
  const value = side.value_numeric !== null && side.value_numeric !== undefined
    ? money(side.value_numeric, side.unit)
    : (side.value_text ?? side.value_date ?? '—');
  const period = side.period_start || side.period_end
    ? ` (${side.period_start ?? '…'} to ${side.period_end ?? '…'})`
    : '';
  const where = side.ref.startsWith('candidate:')
    ? `read from ${side.document_label ?? 'an upload'}${side.source_page ? `, page ${side.source_page}` : ''}`
    : sourceWording(side);
  const locator = side.locator ? ` — ${side.locator}` : '';
  return `${side.label}: ${value}${period} — ${where}${locator}`;
}

function sourceWording(side) {
  switch (side.source) {
    case 'USER_CONFIRMED':
      return `confirmed from ${side.document_label ?? 'a document'}${side.source_page ? `, page ${side.source_page}` : ''}`;
    case 'USER_ENTERED': return 'entered by hand';
    case 'CALCULATED': return `calculated (${side.formula ?? 'stored formula'})`;
    default: return 'in the fact store';
  }
}

// ──────────────────────────────────────────────────────────── detection ──

/**
 * Compare incoming candidates against the facts already held, and against each
 * other.
 *
 * @param {object[]} facts       usable facts only — pass them through
 *                               `usableFacts()` first. Comparing against an
 *                               unconfirmed extraction would manufacture
 *                               conflicts out of two unverified guesses.
 * @param {object[]} candidates  candidates from this run, still awaiting review
 * @param {object}   [labels]    documentId -> human label, for the wording
 * @returns {object[]} conflict rows, ready to store
 */
export function detectConflicts(facts = [], candidates = [], labels = {}) {
  const sides = [
    ...facts.map((f) => ({ ...f, ref: `fact:${f.id}`, document_label: labels[f.source_doc_id] ?? null })),
    ...candidates.map((c) => ({ ...c, ref: `candidate:${c.id}`, document_label: labels[c.document_id] ?? null })),
  ];

  const out = [];
  const seen = new Set();

  // ── same key, two sources ───────────────────────────────────────────────
  const byKey = new Map();
  for (const s of sides) {
    if (!byKey.has(s.fact_key)) byKey.set(s.fact_key, []);
    byKey.get(s.fact_key).push(s);
  }

  for (const [factKey, group] of byKey) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]; const b = group[j];

        // Two facts already in the store are not news: they were each confirmed
        // by a human, and any conflict between them was raised when the second
        // one arrived. Re-raising it on every run would produce a list nobody
        // reads.
        if (a.ref.startsWith('fact:') && b.ref.startsWith('fact:')) continue;

        const pairKey = [a.ref, b.ref].sort().join('|');
        if (seen.has(pairKey)) continue;

        const c = compareSameKey(factKey, a, b);
        if (c) { out.push(c); seen.add(pairKey); }
      }
    }
  }

  // ── cross-key rules ─────────────────────────────────────────────────────
  const latestByKey = new Map();
  for (const s of sides) {
    // A candidate is the newer statement of a figure, so it is the one a
    // cross-key rule should test — that is the point of checking on import.
    const existing = latestByKey.get(s.fact_key);
    if (!existing || (existing.ref.startsWith('fact:') && s.ref.startsWith('candidate:'))) {
      latestByKey.set(s.fact_key, s);
    }
  }

  for (const rule of CROSS_KEY_RULES) {
    const found = rule.keys.map((k) => latestByKey.get(k));
    if (found.some((f) => !f)) continue;                   // rule does not apply yet
    if (found.every((f) => f.ref.startsWith('fact:'))) continue;
    const c = applyCrossKeyRule(rule, found);
    if (c) out.push(c);
  }

  return out;
}

function compareSameKey(factKey, a, b) {
  const base = {
    rule_ref: 'SK-1',
    left_ref: a.ref,
    left_summary: describeSide(a),
    right_ref: b.ref,
    right_summary: describeSide(b),
  };

  // A unit disagreement is never a rounding question. GBP 3,800,000 against
  // USD 3,800,000 are different amounts of money that look identical in a table.
  if (a.unit && b.unit && a.unit !== b.unit) {
    return {
      ...base, rule_ref: 'SK-2', kind: 'UNIT_MISMATCH', severity: 'HIGH',
      detail: `${a.label} is recorded in ${a.unit} in one place and ${b.unit} in another. `
            + 'Until that is settled the two figures cannot be compared at all.',
    };
  }

  const bothNumeric = a.value_numeric !== null && a.value_numeric !== undefined
    && b.value_numeric !== null && b.value_numeric !== undefined;

  if (bothNumeric) {
    const unit = a.unit ?? b.unit;
    if (withinTolerance(a.value_numeric, b.value_numeric, unit)) return null;

    // Different values over overlapping-but-not-identical periods: this may be
    // a contradiction or it may be two different windows reported alike. Say
    // which it is rather than asserting the stronger claim.
    if (periodsOverlap(a, b) && !samePeriod(a, b)) {
      return {
        ...base, rule_ref: 'SK-3', kind: 'PERIOD_CLASH', severity: severityFor(factKey),
        detail: `${a.label} is given as two different figures over periods that overlap. These may be two `
              + 'different windows rather than a disagreement — label the periods and the question answers itself.',
      };
    }

    const delta = Math.abs(Number(a.value_numeric) - Number(b.value_numeric));
    return {
      ...base, kind: 'VALUE_MISMATCH', severity: severityFor(factKey),
      detail: `${a.label} does not agree across sources — a difference of ${money(round2(delta), unit)}. `
            + 'Both are shown; neither has been changed.',
    };
  }

  const aText = a.value_text ?? a.value_date ?? null;
  const bText = b.value_text ?? b.value_date ?? null;
  if (aText !== null && bText !== null && normaliseText(aText) !== normaliseText(bText)) {
    return {
      ...base, kind: 'VALUE_MISMATCH', severity: severityFor(factKey),
      detail: `${a.label} is recorded differently in two places.`,
    };
  }

  return null;
}

function applyCrossKeyRule(rule, found) {
  const base = {
    rule_ref: rule.ref,
    kind: 'CROSS_KEY',
    left_ref: found[0].ref,
    left_summary: found.map(describeSide).join(' · '),
    right_ref: found[found.length - 1].ref,
    right_summary: rule.basis,
  };
  const severity = found.map((f) => severityFor(f.fact_key))
    .reduce((worst, s) => (SEVERITIES.indexOf(s) < SEVERITIES.indexOf(worst) ? s : worst), 'LOW');

  if (rule.relation === 'MONOTONIC') {
    for (let i = 1; i < found.length; i++) {
      const prev = Number(found[i - 1].value_numeric);
      const next = Number(found[i].value_numeric);
      if (!Number.isFinite(prev) || !Number.isFinite(next)) return null;
      if (prev > next) {
        return { ...base, severity, detail: `${rule.detail} ${rule.basis}` };
      }
    }
    return null;
  }

  if (rule.relation === 'MUST_AGREE') {
    const [a, b] = found;
    const x = Number(a.value_numeric); const y = Number(b.value_numeric);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const tol = rule.tolerance?.absolute ?? 0;
    if (Math.abs(x - y) <= tol) return null;
    return { ...base, severity, detail: `${rule.detail} ${rule.basis}` };
  }

  if (rule.relation === 'IDENTITY') {
    const [rev, cogs, margin] = found.map((f) => Number(f.value_numeric));
    if (![rev, cogs, margin].every(Number.isFinite) || rev === 0) return null;
    const implied = ((rev - cogs) / rev) * 100;
    const tol = rule.tolerance?.absolute ?? 0;
    if (Math.abs(implied - margin) <= tol) return null;
    return {
      ...base, severity,
      detail: `${rule.detail} ${rule.formula} gives ${round2(implied)}%, against ${margin}% stated.`,
    };
  }

  return null;
}

const normaliseText = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
const round2 = (n) => Math.round(n * 100) / 100;

// ─────────────────────────────────────────────────────────── resolution ──

/**
 * Validate a resolution.
 *
 * A choice and a written reason, both required — the same discipline as "not
 * applicable" in the data room, and for the same reason. The resolution is what
 * a counterparty's adviser will eventually ask about, and "we picked the higher
 * one" is not an answer. NEITHER is a legitimate choice: sometimes both records
 * are wrong, and the honest outcome is to go and find out.
 */
export function validateResolution({ resolution, note } = {}) {
  if (!RESOLUTIONS.includes(resolution)) {
    throw new ConflictError('invalid_resolution', `resolution must be one of ${RESOLUTIONS.join(', ')}`);
  }
  const text = String(note ?? '').trim();
  if (text.length < 10) {
    throw new ConflictError('resolution_note_required',
      'A resolution needs a sentence saying why. In six months this is the only record of why one '
      + 'figure was preferred, and that is the question you will be asked.');
  }
  return { resolution, note: text };
}

/**
 * Conflicts that must be cleared before anything is generated from the facts.
 *
 * Phase 5 renders decks, one-pagers and models from the fact store. Rendering a
 * document from facts that are known to contradict each other would put the
 * product's name on the contradiction — which is the precise failure it exists
 * to prevent. HIGH only: a low-severity disagreement is worth showing and not
 * worth blocking on.
 */
export function unresolvedBlockers(conflicts = []) {
  return conflicts.filter((c) => !c.resolved_at && c.severity === 'HIGH');
}

/** Summary for a dashboard. */
export function conflictSummary(conflicts = []) {
  const open = conflicts.filter((c) => !c.resolved_at);
  return {
    source: CONFLICT_SOURCE,
    total: conflicts.length,
    open: open.length,
    resolved: conflicts.length - open.length,
    open_high: open.filter((c) => c.severity === 'HIGH').length,
    open_medium: open.filter((c) => c.severity === 'MEDIUM').length,
    open_low: open.filter((c) => c.severity === 'LOW').length,
    blocks_generation: unresolvedBlockers(conflicts).length > 0,
  };
}
