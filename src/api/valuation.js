/**
 * Valuation readiness — the service surface.
 *
 * Two things, and a careful boundary between them:
 *
 *   · **The pack.** What the company can currently evidence, and what it cannot.
 *     Built entirely from the company's own confirmed facts. Contains no
 *     estimate, no score, no grade and no opinion.
 *
 *   · **The own-assumption calculator.** The user supplies a multiple; the
 *     product multiplies and stores the result as a `CALCULATED` fact with the
 *     formula and the inputs recorded. It does not suggest a multiple, offer a
 *     range, or say whether one is sensible.
 *
 * The product does not value companies. That sentence is already in the
 * advisor's refusals, and this feature exists because the right answer to "what
 * are we worth" was never "nothing" — it was *"somebody independent decides
 * that, and here is everything they will ask you for."*
 */

import { authorise, AccessError } from '../domain/access.js';
import { usableFacts } from '../domain/facts.js';
import {
  EVIDENCE_AREAS, AREA_KEYS, VALUATION_KINDS, WHY_THEY_DIFFER, NEXT_STEPS,
  valuationReadiness, applyAssumption, checkAssumption, areaFor, ValuationError,
} from '../domain/valuation.js';
import { createFact } from './service.js';

const ok = (body, status = 200) => ({ status, body });

const membershipOf = (ctx, orgId) => ctx.db.findOne('membership', { org_id: orgId, user_id: ctx.auth.userId });

/**
 * The pack.
 *
 * Ungated. A company deciding whether this product is worth paying for is
 * exactly the company that should be able to see how far from ready its records
 * are, and gating the bad news would be a strange way to sell the fix.
 */
export function readinessPack(ctx, orgId) {
  authorise(membershipOf(ctx, orgId), 'read');
  const facts = usableFacts(ctx.db.find('fact', { org_id: orgId }));
  const readiness = valuationReadiness(facts);

  return ok({
    ...readiness,
    kinds: VALUATION_KINDS,
    why_they_differ: WHY_THEY_DIFFER,
    next_steps: NEXT_STEPS,
    // Repeated here as well as inside the readiness object, because this is the
    // response a UI renders at the top of a page titled "valuation".
    what_this_is: 'Everything an independent valuer will ask you to evidence, and how much of it you '
                + 'currently have. It is a preparation tool. It does not estimate what the company is '
                + 'worth, and the arithmetic elsewhere on this page runs on assumptions you supply.',
    sources: 'docs/VALUATION-SOURCES.md',
  });
}

/** One area, with what is missing spelled out. */
export function area(ctx, orgId, key) {
  authorise(membershipOf(ctx, orgId), 'read');
  const spec = areaFor(key);
  if (!spec) throw new ValuationError('unknown_area', `No evidence area called "${key}".`, 404, { known: AREA_KEYS });

  const facts = usableFacts(ctx.db.find('fact', { org_id: orgId }));
  const readiness = valuationReadiness(facts).areas.find((a) => a.key === key);

  return ok({
    ...readiness,
    requires: spec.requires,
    uses: spec.uses,
    group: spec.group ?? null,
  });
}

// ──────────────────────────────────────────────────────────── the calculator ──

/**
 * Apply the user's own multiple to one of their own confirmed figures.
 *
 * Stored as a `CALCULATED` fact through the ordinary fact service, so the
 * formula and the input references are recorded and the arithmetic can be
 * redone. There is no shortcut path that writes a fact row.
 */
export function calculateOnAssumption(ctx, orgId, input = {}) {
  authorise(membershipOf(ctx, orgId), 'write');

  const baseKey = String(input.base_fact_key ?? '').trim();
  if (!baseKey) {
    throw new ValuationError('base_required',
      'Say which of your figures the multiple applies to.', 400);
  }

  const base = usableFacts(ctx.db.find('fact', { org_id: orgId }))
    .find((f) => f.fact_key === baseKey)
    // Fall back to the unconfirmed row so the refusal can be specific about why,
    // rather than claiming the figure does not exist.
    ?? ctx.db.find('fact', { org_id: orgId }).find((f) => f.fact_key === baseKey && !f.superseded_by)
    ?? null;

  const result = applyAssumption({ multiple: input.multiple, base, note: input.note });

  const fact = createFact(ctx, orgId, {
    // Namespaced under assumptions, never under financials. A figure filed
    // beside the audited numbers will eventually be read as one of them.
    fact_key: `assumption.${baseKey}.x${String(input.multiple).replace('.', '_')}`,
    label: result.label,
    value_numeric: result.value_numeric,
    unit: result.unit,
    source: 'CALCULATED',
    formula: result.formula,
    input_fact_ids: result.input_fact_ids,
  }).body.fact;

  return ok({
    fact,
    ...result,
    // The thing a UI must show beside the number.
    disclosure: result.disclosure,
  }, 201);
}

/** Check an assumption without storing anything, for a live form. */
export function previewAssumption(ctx, orgId, input = {}) {
  authorise(membershipOf(ctx, orgId), 'read');
  const baseKey = String(input.base_fact_key ?? '').trim();
  const base = usableFacts(ctx.db.find('fact', { org_id: orgId }))
    .find((f) => f.fact_key === baseKey) ?? null;

  const problems = checkAssumption({ multiple: input.multiple, base });
  if (problems.length) return ok({ ok: false, problems });

  const result = applyAssumption({ multiple: input.multiple, base });
  return ok({ ok: true, ...result, stored: false });
}

/**
 * Figures a multiple could sensibly be applied to.
 *
 * The confirmed, numeric, currency-denominated facts the company holds — not a
 * recommendation about which one to use, and not ordered by preference.
 */
export function assumptionBases(ctx, orgId) {
  authorise(membershipOf(ctx, orgId), 'read');
  const facts = usableFacts(ctx.db.find('fact', { org_id: orgId }))
    .filter((f) => f.value_numeric !== null && f.value_numeric !== undefined)
    .filter((f) => ['USD', 'GBP', 'EUR'].includes(f.unit))
    .filter((f) => !f.fact_key.startsWith('assumption.'))
    .sort((a, b) => a.fact_key.localeCompare(b.fact_key));

  return ok({
    bases: facts.map((f) => ({
      fact_key: f.fact_key, label: f.label, value_numeric: f.value_numeric,
      unit: f.unit, source: f.source,
      document_backed: f.source === 'USER_CONFIRMED',
    })),
    note: 'Any of your confirmed figures can have a multiple applied to it. Which one is appropriate '
        + 'is your judgement — this product has no view on it.',
  });
}

export { ValuationError, EVIDENCE_AREAS };
