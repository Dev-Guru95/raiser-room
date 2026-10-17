/**
 * Readiness scoring.
 *
 * The hard rules are the point. Readiness is not an average — a single hole
 * sinks a process however good everything around it is — so three rules
 * override the total. They are implemented here as code, not written down as
 * guidance for a user to apply themselves.
 */

import { DOMAINS, MAX_RAW_PER_DOMAIN, MAX_WEIGHTED, criterionByRef } from './criteria.js';

export const BANDS = Object.freeze([
  { band: 'READY',   min: 160, max: 200, means: 'You can begin a process without a preparation phase. Expect questions, not surprises.' },
  { band: 'NEARLY',  min: 125, max: 159, means: 'Begin preparation now and go to market in roughly one to three months. The gaps are known and bounded.' },
  { band: 'NOT_YET', min: 85,  max: 124, means: 'Three to nine months of work. Going now means doing the preparation during the process, in public, under time pressure.' },
  { band: 'EARLY',   min: 0,   max: 84,  means: 'Six to eighteen months. This is not a judgement on the business. It is a statement about evidence.' },
]);

/** Ordered weakest → strongest, so a cap can be applied by comparison. */
const ORDER = ['BLOCKED', 'EARLY', 'NOT_YET', 'NEARLY', 'READY'];

export const HARD_RULES = Object.freeze([
  { id: 'floor',          text: 'Any single domain below 8/20 caps the band at NOT_YET. One hole sinks a process.' },
  { id: 'cap_table_gate', text: 'Criterion 1.1 at 2 or below issues no band at all. Every other number is provisional until ownership of the company is settled.' },
  { id: 'financial_gate', text: 'Domain 2 below 10/20 caps the band at NOT_YET. The financial record is the one domain a counterparty cannot take on trust.' },
]);

export class AssessmentError extends Error {
  constructor(code, message, status = 400) {
    super(message); this.code = code; this.status = status;
  }
}

/**
 * @param {Record<string, number>} scores  criterion ref → 0..5
 * @param {{partial?: boolean}} [opts]     allow an incomplete assessment
 */
export function score(scores, { partial = false } = {}) {
  const clean = {};
  for (const [ref, raw] of Object.entries(scores ?? {})) {
    if (!criterionByRef(ref)) throw new AssessmentError('unknown_criterion', `no such criterion: ${ref}`);

    // null/undefined means UNANSWERED, not zero. Number(null) is 0, and a
    // silent 0 is "does not exist, or exists and is wrong" — it would drag the
    // band down and generate a gap for something the user simply had not got
    // to yet. Treat it as a clearing of the answer instead.
    if (raw === null || raw === undefined || raw === '') continue;

    if (typeof raw === 'boolean') {
      throw new AssessmentError('invalid_score', `${ref} must be an integer 0–5, got ${raw}`);
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 5) {
      throw new AssessmentError('invalid_score', `${ref} must be an integer 0–5, got ${JSON.stringify(raw)}`);
    }
    clean[ref] = n;
  }

  const domains = [];
  let missing = 0;

  for (const d of DOMAINS) {
    const values = d.criteria.map((c) => clean[c.ref]);
    const answered = values.filter((v) => v !== undefined);
    missing += values.length - answered.length;

    const raw = answered.reduce((a, b) => a + b, 0);
    domains.push({
      domain: d.n,
      name: d.name,
      weight: d.weight,
      raw,
      complete: answered.length === values.length,
      answered: answered.length,
      weighted: round2(raw * d.weight),
      criteria: Object.fromEntries(d.criteria.map((c) => [c.ref, clean[c.ref] ?? null])),
    });
  }

  if (missing > 0 && !partial) {
    throw new AssessmentError('incomplete', `${missing} criteria are unscored; score them or pass partial: true`);
  }

  const totalWeighted = round2(domains.reduce((sum, d) => sum + d.weighted, 0));
  const { band, capped, reasons } = applyHardRules(totalWeighted, domains, clean, missing > 0);

  return {
    total_weighted: totalWeighted,
    max_weighted: MAX_WEIGHTED,
    band,
    band_before_rules: capped ? bandFromTotal(totalWeighted) : band,
    capped,
    hard_rule_findings: reasons,
    complete: missing === 0,
    unscored: missing,
    domains,
  };
}

function bandFromTotal(total) {
  return BANDS.find((b) => total >= b.min && total <= b.max)?.band ?? 'EARLY';
}

function applyHardRules(total, domains, clean, incomplete) {
  const reasons = [];
  let band = bandFromTotal(total);
  const original = band;

  // Rule 2 first: without a trustworthy cap table there is no band to issue.
  const capTable = clean['1.1'];
  if (capTable !== undefined && capTable <= 2) {
    reasons.push({
      rule: 'cap_table_gate',
      detail: `Criterion 1.1 scored ${capTable}. No band is issued until the cap table reconciles.`,
      action: 'Fix 1.1, then re-score. Every other number here is provisional.',
    });
    return { band: 'BLOCKED', capped: true, reasons };
  }

  // Rule 1: the floor. Only applies to domains that were fully scored —
  // a partially scored domain is low because it is unanswered, not because
  // it is weak, and penalising that would train people to guess.
  for (const d of domains) {
    if (d.complete && d.raw < 8) {
      reasons.push({
        rule: 'floor',
        detail: `Domain ${d.domain} (${d.name}) scored ${d.raw}/20, below the floor of 8.`,
        action: 'Raise it above 8 before the total means anything.',
      });
      band = weaker(band, 'NOT_YET');
    }
  }

  // Rule 3: the financial gate.
  const d2 = domains.find((d) => d.domain === 2);
  if (d2?.complete && d2.raw < 10) {
    reasons.push({
      rule: 'financial_gate',
      detail: `Domain 2 (The financial record) scored ${d2.raw}/20, below the gate of 10.`,
      action: 'A counterparty cannot proceed on trust here. This is the first thing to fix.',
    });
    band = weaker(band, 'NOT_YET');
  }

  if (incomplete) {
    reasons.push({
      rule: 'incomplete',
      detail: 'Some criteria are unscored. The band reflects only what has been answered.',
      action: 'Finish the assessment before relying on the band.',
    });
  }

  return { band, capped: band !== original, reasons };
}

const weaker = (a, b) => (ORDER.indexOf(a) <= ORDER.indexOf(b) ? a : b);
const round2 = (n) => Math.round(n * 100) / 100;

export function bandMeaning(band) {
  if (band === 'BLOCKED') {
    return 'No band issued. The cap table must reconcile before a readiness score means anything.';
  }
  return BANDS.find((b) => b.band === band)?.means ?? null;
}

export { MAX_RAW_PER_DOMAIN, MAX_WEIGHTED };
